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

`protocol.cjs` is a versioned MIT protocol dependency from the RSSD core repository;
`protocol.source.json` records its source fingerprint. Core maintains its source.

## Verification

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
The existing Postiz social publishing service continues independently; demand-pool
adapters for social networks and Discourse are not implemented in this checkpoint.

Publication intents are distinct from published receipts. Until destination
dispatch and verified readback are configured, a queued intent is not a public
publication. Migration and browser-export work remain separate delivery gates.

## Legacy cutover

`node rssd/migration-cli.cjs import ORGANIZATION PRIVATE-DIRECTORY` imports a
verified final legacy bundle without publishing it. Staged workspaces expose
`writable: false` and cannot create/claim demands or accept submissions. Lists
support bounded `limit` and `offset`; work search covers the latest full text.

After the original writer is disabled, in-flight publication is drained and every
pending manuscript has a recorded destination, run
`node rssd/migration-cli.cjs activate ORGANIZATION SITE PRIVATE-EVIDENCE.json`.
The private operator receipt must contain `receiptId`, `oldWriterDisabled: true`,
`inFlightCount: 0`, `pendingWorkReconciled: true`, `receiverRelease`,
`rollbackReference`, and the final `sourceDatabaseSha256`, `editionIndexSha256`,
`baselineSha256`. Activation checks these against the imported database and
preserves the evidence hash. Repeating the same activation is safe; changing its
evidence or importing over an active workspace is rejected. This operator receipt
records external cutover checks; it does not itself disable an old server.

Activation does not enable the dispatcher or broaden destination policies.
During isolated restoration also set `RSSD_POSTIZ_ORCHESTRATOR_ENABLED=0` and
isolate network access. Real authorization data must never be used by a test
publisher. Keep the normal Postiz orchestrator enabled in production.
