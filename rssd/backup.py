#!/usr/bin/env python3
"""Encrypted, verified backups. Only this program's completed snapshots expire.

Requires Python 3.11+, age, rclone and Docker. Credentials stay in the private
configuration files; subprocess output never includes configuration or tokens.
"""
import argparse, contextlib, datetime as dt, hashlib, json, os, pathlib, re
import shutil, sqlite3, subprocess, tarfile, tempfile, uuid

STAMP = re.compile(r'^rssd-(\d{8}T\d{6}Z)-([a-f0-9]{8})\.tar\.age$')
ARTICLE_QUERY = '''SELECT jsonb_build_object('work',to_jsonb(w),'edition',to_jsonb(e))::text
FROM rssd_editions e JOIN rssd_works w ON w."orgId"=e."orgId" AND w.id=e."workId"
ORDER BY e."orgId",e."workId",e.locale,e.revision'''

def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def remote_md5(row):
    return next((str(value).lower() for name, value in row.get('Hashes', {}).items() if name.lower() == 'md5'), '')

def write_json(path, value):
    path = pathlib.Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temp, 'x', encoding='utf-8') as stream:
        os.chmod(temp, 0o600); json.dump(value, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
    os.replace(temp, path)

def owned_child(root, path):
    root, path = pathlib.Path(root).resolve(), pathlib.Path(path)
    if path.is_symlink() or not path.resolve().is_relative_to(root) or path.resolve() == root:
        raise ValueError('Backup path is outside its private directory')
    return path

def retention(names, daily=14, weekly=8):
    """Keep the newest snapshot of each recent represented UTC day/week."""
    records = []
    for name in names:
        match = STAMP.fullmatch(name)
        if match:
            date = dt.datetime.strptime(match[1], '%Y%m%dT%H%M%SZ')
            records.append((date, name))
    records.sort(reverse=True)
    days, weeks, keep = {}, {}, set()
    for date, name in records:
        days.setdefault(date.date(), name); weeks.setdefault(date.isocalendar()[:2], name)
    keep.update(list(days.values())[:daily]); keep.update(list(weeks.values())[:weekly])
    return [name for _, name in records if name not in keep]

def run(command, **kwargs):
    result = subprocess.run(command, stderr=subprocess.PIPE, **kwargs)
    if result.returncode: raise RuntimeError('Backup command failed: ' + pathlib.Path(command[0]).name)
    return result

class Drive:
    def __init__(self, config): self.config = config
    def command(self, *args):
        return [self.config.get('rclone', 'rclone'), '--config', self.config['rcloneConfig'], '--drive-use-trash=true', *args]
    def path(self, key):
        if key.startswith('/') or '..' in pathlib.PurePosixPath(key).parts: raise ValueError('Invalid remote key')
        return self.config['remote'].rstrip('/') + '/' + key
    def list(self, key):
        raw = run(self.command('lsjson', self.path(key), '--files-only', '--hash'), stdout=subprocess.PIPE).stdout
        return json.loads(raw)
    def prepare(self):
        for key in ['objects', 'snapshots', 'receipts']:
            run(self.command('mkdir', self.path(key)), stdout=subprocess.DEVNULL)
    def upload(self, source, key):
        run(self.command('copyto', str(source), self.path(key)), stdout=subprocess.DEVNULL)
        # Drive reports the checksum of the stored ciphertext, not a cached source.
        rows = self.list(key)
        if isinstance(rows, dict): rows = [rows]
        expected = digest(source, 'md5')
        if len(rows) != 1 or rows[0].get('Size') != source.stat().st_size or remote_md5(rows[0]) != expected:
            raise RuntimeError('Remote backup checksum verification failed')
    def remove(self, key): run(self.command('deletefile', self.path(key)), stdout=subprocess.DEVNULL)
    def download(self, key, destination):
        run(self.command('copyto', self.path(key), str(destination)), stdout=subprocess.DEVNULL)

def encrypt(config, source, output):
    run([config.get('age', 'age'), '-r', config['recipient'], '-o', str(output), str(source)], stdout=subprocess.DEVNULL)
    os.chmod(output, 0o600)

def regular_files(source):
    source = pathlib.Path(source)
    if source.is_symlink(): raise ValueError('Backup input cannot be a symlink')
    if source.is_file(): return [(source, source.name)]
    if not source.is_dir(): raise ValueError('Required backup input is missing')
    result = []
    for base, directories, files in os.walk(source, followlinks=False):
        for name in directories + files:
            path = pathlib.Path(base) / name
            if path.is_symlink(): raise ValueError('Backup input contains a symlink')
        for name in files:
            path = pathlib.Path(base) / name
            if not path.is_file(): raise ValueError('Backup input must be a regular file')
            result.append((path, path.relative_to(source).as_posix()))
    return sorted(result)

def snapshot(config, remote=None):
    state = pathlib.Path(config['stateDirectory']).resolve(); state.mkdir(parents=True, exist_ok=True, mode=0o700)
    for item in config.get('configuration', []) + config.get('archives', []):
        source = pathlib.Path(item['source']).resolve()
        if state.is_relative_to(source): raise ValueError('Backup state cannot be inside a source directory')
    local = state / 'snapshots'; local.mkdir(exist_ok=True, mode=0o700)
    index_file, status_file = state / 'objects.json', state / 'status.json'
    index = json.loads(index_file.read_text()) if index_file.exists() else {}
    previous = json.loads(status_file.read_text()) if status_file.exists() else {}
    remote = remote or Drive(config)
    labels = [item['label'] for item in config.get('archives', []) + config.get('articles', [])]
    if len(labels) != len(set(labels)): raise ValueError('Archive labels must be unique')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = 'rssd-' + stamp + '-' + uuid.uuid4().hex[:8] + '.tar.age'
    tar_path = state / (name + '.tar.tmp')
    write_json(status_file, {**previous, 'state': 'running', 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
    try:
        remote.prepare()
        remote_objects = {row['Name']: row for row in remote.list('objects')}
        with tempfile.TemporaryDirectory(prefix='partial-', dir=state) as temporary:
            work = pathlib.Path(temporary); os.chmod(work, 0o700)
            manifest = {'version': 1, 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'databases': [], 'files': [], 'objects': []}
            # pg_dumpall includes database definitions and Postiz/Temporal roles.
            for database in config['databases']:
                label = database['label']
                if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', label): raise ValueError('Invalid database label')
                output = work / (label + '.sql')
                with open(output, 'xb') as stream:
                    os.chmod(output, 0o600)
                    run(['docker', 'exec', database['container'], 'sh', '-c', 'exec pg_dumpall -U "$POSTGRES_USER"'], stdout=stream)
                manifest['databases'].append({'path': output.name, 'sha256': digest(output)})
            # The legacy labels budget remains an independent SQLite ledger.
            # Online backup includes committed WAL data without copying live files.
            for database in config.get('sqlite', []):
                label = database['label']; source = pathlib.Path(database['source'])
                if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', label) or not source.is_file() or source.is_symlink():
                    raise ValueError('Invalid SQLite backup source')
                output = work / (label + '.sqlite')
                if output.exists(): raise ValueError('Duplicate SQLite backup label')
                with contextlib.closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as reader, contextlib.closing(sqlite3.connect(output)) as writer:
                    os.chmod(output, 0o600); reader.backup(writer)
                    if writer.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('SQLite backup integrity failed')
                manifest['databases'].append({'path': output.name, 'sha256': digest(output), 'kind': 'sqlite'})
            # Small private configuration files go inside every recovery package.
            for item in config.get('configuration', []):
                label = item['label']
                if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', label): raise ValueError('Invalid configuration label')
                for source, relative in regular_files(item['source']):
                    destination = work / 'configuration' / label / relative
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    shutil.copyfile(source, destination); os.chmod(destination, 0o600)
                    manifest['files'].append({'path': destination.relative_to(work).as_posix(), 'sha256': digest(destination), 'mode': source.stat().st_mode & 0o777})
            # Immutable media and article exports are uploaded once by content hash.
            archives = list(config.get('archives', [])); article_updates = []
            for source in config.get('articles', []):
                label = source['label']
                if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', label): raise ValueError('Invalid article archive label')
                ledger_path = state / ('articles-' + label + '.json')
                ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {'rows': [], 'batches': []}
                known = set(ledger['rows']); added = []; export = work / ('export-' + label + '.jsonl'); delta = work / ('delta-' + label + '.jsonl')
                with open(export, 'xb') as stream:
                    run(['docker', 'exec', source['container'], 'sh', '-c', 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "$2"', 'sh', source['database'], ARTICLE_QUERY], stdout=stream)
                with open(export, encoding='utf-8') as stream, open(delta, 'xb') as changed:
                    for line in stream:
                        value = json.loads(line); edition = value['edition']
                        # Work updatedAt is mutable; the edition identity and payload are immutable.
                        row_hash = hashlib.sha256(json.dumps(edition, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                        if row_hash not in known:
                            changed.write(line.encode()); known.add(row_hash); added.append(row_hash)
                export.unlink()
                manifest['objects'].extend(ledger['batches'])
                if added:
                    archives.append({'label': label, 'source': str(delta), 'articleBatch': True})
                    article_updates.append((ledger_path, ledger, added, label, delta.name))
                else: delta.unlink()
            for item in archives:
                label = item['label']
                if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', label): raise ValueError('Invalid archive label')
                for source, relative in regular_files(item['source']):
                    sha = digest(source)
                    # Copy and hash the actual encrypted input; reject concurrent mutation.
                    cached = index.get(sha, {})
                    stored = remote_objects.get(cached.get('key', '').split('/')[-1], {})
                    if not cached.get('md5') or remote_md5(stored) != cached['md5'] or stored.get('Size') != cached.get('bytes'):
                        stable = work / 'object-source'; shutil.copyfile(source, stable); os.chmod(stable, 0o600)
                        if digest(stable) != sha: raise RuntimeError('Archive changed during backup; retry after the write completes')
                        encrypted = work / 'object.age'; encrypt(config, stable, encrypted)
                        encrypted_hash = digest(encrypted)
                        key = 'objects/' + sha + '-' + encrypted_hash + '.age'; remote.upload(encrypted, key)
                        index[sha] = {'key': key, 'sha256': encrypted_hash, 'md5': digest(encrypted, 'md5'), 'bytes': encrypted.stat().st_size}
                        remote_objects[key.split('/')[-1]] = {'Hashes': {'md5': index[sha]['md5']}, 'Size': index[sha]['bytes']}
                        write_json(index_file, index); stable.unlink(); encrypted.unlink()
                    archive_path = (stamp + '-' + name.split('-')[-1].removesuffix('.tar.age') + '.jsonl') if item.get('articleBatch') else relative
                    manifest['objects'].append({'label': label, 'path': archive_path, 'plaintextSha256': sha, **index[sha]})
                if item.get('articleBatch'): pathlib.Path(item['source']).unlink()
            for ledger_path, ledger, added, label, _ in article_updates:
                batch = [entry for entry in manifest['objects'] if entry['label'] == label and entry not in ledger['batches']]
                write_json(ledger_path, {'rows': ledger['rows'] + added, 'batches': ledger['batches'] + batch})
            for entry in manifest['objects']:
                stored = remote_objects.get(entry['key'].split('/')[-1], {})
                if stored.get('Size') != entry['bytes'] or remote_md5(stored) != entry['md5']:
                    raise RuntimeError('A required historical archive is missing or corrupted remotely')
            write_json(work / 'manifest.json', manifest)
            # The archive excludes the output itself and private in-progress state.
            with tarfile.open(tar_path, 'w:gz') as archive:
                for path in sorted(work.iterdir()): archive.add(path, arcname=path.name, recursive=True)
            os.chmod(tar_path, 0o600)
            encrypted = local / name
            try: encrypt(config, tar_path, encrypted)
            finally: tar_path.unlink(missing_ok=True)
            remote.upload(encrypted, 'snapshots/' + name)
            receipt = {'version': 1, 'name': name, 'sha256': digest(encrypted), 'bytes': encrypted.stat().st_size, 'verifiedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'objects': len(manifest['objects'])}
            write_json(local / (name + '.json'), receipt)
            remote.upload(local / (name + '.json'), 'receipts/' + name + '.json')
        # Retention is reached only after both ciphertext and receipt are verified.
        # A failed upload never removes the most recent valid local/remote copy.
        available = {row['Name'] for row in remote.list('snapshots') if STAMP.fullmatch(row['Name'])}
        receipts = {row['Name'].removesuffix('.json') for row in remote.list('receipts') if row['Name'].endswith('.json')}
        if name not in available & receipts: raise RuntimeError('Completed remote snapshot is missing')
        for expired in retention(available & receipts):
            if expired == name: continue
            remote.remove('snapshots/' + expired); remote.remove('receipts/' + expired + '.json')
        completed = sorted((p for p in local.glob('rssd-*.tar.age') if STAMP.fullmatch(p.name) and p.with_name(p.name + '.json').exists()), key=lambda p: json.loads(p.with_name(p.name + '.json').read_text())['verifiedAt'], reverse=True)
        for expired in completed[3:]:
            owned_child(local, expired).unlink(); owned_child(local, expired.with_name(expired.name + '.json')).unlink()
        write_json(status_file, {'state': 'healthy', 'lastSuccess': receipt, 'finishedAt': receipt['verifiedAt']})
        return receipt
    except Exception as error:
        current = json.loads(status_file.read_text())
        write_json(status_file, {**current, 'state': 'failed', 'error': type(error).__name__, 'finishedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
        raise
    finally:
        tar_path.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); args = parser.parse_args()
    config_path = pathlib.Path(args.config)
    if os.name == 'posix' and config_path.stat().st_mode & 0o077: raise ValueError('Backup configuration must be private (0600)')
    config = json.loads(config_path.read_text()); state = pathlib.Path(config['stateDirectory']); state.mkdir(parents=True, exist_ok=True, mode=0o700)
    import fcntl
    with open(state / 'backup.lock', 'w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        print(json.dumps(snapshot(config)))

if __name__ == '__main__': main()
