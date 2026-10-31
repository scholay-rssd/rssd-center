const {mkdirSync,copyFileSync,cpSync} = require('node:fs');
const {join} = require('node:path');
const target=join(__dirname,'../apps/backend/dist/rssd');mkdirSync(target,{recursive:true});
for(const file of ['protocol.cjs','protocol.source.json','rssd-v1.cjs','rssd-media.cjs','rssd-record.cjs','publication.cjs','store.cjs','publisher.cjs','discourse.cjs','postiz.cjs','owner-context.cjs','media.cjs','migration.cjs','migration-cli.cjs','health.cjs','guestbook.cjs','guestbook-cli.cjs','schema.sql'])copyFileSync(join(__dirname,file),join(target,file));
copyFileSync(join(__dirname,'labels.cjs'),join(target,'labels.cjs'));
cpSync(join(__dirname,'legacy-labels'),join(target,'legacy-labels'),{recursive:true});
