# RSSD Center

RSSD extends the pinned Postiz v2.25.1 product with a multilingual work library,
workspace-scoped demand pool, device credentials, immutable revisions and durable
publication intents. It retains Postiz authentication and integrations. This is an
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
language submissions, frozen policies, organization isolation and rollback.

Publication intents are distinct from published receipts. Until destination
dispatch and verified readback are configured, a queued intent is not a public
publication. Migration and browser-export work remain separate delivery gates.
