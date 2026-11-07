# storeOnlyTranslate contract v1

Machine-verifiable center pack for **one existing work, English stored in the center only**.
This file is the companion-facing protocol. Do not guess fields from older
`translateContinuation` servers. Do not treat `publicationScheduling=false`,
MCP tool names, or client `publish:false` as this pack.

Probe: `GET /api/rssd/v1/coordination/overview` or MCP `rssd_overview`.
Fail closed unless `supportsStoreOnlyTranslate(overview)` is true:

- `contracts.storeOnlyTranslate` is an object
- `version` is an integer `>= 1`
- `guarantees` is an array that includes every token below

`translateContinuation` remaining present is **not** sufficient. A 3dd7fb25
center advertises continuation safety and still enqueues publications on
default submit when section policy has `en` targets.

## Name, version, guarantees

```
contracts.storeOnlyTranslate = {
  version: 1,
  guarantees: [
    "storeOnlyFrozen",
    "zeroPublications",
    "exclusiveWorkerClaim",
    "intentRequired",
    "noClaimSteal",
    "leaseRecovery",
    "englishOnly",
    "sourceBind",
    "receipt",
    "receiptIsolation",
    "openWorkFence"
  ]
}
```

| Token | Meaning |
| --- | --- |
| `storeOnlyFrozen` | `storeOnly` and `storeOnlyWorkerId` are written at create and cannot be added, cleared, or retargeted by edit, claim, or submit |
| `zeroPublications` | Store-only submit never inserts `rssd_publications`, never schedules, never starts site/Discourse/Postiz dispatch, even when `policy.targets` includes `en` and `RSSD_DISPATCH_ENABLED=1` |
| `exclusiveWorkerClaim` | Only the creating device (`payload.storeOnlyWorkerId`) can claim |
| `intentRequired` | Claimers that omit `storeOnly:true` cannot take the row. Generic `rssd_claim` / `POST /claims` skips store-only demands. Targeting the id without the flag is `store_only_required` |
| `noClaimSteal` | An active lease cannot be taken. Wrong device is `forbidden` or `claim_conflict` |
| `leaseRecovery` | After TTL expiry the creating device re-claims with `storeOnly:true`. The expired `claimToken` cannot submit (`claim_revoked`) |
| `englishOnly` | Required locale is `en` only. Submit cannot rewrite `zh-CN` |
| `sourceBind` | Create binds current `zh-CN` revision + hash + current head. Later Chinese movement is `source_conflict` on submit; a second open translate is `open_translate_conflict` |
| `receipt` | `requestId` replay returns the original result. Store-only fingerprint ignores the HTTP publish flag |
| `receiptIsolation` | Store-only replay and `rssd_receipt` are only for the creating device (or Owner). Other devices get `404 not_found` and never another device's result, including `request_conflict` bodies |
| `openWorkFence` | While a store-only demand is queued/claimed/blocked for a work, other `/submissions`, `/drafts`, and editorial writes to that work are `409 store_only_conflict` |

This is **not** a grant. Devices still have `publicationScheduling=false` by default.

## Atomic boundary

One demand = one existing work = one frozen store-only EN continuation.

1. Device creates with `storeOnly:true`
2. Same device claims with `storeOnly:true` (preferably `demandId`)
3. Same device submits EN edition on that claim
4. Center writes `rssd_editions` locale `en`, completes the demand, returns a receipt with `storeOnly:true` and `publicationIds:[]`

No other demand, locale, worker, publication, editorial action, or schedule is part of the atom.

Default write/translate/update without `storeOnly` is unchanged: claim pool, publish-on-submit, and policy targets still apply.

## Create

HTTP `POST /api/rssd/v1/demands` or MCP `rssd_create_demand`.

```
{
  "workspaceId": "<id>",
  "sectionId": "<id>",
  "kind": "translate",
  "title": "<text>",
  "brief": "<optional>",
  "requiredLocales": ["en"],
  "source": {"workId": "<id>", "locale": "zh-CN", "revision": <int>=1},
  "storeOnly": true,
  "id": "<optional stable id>",
  "priority": 0
}
```

Requires a device credential (`ctx.workerId`). Owner session create is `403 forbidden`.
`kind` must be `translate`. Source locale must be `zh-CN`. After stripping the
source locale, `requiredLocales` must be exactly `["en"]`.

Frozen payload fields: `storeOnly: true`, `storeOnlyWorkerId: <creating worker>`,
`source`, `sourceHash`, `requiredLocales`.

Results: `status: created | existing | skipped` (`locale_present`).
Same creating device + same bind + same `storeOnly:true` → `existing`.
`storeOnly:false`, omitted `storeOnly`, or another device against an open store-only bind → `409 open_translate_conflict` (never `existing` of the other intent).
Reusing a demand `id` that already belongs to the other intent is `409 identity_conflict` or `409 open_translate_conflict`; it is never `existing`.

