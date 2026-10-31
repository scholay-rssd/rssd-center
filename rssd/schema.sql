-- Additive RSSD v1 schema. Existing Postiz tables and publications are untouched.
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
