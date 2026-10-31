#!/bin/sh
set -eu
node rssd/apply-schema.cjs
nginx
exec pm2-runtime rssd/ecosystem.config.cjs
