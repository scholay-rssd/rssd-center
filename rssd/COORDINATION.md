# Coordination contract v1

All endpoints extend `/api/rssd/v1`; original v1 and Postiz APIs remain compatible. Device requests use existing workspace-scoped credentials. Goal writes require the existing owner browser session. Scheduling writes require that session, or an Owner-granted device capability whose workspace and destination both match the publication. Credentials never enter URLs, frontend persistence or model prompts. Devices cannot self-authorize and never receive `admin=true`.

| Endpoint | Contract |
| --- | --- |
| GET /coordination/overview | contractVersion, workspaces, demand counts, distinct work counts, goals, capabilities, contracts, original Postiz paths. `contracts.translateContinuation` is a read-only server safety contract (`version` integer plus `guarantees`); it is not a permission grant. `contracts.storeOnlyTranslate` is a separate read-only pack for center-only English continuation with zero publication tasks; missing or old keys mean the center does not implement that pack and companions must fail closed. Presence of `rssd_create_demand` or `publicationScheduling=false` is not sufficient |
| GET /coordination/channels | Scoped destinations and provider status; no secret configuration |
| GET /coordination/calendar | from/to ISO instants (up to 367 days), limit 1–200, offset; items/hasNext/total/range |
| PATCH /demands/:id/definition | requestId, baseGeneration, changes; queued only; increments generation |
| GET /goals | Goal definitions, current local calendar period, completed/pending/published counts and maintenance status |
| POST /goals | id, requestId, baseRevision, goal; owner only |
| POST /demands | kind write/translate/update; translate binds source workId+locale+revision and the current edition hash, skips when the target locale already exists, and reuses one open demand when that bind still matches. A second open translate for the same work after the Chinese head moves is `open_translate_conflict`; the original source bind is not rewritten. `storeOnly:true` is a frozen device-owned English-only center store intent; see `rssd/STORE-ONLY-TRANSLATE.md` |
| POST /publications/:id/schedule | requestId, expectedUpdatedAt, scheduledAt; owner or an unrevoked publicationScheduling grant covering that workspace and destination; unstarted queued RSSD intents only |
| POST /workers/:id/grants | requestId, operation=publicationScheduling, workspaceIds, destinationIds; owner only; cannot exceed the device workspace scope |
| POST /workers/:id/grants/:grantId/revoke | requestId; owner only |

`workspaceId` or comma-separated `workspaceIds` narrows the authenticated scope. Calendar items retain source, publicationId, workId, locale, revision, destination, state, scheduledAt, hasSchedule, updatedAt, receipt and error. A fallback creation timestamp is not an explicit schedule. Native Postiz posts remain in their original publisher; root posts are counted once and RSSD-linked posts are deduplicated. Devices only see channels mapped to their workspaces; unmapped native channels are owner-only in the all-workspaces view.

Demand edits accept title, brief, priority, requiredLocales and dueAt. Workspace, section, kind and source remain fixed. Claimed rules are frozen. Original request replay returns the original result; changed payloads conflict. Goal definitions contain workspaceId, sectionId, title, brief, target (0–1000), period (day/week/month), IANA timezone, requiredLocales and enabled. Scope is immutable. New goals default to paused. Native Postiz schedules continue through `/launches`; changing an RSSD schedule never creates a replacement post.

Errors retain HTTP status and code: forbidden, not_found, revision_conflict, request_conflict, demand_frozen, migration_staged, publication_started, source_conflict, open_translate_conflict. Clients retain original request IDs after timeout. No synthetic-data fallback is allowed.

## Persistent maintenance

`RSSD_GOAL_MAINTENANCE_ENABLED=1` enables a once-per-minute loop for explicitly enabled goals in writable workspaces. Each goal is transactionally locked; concurrent instances cannot duplicate the deficit. A run adds at most 20 queued demands tied to the goal revision and local calendar period. Distinct completed work IDs and active demands cover the goal; languages and destinations do not inflate completion.

This is deterministic goal maintenance, not an LLM choosing topics. Owners supply the editorial direction. Status and refill reasons are recorded. Maintenance does not claim, write or publish. Goal edits preserve existing claims; pausing prevents refills without silently cancelling work.

## MCP

`POST /api/rssd/v1/mcp` provides stateless JSON responses; GET returns 405. It supports the pinned SDK's 2025-03-26, 2025-06-18 and 2025-11-25 versions and follows the [official transport specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx). Supplied origins are validated, and every call reuses HTTP authentication.

Tools cover overview, goals, demands, works, calendar, channels, original receipts, demand edits and demand creation. Devices also get their own claim/release/submit tools. Owners get goal management and can grant or revoke a minimal `publicationScheduling` capability. `rssd_schedule_publication` is listed only after an unrevoked grant; HTTP `POST /publications/:id/schedule` is always present. Both writes, including a crafted MCP `tools/call`, authorize workspace+destination+operation in `authorizeSchedule` and return 403 when missing, out of scope, or revoked. Probe English continuation safety through `rssd_overview` / `GET /coordination/overview` `contracts.translateContinuation`, not tool names or descriptions. Probe center-only English store (zero publication tasks, exclusive creating-device claim) through `contracts.storeOnlyTranslate`; companions must fail closed when that pack is missing. `storeOnly` is enforced on create/claim/submit, not by client `publish:false`. Tools delegate to the existing business services. Audit records contain actor, tool and argument hash. Postiz native MCP, OAuth and agent routes remain unchanged.

## Desktop division

Windows owns local-agent conversation and execution display. Center provides business tools and permissions; local conversation integration is not claimed by this change. Mac includes the confirmed Windows layout, connects real responses, preserves its editor and offline outbox, and opens owner management in the system browser. The isolated QA preview remains synthetic and labeled.