Errors: `store_only_unsupported`, `forbidden`, `source_conflict`,
`open_translate_conflict`, `identity_conflict`, `not_found`.

Omit `storeOnly` (or send `false`) for the **default** translate that may publish.
`storeOnly` that is not a boolean is `400 invalid_request`.

Edits cannot set or clear `storeOnly` / `storeOnlyWorkerId` (`409 identity_conflict`).
Title/brief/priority/dueAt remain editable while queued.

## Claim

HTTP `POST /api/rssd/v1/claims` or MCP `rssd_claim`.

```
{ "demandId": "<id>", "storeOnly": true }
```

`workspaceIds` / `sectionIds` remain optional filters as today.

| Caller | Store-only row | Result |
| --- | --- | --- |
| Old/default consumer, no `storeOnly` | highest-priority queued | **skipped**; next non-store-only demand or `null` |
| Old/default consumer, `demandId` of store-only, field omitted | targeted | `403 store_only_required` |
| Creating device, `storeOnly:true` | queued, owned | claimed; policy/destinations frozen on payload as today |
| Other device, `storeOnly:true` | that row | `403 forbidden` |
| `storeOnly:true` against a normal demand | targeted | `409 not_store_only` |
| Active lease, any other device | claimed | `409 claim_conflict` (or `forbidden` if store-only ownership fails first) |
| Same device already holding a claim | — | `409 worker_busy` |

`protocol.cjs` is unchanged. `storeOnly` is a center field beside the MIT demand/submission shapes.

## Submit and receipt

HTTP `POST /api/rssd/v1/submissions` (default `publish:true`) or MCP `rssd_submit`
`{ packet }`. Store-only **ignores** the HTTP publish flag. `POST /drafts` of a
store-only claimed demand still completes the demand and still writes zero
publications. Receipt fingerprint is `{storeOnly:true, packet}` so drafts vs
submissions of the same packet replay.

Packet (MIT `submission`):

```
{
  "requestId": "<id>",
  "workId": "<source work id>",
  "workspaceId": "<id>",
  "sectionId": "<id>",
  "demandId": "<claim id>",
  "claimToken": "<lease token>",
  "baseRevisions": { "en": 0 },
  "editions": [{
    "locale": "en",
    "title": "<text>",
    "bodyMarkdown": "<text>",
    "translationOf": {"workId": "<same>", "locale": "zh-CN", "revision": <bound revision>}
  }]
}
```

Receipt:

```
{
  "requestId": "<id>",
  "workId": "<id>",
  "workspaceId": "<id>",
  "status": "accepted",
  "editions": [{"locale": "en", "revision": <int>, "hash": "<hex>"}],
  "publicationIds": [],
  "storeOnly": true,
  "storeOnlyWorkerId": "<creating worker>",
  "demandState": "completed"
}
```

`POST /drafts` and `POST /submissions` of the **same** store-only packet share one fingerprint and both complete the demand (`status: accepted`, never `draft_saved`). Ordinary `/drafts` still save without publications and do **not** complete a normal demand.

Chinese `revision` / `hash` / current head are unchanged. `publicationIds` is
always `[]`. No calendar schedule row is created. Publisher `tick` has nothing
to drain for this submit.

Same `requestId` + same packet → original receipt. Changed packet → `409 request_conflict`.
Query `GET /api/rssd/v1/submissions/:requestId` or MCP `rssd_receipt`.

Submit errors (unchanged codes where applicable): `claim_revoked`, `source_conflict`,
`revision_conflict`, `forbidden`, `store_only_conflict`.
A mismatched `requestId` replay by another device is `404 not_found`, not the original result.

## Recovery

- Lost submit: keep `requestId`, query receipt, retry the **same** packet.
- Lost claim: `rssd_current_claim` / `GET /claims/current`.
- Expired lease: creating device claims again with `storeOnly:true`. Old token cannot submit.
- Release: creating device `rssd_release` / `PATCH` `{action:release, claimToken}`; row returns to queued, still store-only, still bound to that worker.
- Do not enqueue a second open translate after Chinese moves; wait for expiry, release, or completion.

## Compatibility boundary

| Surface | Store-only | Default (omit storeOnly) |
| --- | --- | --- |
| Create translate | device + `storeOnly:true` | owner or device, may publish |
| Generic claim | cannot see the row | unchanged |
| Submit with en policy targets | zero `rssd_publications` | inserts intents as today |
| Dispatch enabled | still zero intents, nothing to send | drains queued intents as today |
| `translateContinuation` | still advertised | still advertised |
| `protocol.cjs` | not modified | not modified |

Companions that cannot read `contracts.storeOnlyTranslate` v1 **must not**
create, claim, or submit a store-only demand. They must not fall back to
default translate submit.

## Out of scope

Batch translation, outbound/social grants, scheduling grants, owner pairing,
policy/destination edits, production enqueue from this document, and rssd-private.
