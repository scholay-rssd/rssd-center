#!/bin/sh
# Reproducible existing-English website publish checks. Requires a disposable
# rssd_*test Postgres URL. Does not touch production.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${RSSD_TEST_DATABASE_URL:-}" ]; then
  echo 'Set RSSD_TEST_DATABASE_URL to a dedicated rssd_*test database' >&2
  exit 1
fi
if [ ! -f rssd/postiz-schema.sql ]; then
  pnpm exec prisma migrate diff --from-empty --to-schema-datamodel libraries/nestjs-libraries/src/database/prisma/schema.prisma --script --output rssd/postiz-schema.sql
fi
node --test rssd/existing-site-publish.test.cjs
pnpm --filter postiz-backend build
node --test rssd/existing-site-publish.http.test.cjs
