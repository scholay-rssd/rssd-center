const {mkdirSync,copyFileSync} = require('node:fs');
const {join} = require('node:path');
const target=join(__dirname,'../apps/backend/dist/rssd');mkdirSync(target,{recursive:true});
for(const file of ['protocol.cjs','protocol.source.json','store.cjs','schema.sql'])copyFileSync(join(__dirname,file),join(target,file));
