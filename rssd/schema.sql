-- Additive RSSD v1 schema. Existing Postiz tables and publications are untouched.
CREATE TABLE IF NOT EXISTS rssd_device_authorizations (
 id TEXT PRIMARY KEY,"deviceHash" TEXT NOT NULL UNIQUE,"userCode" TEXT NOT NULL UNIQUE,
 details JSONB NOT NULL,state TEXT NOT NULL DEFAULT 'pending',"expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "orgId" TEXT,"userId" TEXT,"workspaceIds" JSONB,"codeHash" TEXT UNIQUE,"nextPollAt" TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS rssd_device_authorizations_expiry ON rssd_device_authorizations ("expiresAt");
CREATE TABLE IF NOT EXISTS rssd_guestbooks (
 "siteId" TEXT PRIMARY KEY,"orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,
 config JSONB NOT NULL,"sealedSecret" TEXT NOT NULL,"proxyTokenHash" TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT false,"sourceHash" TEXT,"legacySource" JSONB,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rssd_guestbook_messages (
 "siteId" TEXT NOT NULL,id TEXT NOT NULL,visitor TEXT NOT NULL,day TEXT NOT NULL,"requestKey" TEXT NOT NULL,
 payload JSONB NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
 created BIGINT NOT NULL,reviewed BIGINT,reviewer TEXT,
 PRIMARY KEY ("siteId",id),UNIQUE ("siteId",visitor,"requestKey")
);
CREATE INDEX IF NOT EXISTS rssd_guestbook_quota ON rssd_guestbook_messages ("siteId",visitor,day);
CREATE TABLE IF NOT EXISTS rssd_guestbook_guard (
 "siteId" TEXT NOT NULL,key TEXT NOT NULL,count INTEGER NOT NULL,expires BIGINT NOT NULL,PRIMARY KEY ("siteId",key)
);
CREATE TABLE IF NOT EXISTS rssd_migrations (
 "orgId" TEXT NOT NULL, "siteId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
 state TEXT NOT NULL, manifest JSONB NOT NULL, ancillary JSONB NOT NULL, report JSONB NOT NULL DEFAULT '{}',
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId","siteId")
);
ALTER TABLE rssd_migrations ADD COLUMN IF NOT EXISTS "importGeneration" TEXT;
ALTER TABLE rssd_migrations ADD COLUMN IF NOT EXISTS "importLeaseUntil" TIMESTAMPTZ(3);
CREATE TABLE IF NOT EXISTS rssd_legacy_documents (
 "orgId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"documentId" TEXT NOT NULL,"workId" TEXT NOT NULL,
 locale TEXT NOT NULL,"sourceHash" TEXT NOT NULL,source JSONB NOT NULL,"deletedAt" TIMESTAMPTZ(3),
 PRIMARY KEY ("orgId","siteId","documentId")
);
CREATE INDEX IF NOT EXISTS rssd_legacy_request_keys ON rssd_legacy_documents USING GIN ((source->'requests') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS rssd_legacy_draft_keys ON rssd_legacy_documents USING GIN ((source->'drafts') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS rssd_legacy_documents_work_locale ON rssd_legacy_documents ("orgId","workId",locale,"siteId");
CREATE TABLE IF NOT EXISTS rssd_media (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, "workspaceId" TEXT NOT NULL, name TEXT NOT NULL,
  manifest JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("orgId", id)
);
CREATE TABLE IF NOT EXISTS rssd_workspaces (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id)
);
CREATE TABLE IF NOT EXISTS rssd_workers (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE,
  "workspaceIds" JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'idle', details JSONB NOT NULL DEFAULT '{}',
  "revokedAt" TIMESTAMPTZ(3), "heartbeatAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id)
);
CREATE TABLE IF NOT EXISTS rssd_demands (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sectionId" TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0, "workerId" TEXT, "claimToken" TEXT, payload JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id)
);
CREATE INDEX IF NOT EXISTS rssd_demands_queue ON rssd_demands ("orgId", state, priority DESC, "createdAt");
CREATE INDEX IF NOT EXISTS rssd_demands_updated ON rssd_demands ("orgId", "workspaceId", "updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS rssd_demands_open_translate_work ON rssd_demands ("orgId", (payload->'source'->>'workId'))
 WHERE kind='translate' AND state IN ('queued','claimed','blocked');
CREATE TABLE IF NOT EXISTS rssd_works (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sectionId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id)
);
CREATE TABLE IF NOT EXISTS rssd_editions (
  "orgId" TEXT NOT NULL, "workId" TEXT NOT NULL, locale TEXT NOT NULL, revision INTEGER NOT NULL,
  payload JSONB NOT NULL, hash TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", "workId", locale, revision)
);
CREATE TABLE IF NOT EXISTS rssd_renditions (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
  "workId" TEXT NOT NULL, locale TEXT NOT NULL, revision INTEGER NOT NULL, variant TEXT NOT NULL,
  summary JSONB NOT NULL, payload JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("orgId",id),
  FOREIGN KEY ("orgId","workId",locale,revision) REFERENCES rssd_editions ("orgId","workId",locale,revision)
);
CREATE INDEX IF NOT EXISTS rssd_renditions_workspace ON rssd_renditions ("orgId","workspaceId",locale,id);
CREATE INDEX IF NOT EXISTS rssd_renditions_work ON rssd_renditions ("orgId","workspaceId",locale,"workId",id);
CREATE TABLE IF NOT EXISTS rssd_rendition_media (
  "orgId" TEXT NOT NULL, "renditionId" TEXT NOT NULL, "mediaId" TEXT NOT NULL,
  PRIMARY KEY ("orgId","renditionId","mediaId"),
  FOREIGN KEY ("orgId","renditionId") REFERENCES rssd_renditions ("orgId",id),
  FOREIGN KEY ("orgId","mediaId") REFERENCES rssd_media ("orgId",id)
);
CREATE INDEX IF NOT EXISTS rssd_rendition_media_asset ON rssd_rendition_media ("orgId","mediaId");
CREATE TABLE IF NOT EXISTS rssd_submissions (
  "orgId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL, "workId" TEXT NOT NULL, result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", "requestId")
);
CREATE TABLE IF NOT EXISTS rssd_destinations (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  "workspaceIds" JSONB NOT NULL, config JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id)
);
CREATE TABLE IF NOT EXISTS rssd_publications (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, "workId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
  locale TEXT NOT NULL, revision INTEGER NOT NULL, "destinationId" TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', payload JSONB NOT NULL, receipt JSONB NOT NULL DEFAULT '{}',
  error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id),
  UNIQUE ("orgId", "workId", locale, revision, "destinationId")
);
CREATE INDEX IF NOT EXISTS rssd_publications_queue ON rssd_publications ("orgId", state, "createdAt");
ALTER TABLE rssd_publications ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;
ALTER TABLE rssd_publications ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMPTZ(3);
ALTER TABLE rssd_publications ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE IF NOT EXISTS rssd_audit (
  "orgId" TEXT NOT NULL, id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, payload JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("orgId", id)
);
-- Finds the device that first saved a work (see RssdEditorial.firstMachine).
CREATE INDEX IF NOT EXISTS rssd_audit_work_saves ON rssd_audit ("orgId", (payload->>'workId'), "createdAt") WHERE action IN ('work.submit','work.save');
CREATE TABLE IF NOT EXISTS rssd_editorial_requests (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"requestKey" TEXT NOT NULL,
 intent TEXT NOT NULL,"payloadHash" TEXT NOT NULL,"workId" TEXT NOT NULL,locale TEXT NOT NULL,
 "destinationId" TEXT NOT NULL,"publicationId" TEXT,receipt JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId","workspaceId","requestKey")
);
CREATE TABLE IF NOT EXISTS rssd_editorial_archives (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,id TEXT NOT NULL,"workId" TEXT NOT NULL,
 locale TEXT NOT NULL,revision INTEGER NOT NULL,payload BYTEA NOT NULL,sha256 TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId","workspaceId",id)
);
CREATE TABLE IF NOT EXISTS rssd_staged_drafts (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"workId" TEXT NOT NULL,locale TEXT NOT NULL,
 "articleId" TEXT NOT NULL,"baseRevision" INTEGER NOT NULL,"baseHash" TEXT NOT NULL,
 "baseSourceHash" TEXT NOT NULL,"basePublishedVersion" INTEGER,"overlayRevision" INTEGER NOT NULL,
 data JSONB NOT NULL,"requestKey" TEXT NOT NULL,"requestHash" TEXT NOT NULL,receipt JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId","workspaceId","workId",locale,"overlayRevision"),
 UNIQUE ("orgId","workspaceId","requestKey")
);
CREATE TABLE IF NOT EXISTS rssd_staged_draft_promotions (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"workId" TEXT NOT NULL,locale TEXT NOT NULL,
 "articleId" TEXT NOT NULL,"overlayRevision" INTEGER NOT NULL,"baseRevision" INTEGER NOT NULL,
 "baseHash" TEXT NOT NULL,"canonicalRevision" INTEGER NOT NULL,"canonicalHash" TEXT NOT NULL,"requestId" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId","workspaceId","workId",locale,"overlayRevision"),
 UNIQUE ("orgId","requestId")
);
ALTER TABLE rssd_staged_draft_promotions ADD COLUMN IF NOT EXISTS "canonicalHash" TEXT;
CREATE TABLE IF NOT EXISTS rssd_editorial_states (
 "orgId" TEXT NOT NULL,"workId" TEXT NOT NULL,locale TEXT NOT NULL,visibility TEXT NOT NULL,
 "previousVisibility" TEXT,"previousPublishedVersion" INTEGER,generation INTEGER NOT NULL DEFAULT 0,"operationSequence" INTEGER NOT NULL DEFAULT 0,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId","workId",locale)
);
ALTER TABLE rssd_editorial_states ADD COLUMN IF NOT EXISTS "previousPublishedVersion" INTEGER;
ALTER TABLE rssd_editorial_states ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS rssd_editorial_actions (
 "orgId" TEXT NOT NULL,id TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"requestKey" TEXT NOT NULL,
 "payloadHash" TEXT NOT NULL,"workId" TEXT NOT NULL,locale TEXT NOT NULL,"destinationId" TEXT NOT NULL,
 action TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',payload JSONB NOT NULL,receipt JSONB NOT NULL DEFAULT '{}',
 packet JSONB,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,"leaseToken" TEXT,"leaseUntil" TIMESTAMPTZ(3),
 "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId",id),UNIQUE ("orgId","workspaceId","requestKey")
);

