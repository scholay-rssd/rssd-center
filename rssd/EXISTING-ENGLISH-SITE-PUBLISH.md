# existingEnglishSitePublish contract v1

Machine-verifiable center pack for **one already stored English revision → the
workspace website only**. This is not store-only translate and not default
submit. Do not infer it from `publicationIds:[]`, `publicationScheduling=false`,
MCP tool names, editorial `/publish`, `/actions`, or `POST /publications/:id/retry`.

Probe: `GET /api/rssd/v1/coordination/overview` or MCP `rssd_overview`.
Fail closed unless `supportsExistingEnglishSitePublish(overview)` is true:

- `contracts.existingEnglishSitePublish` is an object
- `version` is an integer `>= 1`
- `guarantees` is an array that includes every token below

`storeOnlyTranslate` remaining present is **not** sufficient. Store-only success
still writes English with zero publications.

## Name, version, guarantees

```
contracts.existingEnglishSitePublish = {
  version: 1,
  guarantees: [
    "canonicalSiteOnly",
    "englishOnly",
    "existingRevision",
    "hashBind",
    "localeIdentity",
    "noEditionRewrite",
    "zeroExternalTasks",
    "idempotentReceipt",
    "openWorkFence"
  ]
}
```

| Token | Meaning |
| --- | --- |
| `canonicalSiteOnly` | Server accepts only `destinationId === "site-" + workspace.siteId` with `kind=site` (enter → `site-enter`). Other site, postiz, and discourse ids are `409 unsupported_destination` |
| `englishOnly` | `locale` must be `en`. `zh-CN` is `409 english_only` |
| `existingRevision` | Binds `workId` + `locale=en` + `revision` already in `rssd_editions`. Missing revision is `404 not_found` |
| `hashBind` | Required 64-character SHA-256 of that edition. Mismatch is `409 source_conflict` |
| `localeIdentity` | Optional `articleId` is matched against the **English** revision. zh/en sharing one articleId still selects EN via `locale`. Wrong identity is `409 identity_conflict` |
| `noEditionRewrite` | The call never inserts or updates `rssd_editions` |
| `zeroExternalTasks` | At most one `rssd_publications` row for that EN revision and the canonical website. Policy targets, extra sites, postiz, discourse, and `RSSD_DISPATCH_ENABLED=1` cannot create other destination rows or native Postiz posts |
| `idempotentReceipt` | Same `requestId` replays the original public receipt. A second `requestId` for the same tuple returns `status=existing` without a second publication. Concurrent callers cannot duplicate the unique `(workId,en,revision,destinationId)` |
| `openWorkFence` | An open store-only translate for the work is `409 store_only_conflict`, same as other side-channel writes |

This is **not** a scheduling grant. Devices keep `publicationScheduling=false`.

## HTTP

`POST /api/rssd/v1/site-publications`

```
{
  "requestId": "<stable id>",
  "workId": "<id>",
  "locale": "en",
  "revision": 1,
  "hash": "<64 hex>",
  "destinationId": "site-enter",
  "articleId": "<optional English manuscript id>"
}
```

Unknown fields are `400 invalid_request`. `destinationId` is required and must
equal the canonical website of **that work's workspace**, not a caller-chosen
subset of `policy.targets`.

`GET /api/rssd/v1/site-publications/:requestId` recovers the same receipt.

Permission: workspace-scoped device Bearer or Owner session. No extra capability.

## MCP

`rssd_publish_existing_english_site` and `rssd_existing_english_site_receipt`.
Companions must still fail closed when the overview pack is missing. Extra
arguments are `-32602`.

## Public receipt whitelist

```
{
  "requestId": "...",
  "status": "created" | "existing",
  "workId": "...",
  "workspaceId": "...",
  "locale": "en",
  "revision": 1,
  "hash": "...",
  "destinationId": "site-enter",
  "destinationKind": "site",
  "publicationId": "...",
  "publicationState": "queued",
  "articleId": "..."
}
```

No edition body, notes, archives, destination config, or credentials. Replay
refreshes `publicationState` from the original publication id and does not
retry or requeue it.

## App companion (frozen)

After store-only completes (`publicationIds:[]`, EN revision N, hash H):

1. Probe `contracts.existingEnglishSitePublish` v1. If missing, stop.
2. Read `GET /works/:id` (or `rssd_work`) for `editions` where `locale=en`.
3. `POST /site-publications` with that revision, hash, and
   `destinationId=site-{workspace.siteId}` (`site-enter` on enter).
4. Recover with the same `requestId`. Do **not** `POST /submissions`,
   `/drafts`, editorial `/publish`, `/actions`, or `/publications/:id/retry`.

CLI, if added later, should be a thin wrapper of this POST. This center PR
does not change the application repository.

## Out of scope

Store-only create/claim/submit, policy edits, grants, pairing, retry of a
blocked publication, social/forum dispatch, rewriting English, production
enqueue from this document.
