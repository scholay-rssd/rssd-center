# Card sets

The private editorial API supports card sets in every workspace with the existing workspace authorization. Card sets reference an existing work, language and immutable edition revision. This includes structured record works. Registration leaves the article's edition intact.

Routes under `/api/rssd/v1/editorial/:workspaceId/renditions`

- POST registers a complete set.
- GET lists summaries with `limit` from 1 to 100 and an opaque `after` ID cursor.
- GET /:id returns ordered page IDs.

The POST body has `workId`, `locale`, `revision`, `sourceHash`, `method`, `title`, `cover` and `pages`. Methods are algorithm, intelligent and image. `sourceHash` is the stored Center edition hash. Cover and page IDs reference previously uploaded WebP media in the same workspace. Covers may be small dedicated thumbnails.

The server derives the section from the work, verifies revision and hash, and assigns a content-derived set ID. Identical retries return the same set. Different sets remain available for comparison. A set's pages preserve their supplied order. Source edits produce a newer edition and cause the old summary's `current` flag to become false.

The additive schema has a workspace cursor index and a source revision index. Summary queries omit page arrays and image bytes. Counts and bytes are serializable JSON numbers. Registration includes the cover when accounting for distinct referenced bytes.

Deploy the schema and runtime together. Existing assets need a separate import using the source binding from the edition that generated them. Production migration, a gallery UI, editable rendering recipes and reference-aware garbage collection are follow-up integration work.