-- Coordination is additive. Original Postiz publishing tables remain authoritative.
CREATE TABLE IF NOT EXISTS rssd_goals (
 "orgId" TEXT NOT NULL,id TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"sectionId" TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,payload JSONB NOT NULL,status JSONB NOT NULL DEFAULT '{}',
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId",id)
);
CREATE TABLE IF NOT EXISTS rssd_coordination_requests (
 "orgId" TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,result JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY ("orgId",id)
);
CREATE TABLE IF NOT EXISTS rssd_worker_grants (
 "orgId" TEXT NOT NULL,id TEXT NOT NULL,"workerId" TEXT NOT NULL,operation TEXT NOT NULL,
 "workspaceIds" JSONB NOT NULL,"destinationIds" JSONB NOT NULL,"grantedBy" TEXT NOT NULL,
 "revokedAt" TIMESTAMPTZ(3),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orgId",id)
);
CREATE INDEX IF NOT EXISTS rssd_worker_grants_worker ON rssd_worker_grants ("orgId","workerId");
CREATE TABLE IF NOT EXISTS rssd_existing_site_publishes (
 "orgId" TEXT NOT NULL,"requestId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"workId" TEXT NOT NULL,
 locale TEXT NOT NULL,revision INTEGER NOT NULL,"destinationId" TEXT NOT NULL,"editionHash" TEXT NOT NULL,
 "articleId" TEXT NOT NULL,"publicationId" TEXT NOT NULL,"payloadHash" TEXT NOT NULL,result JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY ("orgId","requestId")
);
CREATE INDEX IF NOT EXISTS rssd_existing_site_publishes_work ON rssd_existing_site_publishes ("orgId","workId",locale,revision,"destinationId");

