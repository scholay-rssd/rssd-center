'use strict';
const {readFile}=require('node:fs/promises');
const {resolve,sep}=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const p=require('./protocol.cjs'),{admin}=require('./store.cjs');
const {promoteStaged}=require('./staged-reconcile.cjs');
const {RssdStore}=require('./store.cjs');
const {RssdEditorial}=require('./editorial.cjs');
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args),x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function validateEvidence(evidence,siteId){
 p.object(evidence,'cutover evidence');
 if(evidence.oldWriterDisabled!==true||evidence.inFlightCount!==0||evidence.pendingWorkReconciled!==true)p.fail('Disable the old writer, drain publication and reconcile pending work before activation',409,'handoff_incomplete');
 p.text(evidence.receiptId,'cutover receiptId',200);p.text(evidence.receiverRelease,'receiver release',200);p.text(evidence.rollbackReference,'rollback reference',1000);
 const suffix=':'+siteId,runId=evidence.receiptId.endsWith(suffix)?evidence.receiptId.slice(0,-suffix.length):'';
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(runId)||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(evidence.receiverRelease))p.fail('Cutover receipt or receiver release cannot produce a device proof',409,'invalid_evidence');
}
async function guardImport(db,ctx,siteId,generation){
 const row=(await q(db,'SELECT state,"importGeneration",("importLeaseUntil">CURRENT_TIMESTAMP) AS valid FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2 FOR UPDATE',ctx.orgId,siteId))[0];
 if(!row||row.state!=='staging'||row.importGeneration!==generation||!row.valid)p.fail('Import ownership expired or changed; retain the original snapshot',409,'import_lease_lost');
 await x(db,'UPDATE rssd_migrations SET "importLeaseUntil"=CURRENT_TIMESTAMP+interval \'5 minutes\' WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,siteId);
}
async function stagedSnapshot(db,orgId,workspaceId){
 const digest=createHash('sha256');let count=0,last=null;
 for(;;){
  const rows=await q(db,`SELECT "workId",locale,"articleId","baseRevision","baseHash","baseSourceHash","basePublishedVersion","overlayRevision",data,"requestKey","requestHash",receipt FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 AND ($3::text IS NULL OR ("workId",locale,"overlayRevision")>($3::text,$4::text,$5::int)) ORDER BY "workId",locale,"overlayRevision" LIMIT 100`,orgId,workspaceId,last?.workId??null,last?.locale??null,last?.overlayRevision??null);
  for(const row of rows)digest.update(p.canonical(row)+'\n');
  count+=rows.length;if(rows.length<100)break;last=rows.at(-1);
 }
 return {count,sha256:digest.digest('hex')};
}
async function pendingPromotions(db,orgId,workspaceId){
 return (await q(db,`WITH heads AS (SELECT DISTINCT ON ("workId",locale) * FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 ORDER BY "workId",locale,"overlayRevision" DESC)
  SELECT count(*)::int AS value FROM heads h WHERE NOT EXISTS (SELECT 1 FROM rssd_staged_draft_promotions t WHERE t."orgId"=h."orgId" AND t."workspaceId"=h."workspaceId" AND t."workId"=h."workId" AND t.locale=h.locale AND t."overlayRevision"=h."overlayRevision")`,orgId,workspaceId))[0].value;
}
function assertEvidence(row,evidence){
 if(!row.manifest?.baseline?.sha256||!row.manifest?.databaseSha256||!row.report?.editionIndexSha256||evidence.sourceDatabaseSha256!==row.manifest.databaseSha256||evidence.editionIndexSha256!==row.report.editionIndexSha256||evidence.baselineSha256!==row.manifest.baseline.sha256)p.fail('Cutover evidence does not match the final import',409,'stale_snapshot');
}
async function assertPlan(db,ctx,row,evidence){
 const plan=row.report?.reconciliation;
 if(!plan||plan.version!==1||plan.siteId!==row.siteId||plan.workspaceId!==row.workspaceId||plan.evidenceHash!==p.hash(evidence)||plan.manifestHash!==p.hash(row.manifest)||plan.editionIndexSha256!==row.report.editionIndexSha256)p.fail('The reconciliation plan changed; retain all branches',409,'reconcile_plan_changed');
 const snapshot=await stagedSnapshot(db,ctx.orgId,row.workspaceId);
 if(snapshot.sha256!==plan.snapshotSha256||snapshot.count!==plan.snapshotCount)p.fail('Staged draft history changed during reconciliation',409,'reconcile_plan_changed');
}
class RssdMigration {
 constructor(store,media){this.store=store;this.media=media;}
 async inspect(ctx,siteId){admin(ctx);return (await q(this.store.db,'SELECT * FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,p.id(siteId)))[0]||null;}
 async deviceProof(ctx,siteId,workspaceId){
  p.id(siteId,'siteId');p.id(workspaceId,'workspaceId');
  if(!ctx || ctx.admin!==false || !ctx.workerId || !ctx.orgId || !Array.isArray(ctx.workspaceIds) || !ctx.workspaceIds.includes(workspaceId))p.fail('Device workspace scope required',403,'forbidden');
  const row=(await q(this.store.db,'SELECT "siteId","workspaceId",state,report FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2 AND "workspaceId"=$3',ctx.orgId,siteId,workspaceId))[0];
  if(!row)p.fail('Migration proof not found',404,'not_found');
  const cut=row.report?.cutover, suffix=':'+siteId, receipt=cut?.receiptId;
  const runId=typeof receipt==='string'&&receipt.endsWith(suffix)?receipt.slice(0,-suffix.length):'';
  const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  if(row.state!=='active'||row.siteId!==siteId||row.workspaceId!==workspaceId||row.report?.state!=='active'||row.report?.siteId!==siteId||row.report?.workspaceId!==workspaceId||!cut||typeof cut!=='object'||!runId||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(runId)||!hex(cut.baselineSha256)||!hex(cut.evidenceHash)||typeof cut.receiverRelease!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(cut.receiverRelease))p.fail('Migration proof is incomplete',409,'proof_unavailable');
  const {evidenceHash,activatedAt,actor,...evidence}=cut;
  if(p.hash(evidence)!==evidenceHash)p.fail('Migration proof is inconsistent',409,'proof_unavailable');
  return {siteId,workspaceId,state:'active',receiptId:receipt,runId,baselineSha256:cut.baselineSha256,evidenceHash,receiverRelease:cut.receiverRelease,observedAt:new Date().toISOString()};
 }
 // Explicit local admin operation. The durable reconciling state keeps every
 // ordinary writer fenced; each invocation commits at most eight promotions.
 async reconcile(ctx,siteId,evidence){
  admin(ctx);p.id(siteId);validateEvidence(evidence,siteId);
  return this.store.transaction(async db=>{
   const row=(await q(db,'SELECT * FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2 FOR UPDATE',ctx.orgId,siteId))[0];
   if(!row)p.fail('Migration not found',404,'not_found');
   assertEvidence(row,evidence);
   if(row.state==='active'){
    if(row.report?.cutover?.evidenceHash!==p.hash(evidence))p.fail('This migration was already activated with different evidence',409,'identity_conflict');
    return {state:'active',processed:0,pending:0};
   }
   if(row.state==='staged'){
    const checked=await new RssdMigration({...this.store,db},this.media).verify(ctx,row.manifest);
    if(checked.editionIndexSha256!==row.report.editionIndexSha256)p.fail('Imported editions changed after verification',409,'stale_snapshot');
    if((await q(db,'SELECT 1 FROM rssd_staged_draft_promotions WHERE "orgId"=$1 AND "workspaceId"=$2 LIMIT 1',ctx.orgId,row.workspaceId))[0])p.fail('Unexpected existing promotion history',409,'reconcile_plan_changed');
    const heads=await q(db,`SELECT DISTINCT ON ("workId",locale) "articleId","workId",locale,"baseRevision","baseHash","baseSourceHash","basePublishedVersion" FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 ORDER BY "workId",locale,"overlayRevision" DESC`,ctx.orgId,row.workspaceId);
    const nested=new RssdStore(db),editor=new RssdEditorial(nested,this.media),entries=await editor.entries(ctx,row.workspaceId);
    const grouped=items=>{const result=new Map();for(const item of items){const key=item.workId+'\0'+item.locale;result.set(key,[...(result.get(key)||[]),item]);}return result;};
    const byWork=grouped(entries);
    const sourceRows=await q(db,'SELECT "workId",locale,"sourceHash","deletedAt" FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,siteId);
    const sources=grouped(sourceRows);
    const editions=await q(db,`SELECT DISTINCT ON (e."workId",e.locale) e."workId",e.locale,e.revision,e.hash FROM rssd_editions e JOIN rssd_works w ON w."orgId"=e."orgId" AND w.id=e."workId" WHERE w."orgId"=$1 AND w."workspaceId"=$2 ORDER BY e."workId",e.locale,e.revision DESC`,ctx.orgId,row.workspaceId);
    const bases=new Map(editions.map(item=>[item.workId+'\0'+item.locale,item]));
    for(const draft of heads){
     const key=draft.workId+'\0'+draft.locale,entryRows=byWork.get(key)||[],sourceItems=sources.get(key)||[],entry=entryRows[0],source=sourceItems[0],base=bases.get(key);
     if(entryRows.length!==1||sourceItems.length!==1||entry.deletedAt||entry.articleId!==draft.articleId||entry.revision!==draft.baseRevision||(entry.publishedVersion??null)!==draft.basePublishedVersion||source.deletedAt||source.sourceHash!==draft.baseSourceHash||!base||base.revision!==draft.baseRevision||base.hash!==draft.baseHash)p.fail('The final source conflicts with a private staged draft; retain both for reconciliation',409,'staged_reconcile_conflict');
    }
    const snapshot=await stagedSnapshot(db,ctx.orgId,row.workspaceId);
    const report={...row.report,reconciliation:{version:1,siteId,workspaceId:row.workspaceId,evidenceHash:p.hash(evidence),manifestHash:p.hash(row.manifest),editionIndexSha256:row.report.editionIndexSha256,snapshotSha256:snapshot.sha256,snapshotCount:snapshot.count,actor:ctx.userId||'owner',startedAt:new Date().toISOString()}};
    await x(db,'UPDATE rssd_migrations SET state=\'reconciling\',report=$3::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,siteId,JSON.stringify(report));
    return {state:'reconciling',processed:0,pending:heads.length};
   }
   if(row.state!=='reconciling')p.fail('Migration is not ready for reconciliation',409,'migration_state_changed');
   await assertPlan(db,ctx,row,evidence);
   // The temporary state is visible only inside this transaction. Other
   // database sessions continue to observe the committed reconciling fence.
   await x(db,'UPDATE rssd_migrations SET state=\'active\' WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,siteId);
   const promotions=await promoteStaged({db,ctx,workspaceId:row.workspaceId,media:this.media,limit:8});
   await x(db,'UPDATE rssd_migrations SET state=\'reconciling\',"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,siteId);
   return {state:'reconciling',processed:promotions.length,pending:await pendingPromotions(db,ctx.orgId,row.workspaceId)};
  });
 }
 async activate(ctx,siteId,evidence){
  admin(ctx);p.id(siteId);validateEvidence(evidence,siteId);
  return this.store.transaction(async db=>{
   const row=(await q(db,'SELECT * FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2 FOR UPDATE',ctx.orgId,siteId))[0];
   if(!row)p.fail('Migration not found',404);
   if(row.state==='active'){
    const pending=(await q(db,`SELECT 1 FROM rssd_staged_drafts d WHERE d."orgId"=$1 AND d."workspaceId"=$2 AND d."overlayRevision"=(SELECT max(s."overlayRevision") FROM rssd_staged_drafts s WHERE s."orgId"=d."orgId" AND s."workspaceId"=d."workspaceId" AND s."workId"=d."workId" AND s.locale=d.locale) AND NOT EXISTS (SELECT 1 FROM rssd_staged_draft_promotions t WHERE t."orgId"=d."orgId" AND t."workspaceId"=d."workspaceId" AND t."workId"=d."workId" AND t.locale=d.locale AND t."overlayRevision"=d."overlayRevision") LIMIT 1`,ctx.orgId,row.workspaceId))[0];
    if(pending)p.fail('Private staged drafts must be reconciled before activation',409,'staged_drafts_unreconciled');
    if(row.report.cutover?.evidenceHash===p.hash(evidence))return row.report;
    p.fail('This migration was already activated with different evidence',409,'identity_conflict');
   }
   if(!['staged','reconciling'].includes(row.state))p.fail('Import and verify the final snapshot first',409);
   assertEvidence(row,evidence);
   if(row.state==='reconciling')await assertPlan(db,ctx,row,evidence);
   if(await pendingPromotions(db,ctx.orgId,row.workspaceId))p.fail('Private staged drafts require reconciliation before activation',409,'staged_drafts_unreconciled');
   const checked=await new RssdMigration({...this.store,db},this.media).verify(ctx,row.manifest,{excludePromoted:row.state==='reconciling'});
   if(checked.editionIndexSha256!==row.report.editionIndexSha256)p.fail('Imported editions changed after verification',409,'stale_snapshot');
   const report={...checked,state:'active',dispatchEnabled:false,cutover:{...evidence,evidenceHash:p.hash(evidence),activatedAt:new Date().toISOString(),actor:ctx.userId||'owner'}};
   if(row.state==='reconciling'){
    const promotions=await q(db,'SELECT "workId",locale,"overlayRevision","canonicalRevision","canonicalHash","requestId" FROM rssd_staged_draft_promotions WHERE "orgId"=$1 AND "workspaceId"=$2 ORDER BY "workId",locale,"overlayRevision"',ctx.orgId,row.workspaceId);
    report.stagedDraftReconciliation={count:promotions.length,sha256:p.hash(promotions),plan:row.report.reconciliation,at:new Date().toISOString()};
   }
   await x(db,`UPDATE rssd_migrations SET state='active',report=$3::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND "siteId"=$2`,ctx.orgId,siteId,JSON.stringify(report));
   return report;
  });
 }
 async import(ctx,directory){
  admin(ctx);directory=resolve(directory);
  const read=async descriptor=>{const file=resolve(directory,descriptor.path);if(!file.startsWith(directory+sep))p.fail('Unsafe migration path');const bytes=await readFile(file);if(hash(bytes)!==descriptor.sha256)p.fail('Migration file checksum mismatch: '+descriptor.path,409);return bytes;};
  const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
  if(manifest.version!==1||manifest.workspace.siteId!==manifest.site.id||manifest.workspace.id!==manifest.site.spaceId)p.fail('Invalid migration manifest');
  const siteId=p.id(manifest.site.id),workspaceId=p.id(manifest.workspace.id),previous=await this.inspect(ctx,siteId);
  const generation=randomUUID();
  if(previous?.state==='active')p.fail('An active workspace cannot accept a legacy import',409,'migration_state_changed');
  if(previous&&!['staged','staging'].includes(previous.state))p.fail('A workspace in reconciliation cannot accept a legacy import',409,'migration_state_changed');
  // Validate every file before changing the database. A corrupt bundle cannot partially replace a staged import.
  await read(manifest.baseline);const ancillary=JSON.parse(await read(manifest.ancillary));
  const verifiedDocuments=new Map();
  for(const document of manifest.documents){const value=JSON.parse(await read(document));if(value.sourceHash!==p.hash(value.source)||document.sourceHash!==value.sourceHash||value.workId!==document.workId||value.siteId!==siteId||value.workspaceId!==workspaceId||value.source.document.id!==document.documentId)p.fail('Legacy identity or source hash mismatch',409);const latest=value.editions?.reduce((a,b)=>!a||b.revision>a.revision?b:a,null);verifiedDocuments.set(document.documentId,{sourceHash:value.sourceHash,revision:latest?.revision,hash:latest?.hash});}
  for(const media of manifest.media)await read({path:media.path,sha256:media.manifest.sha256});
  // Serialize the state transition with staged-draft saves. A private branch
  // survives import only when the final source is exactly the captured base.
  await this.store.transaction(async db=>{
   // saveWorkspace uses this same lock. A new workspace and its fence must
   // become visible together; an already writable workspace without a fence
   // cannot be taken over while old submissions may still be in flight.
   await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':workspace:'+workspaceId);
   await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':migration-import:'+siteId);
   const row=(await q(db,'SELECT state,"workspaceId",manifest,"importGeneration",("importLeaseUntil">CURRENT_TIMESTAMP) AS leased FROM rssd_migrations WHERE "orgId"=$1 AND "siteId"=$2 FOR UPDATE',ctx.orgId,siteId))[0];
   const live=(await q(db,'SELECT payload FROM rssd_workspaces WHERE "orgId"=$1 AND id=$2',ctx.orgId,workspaceId))[0];
   if((await q(db,'SELECT 1 FROM rssd_migrations WHERE "orgId"=$1 AND "workspaceId"=$2 AND "siteId"<>$3 LIMIT 1',ctx.orgId,workspaceId,siteId))[0])p.fail('Workspace already belongs to another migration',409,'identity_conflict');
   if(!row&&live)p.fail('An existing writable workspace needs a separately fenced migration bootstrap',409,'migration_bootstrap_required');
   if(row&&row.workspaceId!==workspaceId)p.fail('Migration workspace identity changed',409,'identity_conflict');
   if(live&&p.hash(live.payload.sections)!==p.hash(p.workspace(manifest.workspace).sections))p.fail('Migration workspace rules differ from staged rules',409);
   if(row?.state==='active')p.fail('An active workspace cannot accept a legacy import',409,'migration_state_changed');
   if(row&&!['staged','staging'].includes(row.state))p.fail('A workspace in reconciliation cannot accept a legacy import',409,'migration_state_changed');
   if(row?.state==='staging'&&row.leased)p.fail('Another final import is still running; retain the original snapshot',409,'import_in_progress');
   if(row?.state==='staging'&&!row.importGeneration)p.fail('An older unguarded import needs independent recovery before retry',409,'import_owner_unknown');
   if(row?.state==='staging'&&p.hash(row.manifest)!==p.hash(manifest))p.fail('An interrupted import must resume its original snapshot',409,'import_plan_changed');
   const staged=await q(db,`SELECT DISTINCT ON ("workId",locale) "workId",locale,"baseRevision","baseHash","baseSourceHash","basePublishedVersion" FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 ORDER BY "workId",locale,"overlayRevision" DESC`,ctx.orgId,workspaceId);
   for(const draft of staged){
    const found=manifest.documents.filter(d=>d.workId===draft.workId&&d.locale===draft.locale);
    const descriptor=found.length===1?found[0]:null,value=descriptor&&verifiedDocuments.get(descriptor.documentId);
    if(!descriptor||!value||descriptor.deleted||value.sourceHash!==draft.baseSourceHash||value.revision!==draft.baseRevision||value.hash!==draft.baseHash||(descriptor.publishedRevision??null)!==draft.basePublishedVersion)
     p.fail('The final legacy snapshot conflicts with a private staged draft; retain both for reconciliation',409,'staged_reconcile_conflict');
   }
   await x(db,`INSERT INTO rssd_migrations ("orgId","siteId","workspaceId",state,manifest,ancillary,"importGeneration","importLeaseUntil") VALUES ($1,$2,$3,'staging',$4::jsonb,$5::jsonb,$6,CURRENT_TIMESTAMP+interval '5 minutes')
    ON CONFLICT ("orgId","siteId") DO UPDATE SET state='staging',manifest=EXCLUDED.manifest,ancillary=EXCLUDED.ancillary,"importGeneration"=EXCLUDED."importGeneration","importLeaseUntil"=EXCLUDED."importLeaseUntil","updatedAt"=CURRENT_TIMESTAMP`,ctx.orgId,siteId,workspaceId,JSON.stringify(manifest),JSON.stringify(ancillary),generation);
   if(!live){const nested=new RssdStore(db);nested.transaction=fn=>fn(db);await nested.saveWorkspace(ctx,manifest.workspace);}
  });
  for(const item of manifest.media){
   const bytes=await read({path:item.path,sha256:item.manifest.sha256});
   await this.store.transaction(async db=>{
    await guardImport(db,ctx,siteId,generation);
    const scoped=new RssdStore(db);scoped.transaction=fn=>fn(db);
    const media=new this.media.constructor(scoped,{directory:this.media.directory,origin:this.media.origin});
    const result=await media.upload(ctx,{workspaceId,name:item.path,...item.manifest,data:bytes.toString('base64')});
    if(result.id!==item.id)p.fail('Imported media identity differs',409);
   });
  }
  for(const descriptor of manifest.documents){
   const value=JSON.parse(await read(descriptor));
   await this.store.transaction(async db=>{
    await guardImport(db,ctx,siteId,generation);
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
  return this.store.transaction(async db=>{
   await guardImport(db,ctx,siteId,generation);
   const report=await new RssdMigration({...this.store,db},this.media).verify(ctx,manifest);
   await x(db,`UPDATE rssd_migrations SET state='staged',report=$3::jsonb,"importGeneration"=NULL,"importLeaseUntil"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND "siteId"=$2`,ctx.orgId,siteId,JSON.stringify(report));return report;
  });
 }
 async verify(ctx,manifest,{excludePromoted=false}={}){
  const documents=await q(this.store.db,'SELECT "documentId","workId",locale,"sourceHash","deletedAt" FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,manifest.site.id);
  if(documents.length!==manifest.documents.length)p.fail('Legacy document count differs',409);
  for(const item of manifest.documents){
   const row=documents.find(d=>d.documentId===item.documentId);if(!row||row.workId!==item.workId||row.locale!==item.locale||row.sourceHash!==item.sourceHash||Boolean(row.deletedAt)!==item.deleted)p.fail('Legacy document verification failed',409);
   const archived=(await q(this.store.db,'SELECT source FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2 AND "documentId"=$3',ctx.orgId,manifest.site.id,item.documentId))[0];
   if(p.hash(archived.source)!==item.sourceHash)p.fail('Archived legacy source hash differs',409);
  }
  let editions=await q(this.store.db,'SELECT e."workId",e.locale,e.revision,e.hash FROM rssd_editions e JOIN rssd_works w ON e."orgId"=w."orgId" AND e."workId"=w.id WHERE w."orgId"=$1 AND w."workspaceId"=$2',ctx.orgId,manifest.workspace.id);
  if(excludePromoted){
   const promotions=await q(this.store.db,`SELECT t.*,e.hash AS "editionHash",e.payload AS "editionPayload",s.result AS "submissionResult",d."baseHash" AS "draftBaseHash",d."baseRevision" AS "draftBaseRevision",d."articleId" AS "draftArticleId" FROM rssd_staged_draft_promotions t
     LEFT JOIN rssd_editions e ON e."orgId"=t."orgId" AND e."workId"=t."workId" AND e.locale=t.locale AND e.revision=t."canonicalRevision"
     LEFT JOIN rssd_submissions s ON s."orgId"=t."orgId" AND s."requestId"=t."requestId"
     LEFT JOIN rssd_staged_drafts d ON d."orgId"=t."orgId" AND d."workspaceId"=t."workspaceId" AND d."workId"=t."workId" AND d.locale=t.locale AND d."overlayRevision"=t."overlayRevision"
     WHERE t."orgId"=$1 AND t."workspaceId"=$2`,ctx.orgId,manifest.workspace.id);
   const promoted=new Set();
   for(const item of promotions){
    const key=item.workId+'\0'+item.locale+'\0'+item.canonicalRevision;
    const expected='staged-promote-'+p.hash([manifest.workspace.id,item.workId,item.locale,item.overlayRevision,item.baseHash]).slice(0,48);
    const receipt=item.submissionResult;
    if(promoted.has(key)||item.requestId!==expected||item.canonicalRevision!==item.baseRevision+1||item.baseHash!==item.draftBaseHash||item.baseRevision!==item.draftBaseRevision||item.articleId!==item.draftArticleId||!item.canonicalHash||item.editionHash!==item.canonicalHash||!item.editionPayload||p.hash(p.edition(item.editionPayload))!==item.canonicalHash||receipt?.status!=='draft_saved'||receipt?.workId!==item.workId||receipt?.publicationIds?.length!==0||receipt?.editions?.length!==1||receipt.editions[0].revision!==item.canonicalRevision||receipt.editions[0].hash!==item.canonicalHash)p.fail('A staged promotion cannot be verified; retain the migration fence',409,'reconcile_plan_changed');
    promoted.add(key);
   }
   editions=editions.filter(item=>!promoted.has(item.workId+'\0'+item.locale+'\0'+item.revision));
  }
  if(editions.length!==manifest.counts.revisions)p.fail('Edition revision count differs',409);
  return {siteId:manifest.site.id,workspaceId:manifest.workspace.id,counts:manifest.counts,sourceDatabaseSha256:manifest.databaseSha256,editionIndexSha256:p.hash(editions.sort((a,b)=>p.canonical(a).localeCompare(p.canonical(b)))),verifiedAt:new Date().toISOString(),state:'staged',dispatchEnabled:false};
 }
}
module.exports={RssdMigration};
