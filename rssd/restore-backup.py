#!/usr/bin/env python3
"""Unpack into a NEW private directory. Never connects a restored publisher."""
import argparse, json, os, pathlib, subprocess, tarfile
from backup import Drive, digest, owned_child, run, write_json

def safe_extract(source, output):
    output = pathlib.Path(output).resolve()
    with tarfile.open(source, 'r:gz') as archive:
        seen = set()
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or member.name in seen or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe recovery archive entry')
            seen.add(member.name); owned_child(output, output / member.name)
        archive.extractall(output, filter='data')

def restore(config, snapshot, identity, output, expected_hash, remote=None):
    snapshot, output = pathlib.Path(snapshot), pathlib.Path(output)
    if digest(snapshot) != expected_hash: raise ValueError('Encrypted recovery package checksum mismatch')
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    remote = remote or Drive(config)
    temporary = output / '.package.tar.gz'
    run([config.get('age', 'age'), '-d', '-i', str(identity), '-o', str(temporary), str(snapshot)], stdout=subprocess.DEVNULL)
    try: safe_extract(temporary, output)
    finally: temporary.unlink(missing_ok=True)
    manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('version') != 1: raise ValueError('Unsupported recovery package')
    for entry in manifest['databases'] + manifest['files']:
        path = owned_child(output, output / entry['path'])
        if not path.is_file() or digest(path) != entry['sha256']: raise ValueError('Recovery file checksum mismatch')
    for entry in manifest['objects']:
        path = owned_child(output, output / 'archives' / entry['label'] / entry['path'])
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.exists(): raise ValueError('Duplicate recovery file')
        encrypted = output / '.object.age'
        remote.download(entry['key'], encrypted)
        if digest(encrypted) != entry['sha256']: raise ValueError('Archived object checksum mismatch')
        run([config.get('age', 'age'), '-d', '-i', str(identity), '-o', str(path), str(encrypted)], stdout=subprocess.DEVNULL)
        os.chmod(path, 0o600); encrypted.unlink()
        if digest(path) != entry['plaintextSha256']: raise ValueError('Restored object checksum mismatch')
    write_json(output / 'RESTORE-VERIFIED.json', {'version': 1, 'snapshotSha256': expected_hash, 'databases': len(manifest['databases']), 'files': len(manifest['files']), 'objects': len(manifest['objects']), 'dispatchEnabled': False})
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for field in ['config', 'snapshot', 'identity', 'output', 'sha256']: parser.add_argument('--' + field, required=True)
    args = parser.parse_args()
    restore(json.loads(pathlib.Path(args.config).read_text()), args.snapshot, args.identity, args.output, args.sha256)
    print('Recovery files verified; no database or publishing service was started.')
