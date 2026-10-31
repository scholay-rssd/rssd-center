# Forum discussion mapping

The existing six-site Discourse mapping engine moves into the center. It retains
its signed webhook, author allowlist, explicit source footer, topic identity,
event deduplication and deletion/recovery behavior. It derives from the MIT core
at `c2f9cee`; the only matching change is that published center receipt URLs
replace a local website-file existence check. A missing newly published source
returns a retryable response without consuming its event identity.

Set `RSSD_COMMUNITY_CONFIG` to a private 0600 JSON file containing `orgId`, an
absolute `root`, and `secretFile`. Migrate the entire original `links.sqlite`
with an online SQLite backup, plus its original `config.json` and webhook secret.
The source configuration keeps its existing site and author allowlists. Preserve
all rows, including inactive links and processed events. The center refuses to
initialize this service from a missing ledger.

Keep the original webhook URL on the public website. After pausing the old
webhook writer and verifying its final database copy, proxy that exact URL to
`CENTER/api/rssd/public/v1/community/discourse`. Preserve raw request bytes and
the four `X-Discourse-*` headers. The center verifies the original signature and
limits the raw body to 512 KiB. Do not keep two writable copies of the ledger.
Stage the affected sites' published identities before switching this endpoint.

The public `/api/rssd/public/v1/community/sites/SITE` response contains only the
versioned route-to-topic map. Configure each site's receiver with
`community: {"origin":"https://center.example.org"}`. It refreshes a validated
replica once per minute under `PUBLIC_ROOT/services/community/links.json` and
keeps the old file on failure. Point the existing `/community/links.json` route
to this file; retain the existing discussion-link browser script and article
URLs. No article rebuild or AI call is needed for a forum link change.

Use a separate `sqlite` entry for this ledger in encrypted backup configuration.
Archive its configuration and signing secret through the protected file allowlist.
Restoration must retain processed event IDs and inactive mappings before webhook
intake resumes. This migration does not itself alter RSS polling rules, create
forum topics, or enable a new forum publication destination.
