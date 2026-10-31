'use strict';
const {readFile}=require('node:fs/promises');
const {resolve,sep}=require('node:path');
const {createHash}=require('node:crypto');
const p=require('./protocol.cjs'),{admin}=require('./store.cjs');
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args),x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
class RssdMigration {
 constructor(store,media){this.store=store;this.media=media;}
 async inspect(ctx,siteId){admin(ctx);return (await q(this.store.db,'SELECT * FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,p.id(siteId)))[0]||null;}
 async import(ctx,directory){
  admin(ctx);directory=resolve(directory);
  const read=async descriptor=>{const file=resolve(directory,descriptor.path);if(!file.startsWith(directory+sep))p.fail('Unsafe migration path');const bytes=await readFile(file);if(hash(bytes)!==descriptor.sha256)p.fail('Migration file checksum mismatch: '+descriptor.path,409);return bytes;};
  const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
  if(manifest.version!==1||manifest.workspace.siteId!==manifest.site.id||manifest.workspace.id!==manifest.site.spaceId)p.fail('Invalid migration manifest');
  const siteId=p.id(manifest.site.id),workspaceId=p.id(manifest.workspace.id),previous=await this.inspect(ctx,siteId);
  if(previous?.state==='active')p.fail('An active workspace cannot accept a legacy import',409);
  // Validate every file before changing the database. A corrupt bundle cannot partially replace a staged import.
  await read(manifest.baseline);const ancillary=JSON.parse(await read(manifest.ancillary));
  for(const document of manifest.documents){const value=JSON.parse(await read(document));if(value.sourceHash!==p.hash(value.source)||document.sourceHash!==value.sourceHash||value.workId!==document.workId||value.siteId!==siteId||value.workspaceId!==workspaceId||value.source.document.id!==document.documentId)p.fail('Legacy identity or source hash mismatch',409);}
  for(const media of manifest.media)await read({path:media.path,sha256:media.manifest.sha256});
  const existing=(await this.store.registry(ctx)).workspaces.find(w=>w.id===workspaceId);
  if(!existing)await this.store.saveWorkspace(ctx,manifest.workspace);
  else if(p.hash(existing.sections)!==p.hash(p.workspace(manifest.workspace).sections))p.fail('Migration workspace rules differ from staged rules',409);
  await x(this.store.db,`INSERT INTO rssd_migrations ("orgId","siteId","workspaceId",state,manifest,ancillary) VALUES ($1,$2,$3,'staging',$4::jsonb,$5::jsonb)
   ON CONFLICT ("orgId","siteId") DO UPDATE SET state='staging',manifest=EXCLUDED.manifest,ancillary=EXCLUDED.ancillary,"updatedAt"=CURRENT_TIMESTAMP`,ctx.orgId,siteId,workspaceId,JSON.stringify(manifest),JSON.stringify(ancillary));
  for(const item of manifest.media){const bytes=await read({path:item.path,sha256:item.manifest.sha256});const result=await this.media.upload(ctx,{workspaceId,name:item.path,...item.manifest,data:bytes.toString('base64')});if(result.id!==item.id)p.fail('Imported media identity differs',409);}
  for(const descriptor of manifest.documents){
   const value=JSON.parse(await read(descriptor));
   await this.store.transaction(async db=>{
    await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':work:'+value.workId);
    const existing=(await q(db,'SELECT * FROM rssd_works WHERE "orgId"=$1 AND id=$2',ctx.orgId,value.workId))[0];
    if(existing&&(existing.workspaceId!==workspaceId||existing.sectionId!==value.sectionId))p.fail('Imported work identity collides with existing work',409);
    const heads=await q(db,'SELECT revision FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,value.workId,value.locale);
    if(heads.some(e=>!value.editions.some(v=>v.revision===e.revision)))p.fail('Center has revisions absent from the legacy snapshot',409);
    await x(db,`INSERT INTO rssd_works ("orgId",id,"workspaceId","sectionId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT ("orgId",id) DO UPDATE SET "updatedAt"=EXCLUDED."updatedAt"`,ctx.orgId,value.workId,workspaceId,value.sectionId,new Date(value.editions[0].createdAt),new Date(value.source.document.updated));
    for(const e of value.editions){
     if(p.hash(p.edition(e.payload))!==e.hash)p.fail('Invalid migrated edition hash',409);
     const old=(await q(db,'SELECT hash FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4',ctx.orgId,value.workId,value.locale,e.revision))[0];
     if(old&&old.hash!==e.hash)p.fail('An imported revision conflicts with center content',409);
     if(!old)await x(db,'INSERT INTO rssd_editions ("orgId","workId",locale,revision,payload,hash,"createdAt") VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)',ctx.orgId,value.workId,value.locale,e.revision,JSON.stringify(e.payload),e.hash,new Date(e.createdAt));
    }
    await x(db,`INSERT INTO rssd_legacy_documents ("orgId","siteId","documentId","workId",locale,"sourceHash",source,"deletedAt") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT ("orgId","siteId","documentId") DO UPDATE SET "sourceHash"=EXCLUDED."sourceHash",source=EXCLUDED.source,"deletedAt"=EXCLUDED."deletedAt"`,ctx.orgId,siteId,descriptor.documentId,value.workId,value.locale,value.sourceHash,JSON.stringify(value.source),value.source.tombstone?new Date(value.source.tombstone.deleted):null);
    // Old receipts remain evidence of the old publication. They are never sent again during import.
    const revision=value.source.document.published_revision;
    await x(db,`DELETE FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state='legacy_published'`,ctx.orgId,value.workId,value.locale,'site-'+siteId);
    if(revision&&!value.source.tombstone){
     const e=value.editions.find(e=>e.revision===revision);if(!e)p.fail('Published legacy revision is missing',409);
     const receipt={legacy:true,url:manifest.site.origin+value.source.document.permalink,documentId:descriptor.documentId,requests:value.source.requests.filter(r=>r.revision===revision),jobs:value.source.jobs.filter(j=>j.revision===revision&&j.status==='success')};
     await x(db,`INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",state,payload,receipt,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'legacy_published',$8::jsonb,$9::jsonb,$10)
      ON CONFLICT ("orgId",id) DO NOTHING`,ctx.orgId,'legacy-pub-'+p.hash([siteId,descriptor.documentId,revision]).slice(0,48),value.workId,workspaceId,value.locale,revision,'site-'+siteId,JSON.stringify({edition:e.payload,sectionId:value.sectionId,hash:e.hash,policyVersion:1}),JSON.stringify(receipt),new Date(e.createdAt));
    }
   });
  }
  const report=await this.verify(ctx,manifest);
  await x(this.store.db,`UPDATE rssd_migrations SET state='staged',report=$3::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND "siteId"=$2`,ctx.orgId,siteId,JSON.stringify(report));return report;
 }
 async verify(ctx,manifest){
  const documents=await q(this.store.db,'SELECT "documentId","workId",locale,"sourceHash","deletedAt" FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,manifest.site.id);
  if(documents.length!==manifest.documents.length)p.fail('Legacy document count differs',409);
  for(const item of manifest.documents){
   const row=documents.find(d=>d.documentId===item.documentId);if(!row||row.workId!==item.workId||row.locale!==item.locale||row.sourceHash!==item.sourceHash||Boolean(row.deletedAt)!==item.deleted)p.fail('Legacy document verification failed',409);
   const archived=(await q(this.store.db,'SELECT source FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2 AND "documentId"=$3',ctx.orgId,manifest.site.id,item.documentId))[0];
   if(p.hash(archived.source)!==item.sourceHash)p.fail('Archived legacy source hash differs',409);
  }
  const editions=await q(this.store.db,'SELECT e."workId",e.locale,e.revision,e.hash FROM rssd_editions e JOIN rssd_works w ON e."orgId"=w."orgId" AND e."workId"=w.id WHERE w."orgId"=$1 AND w."workspaceId"=$2',ctx.orgId,manifest.workspace.id);
  if(editions.length!==manifest.counts.revisions)p.fail('Edition revision count differs',409);
  return {siteId:manifest.site.id,workspaceId:manifest.workspace.id,counts:manifest.counts,sourceDatabaseSha256:manifest.databaseSha256,editionIndexSha256:p.hash(editions.sort((a,b)=>p.canonical(a).localeCompare(p.canonical(b)))),verifiedAt:new Date().toISOString(),state:'staged',dispatchEnabled:false};
 }
}
module.exports={RssdMigration};
