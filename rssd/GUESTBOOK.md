# Site guestbooks

The center stores visitor hashes, request IDs, moderation and private contacts in
PostgreSQL. A migration retains the original signed-cookie secret encrypted with
the center credential key. The public API only returns approved names, message
text, kind, date and identity. The owner reviews messages in RSSD → 留言审核.

Export each consistent legacy SQLite backup with the public core command:

```
node scripts/rssd-migrate-guestbook.mjs SITE SNAPSHOT.sqlite .local/guestbook.json
```

Import with `node rssd/guestbook-cli.cjs import ORGANIZATION PRIVATE-CONFIG.json`.
The private configuration contains `archive` and a randomly generated
`proxyToken` (at least 32 characters). The imported book is disabled. After
disabling the old guestbook writer and re-exporting its final state, use
`activate ORGANIZATION PRIVATE-EVIDENCE.json` with `siteId`, `sourceHash` and
`oldWriterDisabled: true`. An active book cannot be overwritten by an old import.

Keep the existing public `/guestbook/` URL. The site's static release includes
its page, form definitions and assets. Its receiver configuration has a private
`guestbook` object containing the center HTTPS `origin` and this site's `token`.
The receiver polls approved messages once per minute, atomically writes
`PUBLIC_ROOT/services/guestbook/messages.json`, and keeps the last valid copy if
the center fails. The public site's exact GET `/guestbook/api/messages` route
serves that file. This directory survives page release changes.

Proxy only the session GET and message POST routes to
`CENTER/api/rssd/public/v1/guestbooks/SITE/session|messages`. Set (overwrite,
never pass through visitor values) `X-RSSD-Site-Token` and `X-RSSD-Client-IP`
using the site's credential and Nginx's trusted client address. Preserve the
browser's Origin, Cookie and X-Guestbook-CSRF headers. Verify upstream TLS and
restrict the request body to 16 KiB. A forwarded client IP without the scoped
site token is rejected. No center credential enters JavaScript or public files.

Keep anonymous cookies as `__Host-today-guest-SITE`, HttpOnly, Secure,
SameSite=Strict, path `/`. Their HMAC and per-site timezone are unchanged. The
center serializes submissions by site and visitor; retrying the original key
does not consume another quota. Moderation does not refund the daily quota.

The guestbook PostgreSQL tables are included in center database backups. Public
replicas are recoverable outputs. Public-site administration URLs should redirect
to the center after cutover; do not leave the old moderation writer active.
