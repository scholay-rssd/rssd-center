# Labels ledger handoff

The existing labels collector is vendored unchanged from the public core revision
in `legacy-labels/SOURCE.json`, with its MIT license. Its cost ceilings, endpoint
price checks, four-hour schedule, uncertain reservations and stable request IDs
are preserved. The ledger remains SQLite, located on the center's persistent
volume; it is separate from article data. It is not recreated from feed JSON.

Stop the original labels timer and wait for its current collector process to
finish. Use SQLite's online backup API to copy the entire database, verify
integrity, every table's row count/hash, monthly spent/reserved totals and request
identities. Keep the original stopped database as recovery material. Do not run
two collectors against divergent copies of the same billing ledger.

Set `RSSD_LABELS_CONFIG` to a private 0600 JSON file:

```json
{
  "orgId": "existing-owner-organization",
  "database": "/config/rssd/labels.sqlite",
  "collectionEnabled": false,
  "tokenFile": "/config/rssd/labels-token"
}
```

The center's authenticated `/api/rssd/v1/labels` reads only the existing database.
It retains the old feed schema, permits the matching organization's owner and
scoped devices, and limits reads to 90/minute per actor. Reads do not import the
provider or create a blank ledger. The provider token is never read by the HTTP
path and never returned in a feed.

After the final handoff is verified, set `collectionEnabled: true` and
`RSSD_LABELS_COLLECTION_ENABLED=1`. PM2 starts the existing collector under flock.
The token file is private 0600 and contains only the existing TikHub token. Each
loop checks the current enable flag; stopping waits for the active cycle. Paid
requests still require their original persistent reservation and price check.

Backups must use `sqlite: [{"label":"labels","source":"HOST-PERSISTENT-PATH/labels.sqlite"}]`
in the encrypted backup configuration. This creates an online, integrity-checked
SQLite snapshot including committed WAL rows. Do not copy the live database as
an ordinary archive file. Include the private labels configuration and token in
the protected configuration allowlist. Restore the verified ledger before
enabling the collector.
