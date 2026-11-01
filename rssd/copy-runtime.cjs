const {mkdirSync,copyFileSync,readdirSync} = require('node:fs');
const {join} = require('node:path');
// fs.cpSync currently crashes the bundled Windows Node runtime on these
// directories. The build owns two small source closures; copy regular entries
// explicitly and reject symlinks instead of following external workspace data.
function copyDirectory(source,target){
 mkdirSync(target,{recursive:true});
 for(const entry of readdirSync(source,{withFileTypes:true})){
  if(entry.isDirectory())copyDirectory(join(source,entry.name),join(target,entry.name));
  else if(entry.isFile())copyFileSync(join(source,entry.name),join(target,entry.name));
  else throw Error('Runtime source contains a non-regular entry: '+entry.name);
 }
}
const target=join(__dirname,'../apps/backend/dist/rssd');mkdirSync(target,{recursive:true});
copyFileSync(join(__dirname,'body-parsers.cjs'),join(target,'body-parsers.cjs'));
copyFileSync(join(__dirname,'device-auth.cjs'),join(target,'device-auth.cjs'));
for(const file of ['protocol.cjs','protocol.source.json','rssd-v1.cjs','rssd-media.cjs','rssd-record.cjs','publication.cjs','store.cjs','coordination.cjs','mcp.cjs','publisher.cjs','discourse.cjs','postiz.cjs','owner-context.cjs','media.cjs','migration.cjs','migration-cli.cjs','health.cjs','guestbook.cjs','guestbook-cli.cjs','schema.sql'])copyFileSync(join(__dirname,file),join(target,file));
copyFileSync(join(__dirname,'labels.cjs'),join(target,'labels.cjs'));
copyDirectory(join(__dirname,'legacy-labels'),join(target,'legacy-labels'));
for(const file of ['community.cjs','community-engine.mjs'])copyFileSync(join(__dirname,file),join(target,file));
copyFileSync(join(__dirname,'editorial.cjs'),join(target,'editorial.cjs'));
copyFileSync(join(__dirname,'editorial-actions.cjs'),join(target,'editorial-actions.cjs'));
copyFileSync(join(__dirname,'private-review.cjs'),join(target,'private-review.cjs'));
for(const file of ['private-import-owner.mjs','private-import-profile.mjs','private-import-startup.mjs','private-import-secrets.mjs','private-import-probe.mjs','private-import-limits.mjs','private-import-read-archive.py','private-import-secure-roles.mjs','private-import-secure-adapter.mjs','private-import-trusted-source.mjs','private-import-verified-archive.py','private-import-secure-policy.sql','private-import-socket.mjs','private-import-cli.mjs'])copyFileSync(join(__dirname,file),join(target,file));
copyDirectory(join(__dirname,'community-public'),join(target,'community-public'));
