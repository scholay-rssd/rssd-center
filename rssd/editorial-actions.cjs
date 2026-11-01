'use strict';
const {randomUUID}=require('node:crypto');
const p=require('./protocol.cjs');
const {RssdStore}=require('./store.cjs');
const {publication,publicContent,contentKey}=require('./publication.cjs');
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args),x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args);
const lock=(db,key)=>x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',key);
class RssdEditorialActions {
 constructor(store,media,publisher,editorial){this.store=store;this.media=media;this.publisher=publisher;this.editorial=editorial;this.running=false;}
 async list(ctx,workspaceId){
  await this.editorial.workspace(ctx,workspaceId);
  const rows=await q(this.store.db,'SELECT "requestKey" FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workspaceId"=$2 ORDER BY "createdAt" DESC LIMIT 200',ctx.orgId,workspaceId);
  const items=[];for(const row of rows)items.push(await this.status(ctx,workspaceId,row.requestKey));return {items};
 }
 async status(ctx,workspaceId,key){
  await this.editorial.workspace(ctx,workspaceId);p.id(key);
  const row=(await q(this.store.db,'SELECT * FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3',ctx.orgId,workspaceId,key))[0];
  if(!row){
   const legacy=(await q(this.store.db,`SELECT l.source,l."documentId",a.value AS action FROM rssd_legacy_documents l JOIN rssd_works w ON w."orgId"=l."orgId" AND w.id=l."workId",
    LATERAL jsonb_array_elements(l.source->'actions') a WHERE l."orgId"=$1 AND w."workspaceId"=$2 AND a.value->>'key'=$3`,ctx.orgId,workspaceId,key))[0];
   if(!legacy)p.fail('Original action not found',404,'not_found');
   const old=legacy.action,doc=legacy.source.document,latest=JSON.parse(legacy.source.revisions.at(-1).payload),job=(legacy.source.jobs||[]).find(j=>j.id===old.job_id)||null;
   return {requestKey:key,action:old.action,articleId:doc.kind==='news'?latest.id:'record-'+legacy.documentId,version:doc.latest_revision,publishedVersion:doc.published_revision,url:doc.permalink,job,deleted:Boolean(legacy.source.tombstone),status:job?.status||'success',centerManaged:true,legacy:true};
  }
  const current=await this.editorial.find(ctx,workspaceId,row.payload.articleId,{allowDeleted:true});
  const status=row.state==='published'?'success':row.state==='dispatching'?'running':row.state==='queued'?'queued':'failed';
  return {requestKey:key,action:row.action,articleId:row.payload.articleId,version:current?.revision||row.payload.revision,
   publishedVersion:current?.publishedVersion??null,url:row.payload.route,job:{id:row.id,status,error:row.error,release:row.receipt.release||row.receipt.releaseId||null},
   deleted:Boolean(current?.deletedAt),draftRestored:Boolean(row.receipt.draftRestored),requiresExplicitPublish:Boolean(row.receipt.draftRestored&&current?.visibility==='withdrawn'),superseded:row.state==='superseded',status,centerManaged:true};
 }
 async submit(ctx,workspaceId,input){
  p.object(input,'editorial action');if(input.confirmed!==true||!['publish','withdraw','delete','restore'].includes(input.action))p.fail('Explicitly confirm the website action');
  if(!/^[a-zA-Z0-9_-]{12,128}$/.test(input.requestKey||''))p.fail('Provide a stable original action key');
  p.id(input.articleId);p.integer(input.expectedVersion,'expectedVersion',1);if(input.expectedPublishedVersion!==null)p.integer(input.expectedPublishedVersion,'expectedPublishedVersion',1);
  const fingerprint=p.hash([input.articleId,input.action,input.expectedVersion,input.expectedPublishedVersion]);
  await this.store.transaction(async db=>{
   await lock(db,ctx.orgId+':editorial-action:'+workspaceId+':'+input.requestKey);
   const old=(await q(db,'SELECT * FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3',ctx.orgId,workspaceId,input.requestKey))[0];
   if(old){if(old.payloadHash!==fingerprint)p.fail('Action key belongs to another operation',409,'request_conflict');return;}
   const nested=new RssdStore(db);nested.transaction=fn=>fn(db);const editorial=new this.editorial.constructor(nested,this.media);
   const workspace=await editorial.workspace(ctx,workspaceId);await nested.writable(db,ctx,workspaceId);
   if(ctx.workerId&&!(await q(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId)).length)p.fail('Device revoked',401);
   const migrated=(await q(db,`SELECT l."documentId" FROM rssd_legacy_documents l JOIN rssd_works w ON w."orgId"=l."orgId" AND w.id=l."workId",
    LATERAL jsonb_array_elements(l.source->'actions') a WHERE l."orgId"=$1 AND w."workspaceId"=$2 AND a.value->>'key'=$3`,ctx.orgId,workspaceId,input.requestKey))[0];
   if(migrated)p.fail('This original action was migrated; query its preserved receipt instead of submitting it again',409,'legacy_action_exists');
   let row=await editorial.find(ctx,workspaceId,input.articleId,{allowDeleted:true});if(!row)p.fail('Manuscript not found',404);
   await lock(db,ctx.orgId+':work:'+row.workId);
   await q(db,'SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 FOR UPDATE',ctx.orgId,row.workId,row.locale);
   row=await editorial.find(ctx,workspaceId,input.articleId,{allowDeleted:true});
   if(row.revision!==input.expectedVersion||(row.publishedVersion??null)!==input.expectedPublishedVersion)p.fail('Center content or public state changed; reload before confirming the action',409,'revision_conflict');
   if(row.deletedAt&&input.action!=='restore')p.fail('Restore this deleted edition explicitly before editing or publishing',409,'edition_deleted');
   if(input.action==='restore'&&!row.deletedAt&&row.visibility!=='withdrawn')p.fail('Only withdrawn or deleted editions can be restored',409,'invalid_action');
   if(input.action==='withdraw'&&!row.publishedVersion)p.fail('This website edition is not currently public',409,'invalid_action');
   if(input.action==='publish'&&row.publishedVersion===row.revision)p.fail('This edition is already public',409,'invalid_action');
   const destinationId='site-'+workspace.siteId;
   const pending=(await q(db,`SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('queued','dispatching')
    UNION ALL SELECT id FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND state IN ('queued','dispatching')`,ctx.orgId,row.workId,row.locale,destinationId))[0];
   if(pending)p.fail('Query the existing website operation before starting another',409,'publication_pending');
   const destination=(await q(db,'SELECT * FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,destinationId))[0];
   if(!destination||destination.kind!=='site'||!destination.enabled||!destination.workspaceIds.includes(workspaceId))p.fail('Website destination is not configured for this workspace',409,'missing_destination');
   if(input.action==='publish'){
    const {section}=await nested.workspace(db,ctx,workspaceId,row.sectionId);
    if(!section.policy.targets.some(t=>t.destinationId===destinationId&&t.locale===row.locale))p.fail('This section has no website destination for the requested language',409,'missing_destination');
   }
   const prior=(await q(db,'SELECT * FROM rssd_editorial_states WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,row.workId,row.locale))[0];
   let publicRevision=row.revision,restoreAsDraft=false,restoreVisibility='active';
   if(input.action==='restore'){
    const deleted=Boolean(row.deletedAt),previous=deleted?prior?.previousVisibility:prior?.visibility;
    const lastPublished=(await q(db,`SELECT max(revision) AS revision FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('published','legacy_published')`,ctx.orgId,row.workId,row.locale,destinationId))[0]?.revision||null;
    const approved=deleted?prior?.previousPublishedVersion:lastPublished;
    if(deleted&&(previous==='withdrawn'||!approved)||!deleted&&!lastPublished){restoreAsDraft=true;restoreVisibility=previous==='withdrawn'?'withdrawn':'active';}
    else publicRevision=approved||lastPublished||row.revision;
   }
   const edition=(await nested.edition(ctx,row.workId,row.locale,publicRevision)).payload;
   const payload={articleId:row.articleId,revision:row.revision,publicRevision,sectionId:row.sectionId,route:row.url,edition,hash:p.hash(edition),previousVisibility:row.visibility||'active',wasPublished:Boolean(row.publishedVersion),
    expectedPublishedVersion:input.expectedPublishedVersion,expectedVisibilityGeneration:row.visibilityGeneration||0,
    expectedReceiverOperationSequence:row.publishedVersion?row.publishedReceipt?.latestVisibilityAction?.operationSequence??row.publishedReceipt?.operationSequence??0:prior?.operationSequence??null,restoreAsDraft,restoreVisibility};
   await x(db,`INSERT INTO rssd_editorial_actions ("orgId",id,"workspaceId","requestKey","payloadHash","workId",locale,"destinationId",action,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,ctx.orgId,'action-'+p.hash([workspaceId,input.requestKey]).slice(0,48),workspaceId,input.requestKey,fingerprint,row.workId,row.locale,destinationId,input.action,JSON.stringify(payload));
  });return this.status(ctx,workspaceId,input.requestKey);
 }
 async assertBase(db,row){
  if(!Object.hasOwn(row.payload,'expectedPublishedVersion')||!Object.hasOwn(row.payload,'expectedVisibilityGeneration'))p.fail('Original action base is missing; reconcile its retained request before retry',409,'action_base_missing');
  await lock(db,row.orgId+':work:'+row.workId);
  await q(db,'SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 FOR UPDATE',row.orgId,row.workId,row.locale);
  const nested=new RssdStore(db);nested.transaction=fn=>fn(db);const editorial=new this.editorial.constructor(nested,this.media);
  const current=await editorial.find({orgId:row.orgId,admin:true,workspaceIds:null},row.workspaceId,row.payload.articleId,{allowDeleted:true});
  if(!current||current.revision!==row.payload.revision||(current.publishedVersion??null)!==row.payload.expectedPublishedVersion||(current.visibilityGeneration||0)!==row.payload.expectedVisibilityGeneration)p.fail('A newer edition or visibility decision superseded this action; its original request is retained',409,'stale_action');
  const pending=(await q(db,`SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('queued','dispatching')
   UNION ALL SELECT id FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND id<>$5 AND state IN ('queued','dispatching')`,row.orgId,row.workId,row.locale,row.destinationId,row.id))[0];
  if(pending)p.fail('Another website operation is pending; preserve this original action',409,'publication_pending');
 }
 async retry(ctx,workspaceId,key,input){
  const current=await this.status(ctx,workspaceId,key);
  if(input?.confirmed!==true||input.jobId!==current.job?.id)p.fail('Explicitly confirm retry of the original website action',409,'request_conflict');
  if(current.legacy)p.fail('Reconcile the original legacy action before resuming at the center',409,'legacy_handoff_required');
  await this.store.transaction(async db=>{
   await this.store.writable(db,ctx,workspaceId);
   const row=(await q(db,'SELECT * FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3 FOR UPDATE',ctx.orgId,workspaceId,key))[0];
   if(!row||row.id!==input.jobId)p.fail('Original website action not found',404);
   if(row.state!=='blocked')return;
   await this.assertBase(db,row);
   if(ctx.workerId&&!(await q(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId)).length)p.fail('Device revoked',401);
   await x(db,`UPDATE rssd_editorial_actions SET state='queued',error=NULL,receipt=receipt || '{"manualRetry":true}'::jsonb,"nextAttemptAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2`,ctx.orgId,row.id);
  });return this.status(ctx,workspaceId,key);
 }
 async claim(orgId){return this.store.transaction(async db=>{
  const row=(await q(db,`SELECT * FROM rssd_editorial_actions WHERE state IN ('queued','dispatching') AND "nextAttemptAt"<=CURRENT_TIMESTAMP AND ($1::text IS NULL OR "orgId"=$1)
   AND ("leaseUntil" IS NULL OR "leaseUntil"<CURRENT_TIMESTAMP) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`,orgId))[0];
  if(!row)return null;const leaseToken=randomUUID();
  await x(db,`UPDATE rssd_editorial_actions SET state='dispatching',attempts=attempts+1,"leaseToken"=$3,"leaseUntil"=CURRENT_TIMESTAMP+interval '90 seconds',"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2`,row.orgId,row.id,leaseToken);
  return {...row,leaseToken,attempts:row.attempts+1};
 });}
 async finish(row,{state,receipt=row.receipt,error=null,delay=10000,packet=row.packet,visibility}={}){
  return this.store.transaction(async db=>{
   const current=(await q(db,'SELECT * FROM rssd_editorial_actions WHERE "orgId"=$1 AND id=$2 FOR UPDATE',row.orgId,row.id))[0];
   if(!current||current.leaseToken!==row.leaseToken)return {id:row.id,state:'lease_lost'};
   if(state==='published'){
    await this.assertBase(db,row);
    const previous=(await q(db,'SELECT * FROM rssd_editorial_states WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',row.orgId,row.workId,row.locale))[0];
    const next=visibility||(row.action==='withdraw'?'withdrawn':row.action==='delete'?'deleted':'active');
    await x(db,`INSERT INTO rssd_editorial_states ("orgId","workId",locale,visibility,"previousVisibility","previousPublishedVersion",generation,"operationSequence") VALUES ($1,$2,$3,$4,$5,$6,1,$7)
     ON CONFLICT ("orgId","workId",locale) DO UPDATE SET visibility=EXCLUDED.visibility,"previousVisibility"=EXCLUDED."previousVisibility","previousPublishedVersion"=EXCLUDED."previousPublishedVersion",generation=rssd_editorial_states.generation+1,"operationSequence"=EXCLUDED."operationSequence","updatedAt"=CURRENT_TIMESTAMP`,row.orgId,row.workId,row.locale,next,['delete','withdraw'].includes(row.action)?row.payload.previousVisibility:previous?.previousVisibility||null,['delete','withdraw'].includes(row.action)?row.payload.expectedPublishedVersion:previous?.previousPublishedVersion||null,receipt.operationSequence||previous?.operationSequence||0);
    if(next==='active'&&!receipt.localOnly){
     const pubReceipt={...receipt,url:row.payload.origin+row.payload.route};
     await x(db,`INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",state,payload,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8::jsonb,$9::jsonb)
      ON CONFLICT ("orgId","workId",locale,revision,"destinationId") DO UPDATE SET state='published',receipt=rssd_publications.receipt || jsonb_build_object('latestVisibilityAction',EXCLUDED.receipt),error=NULL,"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=CURRENT_TIMESTAMP`,row.orgId,row.id,row.workId,row.workspaceId,row.locale,row.payload.publicRevision||row.payload.revision,row.destinationId,JSON.stringify({edition:row.payload.edition,sectionId:row.payload.sectionId,hash:row.payload.hash,policyVersion:0}),JSON.stringify(pubReceipt));
    }
   }
   await x(db,`UPDATE rssd_editorial_actions SET state=$3,receipt=$4::jsonb,error=$5,packet=$6::jsonb,"leaseToken"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=CURRENT_TIMESTAMP+($7*interval '1 millisecond'),"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2`,row.orgId,row.id,state,JSON.stringify(receipt),error,packet?JSON.stringify(packet):null,delay);
   return {id:row.id,state,error};
  });
 }
 async dispatch(row){
  const destination=(await q(this.store.db,'SELECT * FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',row.orgId,row.destinationId))[0];
  if(!destination?.enabled||destination.kind!=='site'||!destination.workspaceIds.includes(row.workspaceId))p.fail('Website action destination is disabled or changed',409,'missing_destination');
  const config=destination.config,token=this.publisher.cipher().open(config.sealedToken,row.orgId+':'+destination.id),base=config.origin+'/api/rssd-receiver/v1/sites/'+encodeURIComponent(config.siteId);
  row.payload.origin=config.origin;
  let receipt;try{receipt=await this.publisher.request(base+'/submissions/'+row.id,{token});}catch(error){if(error.status!==404)throw error;}
  let packet=row.packet;
  if(!receipt&&!packet){
   await this.store.transaction(db=>this.assertBase(db,row));
   let head;try{head=await this.publisher.request(base+'/heads/'+encodeURIComponent(row.workId)+'/'+encodeURIComponent(row.locale),{token});}catch(error){if(error.status!==404)throw error;}
   if(!head&&['withdraw','delete','restore'].includes(row.action)){
    const published=(await q(this.store.db,`SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('published','legacy_published') LIMIT 1`,row.orgId,row.workId,row.locale,row.destinationId))[0];
    if(row.action==='withdraw'||published)p.fail('Published receiver identity is missing; reconcile its original release before changing visibility',409,'receiver_head_missing');
    return this.finish(row,{state:'published',visibility:row.action==='delete'?'deleted':'active',receipt:{requestId:row.id,localOnly:true,draftRestored:row.action==='restore',operation:row.action,operationSequence:0}});
   }
   if(head&&(head.workId!==row.workId||head.locale!==row.locale||head.siteId!==config.siteId||head.route!==row.payload.route))p.fail('Receiver head belongs to another edition or permanent route',409,'identity_conflict');
   if(head?.state&&!['legacy','success'].includes(head.state))p.fail('The receiver has an unfinished or failed original request; reconcile it before changing visibility',409,'receiver_request_pending');
   const expectedPublic=row.payload.expectedPublishedVersion;
   if(head&&(expectedPublic!==null?(head.revision!==expectedPublic||['withdraw','delete'].includes(head.operation)):head.revision>0&&!['withdraw','delete'].includes(head.operation)))p.fail('Receiver public revision differs from the confirmed action base; reconcile its original publication first',409,'receiver_head_conflict');
   if(head&&row.payload.expectedReceiverOperationSequence!==null&&head.operationSequence!==row.payload.expectedReceiverOperationSequence)p.fail('Receiver visibility changed after action confirmation',409,'receiver_head_conflict');
   if(row.action==='restore'&&row.payload.restoreAsDraft)return this.finish(row,{state:'published',visibility:head&&['delete','withdraw'].includes(head.operation)?'withdrawn':row.payload.restoreVisibility,receipt:{requestId:row.id,localOnly:true,draftRestored:true,operation:row.action,operationSequence:head?.operationSequence||0}});
   // A legacy revision-zero identity has never supplied a public edition.
   // Recover its manuscript without publishing it. A pre-existing receiver
   // tombstone stays fenced until a separate explicit publish action clears it.
   if(head?.revision===0&&['delete','restore'].includes(row.action)){
    return this.finish(row,{state:'published',visibility:row.action==='delete'?'deleted':['withdraw','delete'].includes(head.operation)?'withdrawn':'active',
     receipt:{requestId:row.id,localOnly:true,draftRestored:row.action==='restore',operation:row.action,operationSequence:head.operationSequence||0}});
   }
   const prepared=await this.media.publication(row.orgId,row.workspaceId,row.payload.edition),content=publicContent(prepared.edition);
   if(!content.metadata.date)content.metadata.date=new Date(row.createdAt).toISOString().slice(0,10);
   const hidden=head&&['withdraw','delete'].includes(head.operation),operation=row.action==='publish'?(hidden?'restore':null):row.action;
   let hash=row.payload.hash;
   if(['withdraw','delete'].includes(operation)){
    if(head.contentHash)hash=head.contentHash;
    else if(head.revision>0){const archived=await this.store.edition({orgId:row.orgId,admin:true,workspaceIds:null},row.workId,row.locale,head.revision);hash=archived.hash;}
   }
   packet=publication({version:1,requestId:row.id,siteId:config.siteId,workspaceId:row.workspaceId,sectionId:row.payload.sectionId,workId:row.workId,locale:row.locale,
    revision:['withdraw','delete'].includes(operation)?head.revision:row.payload.publicRevision||row.payload.revision,contentHash:hash,route:head?.route||row.payload.route,
    operationSequence:(head?.operationSequence||0)+1,
    ...(operation?{operation,operationSequence:(head?.operationSequence||0)+1,expectedOperationSequence:head?.operationSequence||0,expectedRevision:head?.revision||0}:{}),
    ...(!['withdraw','delete'].includes(operation)?{content,...(prepared.assets.length?{assets:prepared.assets}:{})}:{})});
   const changed=await x(this.store.db,'UPDATE rssd_editorial_actions SET packet=$4::jsonb WHERE "orgId"=$1 AND id=$2 AND "leaseToken"=$3',row.orgId,row.id,row.leaseToken,JSON.stringify(packet));
   if(!changed)return {id:row.id,state:'lease_lost'};row.packet=packet;
  }
  if(!packet)p.fail('Original action packet is missing; retain its receiver receipt',409,'receipt_conflict');
  if(!receipt){
   if(!['withdraw','delete'].includes(packet.operation))for(const asset of packet.assets||[]){
    const media=await this.media.row({orgId:row.orgId,admin:true,workspaceIds:null},require('./rssd-media.cjs').mediaId(row.workspaceId,asset.sha256));
    const url=base+'/media/'+asset.sha256;let stored;try{stored=await this.publisher.request(url,{token});}catch(error){if(error.status!==404)throw error;const {bytes}=await this.media.bytes({orgId:row.orgId,admin:true,workspaceIds:null},media.id);stored=await this.publisher.request(url,{token,method:'POST',body:{...asset,data:bytes.toString('base64')}});}
    if(p.hash(stored)!==p.hash(asset))p.fail('Receiver media identity mismatch',409,'media_conflict');
   }
   receipt=await this.publisher.request(base+'/submissions',{token,method:'POST',body:packet});
  }
  const matches=value=>value.requestId===row.id&&value.siteId===config.siteId&&value.workId===row.workId&&value.locale===row.locale&&value.revision===packet.revision&&value.contentHash===packet.contentHash&&value.packetHash===p.hash(packet)&&value.operation===(packet.operation||'publish')&&value.operationSequence===packet.operationSequence;
  if(!matches(receipt))p.fail('Website action receipt does not match its frozen original packet',409,'receipt_conflict');
  if(receipt.state==='failed'&&row.receipt.manualRetry){receipt=await this.publisher.request(base+'/submissions/'+row.id+'/retry',{token,method:'POST',body:{}});if(!matches(receipt))p.fail('Website action retry receipt changed its original identity',409,'receipt_conflict');}
  row.receipt=receipt;
  if(receipt.state==='failed')return this.finish(row,{state:'blocked',receipt,error:'Website action build failed: '+String(receipt.error||'unknown failure').slice(0,1000)});
  if(receipt.state!=='success')return this.finish(row,{state:'queued',receipt,packet});
  const readback=await this.publisher.request(config.origin+'/rssd-content/'+contentKey(packet)+'.json');
  if(p.hash(readback)!==p.hash(packet)){
   const head=await this.publisher.request(base+'/heads/'+encodeURIComponent(row.workId)+'/'+encodeURIComponent(row.locale),{token});
   if(Number.isSafeInteger(head.operationSequence)&&head.operationSequence>receipt.operationSequence)return this.finish(row,{state:'superseded',receipt,packet,error:'A newer website operation superseded this original action; its receipt is retained'});
   return this.finish(row,{state:'queued',receipt,packet,error:'Public action record has not converged',delay:30000});
  }
  if(['withdraw','delete'].includes(packet.operation)){
   const response=await this.publisher.fetch(config.origin+packet.route,{redirect:'error',signal:AbortSignal.timeout(30000)});
   if(![404,410].includes(response.status))return this.finish(row,{state:'queued',receipt,packet,error:'Public article is still visible',delay:30000});
  }
  return this.finish(row,{state:'published',receipt:{...receipt,verifiedAt:new Date().toISOString()},packet});
 }
 async tick({orgId=null}={}){
  if(this.running)return null;this.running=true;let row;
  try{row=await this.claim(orgId);if(!row)return null;return await this.dispatch(row);}
  catch(error){if(!row)throw error;const blocked=error instanceof p.ProtocolError||[400,401,403,409,422].includes(error.status);return this.finish(row,{state:blocked?'blocked':'queued',error:blocked?String(error.message).slice(0,1000):'Receiver unavailable; the original action will be queried before retry',delay:30000});}
  finally{this.running=false;}
 }
}
module.exports={RssdEditorialActions};
