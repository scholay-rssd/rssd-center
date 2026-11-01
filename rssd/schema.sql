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
CREATE TABLE IF NOT EXISTS rssd_legacy_documents (
 "orgId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"documentId" TEXT NOT NULL,"workId" TEXT NOT NULL,
 locale TEXT NOT NULL,"sourceHash" TEXT NOT NULL,source JSONB NOT NULL,"deletedAt" TIMESTAMPTZ(3),
 PRIMARY KEY ("orgId","siteId","documentId")
);
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

-- Private handoff evidence is an isolated review queue, never a publication or
-- demand. Legacy keys remain evidence and review IDs are generated independently.
CREATE TABLE IF NOT EXISTS rssd_private_review_items (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"legacyKey" TEXT NOT NULL,"articleId" TEXT NOT NULL,
 id TEXT NOT NULL,fingerprint TEXT NOT NULL,"bundleDigest" TEXT NOT NULL,metadata JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'needs_reconciliation' CHECK(state='needs_reconciliation'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("orgId","workspaceId","legacyKey"),UNIQUE("orgId","workspaceId",id)
);
CREATE TABLE IF NOT EXISTS rssd_private_review_files (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"legacyKey" TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,data BYTEA NOT NULL,
 PRIMARY KEY("orgId","workspaceId","legacyKey",path),
 FOREIGN KEY("orgId","workspaceId","legacyKey") REFERENCES rssd_private_review_items("orgId","workspaceId","legacyKey")
);
CREATE TABLE IF NOT EXISTS rssd_private_review_access (
 "orgId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,"reviewId" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Private import grant and source evidence. No public publication is created.
CREATE TABLE IF NOT EXISTS rssd_import_grants(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,org TEXT NOT NULL,workspace TEXT NOT NULL,site TEXT NOT NULL,bundle TEXT NOT NULL,actor TEXT NOT NULL,source_profile JSONB NOT NULL DEFAULT '{}',expires TIMESTAMPTZ NOT NULL,state TEXT NOT NULL DEFAULT 'issued',job_id TEXT);
ALTER TABLE rssd_import_grants ADD COLUMN IF NOT EXISTS source_profile JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS rssd_import_jobs(id TEXT PRIMARY KEY,org TEXT NOT NULL,workspace TEXT NOT NULL,site TEXT NOT NULL,bundle TEXT NOT NULL,actor TEXT NOT NULL,archive BYTEA NOT NULL,manifest BYTEA NOT NULL,inventory BYTEA NOT NULL,manifest_hash TEXT NOT NULL,inventory_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'staging',UNIQUE(org,workspace,bundle));
CREATE TABLE IF NOT EXISTS rssd_import_items(job_id TEXT NOT NULL REFERENCES rssd_import_jobs(id),review_id TEXT NOT NULL,PRIMARY KEY(job_id,review_id));
CREATE TABLE IF NOT EXISTS rssd_import_audit(org TEXT NOT NULL,workspace TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,job_id TEXT,review_id TEXT,created TIMESTAMPTZ NOT NULL DEFAULT now());

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
