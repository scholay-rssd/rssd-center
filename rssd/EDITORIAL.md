# Existing manuscript editor

The authenticated `/api/rssd/v1/editorial/:workspaceId` bridge retains the
desktop/CLI editor protocol while storing editions and publication state at
the center. Device authorization is checked against the selected workspace.
No bridge request falls back to the legacy site writer.

Append the existing operation path:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/site` | Site/workspace identity and the original site origin |
| GET | `/catalog`, `/index` | Complete versioned, paginated read models |
| GET | `/:id`, `/cloud/:id`, `/published/:id` | Stable article identity, current and public revisions |
| POST | `/drafts`, `/publish` | Exact-base save or publication using the original `requestKey` |
| GET | `/requests/:key`, `/drafts/requests/:key` | Recovery of original center or migrated requests |
| POST | `/requests/:key/retry` | Explicit retry of the original website job |
| POST / GET | `/source-archives`, `/source-archives/:sha256` | Private original archives with byte-level readback |
| GET | `/source-archives/private-notes/:id` | Bounded private author-note lookup |
| POST / GET | `/actions`, `/actions/:key` | Confirmed publish, withdraw, soft-delete or restore |
| POST | `/actions/:key/retry` | Explicit retry with `confirmed:true` and the original `jobId` |

Responses include `centerManaged:true`. Clients suppress their former local
translation/distribution continuations and asynchronous legacy publish queue.
Draft acceptance is distinct from successful website publication. A website
job succeeds independently of other destinations, after the receiver receipt
and unauthenticated published content agree.

Submission envelopes retain `data`, `expectedVersion`,
`expectedPublishedVersion` and `requestKey`; `data.sectionId` is required.
The response keeps site-relative `url` values. Catalog URLs are absolute.
Migrated request keys can be queried without creating a new request. A POST
that reuses a migrated key is rejected and instructs the client to recover
its preserved receipt. Versions and tombstones are never discarded.

Visibility actions run only when `RSSD_DISPATCH_ENABLED=1`. Their confirmed
content revision, published revision and center visibility generation stay
frozen across failures; an old blocked action cannot capture a newer revision
when retried. Their original
receiver packet is durably frozen before the first POST. Retries first query
the same request. Sequence and revision checks prevent a stale result from
overwriting a newer action. Withdraw/delete complete only after the public
tombstone matches and the article route returns 404 or 410. A never-published
draft can be soft-deleted and restored locally without making it public.

The center blocks new edition writes during an outstanding website action.
Withdrawn editions can still save drafts; automatic publication requires an
explicit restore. Deleted editions retain all revisions and archives and
must be explicitly restored before editing. Restore retains the visibility
that existed before deletion. It restores the previous approved public
revision without approving a newer private draft. A previously withdrawn or
never-published manuscript recovers privately and needs a separate explicit
publish action. A restored existing edition retains its identity and does not
create a new revision unless its content was edited. Historical publication receipts remain attached when a later
visibility action succeeds.

Archive uploads retain the prior 48 MiB decoded limit and 1,500-file limit.
The bridge JSON parser accepts 68 MiB for their base64 envelopes. Archives
are workspace-scoped and excluded from public publication payloads.
