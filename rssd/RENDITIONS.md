# Card renditions

The workspace editorial API advertises `card-renditions-v1`. Every workspace uses the same schema and authenticated endpoints.

## Source identity

A rendition belongs to an existing `workId`, language, immutable edition revision and edition hash. `source.hash` records the producer's rendering-input fingerprint. `variant` identifies the production method. The rendition ID hashes the normalized manifest, including engine version, page order, cover and media references. Repeating a save returns the same ID.

Article categories remain attached through the work's section and edition record kind. Existing editions can acquire renditions through the same API. A newer edition makes the earlier rendition's listing report `current: false`. Historical outputs remain readable through their immutable IDs.

## Storage

- `raster` pages contain `{mediaId}`. Producers convert model-generated pixels to WebP before upload.
- `layout` pages contain `{html}`, with shared `css` and explicit `mediaIds`. These strings are inert stored export data. A future viewer must render them in a sandbox. Data URLs are rejected. Image references use authenticated `/api/rssd/v1/media/<id>/raw` URLs.
- `coverMediaId` references a separate small image. The producer uses a maximum 360 × 480 WebP cover.
- Images use the existing content-addressed media store. Physical blobs are deduplicated within an organization. Workspace-specific media IDs preserve authorization boundaries.
- PostgreSQL stores the recipe as JSONB with its normal TOAST compression. `rssd_rendition_media` records all page, cover and layout dependencies with foreign keys. Reference accounting must include this table before future media cleanup.
- A manifest is limited to 2 MiB, 500 pages and 8192 pixels per dimension. A layout page is limited to 200,000 characters and shared CSS to 100,000 characters. Images retain the existing media upload limits.

## API

All paths below are relative to `/api/rssd/v1/editorial/<workspaceId>`.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/renditions` | Save an immutable manifest after uploading its media |
| GET | `/renditions/<id>` | Read a complete manifest |
| GET | `/renditions?locale=en&limit=40&after=<id>&workId=<id>` | Read metadata and covers with keyset pagination |

`workId` and `after` are optional. The default locale is `zh-CN` and the maximum page size is 100. Lists include all stored variants and revisions. `next` is the next cursor or null. Pagination traverses the current immutable set in ID order. Refresh from the start to discover concurrent insertions whose IDs precede the cursor.

List queries read summaries and source revision metadata. Full page recipes and image bytes are loaded through detail and media endpoints. Workspace/locale and workspace/locale/work indexes support both list paths.

```json
{
  "schemaVersion": 1,
  "format": "cards",
  "workspaceId": "research",
  "workId": "example-work",
  "locale": "en",
  "source": {"revision": 1, "editionHash": "<64 lowercase hex characters>", "hash": "<render input SHA-256>"},
  "variant": "model",
  "engine": {"name": "example", "version": "1"},
  "width": 1080,
  "height": 1440,
  "coverMediaId": "<uploaded media ID>",
  "representation": "raster",
  "pages": [{"mediaId": "<uploaded media ID>"}]
}
```

The save transaction validates workspace access, migration state, worker revocation, exact source revision/hash and every referenced media ID. A failed save can leave uploaded blobs available for a retry. Resubmit the identical manifest after an uncertain response, or look up its content-addressed ID. The manifest and dependency rows commit together.

Schema initialization creates additive tables and indexes. The existing database backup includes these tables and the existing media backup includes the referenced blobs. Production rollout and importing existing local exports follow the owner's release authorization.
