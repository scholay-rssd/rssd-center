# RSSD Center

RSSD extends the pinned Postiz v2.25.1 product with a multilingual work library,
workspace-scoped demand pool, device credentials, immutable revisions and durable
publication intents and verified site delivery. It retains Postiz authentication and integrations. This is an
AGPL-3.0 derivative; see the repository LICENSE and upstream notices.

The owner interface is `/rssd`. The backend routes are `/rssd/v1`; the existing
reverse proxy exposes these as `/api/rssd/v1`. Browser requests use the existing
Postiz session and organization. Devices use separately generated, revocable
`Bearer` credentials scoped to selected workspaces. Device tokens are displayed
once and stored as SHA-256 fingerprints on the server.

`schema.sql` is an additive migration only. Its tables are also represented in
the main Prisma schema so the existing Postiz startup procedure cannot treat
them as unknown tables. Back up the existing database before applying changes.
Do not use schema reset or accept-data-loss to deploy this change.

For a new self-hosted installation only, set `RSSD_INITIALIZE_EMPTY_DATABASE=1`.
CI generates the initial schema from the pinned Prisma model and packages it in
the image. Startup uses that SQL without downloading a Prisma engine. Initialization
refuses a partially populated database; an existing Postiz database receives only
the additive RSSD migration. The first-install flag does not reset existing data.

`protocol.cjs` is a versioned MIT protocol dependency from the RSSD core repository;
`protocol.source.json` records its source fingerprint. Core maintains its source.

## Verification

Writing defaults are a public text/data bundle compiled from the core GitHub
repository. Publish a validated catalog before starting new writing claims:
`node rssd/writing-defaults.cjs publish catalog.json /config/rssd-writing-defaults/active.json`.
Set `RSSD_WRITING_DEFAULTS_FILE` for another path. Publishing retains immutable
hash-named versions and atomically switches the active file. No database migration
or organization data is involved. The GET-only `/rssd/public/v1/writing-defaults`
and `/:workspaceId/:sectionId` routes expose only that public catalog without a
device credential. New write claims freeze the full selected rules; resumed legacy
claims are preserved. New baseline-bound publications check the claimed baseline,
actual notebook image references and captions. Draft storage remains available.
The portable contract and fingerprint are maintained by core's
`scripts/sync-writing-defaults-contract.mjs`.

Use Node 22.19 and pnpm 10.6.1 with the committed lockfile. Run the backend build
and frontend TypeScript check. The build packages `rssd/*.cjs` alongside the Nest
output so deployment does not rely on a sibling private checkout.

The integration tests require a disposable PostgreSQL database whose name starts
with `rssd_` and contains `test`. Set `RSSD_TEST_DATABASE_URL`, or point
`RSSD_TEST_DATABASE_URL_FILE` at a private pg connection JSON file, then run:

```sh
node --test rssd/store.test.cjs
```

Tests use synthetic organizations, works and devices. They cover concurrent
claims, request replay, stale revisions, revoked claims/credentials, partial
language submissions, frozen policies, organization isolation, rollback, fenced
publisher leases, lost delivery responses and public content verification.

## Site publishing

Configure site destinations and workspace section policies in the owner interface.
Each destination has a separate receiver credential, encrypted with AES-256-GCM.
Set a persistent `RSSD_ENCRYPTION_KEY` of at least 32 characters (otherwise the
existing `JWT_SECRET` is used). Include that key in the encrypted recovery backup;
changing it without re-encrypting credentials makes existing destinations unusable.
Device APIs never return destination secrets.

The dispatcher starts only with `RSSD_DISPATCH_ENABLED=1`. Keep it off during
migration and restore until publication identities have been reconciled. It uses
the core receiver's `/api/rssd-receiver/v1/sites/:siteId/submissions` contract and
checks the original request before retrying uncertain delivery. Publication becomes
`published` only after the receiver activates a release and the corresponding
unauthenticated `rssd-content` file matches the submitted packet. Failed builds or
missing authorization become `blocked`; an owner can resume the original request.
Discourse destinations use the existing forum API key and username, an explicit
category, and a stable external topic identity. They retain a creation intent
before sending; an uncertain missing topic needs reconciliation instead of an
automatic second creation. Updates compare the previous accepted raw body before
changing the same first post. Public readback is checked without API credentials.
The contract follows the [Discourse API](https://docs.discourse.org/), including
external-ID lookup and original-text conflict checks. Tests use a synthetic forum.
The existing Postiz social publishing service continues independently; its
demand-pool adapter is still being integrated.

Publication intents are distinct from published receipts. Until destination
dispatch and verified readback are configured, a queued intent is not a public
publication. Migration and browser-export work remain separate delivery gates.

## Legacy cutover

`node rssd/migration-cli.cjs import ORGANIZATION PRIVATE-DIRECTORY` imports a
verified final legacy bundle without publishing it. Staged workspaces expose
`writable: false` and cannot create/claim demands or accept submissions. Lists
support bounded `limit` and `offset`; work search covers the latest full text.
Private editor branches use a separate staged-drafts API and do not grant
publication or production access. Their bases still require reconciliation with
the final legacy snapshot. An existing writable workspace with no migration row
requires a separately fenced bootstrap; a new workspace and fence are created
atomically. Import uses a renewable five-minute owner lease: concurrent attempts
are refused; an interrupted attempt can resume the same manifest after expiry.

After the original writer is disabled, in-flight publication is drained and every
pending manuscript has a recorded destination, run
`node rssd/migration-cli.cjs activate ORGANIZATION SITE PRIVATE-EVIDENCE.json`.
If private staged branches exist, first run `node rssd/migration-cli.cjs
reconcile ORGANIZATION SITE PRIVATE-EVIDENCE.json` repeatedly until its
`pending` count is zero. The first call freezes the evidence and branch-history
hash under a persistent `reconciling` fence; each later call commits at most
eight private promotions and can be retried after a crash. Ordinary writes stay
fenced until final activation verifies every promotion and the original import.
An incompatible final legacy snapshot returns `staged_reconcile_conflict`;
both the branch and snapshot must be retained for a deliberate human merge.
The operator must independently recheck the original writer's live fence,
queues and unchanged snapshot before every batch and final activation: the
evidence file and Center alone do not prove that external condition.
The private operator receipt must contain `receiptId`, `oldWriterDisabled: true`,
`inFlightCount: 0`, `pendingWorkReconciled: true`, `receiverRelease`,
`rollbackReference`, and the final `sourceDatabaseSha256`, `editionIndexSha256`,
`baselineSha256`. Activation checks these against the imported database and
preserves the evidence hash. Repeating the same activation is safe; changing its
evidence or importing over an active workspace is rejected. This operator receipt
records external cutover checks; it does not itself disable an old server.
The receipt ID must be `<runId>:<siteId>` with a valid run ID, and the receiver
release must use only letters, numbers, `.`, `_`, `:` and `-`, so that an
activated site can produce a valid scoped device proof.

Activation does not enable the dispatcher or broaden destination policies.
During isolated restoration also set `RSSD_POSTIZ_ORCHESTRATOR_ENABLED=0` and
isolate network access. Real authorization data must never be used by a test
publisher. Keep the normal Postiz orchestrator enabled in production.
