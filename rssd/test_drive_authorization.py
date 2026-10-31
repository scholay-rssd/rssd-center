import importlib.util, json, pathlib, subprocess, tempfile, unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('authorize_drive', pathlib.Path(__file__).with_name('authorize-drive.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class AuthorizationTests(unittest.TestCase):
    def test_secrets_use_stdin_and_only_drive_file_is_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); client=root/'client.json'; config=root/'private/rclone.conf'
            client.write_text(json.dumps({'installed':{'client_id':'test.apps.googleusercontent.com','client_secret':'synthetic-secret'}}))
            with patch.object(module,'protect_directory',side_effect=lambda p:p.mkdir()), patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='obscured\n')) as run:
                module.prepare(client,config,'rclone')
            self.assertEqual(run.call_args.args[0],['rclone','obscure','-'])
            self.assertEqual(run.call_args.kwargs['input'],'synthetic-secret\n')
            self.assertNotIn('synthetic-secret',config.read_text())
            self.assertIn('scope = drive.file',config.read_text())
            with self.assertRaisesRegex(ValueError,'already exists'):module.prepare(client,config,'rclone')

    def test_invalid_client_cannot_inject_config_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); client=root/'client.json'
            for secret in ['secret\nscope=drive','secret\rfoo','secret\x00foo']:
                client.write_text(json.dumps({'installed':{'client_id':'test.apps.googleusercontent.com','client_secret':secret}}))
                with self.assertRaises(ValueError):module.prepare(client,root/'out.conf','rclone')
                self.assertFalse((root/'out.conf').exists())

if __name__=='__main__':unittest.main()
