const {mkdirSync,copyFileSync} = require('node:fs');
const {join} = require('node:path');
const target=join(__dirname,'../apps/backend/dist/rssd');mkdirSync(target,{recursive:true});
for(const file of ['protocol.cjs','protocol.source.json','rssd-v1.cjs','rssd-media.cjs','rssd-record.cjs','publication.cjs','store.cjs','publisher.cjs','discourse.cjs','media.cjs','migration.cjs','migration-cli.cjs','schema.sql'])copyFileSync(join(__dirname,file),join(target,file));
