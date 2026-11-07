'use strict';
const {randomUUID, randomBytes} = require('node:crypto');
const p = require('./protocol.cjs');
const encoded = value => JSON.stringify(value);
const rows = (db, sql, ...params) => db.$queryRawUnsafe(sql, ...params);
const execute = (db, sql, ...params) => db.$executeRawUnsafe(sql, ...params);
async function one(db, sql, ...params) { return (await rows(db, sql, ...params))[0] || null; }
const lock = (db, key) => execute(db, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', key);
function scope(ctx, workspaceId) {
  if (!ctx?.orgId) p.fail('Authentication required', 401, 'unauthorized');
  if (ctx.workspaceIds !== null && !ctx.workspaceIds?.includes(workspaceId)) p.fail('Workspace access denied', 403, 'forbidden');
}
function admin(ctx) { if (!ctx?.admin || !ctx.orgId) p.fail('Owner access required', 403, 'forbidden'); }
function safeDemand(row) { if (!row) return null; const {claimToken, ...rest} = row; return rest; }
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
function localeKey(list) { return [...list].sort().join(','); }
function schedulingGranted(ctx) {
  return Boolean(ctx?.admin) || (ctx.grants || []).some(grant => grant.operation === 'publicationScheduling');
}
function pageNumber(value,name,min,max) {
  if(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value))value=Number(value);
  return p.integer(value,name,min,max);
}
async function audit(db, ctx, action, payload) {
  await execute(db, 'INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,randomUUID(),ctx.workerId || ctx.userId || 'owner',action,encoded(payload));
}
class RssdStore {
  constructor(db) { this.db = db; }
  transaction(fn) { return this.db.$transaction(fn, {maxWait:10000,timeout:20000}); }
  async writable(db,ctx,workspaceId) {
    const migration=await one(db,'SELECT state FROM rssd_migrations WHERE "orgId"=$1 AND "workspaceId"=$2',ctx.orgId,workspaceId);
    if(migration&&migration.state!=='active')p.fail('This workspace is staged for migration; its original writer is still active',409,'migration_staged');
  }
  async workspace(db, ctx, workspaceId, sectionId) {
    scope(ctx, workspaceId);
    const row = await one(db, 'SELECT * FROM rssd_workspaces WHERE "orgId"=$1 AND id=$2',ctx.orgId,workspaceId);
    if (!row) p.fail('Workspace not found',404,'not_found');
    const section = row.payload.sections.find(s => s.id === sectionId);
    if (sectionId && !section) p.fail('Section not found',404,'not_found');
    return {row,section};
  }
  async workSection(db,ctx,workspaceId,sectionId,workId) {
    const {row}=await this.workspace(db,ctx,workspaceId);
    const section=row.payload.sections.find(s=>s.id===sectionId);
    if(section)return {row,section};
    // Retired columns are available only to an already imported work. They
    // cannot be selected for a new work, demand, or another workspace.
    const legacy=workId&&await one(db,`SELECT m.manifest FROM rssd_works w
      JOIN rssd_legacy_documents l ON l."orgId"=w."orgId" AND l."workId"=w.id
      JOIN rssd_migrations m ON m."orgId"=l."orgId" AND m."siteId"=l."siteId" AND m."workspaceId"=w."workspaceId"
      WHERE w."orgId"=$1 AND w."workspaceId"=$2 AND w.id=$3 AND w."sectionId"=$4 LIMIT 1`,ctx.orgId,workspaceId,workId,sectionId);
    const archived=legacy?.manifest?.compatibilitySections?.find(s=>s.id===sectionId);
    if(!archived)p.fail('Section not found',404,'not_found');
    const destinationId='site-'+row.payload.siteId;
    const targets=[...new Map(row.payload.sections.flatMap(s=>s.policy.targets)
      .filter(t=>t.destinationId===destinationId).map(t=>[t.destinationId+':'+t.locale,t])).values()];
    return {row,section:{id:sectionId,name:archived.name,policy:{version:1,targets}}};
  }
  async registry(ctx) {
    const all = await rows(this.db,'SELECT w.*,m.state AS "migrationState" FROM rssd_workspaces w LEFT JOIN rssd_migrations m ON m."orgId"=w."orgId" AND m."workspaceId"=w.id WHERE w."orgId"=$1 ORDER BY w.id',ctx.orgId);
    return {protocolVersion:p.VERSION,workspaces:all.filter(w => ctx.workspaceIds === null || ctx.workspaceIds.includes(w.id)).map(w => ({...w.payload,revision:w.revision,migrationState:w.migrationState||null,writable:!w.migrationState||w.migrationState==='active'}))};
  }
  async saveWorkspace(ctx, input, baseRevision = 0) {
    admin(ctx); const value=p.workspace(input);p.integer(baseRevision,'baseRevision');
    return this.transaction(async db => {
      await lock(db,ctx.orgId+':workspace:'+value.id);
      const old=await one(db,'SELECT revision FROM rssd_workspaces WHERE "orgId"=$1 AND id=$2',ctx.orgId,value.id);
      if ((old?.revision || 0)!==baseRevision) p.fail('Workspace changed; reload before saving',409,'revision_conflict');
      for(const section of value.sections) await this.validateTargets(db,ctx,value.id,section.policy);
      const result=await one(db,`INSERT INTO rssd_workspaces ("orgId",id,revision,payload) VALUES ($1,$2,$3,$4::jsonb)
        ON CONFLICT ("orgId",id) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,"updatedAt"=CURRENT_TIMESTAMP RETURNING *`,ctx.orgId,value.id,baseRevision+1,encoded(value));
      await audit(db,ctx,'workspace.save',{id:value.id,revision:result.revision});return {...result.payload,revision:result.revision};
    });
  }
  async validateTargets(db,ctx,workspaceId,policy) {
    for(const target of policy.targets) {
      const destination=await one(db,'SELECT "workspaceIds" FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,target.destinationId);
      if(!destination || !destination.workspaceIds.includes(workspaceId)) p.fail('Destination is not configured for this workspace',400,'invalid_destination');
    }
  }
  async createWorker(ctx, input) {
    admin(ctx);const name=p.text(input.name,'worker name',200);
    const workspaceIds=[...new Set(p.array(input.workspaceIds,'workspaceIds').map(x=>p.id(x)))];
    if(!workspaceIds.length)p.fail('Select at least one workspace');
    for(const workspaceId of workspaceIds)await this.workspace(this.db,ctx,workspaceId);
    const id=randomUUID(),token='rssd_device_'+randomBytes(36).toString('base64url');
    await execute(this.db,'INSERT INTO rssd_workers ("orgId",id,name,"tokenHash","workspaceIds") VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,id,name,p.hash(token),encoded(workspaceIds));
    return {id,name,workspaceIds,token};
  }
  async authenticate(token) {
    if(typeof token!=='string'||!/^rssd_device_[A-Za-z0-9_-]{48}$/.test(token))p.fail('Invalid device credential',401,'unauthorized');
    const worker=await one(this.db,'SELECT * FROM rssd_workers WHERE "tokenHash"=$1 AND "revokedAt" IS NULL',p.hash(token));
    if(!worker)p.fail('Device credential revoked or unknown',401,'unauthorized');
    const grants=await rows(this.db,'SELECT id,operation,"workspaceIds","destinationIds" FROM rssd_worker_grants WHERE "orgId"=$1 AND "workerId"=$2 AND "revokedAt" IS NULL ORDER BY "createdAt",id',worker.orgId,worker.id);
    return {orgId:worker.orgId,workerId:worker.id,workspaceIds:worker.workspaceIds,admin:false,grants};
  }
  async workers(ctx) {
    admin(ctx);
    const list=await rows(this.db,'SELECT id,name,"workspaceIds",state,details,"heartbeatAt","revokedAt" FROM rssd_workers WHERE "orgId"=$1 ORDER BY "createdAt"',ctx.orgId);
    const grants=await rows(this.db,'SELECT id,"workerId",operation,"workspaceIds","destinationIds","grantedBy","revokedAt","createdAt" FROM rssd_worker_grants WHERE "orgId"=$1 ORDER BY "createdAt",id',ctx.orgId);
    return list.map(worker=>({...worker,grants:grants.filter(grant=>grant.workerId===worker.id)}));
  }
  async expireStaleClaims(db,orgId) {
    const expired=await rows(db,`UPDATE rssd_demands SET state='queued',"workerId"=NULL,"claimToken"=NULL,generation=generation+1,
      payload=(payload - 'claimExpiresAt') || jsonb_build_object('lastError','claim_expired'),"updatedAt"=CURRENT_TIMESTAMP
      WHERE "orgId"=$1 AND state IN ('claimed','blocked') AND payload ? 'claimExpiresAt'
      AND (payload->>'claimExpiresAt')::timestamptz < CURRENT_TIMESTAMP RETURNING id`,orgId);
    if(expired.length)await audit(db,{orgId,userId:'center'},'demand.expire',{ids:expired.map(row=>row.id)});
  }
  async revokeWorker(ctx,id) {
    admin(ctx);p.id(id);
    // Revocation prevents writes immediately; existing claims require explicit release.
    await execute(this.db,'UPDATE rssd_workers SET "revokedAt"=CURRENT_TIMESTAMP,state=$3 WHERE "orgId"=$1 AND id=$2',ctx.orgId,id,'revoked');
    return {revoked:true};
  }
  async heartbeat(ctx,input) {
    if(!ctx.workerId)p.fail('Device authentication required',403);
    if(!['idle','running','blocked','paused'].includes(input.state))p.fail('Invalid worker state');
    const details={agentId:p.text(input.agentId || '', 'agentId',200,true),version:p.text(input.version || '', 'version',100,true),
      message:p.text(input.message || '', 'message',2000,true)};
    await execute(this.db,'UPDATE rssd_workers SET state=$3,details=$4::jsonb,"heartbeatAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId,input.state,encoded(details));
    return {ok:true};
  }
  async createDemand(ctx,input) {
    const value=p.demand(input);await this.workspace(this.db,ctx,value.workspaceId,value.sectionId);
    await this.writable(this.db,ctx,value.workspaceId);
    if(!value.source){
      const result=await one(this.db,`INSERT INTO rssd_demands ("orgId",id,"workspaceId","sectionId",kind,title,priority,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT ("orgId",id) DO NOTHING RETURNING *`,ctx.orgId,value.id,value.workspaceId,value.sectionId,value.kind,value.title,value.priority,encoded(value));
      if(!result)p.fail('Demand identity already exists',409,'identity_conflict');
      return {...safeDemand(result),status:'created'};
    }
    return this.transaction(async db=>{
      await lock(db,ctx.orgId+':work:'+value.source.workId);
      const source=await one(db,'SELECT * FROM rssd_works WHERE "orgId"=$1 AND id=$2',ctx.orgId,value.source.workId);
      if(!source)p.fail('Work not found',404,'not_found');scope(ctx,source.workspaceId);
      if(source.workspaceId!==value.workspaceId)p.fail('Source workspace differs');
      if(source.sectionId!==value.sectionId)p.fail('Source section differs');
      const edition=await one(db,'SELECT revision,hash FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4',ctx.orgId,value.source.workId,value.source.locale,value.source.revision);
      if(!edition)p.fail('Source revision not found',404,'not_found');
      let requiredLocales=value.requiredLocales;
      if(value.kind==='translate'){
        requiredLocales=[...new Set(value.requiredLocales.filter(locale=>locale!==value.source.locale))];
        if(!requiredLocales.length)p.fail('Translation demand needs a target locale');
      }
      const present=(await rows(db,'SELECT DISTINCT locale FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2',ctx.orgId,value.source.workId)).map(row=>row.locale);
      if(value.kind==='translate' && requiredLocales.every(locale=>present.includes(locale))){
        return {status:'skipped',reason:'locale_present',workId:value.source.workId,workspaceId:value.workspaceId,requiredLocales,existingLocales:present};
      }
      const payload={...value,requiredLocales,sourceHash:edition.hash};
      const open=await rows(db,`SELECT * FROM rssd_demands WHERE "orgId"=$1 AND kind=$2 AND "workspaceId"=$3 AND state IN ('queued','claimed','blocked')
        AND payload->'source'->>'workId'=$4`,ctx.orgId,value.kind,value.workspaceId,value.source.workId);
      const existing=open.find(row=>row.payload.source?.locale===value.source.locale && row.payload.source?.revision===value.source.revision
        && row.payload.sourceHash===edition.hash && localeKey(row.payload.requiredLocales||[])===localeKey(requiredLocales));
      if(existing)return {...safeDemand(existing),status:'existing'};
      const result=await one(db,`INSERT INTO rssd_demands ("orgId",id,"workspaceId","sectionId",kind,title,priority,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT ("orgId",id) DO NOTHING RETURNING *`,ctx.orgId,value.id,value.workspaceId,value.sectionId,value.kind,value.title,value.priority,encoded(payload));
      if(!result){
        const old=await one(db,'SELECT * FROM rssd_demands WHERE "orgId"=$1 AND id=$2',ctx.orgId,value.id);
        if(old && old.kind===value.kind && old.payload.source?.workId===value.source.workId)return {...safeDemand(old),status:'existing'};
        p.fail('Demand identity already exists',409,'identity_conflict');
      }
      await audit(db,ctx,'demand.create',{id:result.id,kind:value.kind,workId:value.source.workId});
      return {...safeDemand(result),status:'created'};
    });
  }
  async demands(ctx,{workspaceId,state,search='',limit=100,offset=0}={}) {
    if(workspaceId)scope(ctx,p.id(workspaceId));limit=pageNumber(limit,'limit',1,200);offset=pageNumber(offset,'offset',0,1000000);p.text(search,'search',500,true);
    const found=await rows(this.db,`SELECT * FROM rssd_demands WHERE "orgId"=$1
      AND ($2::text IS NULL OR "workspaceId"=$2) AND ($3::text IS NULL OR state=$3)
      AND ($4::jsonb IS NULL OR "workspaceId" IN (SELECT jsonb_array_elements_text($4::jsonb)))
      AND ($5='' OR title ILIKE '%' || $5 || '%' OR payload->>'brief' ILIKE '%' || $5 || '%') ORDER BY priority DESC,"createdAt",id LIMIT $6 OFFSET $7`,ctx.orgId,workspaceId||null,state||null,ctx.workspaceIds===null?null:encoded(ctx.workspaceIds),search,limit,offset);
    return found.map(safeDemand);
  }
  async claim(ctx,input={}) {
    if(!ctx.workerId)p.fail('Device authentication required',403);
    const workspaceIds=input.workspaceIds ? p.array(input.workspaceIds,'workspaceIds').map(x=>p.id(x)) : ctx.workspaceIds;
    workspaceIds.forEach(id=>scope(ctx,id));
    const sectionIds=p.array(input.sectionIds || [],'sectionIds').map(x=>p.id(x));
    const demandId=input.demandId?p.id(input.demandId):null;
    return this.transaction(async db=>{
      await lock(db,ctx.orgId+':worker:'+ctx.workerId);
      const worker=await one(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId);
      if(!worker)p.fail('Device revoked',401);
      await this.expireStaleClaims(db,ctx.orgId);
      const active=await one(db,`SELECT id FROM rssd_demands WHERE "orgId"=$1 AND "workerId"=$2 AND state IN ('claimed','blocked')`,ctx.orgId,ctx.workerId);
      if(active)p.fail('Finish, resume or release the current demand first',409,'worker_busy');
      const demand=await one(db,`SELECT * FROM rssd_demands d WHERE "orgId"=$1 AND state='queued'
        AND "workspaceId" IN (SELECT jsonb_array_elements_text($2::jsonb))
        AND NOT EXISTS (SELECT 1 FROM rssd_migrations m WHERE m."orgId"=d."orgId" AND m."workspaceId"=d."workspaceId" AND m.state<>'active')
        AND ($3::text IS NULL OR id=$3) AND ($4='[]' OR "sectionId" IN (SELECT jsonb_array_elements_text($4::jsonb)))
        ORDER BY priority DESC,"createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`,ctx.orgId,encoded(workspaceIds),demandId,encoded(sectionIds));
      if(!demand){
        if(demandId){
          const held=await one(db,'SELECT id,state FROM rssd_demands WHERE "orgId"=$1 AND id=$2',ctx.orgId,demandId);
          if(held && ['claimed','blocked'].includes(held.state))p.fail('Demand is claimed by another device',409,'claim_conflict');
        }
        return null;
      }
      const {row,section}=await this.workspace(db,ctx,demand.workspaceId,demand.sectionId);
      const destinations=[];
      for(const target of section.policy.targets){
        const destination=await one(db,'SELECT id,name,kind,config FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,target.destinationId);
        if(!destination)continue;
        const channel=destination.kind==='postiz'?await one(db,'SELECT "providerIdentifier" FROM "Integration" WHERE "organizationId"=$1 AND id=$2',ctx.orgId,destination.config.integrationId):null;
        destinations.push({...target,name:destination.name,kind:destination.kind,...(channel?{platform:channel.providerIdentifier}:{})});
      }
      const claimToken=randomUUID(),payload={...demand.payload,policy:section.policy,workspaceRevision:row.revision,destinations,outputContractVersion:1,claimExpiresAt:new Date(Date.now()+CLAIM_TTL_MS).toISOString()};
      const result=await one(db,`UPDATE rssd_demands SET state='claimed',"workerId"=$3,"claimToken"=$4,generation=generation+1,
        payload=$5::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 RETURNING *`,ctx.orgId,demand.id,ctx.workerId,claimToken,encoded(payload));
      await audit(db,ctx,'demand.claim',{id:demand.id,generation:result.generation});return result;
    });
  }
  async activeClaim(ctx) {
    if(!ctx.workerId)p.fail('Device authentication required',403);
    return this.transaction(async db=>{
      await this.expireStaleClaims(db,ctx.orgId);
      return one(db,`SELECT * FROM rssd_demands WHERE "orgId"=$1 AND "workerId"=$2 AND state IN ('claimed','blocked')`,ctx.orgId,ctx.workerId);
    });
  }
  async changeDemand(ctx,id,input) {
    p.id(id);if(!['release','cancel','blocked','resume'].includes(input.action))p.fail('Invalid demand action');
    return this.transaction(async db=>{
      const demand=await one(db,'SELECT * FROM rssd_demands WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,id);
      if(!demand)p.fail('Demand not found',404);scope(ctx,demand.workspaceId);
      if(!ctx.admin && (demand.workerId!==ctx.workerId || demand.claimToken!==input.claimToken))p.fail('Claim no longer belongs to this device',409,'claim_revoked');
      if(['completed','cancelled'].includes(demand.state))p.fail('Demand is already closed',409);
      const clear=['release','cancel'].includes(input.action),state={release:'queued',cancel:'cancelled',blocked:'blocked',resume:'claimed'}[input.action];
      if(!clear&&!demand.workerId)p.fail('Demand is not claimed',409);
      const payload={...demand.payload,lastError:input.action==='blocked'?p.text(input.message,'message',2000):null};
      if(input.action==='resume')payload.claimExpiresAt=new Date(Date.now()+CLAIM_TTL_MS).toISOString();
      const result=await one(db,`UPDATE rssd_demands SET state=$3,"workerId"=$4,"claimToken"=$5,payload=$6::jsonb,
        generation=generation+$7,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 RETURNING *`,ctx.orgId,id,state,clear?null:demand.workerId,clear?null:demand.claimToken,encoded(payload),clear?1:0);
      await audit(db,ctx,'demand.'+input.action,{id,generation:result.generation});return safeDemand(result);
    });
  }
  async work(ctx,id) {
    p.id(id);const work=await one(this.db,'SELECT * FROM rssd_works WHERE "orgId"=$1 AND id=$2',ctx.orgId,id);
    if(!work)p.fail('Work not found',404,'not_found');scope(ctx,work.workspaceId);
    const editions=await rows(this.db,`SELECT DISTINCT ON (locale) locale,revision,payload,hash,"createdAt" FROM rssd_editions
      WHERE "orgId"=$1 AND "workId"=$2 ORDER BY locale,revision DESC`,ctx.orgId,id);
    return {...work,editions};
  }
  async works(ctx,{workspaceId,search='',limit=100,offset=0}={}) {
    if(workspaceId)scope(ctx,p.id(workspaceId));limit=pageNumber(limit,'limit',1,200);offset=pageNumber(offset,'offset',0,1000000);p.text(search,'search',500,true);
    return rows(this.db,`SELECT w.*,COALESCE(e.editions,'[]'::jsonb) AS editions FROM rssd_works w LEFT JOIN LATERAL
      (SELECT jsonb_agg(jsonb_build_object('locale',x.locale,'revision',x.revision,'title',x.payload->>'title','hash',x.hash)) AS editions,
        bool_or(x.payload->>'title' ILIKE '%' || $4 || '%' OR x.payload->>'bodyMarkdown' ILIKE '%' || $4 || '%') AS matches FROM
      (SELECT DISTINCT ON (locale) locale,revision,payload,hash FROM rssd_editions WHERE "orgId"=w."orgId" AND "workId"=w.id ORDER BY locale,revision DESC) x) e ON true
      WHERE w."orgId"=$1 AND ($2::text IS NULL OR w."workspaceId"=$2)
      AND ($3::jsonb IS NULL OR w."workspaceId" IN (SELECT jsonb_array_elements_text($3::jsonb)))
      AND ($4='' OR e.matches) ORDER BY w."updatedAt" DESC,w.id LIMIT $5 OFFSET $6`,ctx.orgId,workspaceId||null,ctx.workspaceIds===null?null:encoded(ctx.workspaceIds),search,limit,offset);
  }
  async edition(ctx,workId,locale,revision) {
    await this.work(ctx,workId);p.locale(locale);p.integer(revision,'revision',1);
    const row=await one(this.db,'SELECT locale,revision,payload,hash,"createdAt" FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4',ctx.orgId,workId,locale,revision);
    if(!row)p.fail('Edition revision not found',404,'not_found');return row;
  }
  async submit(ctx,input,{publish=true}={}) {
    const value=p.submission(input);scope(ctx,value.workspaceId);
    const fingerprint=p.hash({publish,value});
    return this.transaction(async db=>{
      await lock(db,ctx.orgId+':request:'+value.requestId);
      const previous=await one(db,'SELECT * FROM rssd_submissions WHERE "orgId"=$1 AND "requestId"=$2',ctx.orgId,value.requestId);
      if(previous){if(previous.payloadHash!==fingerprint)p.fail('Request identity was reused with different content',409,'request_conflict');return previous.result;}
      // Check revocation inside the transaction, not only at the HTTP boundary.
      if(ctx.workerId){const worker=await one(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId);if(!worker)p.fail('Device revoked',401);}
      await this.expireStaleClaims(db,ctx.orgId);
      const {section}=await this.workSection(db,ctx,value.workspaceId,value.sectionId,value.workId);
      await this.writable(db,ctx,value.workspaceId);
      let policy=section.policy,demand=null;
      if(value.demandId){
        demand=await one(db,'SELECT * FROM rssd_demands WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,value.demandId);
        if(!demand || !['claimed','blocked'].includes(demand.state) || demand.workerId!==ctx.workerId || demand.claimToken!==value.claimToken)p.fail('Claim no longer belongs to this device',409,'claim_revoked');
        if(demand.workspaceId!==value.workspaceId||demand.sectionId!==value.sectionId)p.fail('Submission does not match the claimed demand',409);
        if(demand.payload.source && demand.payload.source.workId!==value.workId)p.fail('Update or translation must retain the source work identity',409);
        if(demand.payload.workId && demand.payload.workId!==value.workId)p.fail('Language editions must retain the original submission work identity',409);
        policy=demand.payload.policy;
        if(demand.kind==='translate'){
          if(value.editions.some(edition=>edition.locale===demand.payload.source.locale))p.fail('Translation must not rewrite the source edition',409,'source_conflict');
          const bound=demand.payload.source;
          const sourceEdition=await one(db,'SELECT revision,hash FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4',ctx.orgId,bound.workId,bound.locale,bound.revision);
          if(!sourceEdition)p.fail('Translation source revision not found',409,'source_conflict');
          if(demand.payload.sourceHash && sourceEdition.hash!==demand.payload.sourceHash)p.fail('Translation source fingerprint changed',409,'source_conflict');
          const head=await one(db,'SELECT revision FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 ORDER BY revision DESC LIMIT 1',ctx.orgId,bound.workId,bound.locale);
          if((head?.revision||0)!==bound.revision)p.fail('Translation source has a newer revision',409,'source_conflict');
        }
      }
      await lock(db,ctx.orgId+':work:'+value.workId);
      const work=await one(db,'SELECT * FROM rssd_works WHERE "orgId"=$1 AND id=$2',ctx.orgId,value.workId);
      if(work&&(work.workspaceId!==value.workspaceId||work.sectionId!==value.sectionId))p.fail('Work belongs to a different workspace or section',409,'identity_conflict');
      const result={requestId:value.requestId,workId:value.workId,workspaceId:value.workspaceId,status:publish?'accepted':'draft_saved',editions:[],publicationIds:[]};
      for(const edition of value.editions){
        const action=await one(db,`SELECT id FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND state IN ('queued','dispatching') LIMIT 1`,ctx.orgId,value.workId,edition.locale);
        if(action)p.fail('A website visibility action is in progress; retain the local result until its receipt settles',409,'publication_pending');
        const visibility=await one(db,'SELECT visibility FROM rssd_editorial_states WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,value.workId,edition.locale);
        if(visibility?.visibility==='deleted')p.fail('This edition was deleted; restore it explicitly before editing',409,'edition_deleted');
        if(publish&&visibility?.visibility==='withdrawn')p.fail('This website edition is withdrawn; explicitly publish or restore it through a visibility action',409,'edition_withdrawn');
        const deleted=await one(db,'SELECT "documentId" FROM rssd_legacy_documents WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "deletedAt" IS NOT NULL',ctx.orgId,value.workId,edition.locale);
        if(deleted&&!visibility)p.fail('This historical edition was deleted; restore it explicitly before editing',409,'edition_deleted');
        if(demand?.kind==='translate' && (!edition.translationOf || p.hash(edition.translationOf)!==p.hash(demand.payload.source)))p.fail('Translation must identify the requested source revision',409,'source_conflict');
        const head=await one(db,'SELECT revision FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 ORDER BY revision DESC LIMIT 1',ctx.orgId,value.workId,edition.locale);
        if((head?.revision||0)!==value.baseRevisions[edition.locale])p.fail('Edition changed; keep local changes and reload',409,'revision_conflict');
        for(const mediaId of p.referencedMediaIds(edition.bodyMarkdown)){if(!edition.media.some(item=>item.id===mediaId))p.fail('Article references media missing from its edition manifest',400,'missing_media');}
        for(const media of edition.media){
          const own=await one(db,'SELECT id,"workspaceId" FROM rssd_media WHERE "orgId"=$1 AND id=$2',ctx.orgId,media.id);
          if(own&&own.workspaceId!==value.workspaceId)p.fail('Media belongs to another workspace',403,'invalid_media');
          const found=own||await one(db,'SELECT id FROM "Media" WHERE "organizationId"=$1 AND id=$2 AND "deletedAt" IS NULL',ctx.orgId,media.id);if(!found)p.fail('Media not found in this organization',400,'invalid_media');
        }
        if(edition.translationOf){
          if(edition.translationOf.workId!==value.workId || edition.translationOf.locale===edition.locale)p.fail('Invalid translation source');
          const sourceInPacket=value.editions.find(e=>e.locale===edition.translationOf.locale);
          const source=sourceInPacket&&value.baseRevisions[sourceInPacket.locale]+1===edition.translationOf.revision || await one(db,'SELECT revision FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4',ctx.orgId,value.workId,edition.translationOf.locale,edition.translationOf.revision);
          if(!source)p.fail('Translation source revision not found',409,'source_conflict');
        }
        const revision=(head?.revision||0)+1,hash=p.hash(edition);
        await execute(db,'INSERT INTO rssd_editions ("orgId","workId",locale,revision,payload,hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',ctx.orgId,value.workId,edition.locale,revision,encoded(edition),hash);
        result.editions.push({locale:edition.locale,revision,hash});
        if(publish)for(const target of policy.targets.filter(t=>t.locale===edition.locale)){
          const publicationId=randomUUID();
          await execute(db,`INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",payload)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,ctx.orgId,publicationId,value.workId,value.workspaceId,edition.locale,revision,target.destinationId,encoded({edition,sectionId:value.sectionId,policyVersion:policy.version,hash}));
          result.publicationIds.push(publicationId);
        }
      }
      await execute(db,`INSERT INTO rssd_works ("orgId",id,"workspaceId","sectionId") VALUES ($1,$2,$3,$4)
        ON CONFLICT ("orgId",id) DO UPDATE SET "updatedAt"=CURRENT_TIMESTAMP`,ctx.orgId,value.workId,value.workspaceId,value.sectionId);
      if(demand&&publish){
        const submittedLocales=new Set([...(demand.payload.submittedLocales||[]),...value.editions.map(e=>e.locale)]);
        const completed=demand.payload.requiredLocales.every(l=>submittedLocales.has(l));
        await execute(db,`UPDATE rssd_demands SET state=$3,payload=$4::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2`,ctx.orgId,demand.id,completed?'completed':'claimed',encoded({...demand.payload,submittedLocales:[...submittedLocales],workId:value.workId}));
        result.demandState=completed?'completed':'claimed';
      }
      await execute(db,'INSERT INTO rssd_submissions ("orgId","requestId","payloadHash","workspaceId","workId",result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',ctx.orgId,value.requestId,fingerprint,value.workspaceId,value.workId,encoded(result));
      await audit(db,ctx,publish?'work.submit':'work.save',{workId:value.workId,requestId:value.requestId,editions:result.editions});
      return result;
    });
  }
  async submissionStatus(ctx,requestId) {
    p.id(requestId);const row=await one(this.db,'SELECT "workspaceId",result FROM rssd_submissions WHERE "orgId"=$1 AND "requestId"=$2',ctx.orgId,requestId);
    if(!row)p.fail('Submission not found',404,'not_found');scope(ctx,row.workspaceId);return row.result;
  }
  async publications(ctx,{workspaceId,limit=100,offset=0}={}) {
    if(workspaceId)scope(ctx,p.id(workspaceId));limit=pageNumber(limit,'limit',1,200);offset=pageNumber(offset,'offset',0,1000000);
    return rows(this.db,`SELECT id,"workId","workspaceId",locale,revision,"destinationId",state,receipt,error,attempts,"createdAt","updatedAt",payload->'edition'->>'title' AS title
      FROM rssd_publications WHERE "orgId"=$1 AND ($2::text IS NULL OR "workspaceId"=$2)
      AND ($3::jsonb IS NULL OR "workspaceId" IN (SELECT jsonb_array_elements_text($3::jsonb))) ORDER BY "createdAt" DESC,id LIMIT $4 OFFSET $5`,ctx.orgId,workspaceId||null,ctx.workspaceIds===null?null:encoded(ctx.workspaceIds),limit,offset);
  }
}
module.exports={RssdStore,scope,admin,schedulingGranted,CLAIM_TTL_MS};
