# Annotations

Answers to the annotation form about finished works, given by people and by models. They are kept in `rssd_annotations`, apart from works: annotating never creates a revision.

The form is `annotation-forms.json` with its rules in `annotation-forms.mjs`. Both are unchanged copies from `contracts/` in the rssd repository, with `work-types.mjs` and `writing-column-families.json`, which they read.

All endpoints extend `/api/rssd/v1` and use the existing owner session or workspace-scoped device credential.

| Endpoint | Contract |
| --- | --- |
| GET /annotations/form | The current form: version, sections, items |
| GET /annotations/target | `workId`, or `workspaceId` and `articleId`; `locale` (default zh-CN); optional `revision`. Returns `{formVersion, target, sections, mine}`: the revision to annotate, the sections that apply to it, and the caller's own newest answers for it, if any |
| POST /annotations | `workId` (or `workspaceId` and `articleId`), `locale`, optional `revision`, `formVersion`, `answers`, optional `editionHash`, optional `annotator {kind:"model", id}`. Adds one row and returns it |
| GET /annotations | `workspaceId`, `workId`, `locale`, `limit` 1–200, `offset`. The rows that count, newest first |

Rules:

- Only a **published** revision of an article or a note is annotated; without `revision` it is the newest published one. A draft answers `not_published`; a calendar, history or resource record answers `not_annotatable`.
- Form version 2 is one questionnaire for every article and note: the slop taxonomy of Shaib et al. (arXiv:2509.19163), an initial yes or no judgement and eleven yes or no codes in three themes. Its sections apply to every work.
- What a form's sections may depend on is decided here, not by the client: the work's type from the edition, the section's writing family from the published writing defaults, a card page when a raster rendition exists for that revision, and a rewritten note from its source link. Without published writing defaults only the common questions are asked.
- `formVersion` must be the current version (`form_changed` otherwise). Answers are checked against the form: every item that applies and is not optional, nothing that does not apply (`invalid_annotation`).
- Rows are only added. The newest row of one annotator for one revision and form version is the one that counts.
- A person is identified by the credential (`device:<workerId>` or `user:<userId>`). A device may submit a model's answers under `annotator {kind:"model", id}`; the row records who submitted it.
- People answer blind: a device sees the rows it submitted, and other annotators' rows for a revision only after it has answered that revision as a person. The owner sees all.

Not here yet: a credential that may only annotate, sampling and assignment of works to annotators, and agreement statistics.
