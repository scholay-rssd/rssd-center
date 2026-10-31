# Encrypted recovery backups

`backup.py` runs on the Docker host, outside the application container. Its
configuration and rclone OAuth token are private files (0600). The host has only
an age **public recipient**; keep the recovery identity separately on an owner PC.

Prerequisites: Python 3.11+, Docker, age and rclone. Configure a dedicated Google
Drive remote with `scope=drive.file` and its own backup folder. This scope grants
access to files created by that app, rather than existing unrelated Drive files.
Use an owner-managed OAuth client; do not copy a chat connector's credentials.
See [rclone Drive configuration](https://rclone.org/drive/#scopes).

For first-time authorization on an owner PC, create a Google Cloud Desktop app
OAuth client, enable Drive API, and download its client JSON privately. Configure
only `https://www.googleapis.com/auth/drive.file` in the consent screen. For a
personal External application, complete the owner's consent and publishing steps
in Google Cloud so that a Testing-mode grant does not expire after seven days.
No payment, broad Drive scope, or shared chat-connector credential is required.
Use a current official rclone build on the PC and backup host, then run:

```sh
python3 rssd/authorize-drive.py --client-json /private/google-desktop-client.json --rclone /path/to/rclone
```

The helper protects its configuration directory, passes the client secret through
stdin, requests `drive.file`, and lets the owner complete Google's browser flow.
It writes `~/.rssd-recovery/drive/rclone.conf`; do not paste that file or the OAuth
JSON into chat or a repository. Copy the verified configuration over SSH to the
backup host's private directory. Create `RSSD-recovery` through this new remote;
an existing folder created by another application may not be visible with this
scope. `--prepare-only` prepares a configuration without opening a browser.

Example `/etc/rssd-backup/config.json` (all values below are placeholders):

```json
{
  "stateDirectory": "/var/lib/rssd-backup",
  "recipient": "age1REPLACE_WITH_OWNER_PUBLIC_RECIPIENT",
  "rcloneConfig": "/etc/rssd-backup/rclone.conf",
  "remote": "rssd-drive:RSSD-recovery",
  "databases": [
    {"label": "postiz", "container": "postiz-postgres"},
    {"label": "temporal", "container": "temporal-postgresql"}
  ],
  "configuration": [
    {"label": "environment", "source": "/opt/postiz/.env"},
    {"label": "compose", "source": "/opt/postiz/docker-compose.yaml"},
    {"label": "center", "source": "/opt/postiz/data/config"},
    {"label": "temporal", "source": "/opt/postiz/dynamicconfig"}
  ],
  "archives": [{"label": "uploads", "source": "/opt/postiz/data/uploads"}],
  "articles": [{"label": "articles", "container": "postiz-postgres", "database": "postiz-db-local"}]
}
```

Add the separate RSSD media directory to `archives` if it is outside uploads.
Do not include the backup state directory within any source directory. Article
export requires the RSSD schema; enable it after installing the center migration.
All Postiz databases and roles are dumped, including existing channel identities
and receipts. Configuration is allowlisted. Article revisions are archived in
incremental JSONL batches; media is content addressed. Every object is encrypted
before upload. The recovery manifest records plaintext and ciphertext hashes.

Copy the scripts to `/opt/rssd-backup/`, run one backup manually, and verify its
Drive receipt before installing/enabling the supplied systemd service and timer.
The timer runs daily at 03:30 UTC with up to 20 minutes of jitter. A host lock
prevents overlap. Resource limits keep backup work below half one CPU and 512 MiB.

Completed recovery snapshots keep the newest 3 locally, and 14 daily plus 8 weekly
copies on Drive. Remote expiry uses Drive trash. Historical article/media objects
remain archived; retention never removes objects required by surviving snapshots.
Uploads and receipts must pass remote size and MD5 checks before retention runs.
A missing historical object or failed upload stops cleanup and leaves the last
successful backup available. `status.json` contains a bounded health receipt;
never expose the configuration, token or `objects.json` through a public endpoint.

## Restore into isolation

Download a completed ciphertext and its receipt. On the owner PC or an isolated
restore host with the owner's key, run:

```sh
python3 restore-backup.py --config private-config.json --snapshot rssd-DATE-ID.tar.age \
  --sha256 SHA_FROM_RECEIPT --identity /private/recovery.agekey --output /private/new-restore
```

The destination must not exist. The tool rejects traversal, links and duplicate
archive entries, verifies every restored file and media object, and writes
`RESTORE-VERIFIED.json`. It does not start a database or publisher. Import the SQL
into isolated matching PostgreSQL versions, restore the allowlisted configuration
and uploads, and start the matching RSSD image with `RSSD_DISPATCH_ENABLED=0` and
`RSSD_POSTIZ_ORCHESTRATOR_ENABLED=0`. Verify works, revisions, destination identities
and uncertain receipts before enabling either dispatcher. Do not run restored
publishers while the original center is still writing to the same destinations.
# SQLite operational ledgers

Add `sqlite` entries with a unique `label` and existing host `source` path for
the migrated labels ledger. The backup uses SQLite's online backup API and
checks integrity; it includes committed WAL data without copying live files.
These snapshots are verified with the other database files during recovery.
Keep live SQLite files out of ordinary `archives` and `configuration` inputs.

