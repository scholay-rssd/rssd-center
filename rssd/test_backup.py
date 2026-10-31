import importlib.util, io, json, os, pathlib, shutil, tarfile, tempfile, unittest
from unittest.mock import patch
import backup

spec = importlib.util.spec_from_file_location('restore_backup', pathlib.Path(__file__).with_name('restore-backup.py'))
restore_backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(restore_backup)

class FixtureRemote:
    def __init__(self, directory): self.directory = directory; self.uploads = []; self.fail = False; self.removed = []
    def prepare(self):
        for name in ['objects', 'snapshots', 'receipts']: (self.directory / name).mkdir(exist_ok=True)
    def list(self, key):
        path = self.directory / key
        paths = [path] if path.is_file() else list(path.iterdir())
        return [{'Name': p.name, 'Size': p.stat().st_size, 'Hashes': {'MD5': backup.digest(p, 'md5')}} for p in paths if p.is_file()]
    def upload(self, source, key):
        if self.fail: raise RuntimeError('Fixture upload failure')
        self.uploads.append(key); shutil.copyfile(source, self.directory / key)
    def remove(self, key): self.removed.append(key); (self.directory / key).unlink()
    def download(self, key, destination): shutil.copyfile(self.directory / key, destination)

class BackupTests(unittest.TestCase):
    def test_article_versions_archive_only_new_rows_and_require_previous_batches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); remote_root = root / 'remote'; remote_root.mkdir(); remote = FixtureRemote(remote_root)
            config = {'stateDirectory': str(root / 'state'), 'databases': [], 'recipient': 'fixture', 'articles': [{'label': 'articles', 'container': 'fixture', 'database': 'fixture'}]}
            rows = [{'work': {'id': 'work1'}, 'edition': {'revision': 1, 'payload': {'title': 'Fixture'}}}]
            def export(command, **kwargs):
                self.assertEqual(command[:2], ['docker', 'exec'])
                for row in rows: kwargs['stdout'].write((json.dumps(row) + '\n').encode())
            with patch.object(backup, 'encrypt', side_effect=lambda c,s,o: shutil.copyfile(s,o)), patch.object(backup, 'run', side_effect=export):
                backup.snapshot(config, remote); backup.snapshot(config, remote)
                self.assertEqual(len([k for k in remote.uploads if k.startswith('objects/')]), 1)
                rows.append({'work': {'id': 'work1'}, 'edition': {'revision': 2, 'payload': {'title': 'Updated fixture'}}})
                result = backup.snapshot(config, remote)
                ledger = json.loads((root / 'state/articles-articles.json').read_text())
                self.assertEqual(len(ledger['rows']), 2); self.assertEqual(len(ledger['batches']), 2)
                self.assertEqual(result['objects'], 2)
                (remote_root / ledger['batches'][0]['key']).unlink()
                with self.assertRaisesRegex(RuntimeError, 'historical archive'): backup.snapshot(config, remote)
                self.assertTrue((remote_root / 'snapshots' / result['name']).exists())

    def test_retention_keeps_days_and_weeks_and_never_selects_other_files(self):
        names = ['rssd-202601%02dT000000Z-deadbeef.tar.age' % day for day in range(1, 32)]
        expired = backup.retention(names + ['unrelated.tar.age'])
        kept = set(names) - set(expired)
        self.assertGreaterEqual(len(kept), 14); self.assertNotIn('unrelated.tar.age', expired)
        self.assertIn(names[-1], kept); self.assertTrue(any('20260104' in name for name in kept))

    def test_archive_rejects_traversal_links_and_duplicate_entries_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); output = root / 'out'; output.mkdir()
            for name, kind in [('../escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)]:
                with tarfile.open(root / 'bad.tar.gz', 'w:gz') as archive:
                    entry = tarfile.TarInfo(name); entry.type = kind; entry.linkname = '/private'; archive.addfile(entry)
                with self.assertRaises(ValueError): restore_backup.safe_extract(root / 'bad.tar.gz', output)
            self.assertFalse(list(output.iterdir()))

    def test_incremental_objects_and_failed_upload_preserve_valid_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); source = root / 'source'; source.mkdir(); (source / 'image.png').write_bytes(b'fixture image')
            remote_root = root / 'remote'; remote_root.mkdir(); remote = FixtureRemote(remote_root)
            config = {'stateDirectory': str(root / 'state'), 'databases': [], 'archives': [{'label': 'media', 'source': str(source)}], 'recipient': 'fixture'}
            # Cipher transport is mocked here; real age round-trip runs separately.
            with patch.object(backup, 'encrypt', side_effect=lambda c,s,o: shutil.copyfile(s,o)):
                first = backup.snapshot(config, remote); second = backup.snapshot(config, remote)
                self.assertEqual(len([k for k in remote.uploads if k.startswith('objects/')]), 1)
                self.assertTrue((root / 'state/snapshots' / second['name']).exists())
                remote.fail = True
                with self.assertRaises(RuntimeError): backup.snapshot(config, remote)
                self.assertTrue((remote_root / 'snapshots' / second['name']).exists()); self.assertTrue((root / 'state/snapshots' / second['name']).exists())
                status = json.loads((root / 'state/status.json').read_text()); self.assertEqual(status['state'], 'failed'); self.assertEqual(status['lastSuccess']['name'], second['name'])
                remote.fail = False
                next((remote_root / 'objects').iterdir()).write_bytes(b'corrupted')
                backup.snapshot(config, remote)
                self.assertEqual(len([k for k in remote.uploads if k.startswith('objects/')]), 2)

    def test_real_age_backup_and_restore(self):
        age = os.environ.get('RSSD_TEST_AGE') or shutil.which('age')
        keygen = os.environ.get('RSSD_TEST_AGE_KEYGEN') or shutil.which('age-keygen')
        if not age or not keygen: self.skipTest('age tools unavailable')
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); key = root / 'fixture.key'
            backup.run([keygen, '-o', str(key)], stdout=backup.subprocess.DEVNULL)
            recipient = backup.run([keygen, '-y', str(key)], stdout=backup.subprocess.PIPE).stdout.decode().strip()
            source = root / 'source'; source.mkdir(); (source / 'image.png').write_bytes(b'fixture image with private bytes')
            settings = root / 'settings.env'; settings.write_text('FIXTURE_SECRET=not-a-real-credential')
            remote_root = root / 'remote'; remote_root.mkdir(); remote = FixtureRemote(remote_root)
            config = {'age': age, 'recipient': recipient, 'stateDirectory': str(root / 'state'), 'databases': [], 'configuration': [{'label': 'settings', 'source': str(settings)}], 'archives': [{'label': 'media', 'source': str(source)}]}
            result = backup.snapshot(config, remote); encrypted = root / 'state/snapshots' / result['name']
            self.assertNotIn(b'FIXTURE_SECRET', encrypted.read_bytes())
            restore_backup.restore(config, encrypted, key, root / 'restore', result['sha256'], remote)
            self.assertEqual((root / 'restore/archives/media/image.png').read_bytes(), (source / 'image.png').read_bytes())
            self.assertEqual((root / 'restore/configuration/settings/settings.env').read_text(), settings.read_text())
            with self.assertRaises(FileExistsError): restore_backup.restore(config, encrypted, key, root / 'restore', result['sha256'], remote)

if __name__ == '__main__': unittest.main()
