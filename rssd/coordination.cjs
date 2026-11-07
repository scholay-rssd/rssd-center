'use strict';
const {randomUUID}=require('node:crypto');
const p=require('./protocol.cjs');
const {scope,admin}=require('./store.cjs');
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args);
const x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args);
const one=async(...args)=>(await q(...args))[0]||null;
const json=JSON.stringify;
const TRANSLATE_CONTINUATION_VERSION=1;
const TRANSLATE_CONTINUATION_GUARANTEES=Object.freeze(['sourceHash','currentHead','uniqueOpenWork','claimLease','englishOnly','sourceChangeReject','receipt']);
function translateContinuationContract(){return {version:TRANSLATE_CONTINUATION_VERSION,guarantees:[...TRANSLATE_CONTINUATION_GUARANTEES]};}
function supportsTranslateContinuation(overview){
 const row=overview?.contracts?.translateContinuation;
 if(!row||typeof row!=='object'||Array.isArray(row)||!Number.isInteger(row.version)||row.version<TRANSLATE_CONTINUATION_VERSION||!Array.isArray(row.guarantees))return false;
 return TRANSLATE_CONTINUATION_GUARANTEES.every(token=>row.guarantees.includes(token));
}
const STORE_ONLY_TRANSLATE_VERSION=1;
const STORE_ONLY_TRANSLATE_GUARANTEES=Object.freeze(['storeOnlyFrozen','zeroPublications','exclusiveWorkerClaim','intentRequired','noClaimSteal','leaseRecovery','englishOnly','sourceBind','receipt']);
function storeOnlyTranslateContract(){return {version:STORE_ONLY_TRANSLATE_VERSION,guarantees:[...STORE_ONLY_TRANSLATE_GUARANTEES]};}
function supportsStoreOnlyTranslate(overview){
 const row=overview?.contracts?.storeOnlyTranslate;
 if(!row||typeof row!=='object'||Array.isArray(row)||!Number.isInteger(row.version)||row.version<STORE_ONLY_TRANSLATE_VERSION||!Array.isArray(row.guarantees))return false;
 return STORE_ONLY_TRANSLATE_GUARANTEES.every(token=>row.guarantees.includes(token));
}
function date(value,name){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))p.fail('Invalid '+name);return new Date(value).toISOString();}
function page(input={}){const limit=p.integer(Number(input.limit??50),'limit',1,200),offset=p.integer(Number(input.offset??0),'offset',0,1000000);return {limit,offset};}
function windowFor(timezone,period,now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
 const d=new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
 if(period==='week')d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
 if(period==='month')d.setUTCDate(1);
 const start=d.toISOString().slice(0,10);if(period==='month')d.setUTCMonth(d.getUTCMonth()+1);else d.setUTCDate(d.getUTCDate()+(period==='week'?7:1));
 return {start,end:d.toISOString().slice(0,10)};
}
async function audit(db,ctx,action,payload){await x(db,'INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,randomUUID(),ctx.workerId||ctx.userId||'center',action,json(payload));}
class RssdCoordination {
 constructor(store){this.store=store;this.db=store.db;this.running=false;}
 async selection(ctx,input={}){
  const registry=await this.store.registry(ctx),allowed=registry.workspaces.map(w=>w.id);
  const ids=input.workspaceIds?String(input.workspaceIds).split(',').filter(Boolean):input.workspaceId?[input.workspaceId]:allowed;
  for(const id of ids){scope(ctx,p.id(id));if(!allowed.includes(id))p.fail('Workspace not found',404,'not_found');}
  return {registry,ids:[...new Set(ids)]};
 }
 async once(ctx,requestId,input,run){
  p.id(requestId,'requestId');const hash=p.hash(input);
  return this.store.transaction(async db=>{
   await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':coordination:'+requestId);
   const old=await one(db,'SELECT * FROM rssd_coordination_requests WHERE "orgId"=$1 AND id=$2',ctx.orgId,requestId);
   if(old){if(old.hash!==hash)p.fail('Original request contains different content',409,'request_conflict');return old.result;}
   if(ctx.workerId&&!await one(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId))p.fail('Device revoked',401,'unauthorized');
   const result=await run(db);
   await x(db,'INSERT INTO rssd_coordination_requests ("orgId",id,hash,result) VALUES ($1,$2,$3,$4::jsonb)',ctx.orgId,requestId,hash,json(result));return result;
  });
 }
 async editDemand(ctx,id,input){
  p.id(id);p.integer(input.baseGeneration,'baseGeneration');
  const check=await one(this.db,'SELECT "workspaceId" FROM rssd_demands WHERE "orgId"=$1 AND id=$2',ctx.orgId,id);if(!check)p.fail('Demand not found',404,'not_found');scope(ctx,check.workspaceId);
  return this.once(ctx,input.requestId,{action:'demand.edit',id,...input},async db=>{
   const old=await one(db,'SELECT * FROM rssd_demands WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,id);
   if(old.generation!==input.baseGeneration)p.fail('需求已变化，请保留修改并重新加载',409,'revision_conflict');
   if(old.state!=='queued')p.fail('认领后写作规则已冻结',409,'demand_frozen');
   if(Object.prototype.hasOwnProperty.call(input.changes||{},'storeOnly')||Object.prototype.hasOwnProperty.call(input.changes||{},'storeOnlyWorkerId'))
    p.fail('Store-only intent is frozen',409,'identity_conflict');
   await this.store.writable(db,ctx,old.workspaceId);
   const value=p.demand({...old.payload,...input.changes,id,workspaceId:old.workspaceId,sectionId:old.sectionId,kind:old.kind,source:old.payload.source});
   if(old.kind==='translate' && value.source){
    value.requiredLocales=[...new Set(value.requiredLocales.filter(locale=>locale!==value.source.locale))];
    if(!value.requiredLocales.length)p.fail('Translation demand needs a target locale');
   }
   const dueAt=input.changes?.dueAt===null?null:input.changes?.dueAt?date(input.changes.dueAt,'dueAt'):old.payload.dueAt||null;
   const payload={...old.payload,...value,dueAt};
   if(old.payload.storeOnly===true){payload.storeOnly=true;payload.storeOnlyWorkerId=old.payload.storeOnlyWorkerId;}
   else {delete payload.storeOnly;delete payload.storeOnlyWorkerId;}
   const result=await one(db,'UPDATE rssd_demands SET title=$3,priority=$4,payload=$5::jsonb,generation=generation+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 RETURNING *',ctx.orgId,id,value.title,value.priority,json(payload));
   delete result.claimToken;await audit(db,ctx,'demand.edit',{id,generation:result.generation,requestId:input.requestId});return result;
  });
 }
 async goals(ctx,input={}){
  const {ids}=await this.selection(ctx,input);const found=await q(this.db,'SELECT * FROM rssd_goals WHERE "orgId"=$1 AND "workspaceId" IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY "workspaceId",id',ctx.orgId,json(ids));
  return Promise.all(found.map(async goal=>({...goal,...await this.progress(this.db,goal)})));
 }
 async progress(db,goal,now=new Date()){
  const period=windowFor(goal.payload.timezone,goal.payload.period,now);
  const counts=await one(db,`SELECT count(DISTINCT payload->>'workId') FILTER (WHERE state='completed')::int AS completed,
   count(*) FILTER (WHERE state IN ('queued','claimed','blocked'))::int AS pending FROM rssd_demands WHERE "orgId"=$1 AND payload->>'goalId'=$2 AND payload->>'goalPeriod'=$3`,goal.orgId,goal.id,period.start);
  const publications=await one(db,`SELECT count(*)::int AS count FROM rssd_publications WHERE "orgId"=$1 AND state IN ('published','legacy_published') AND "workId" IN (SELECT payload->>'workId' FROM rssd_demands WHERE "orgId"=$1 AND payload->>'goalId'=$2 AND payload->>'goalPeriod'=$3)`,goal.orgId,goal.id,period.start);
  return {period,completed:counts.completed,pending:counts.pending,published:publications.count};
 }
 async saveGoal(ctx,input){
  admin(ctx);p.id(input.id);p.integer(input.baseRevision,'baseRevision');const value=input.goal||{};
  const workspaceId=p.id(value.workspaceId),sectionId=p.id(value.sectionId);await this.store.workspace(this.db,ctx,workspaceId,sectionId);
  if(!['day','week','month'].includes(value.period))p.fail('Invalid goal period');
  try{new Intl.DateTimeFormat('en',{timeZone:value.timezone}).format();}catch{p.fail('Invalid timezone');}
  if(typeof value.timezone!=='string'||!value.timezone)p.fail('Timezone required');
  const payload={period:value.period,timezone:value.timezone,target:p.integer(value.target,'target',0,1000),
   requiredLocales:p.array(value.requiredLocales,'requiredLocales',2).map(p.locale),title:p.text(value.title,'title',400),brief:p.text(value.brief||'','brief',50000,true),enabled:value.enabled===true};
  if(!payload.requiredLocales.length)p.fail('Select a language');
  return this.once(ctx,input.requestId,{action:'goal.save',...input},async db=>{
   await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':goal:'+input.id);
   const old=await one(db,'SELECT * FROM rssd_goals WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,input.id);
   if((old?.revision||0)!==input.baseRevision)p.fail('Goal changed; reload',409,'revision_conflict');
   if(old&&(old.workspaceId!==workspaceId||old.sectionId!==sectionId))p.fail('Goal scope is immutable',409,'identity_conflict');
   if(payload.enabled)await this.store.writable(db,ctx,workspaceId);
   const result=await one(db,`INSERT INTO rssd_goals ("orgId",id,"workspaceId","sectionId",revision,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT ("orgId",id) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,"updatedAt"=CURRENT_TIMESTAMP RETURNING *`,ctx.orgId,input.id,workspaceId,sectionId,input.baseRevision+1,json(payload));
   await audit(db,ctx,'goal.save',{id:input.id,revision:result.revision,enabled:payload.enabled});return result;
  });
 }
 async maintainGoal(orgId,id,now=new Date()){
  return this.store.transaction(async db=>{
   const goal=await one(db,'SELECT * FROM rssd_goals WHERE "orgId"=$1 AND id=$2 FOR UPDATE',orgId,id);
   if(!goal?.payload.enabled)return {state:'paused',created:0};
   const ctx={orgId,admin:true,workspaceIds:null,userId:'center-goal-maintainer'};
   try{await this.store.writable(db,ctx,goal.workspaceId);}catch(e){if(e.code==='migration_staged')return {state:'migration_staged',created:0};throw e;}
   const {row}=await this.store.workspace(db,ctx,goal.workspaceId,goal.sectionId),progress=await this.progress(db,goal,now);
   const deficit=Math.max(0,goal.payload.target-progress.completed-progress.pending),created=Math.min(deficit,20);
   for(let i=0;i<created;i++){
    const demand=p.demand({workspaceId:goal.workspaceId,sectionId:goal.sectionId,title:goal.payload.title,brief:goal.payload.brief,requiredLocales:goal.payload.requiredLocales});
    await x(db,`INSERT INTO rssd_demands ("orgId",id,"workspaceId","sectionId",kind,title,priority,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,orgId,demand.id,goal.workspaceId,goal.sectionId,demand.kind,demand.title,demand.priority,json({...demand,goalId:id,goalRevision:goal.revision,goalPeriod:progress.period.start,goalTimezone:goal.payload.timezone,goalPeriodEnd:progress.period.end,workspaceRevision:row.revision}));
   }
   const result={state:'ready',created,reason:created?'目标尚有缺口，补充待领取需求':'已有完成作品及在途任务覆盖目标',...progress,checkedAt:now.toISOString()};
   await x(db,'UPDATE rssd_goals SET status=$3::jsonb WHERE "orgId"=$1 AND id=$2',orgId,id,json(result));
   if(created)await audit(db,ctx,'goal.refill',{id,...result});return result;
  });
 }
 async tick(){if(this.running)return;this.running=true;try{const goals=await q(this.db,"SELECT \"orgId\",id FROM rssd_goals WHERE payload->>'enabled'='true' ORDER BY \"updatedAt\" LIMIT 100");for(const goal of goals)await this.maintainGoal(goal.orgId,goal.id);}finally{this.running=false;}}
 async channels(ctx,input={}){
  const {ids}=await this.selection(ctx,input);
  const destinations=await q(this.db,'SELECT id,name,kind,enabled,"workspaceIds",config FROM rssd_destinations WHERE "orgId"=$1 AND "workspaceIds" ?| $2::text[] ORDER BY name,id',ctx.orgId,ids);
  const channels=await q(this.db,`SELECT id,name,"providerIdentifier",disabled,"refreshNeeded" FROM "Integration" WHERE "organizationId"=$1 AND "deletedAt" IS NULL AND ($2::boolean OR id IN (SELECT config->>'integrationId' FROM rssd_destinations WHERE "orgId"=$1 AND "workspaceIds" ?| $3::text[])) ORDER BY name,id`,ctx.orgId,ctx.admin&&ids.length===(await this.store.registry(ctx)).workspaces.length,ids);
  return {destinations:destinations.map(d=>({id:d.id,name:d.name,kind:d.kind,enabled:d.enabled,workspaceIds:d.workspaceIds.filter(id=>ids.includes(id)),origin:d.config.origin||null,integrationId:d.kind==='postiz'?d.config.integrationId:null})),channels};
 }
 async calendar(ctx,input={}){
  const {ids}=await this.selection(ctx,input),{limit,offset}=page(input);
  const from=date(input.from||new Date(Date.now()-31*86400000).toISOString(),'from'),to=date(input.to||new Date(Date.now()+62*86400000).toISOString(),'to');
  if(Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>367*86400000)p.fail('Calendar range must be between 1 and 367 days');
  const values=[ctx.orgId,json(ids),from,to];
  const sql=`WITH events AS (
   SELECT 'rssd:'||r.id AS id,'rssd' AS source,r.id AS "publicationId",r."workId",r."workspaceId",r.locale,r.revision,r."destinationId",d.name AS destination,r.payload->'edition'->>'title' AS title,r.state,
    COALESCE((r.payload->>'scheduledAt')::timestamptz,r."createdAt") AS "scheduledAt",r."updatedAt",r.receipt,r.error,(r.payload ? 'scheduledAt') AS "hasSchedule" FROM rssd_publications r LEFT JOIN rssd_destinations d ON d."orgId"=r."orgId" AND d.id=r."destinationId" WHERE r."orgId"=$1 AND r."workspaceId" IN (SELECT jsonb_array_elements_text($2::jsonb))
   UNION ALL
   SELECT 'postiz:'||p.id,'postiz',p.id,NULL,NULL,NULL,NULL,p."integrationId",i.name,COALESCE(p.title,left(p.content,180)),p.state::text,p."publishDate",p."updatedAt",jsonb_build_object('url',p."releaseURL",'releaseId',p."releaseId"),p.error,(p.state::text<>'DRAFT') FROM "Post" p JOIN "Integration" i ON i.id=p."integrationId" AND i."organizationId"=p."organizationId"
    WHERE p."organizationId"=$1 AND p."deletedAt" IS NULL AND p."parentPostId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM rssd_publications r WHERE r."orgId"=$1 AND (r.receipt->'postiz'->>'postId'=p.id OR r.receipt->>'postId'=p.id))
    AND ($5::boolean OR EXISTS (SELECT 1 FROM rssd_destinations d WHERE d."orgId"=$1 AND d.kind='postiz' AND d.config->>'integrationId'=p."integrationId" AND d."workspaceIds" ?| ARRAY(SELECT jsonb_array_elements_text($2::jsonb))))
   ) SELECT *,count(*) OVER()::int AS "totalCount" FROM events WHERE "scheduledAt">=$3::timestamptz AND "scheduledAt"<$4::timestamptz ORDER BY "scheduledAt",id LIMIT $6 OFFSET $7`;
  const all=(await this.store.registry(ctx)).workspaces.length;
  const rows=await q(this.db,sql,...values,Boolean(ctx.admin&&ids.length===all),limit+1,offset);
  return {items:rows.slice(0,limit).map(({totalCount,...r})=>r),hasNext:rows.length>limit,total:rows[0]?.totalCount||0,limit,offset,from,to};
 }
 async authorizeSchedule(ctx,db,workspaceId,destinationId){
  if(ctx.admin)return;
  if(!ctx.workerId)p.fail('Owner access required',403,'forbidden');
  if(!await one(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId))p.fail('Device revoked',401,'unauthorized');
  const grant=await one(db,`SELECT id FROM rssd_worker_grants WHERE "orgId"=$1 AND "workerId"=$2 AND operation='publicationScheduling'
    AND "revokedAt" IS NULL AND "workspaceIds" ? $3 AND "destinationIds" ? $4`,ctx.orgId,ctx.workerId,workspaceId,destinationId);
  if(!grant)p.fail('Owner access required',403,'forbidden');
 }
 async grantCapability(ctx,input){
  admin(ctx);p.id(input.workerId,'workerId');
  const operation=p.text(input.operation,'operation',80);
  if(operation!=='publicationScheduling')p.fail('Unsupported capability');
  const workspaceIds=[...new Set(p.array(input.workspaceIds,'workspaceIds').map(id=>p.id(id)))].sort();
  const destinationIds=[...new Set(p.array(input.destinationIds,'destinationIds').map(id=>p.id(id)))].sort();
  if(!workspaceIds.length||!destinationIds.length)p.fail('Select at least one workspace and destination');
  return this.once(ctx,input.requestId,{action:'worker.grant',workerId:input.workerId,operation,workspaceIds,destinationIds},async db=>{
   const worker=await one(db,'SELECT * FROM rssd_workers WHERE "orgId"=$1 AND id=$2',ctx.orgId,input.workerId);
   if(!worker||worker.revokedAt)p.fail('Device not found',404,'not_found');
   for(const workspaceId of workspaceIds){
    if(!worker.workspaceIds.includes(workspaceId))p.fail('Grant exceeds the device workspace scope',403,'forbidden');
    scope(ctx,workspaceId);await this.store.workspace(db,ctx,workspaceId);
   }
   for(const destinationId of destinationIds){
    const destination=await one(db,'SELECT id,"workspaceIds" FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,destinationId);
    if(!destination)p.fail('Destination not found',404,'not_found');
    if(!destination.workspaceIds.some(id=>workspaceIds.includes(id)))p.fail('Destination is not configured for the granted workspaces',400,'invalid_destination');
   }
   const existing=await one(db,`SELECT * FROM rssd_worker_grants WHERE "orgId"=$1 AND "workerId"=$2 AND operation=$3 AND "revokedAt" IS NULL
     AND "workspaceIds"=$4::jsonb AND "destinationIds"=$5::jsonb`,ctx.orgId,input.workerId,operation,json(workspaceIds),json(destinationIds));
   if(existing)return existing;
   const result=await one(db,`INSERT INTO rssd_worker_grants ("orgId",id,"workerId",operation,"workspaceIds","destinationIds","grantedBy")
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id,"workerId",operation,"workspaceIds","destinationIds","grantedBy","revokedAt","createdAt"`,
     ctx.orgId,randomUUID(),input.workerId,operation,json(workspaceIds),json(destinationIds),ctx.userId||'owner');
   await audit(db,ctx,'worker.grant',{id:result.id,workerId:input.workerId,operation,workspaceIds,destinationIds});return result;
  });
 }
 async revokeCapability(ctx,input){
  admin(ctx);p.id(input.id);
  return this.once(ctx,input.requestId,{action:'worker.grant.revoke',id:input.id},async db=>{
   const row=await one(db,'SELECT * FROM rssd_worker_grants WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,input.id);
   if(!row)p.fail('Grant not found',404,'not_found');
   if(row.revokedAt)return {id:row.id,workerId:row.workerId,operation:row.operation,workspaceIds:row.workspaceIds,destinationIds:row.destinationIds,revokedAt:row.revokedAt};
   const result=await one(db,'UPDATE rssd_worker_grants SET "revokedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 RETURNING id,"workerId",operation,"workspaceIds","destinationIds","grantedBy","revokedAt","createdAt"',ctx.orgId,input.id);
   await audit(db,ctx,'worker.grant.revoke',{id:input.id,workerId:row.workerId,operation:row.operation});return result;
  });
 }
 async schedule(ctx,id,input){
  p.id(id);const scheduledAt=date(input.scheduledAt,'scheduledAt');
  return this.once(ctx,input.requestId,{action:'publication.schedule',id,...input},async db=>{
   const row=await one(db,'SELECT * FROM rssd_publications WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,id);
   if(!row)p.fail('Publication not found',404,'not_found');scope(ctx,row.workspaceId);
   await this.authorizeSchedule(ctx,db,row.workspaceId,row.destinationId);
   if(new Date(row.updatedAt).toISOString()!==input.expectedUpdatedAt)p.fail('Publication changed',409,'revision_conflict');
   if(row.state!=='queued'||row.leaseToken||row.attempts||row.receipt?.postiz)p.fail('原发布已开始，请在原发布入口处理',409,'publication_started');
   await this.store.writable(db,ctx,row.workspaceId);
   const result=await one(db,'UPDATE rssd_publications SET payload=payload || $3::jsonb,"nextAttemptAt"=$4::timestamptz,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 RETURNING id,payload,"updatedAt"',ctx.orgId,id,json({scheduledAt}),scheduledAt);
   await audit(db,ctx,'publication.schedule',{id,scheduledAt});return result;
  });
 }
 async overview(ctx,input={}){
  const {registry,ids}=await this.selection(ctx,input);
  const counts=await q(this.db,`SELECT "workspaceId",state,count(*)::int AS count FROM rssd_demands WHERE "orgId"=$1 AND "workspaceId" IN (SELECT jsonb_array_elements_text($2::jsonb)) GROUP BY "workspaceId",state`,ctx.orgId,json(ids));
  const works=await q(this.db,`SELECT "workspaceId",count(*)::int AS count FROM rssd_works WHERE "orgId"=$1 AND "workspaceId" IN (SELECT jsonb_array_elements_text($2::jsonb)) GROUP BY "workspaceId"`,ctx.orgId,json(ids));
  const goals=await this.goals(ctx,input);
  const publicationScheduling=Boolean(ctx.admin)||(ctx.grants||[]).some(grant=>grant.operation==='publicationScheduling'&&grant.workspaceIds.some(id=>ids.includes(id)));
  return {contractVersion:1,generatedAt:new Date().toISOString(),workspaces:registry.workspaces.filter(w=>ids.includes(w.id)),counts,works,goals,
   capabilities:{goalManagement:Boolean(ctx.admin),publicationScheduling,demandEditing:true,mcp:true},
   contracts:{translateContinuation:translateContinuationContract(),storeOnlyTranslate:storeOnlyTranslateContract()},
   nativePaths:{calendar:'/launches',media:'/media',analytics:'/analytics',agents:'/agents',settings:'/settings'}};
 }
}
module.exports={RssdCoordination,windowFor,page,TRANSLATE_CONTINUATION_VERSION,TRANSLATE_CONTINUATION_GUARANTEES,translateContinuationContract,supportsTranslateContinuation,STORE_ONLY_TRANSLATE_VERSION,STORE_ONLY_TRANSLATE_GUARANTEES,storeOnlyTranslateContract,supportsStoreOnlyTranslate};
