#!/usr/bin/env python3
"""Owner-run desktop OAuth setup; credentials never enter command arguments or stdout."""
import argparse, configparser, csv, io, json, os, pathlib, subprocess, sys

def protect_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == 'nt':
        result = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, text=True, check=True)
        sid = next(csv.reader(io.StringIO(result.stdout)))[1]
        subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', f'*{sid}:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else: path.chmod(0o700)

def prepare(client, config, rclone):
    value = json.loads(pathlib.Path(client).read_text(encoding='utf-8-sig')).get('installed', {})
    identity, secret = value.get('client_id', ''), value.get('client_secret', '')
    if not identity.endswith('.apps.googleusercontent.com') or not secret or any(c in identity + secret for c in '\r\n\x00'):
        raise ValueError('Use the downloaded Google Desktop app OAuth JSON file')
    config = pathlib.Path(config).resolve()
    if config.exists(): raise ValueError('Configuration already exists; keep it and use rclone config reconnect to renew authorization')
    protect_directory(config.parent)
    # rclone's obfuscation is reversible. File permissions protect this secret.
    encoded = subprocess.run([str(rclone), 'obscure', '-'], input=secret + '\n', capture_output=True, text=True, check=True).stdout.strip()
    parser = configparser.ConfigParser(interpolation=None)
    parser['rssd-drive'] = {'type': 'drive', 'client_id': identity, 'client_secret': encoded, 'scope': 'drive.file'}
    with config.open('x', encoding='utf-8') as stream: parser.write(stream)
    if os.name != 'nt': config.chmod(0o600)
    return config

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client-json', required=True)
    parser.add_argument('--rclone', required=True)
    parser.add_argument('--config', default=str(pathlib.Path.home()/'.rssd-recovery/drive/rclone.conf'))
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    config = prepare(args.client_json, args.config, args.rclone)
    if args.prepare_only:
        print('Private drive.file configuration prepared. Browser authorization is still required.'); return
    print('Complete Google authorization in the browser. Do not paste credentials into chat.', flush=True)
    # rclone starts its loopback OAuth callback listener and opens the browser.
    # Output is kept in the protected directory instead of exposing a token.
    with config.with_suffix('.authorization.log').open('w', encoding='utf-8') as log:
        result = subprocess.run([args.rclone, '--config', str(config), 'config', 'reconnect', 'rssd-drive:', '--auto-confirm'], stdout=log, stderr=log)
    if result.returncode: raise ValueError('Authorization did not complete; the private log is next to rclone.conf')
    saved = configparser.ConfigParser(interpolation=None); saved.read(config, encoding='utf-8')
    token = json.loads(saved.get('rssd-drive', 'token', fallback='{}'))
    if saved.get('rssd-drive', 'scope') != 'drive.file' or not token.get('refresh_token'):
        raise ValueError('A renewable drive.file authorization was not saved')
    print('Authorization saved privately. The operator can now verify the remote and install the server backup configuration.')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else 'Drive setup failed; no credential values were printed', file=sys.stderr)
        sys.exit(1)
