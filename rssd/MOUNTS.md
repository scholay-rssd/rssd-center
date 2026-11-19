# The mount library and persona voices

The mount library holds what a writer is handed for one work besides the section's rules. An item has a kind, an ID and revisions; a revision is content with a hash and is never changed once stored. The Center decides which items a work uses when its demand is claimed, freezes the decision with the claim, and gives the claiming device the content of exactly those items.

The first kind is `persona`: a preset person of a persona library kept outside this repository, stored as that library's own writing snapshot (`12monkey.content-persona-snapshot.v1`). The design is `docs/persona-voice.md` in the rssd repository. `persona-voice.mjs` is an unchanged copy of `contracts/persona-voice.mjs` there and decides which persona writes a work.

All endpoints extend `/api/rssd/v1`.

| Endpoint | Who | Contract |
| --- | --- | --- |
| GET /mounts/personas | owner | One row per persona: `id`, newest `revision`, `revisions`, `snapshotHash`, `founder {id,name}`, `summary`, `active`. No content |
| POST /mounts/personas | owner | `personas`: up to 30 of `{snapshot, founderName}`. Each is reported as `created` or `existing`. A stored revision with other content, or another founder name, is refused with `mount_conflict` |
| POST /mounts/personas/:id/retire | owner | `retired` (default true). A retired persona is not picked for new works |
| POST /claims/voice | the claiming device | `demandId`, `claimToken`, and either `personaId` with a one-sentence `reason`, or neither to decline. Returns `{demandId, voiceDecision, mounts?}` |

The same four are MCP tools: `rssd_personas`, `rssd_save_personas`, `rssd_retire_persona` for the owner and `rssd_choose_voice` for a device.

## What a section and an order say

A section's policy may state a `voice` instead of the earlier `persona` byline:

- `mode`: `fixed` names one `persona`; `choose` lets the writer pick; `random` and `balanced` let the Center draw.
- `range` (every mode but `fixed`): `"all"` or a list of persona IDs. `fallback`: a persona for when nothing in the range can be used.
- `byline`: `persona` (the founder the preset was tuned from signs) or `site` (the site signs, and the persona stays private).

A write demand may state `voice`: `{persona: id}` to name one, or `"none"`. The named persona must be in the library and not retired (`unknown_persona`). A note rewritten from an article cannot state one.

## What a claim freezes

When a demand is claimed, `payload.voiceDecision` is set in this order:

1. A translation, an update or a note rewritten from an article keeps the voice its source edition recorded, at the revision that wrote it, even if that persona has since been retired. A source without a voice gives none.
2. The order: the persona it names, or none.
3. The section's mode. `random` and `balanced` are seeded by the demand's ID, so a retried claim decides the same; `balanced` prefers the persona this section used least in the last 30 days.
4. When that yields no usable persona, the section's fallback, else none.

The decision is `{state:"none"}`, or `{state:"chosen", method, persona {id,revision,snapshotHash,founder}, byline}`, or for `choose` with more than one candidate `{state:"pending", candidates, byline, fallback}` with at most five candidates, each a reference and a short summary.

A claim where neither the section, the order nor a source says anything about voices has no `voiceDecision` and is exactly as before.

The claiming device receives the chosen persona's snapshot as `mounts.voice` on the claim (`POST /claims`, `GET /claims/current`). The snapshot is not stored on the demand, so listing demands never shows it. A pending decision carries no snapshot until the writer answers through `POST /claims/voice`; asking again returns the settled answer.

## What a submission must carry

For a new work under a claim with a `voiceDecision`, every edition is checked:

- chosen: `metadata.voice` is `{id, revision, snapshotHash}` of the frozen persona (`voice_conflict` otherwise).
- chosen with `byline: persona`: `metadata.author` is the founder's name and `metadata.persona.id` the founder's ID (`byline_conflict`).
- chosen with `byline: site`: no `metadata.persona`.
- none: neither `metadata.voice` nor `metadata.persona`.

A decision still pending at submission lapses to the fallback or to none, and that is recorded on the demand. Translations and updates are not checked; they keep what their source carried.

`metadata.voice` and `metadata.persona` are private. The public packet carries only `author`.

A section that still uses the earlier `persona` byline, and has no `voiceDecision` on the claim, is checked as before.

Not here yet: editing a section's voice in the owner interface (it is set through `POST /workspaces`), ranges and candidate ranking by persona tags, and other kinds of mount.