-- Annotations of published revisions. Rows are only added, and the newest per annotator, revision and form version counts.
CREATE TABLE IF NOT EXISTS rssd_annotations (
 "orgId" TEXT NOT NULL,id TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"sectionId" TEXT NOT NULL,"workId" TEXT NOT NULL,
 locale TEXT NOT NULL,revision INTEGER NOT NULL,"editionHash" TEXT NOT NULL,"formVersion" TEXT NOT NULL,
 "annotatorKind" TEXT NOT NULL,"annotatorId" TEXT NOT NULL,"submittedBy" TEXT NOT NULL,target JSONB NOT NULL,answers JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY ("orgId",id)
);
CREATE INDEX IF NOT EXISTS rssd_annotations_work ON rssd_annotations ("orgId","workId",locale,revision,"createdAt");
CREATE INDEX IF NOT EXISTS rssd_annotations_workspace ON rssd_annotations ("orgId","workspaceId","createdAt");

-- The mount library: what a writer is handed for one work besides the section's rules. One row is one revision
-- of one item of a kind, and the first kind is persona. A row's content never changes, and `version` orders
-- the revisions of an item. `entry` is what the Center reads to decide, `content` what the claiming device gets.
CREATE TABLE IF NOT EXISTS rssd_mounts (
 "orgId" TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,version INTEGER NOT NULL,
 hash TEXT NOT NULL,entry JSONB NOT NULL,content JSONB NOT NULL,"retiredAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY ("orgId",kind,id,revision)
);
