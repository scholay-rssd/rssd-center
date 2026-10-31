# Existing social channels

RSSD destinations of kind `postiz` reference an existing, same-organization
`Integration.id`. The adapter never copies an access token into RSSD configuration
or exposes it to a device. Channel selection does not add it to any publication
rule automatically. The existing channel page continues to own authorization.

Production results provide platform-specific content on each language edition:

```json
{
  "metadata": {
    "platformContent": {
      "destination-id": {
        "text": "Complete platform-specific text",
        "mediaIds": [],
        "settings": {}
      }
    }
  }
}
```

Devices may produce `mediaUrls` before submission; the shared device runtime
downloads and verifies those images, assigns workspace-scoped IDs, and replaces
the URLs with `mediaIds`. Media may be specific to the social post and need not
appear in the article body. These instructions and platform identities are frozen
with the claim. Platform settings are validated by the original Postiz provider
DTO and media rules; `__type` always comes from the selected channel. Missing
text, required media or settings blocks only that destination.

The adapter inserts one deterministic Postiz post in a fenced transaction, then
starts the existing `postWorkflowV112` using its stable workflow identity. It
persists start intent before the call. Retries inspect the same post/workflow;
an absent workflow after an uncertain start is blocked for reconciliation, even
after workflow history retention expires. A newer content revision cannot create
a replacement for an older uncertain publication.

Success requires the original Postiz post to be `PUBLISHED` with both platform
release ID and URL. The receipt explicitly records `postiz-provider-receipt`;
it does not claim anonymous HTTP content verification on platforms that require
login. Site and forum adapters separately verify publicly readable content.

The generic Postiz update operation changes its scheduling record and is not a
remote-edit API. Consequently this connector currently blocks edits to an already
published social post while retaining its identity. Per-platform remote update
support remains an explicit follow-up; it must not be simulated by creating a new
post. Discourse already supports verified updates to its original topic.

Automated tests use a new PostgreSQL schema and synthetic workflow hooks, never
real platform credentials. Production-channel delivery and provider-specific
media combinations remain release acceptance work.
