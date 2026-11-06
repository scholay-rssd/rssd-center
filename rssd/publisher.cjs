'use strict';
const {createHash,createCipheriv,createDecipheriv,randomBytes,randomUUID}=require('node:crypto');
const p=require('./protocol.cjs');
const {admin}=require('./store.cjs');
const {publication,publicContent,contentKey}=require('./publication.cjs');
const {dispatchDiscourse}=require('./discourse.cjs');
const json=JSON.stringify;
const query=(db,sql,...values)=>db.$queryRawUnsafe(sql,...values);
const execute=(db,sql,...values)=>db.$executeRawUnsafe(sql,...values);
async function one(db,sql,...values){return (await query(db,sql,...values))[0]||null;}
function origin(value){let url;try{url=new URL(value);}catch{p.fail('Invalid destination origin');}
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.pathname!=='/'||url.search||url.hash)p.fail('Destination must be an HTTPS origin');return url.origin;}
class CredentialCipher {
  constructor(secret){if(typeof secret!=='string'||secret.length<32)throw Error('RSSD credential encryption requires a persistent key of at least 32 characters');this.key=createHash('sha256').update('rssd-destination-v1\0'+secret).digest();}
  seal(value,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');}
  open(value,aad){const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64url'));const cipher=createDecipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');}
}
function visibleDestination(row){const {sealedToken,...config}=row.config;return {...row,config,hasCredential:Boolean(sealedToken)};}
class RssdPublisher {
  constructor(store,{secret,fetchImpl=fetch,media,postiz}={}){this.store=store;this.db=store.db;this.fetch=fetchImpl;this.secret=secret;this.media=media;this.postiz=postiz;this.running=false;}
  cipher(){return new CredentialCipher(this.secret);}
  async destinations(ctx){admin(ctx);return (await query(this.db,'SELECT * FROM rssd_destinations WHERE "orgId"=$1 ORDER BY id',ctx.orgId)).map(visibleDestination);}
  async saveDestination(ctx,input){
    admin(ctx);const id=p.id(input.id),name=p.text(input.name,'name',200),kind=input.kind;
    if(!['site','discourse','postiz'].includes(kind))p.fail('This connector is not implemented yet',400,'unsupported_connector');
    const workspaceIds=[...new Set(p.array(input.workspaceIds,'workspaceIds').map(x=>p.id(x)))];if(!workspaceIds.length)p.fail('Choose a workspace');
    for(const w of workspaceIds)await this.store.workspace(this.db,ctx,w);
    const config=kind==='postiz'?{integrationId:p.id(input.config?.integrationId)}:{origin:origin(input.config?.origin),...(kind==='site'?{siteId:p.id(input.config?.siteId)}:{username:p.text(input.config?.username,'forum username',100),categoryId:p.integer(input.config?.categoryId,'forum category',1)})};
    if(kind==='postiz'){if(!this.postiz)p.fail('Postiz connector unavailable');await this.postiz.channel(ctx.orgId,config.integrationId);}
    if(config.username&&/[\r\n]/.test(config.username))p.fail('Invalid forum username');
    if(typeof input.enabled!=='boolean')p.fail('Explicit enabled state required');
    return this.store.transaction(async db=>{
      await execute(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':destination:'+id);
      const old=await one(db,'SELECT * FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,id);
      if(old&&(old.kind!==kind||old.config.origin!==config.origin||old.config.siteId!==config.siteId||old.config.username!==config.username||old.config.categoryId!==config.categoryId||old.config.integrationId!==config.integrationId))p.fail('Destination identity is immutable; create a new destination',409);
      if(input.token&&kind==='postiz')p.fail('Postiz channels use existing authorization');
      if(input.token){p.text(input.token,'credential',4096);if(input.token.length<32||/[\r\n]/.test(input.token))p.fail('Credential too short or invalid');config.sealedToken=this.cipher().seal(input.token,ctx.orgId+':'+id);}
      else config.sealedToken=old?.config.sealedToken;
      if(kind!=='postiz'&&!config.sealedToken)p.fail('Destination credential required');
      const row=await one(db,`INSERT INTO rssd_destinations ("orgId",id,name,kind,"workspaceIds",config,enabled) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
        ON CONFLICT ("orgId",id) DO UPDATE SET name=EXCLUDED.name,"workspaceIds"=EXCLUDED."workspaceIds",config=EXCLUDED.config,enabled=EXCLUDED.enabled RETURNING *`,ctx.orgId,id,name,kind,json(workspaceIds),json(config),input.enabled);
      return visibleDestination(row);
    });
  }
  async retry(ctx,id){admin(ctx);p.id(id);return this.store.transaction(async db=>{
    const seed=await one(db,'SELECT * FROM rssd_publications WHERE "orgId"=$1 AND id=$2',ctx.orgId,id);if(!seed)p.fail('Publication not found',404);
    await execute(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ctx.orgId+':work:'+seed.workId);
    const row=await one(db,'SELECT * FROM rssd_publications WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,id);
    if(row.state!=='blocked')p.fail('Only blocked publications can be resumed',409);
    const destination=await one(db,'SELECT kind FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,row.destinationId);
    if(destination?.kind==='site'){
      const action=await one(db,`SELECT id FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND state IN ('queued','dispatching') LIMIT 1`,ctx.orgId,row.workId,row.locale);
      if(action)p.fail('A website visibility action is pending; preserve the original publication receipt',409,'publication_pending');
      const visibility=await one(db,'SELECT visibility FROM rssd_editorial_states WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,row.workId,row.locale);
      if(visibility&&visibility.visibility!=='active')p.fail('Restore or explicitly publish the hidden website edition through a visibility action',409,'edition_hidden');
    }
    const newer=await one(db,'SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND revision>$5 AND attempts>0',ctx.orgId,row.workId,row.locale,row.destinationId,row.revision);
    if(newer)p.fail('A newer revision has entered this destination; resume the newer publication',409,'stale_revision');
    await execute(db,`UPDATE rssd_publications SET state='queued',error=NULL,receipt=receipt || '{"manualRetry":true}'::jsonb,"nextAttemptAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2`,ctx.orgId,id);return {queued:true};
  });}
  async claim(orgId=null){return this.store.transaction(async db=>{
    const row=await one(db,`SELECT p.* FROM rssd_publications p WHERE p.state IN ('queued','dispatching') AND p."nextAttemptAt"<=CURRENT_TIMESTAMP
      AND (p."leaseUntil" IS NULL OR p."leaseUntil"<CURRENT_TIMESTAMP)
      AND NOT EXISTS (SELECT 1 FROM rssd_publications older WHERE older."orgId"=p."orgId" AND older."workId"=p."workId" AND older.locale=p.locale AND older."destinationId"=p."destinationId" AND older.revision<p.revision AND older.state IN ('queued','dispatching'))
      AND ($1::text IS NULL OR p."orgId"=$1)
      ORDER BY p."nextAttemptAt",p."createdAt",p.id FOR UPDATE SKIP LOCKED LIMIT 1`,orgId);
    if(!row)return null;const leaseToken=randomUUID();
    return one(db,`UPDATE rssd_publications SET state='dispatching',"leaseToken"=$3,"leaseUntil"=CURRENT_TIMESTAMP+interval '120 seconds',attempts=attempts+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 RETURNING *`,row.orgId,row.id,leaseToken);
  });}
  async finish(row,{state,receipt={},error=null,delay=5000}){
    await execute(this.db,`UPDATE rssd_publications SET state=$4,receipt=$5::jsonb,error=$6,"leaseToken"=NULL,"leaseUntil"=NULL,
      "nextAttemptAt"=CURRENT_TIMESTAMP+($7::integer * interval '1 millisecond'),"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2 AND "leaseToken"=$3`,row.orgId,row.id,row.leaseToken,state,json(receipt),error,delay);
    return {id:row.id,state,error};
  }
  async checkpoint(row,receipt){
    const changed=await execute(this.db,'UPDATE rssd_publications SET receipt=receipt || $4::jsonb WHERE "orgId"=$1 AND id=$2 AND "leaseToken"=$3',row.orgId,row.id,row.leaseToken,json(receipt));
    if(!changed)p.fail('Publication lease changed; reconcile before continuing',409,'lease_revoked');
    row.receipt={...row.receipt,...receipt};
  }
  async request(url,{token,method='GET',body}={}){
    const response=await this.fetch(url,{method,redirect:'error',headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?json(body):undefined,signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Object.assign(Error('Destination returned HTTP '+response.status),{status:response.status});
    const reader=response.body.getReader();let size=0;const chunks=[];try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8*1024*1024)throw Error('Destination response is too large');chunks.push(r.value);}}finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async dispatch(row){
    const destination=await one(this.db,'SELECT * FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',row.orgId,row.destinationId);
    if(!destination?.enabled||!destination.workspaceIds.includes(row.workspaceId))return this.finish(row,{state:'blocked',error:'Destination is disabled or workspace authorization was removed'});
    const newer=await one(this.db,`SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND revision>$5 AND state='published'`,row.orgId,row.workId,row.locale,row.destinationId,row.revision);
    if(newer)return this.finish(row,{state:'superseded',error:'A newer revision is already published'});
    const old=await one(this.db,`SELECT receipt FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('published','legacy_published') ORDER BY revision DESC LIMIT 1`,row.orgId,row.workId,row.locale,row.destinationId);
    if(destination.kind==='discourse')return dispatchDiscourse(this,row,destination,old);
    if(destination.kind==='postiz'&&this.postiz)return this.postiz.dispatch(this,row,destination,old);
    if(destination.kind!=='site')return this.finish(row,{state:'blocked',error:'Connector is not implemented'});
    const config=destination.config,token=this.cipher().open(config.sealedToken,row.orgId+':'+destination.id);
    const path=old?.receipt.url?new URL(old.receipt.url).pathname:row.payload.edition.metadata?.publication?.path||((row.locale==='en'?'/en':'')+'/news/'+p.hash(row.workId).slice(0,32)+'/');
    if((row.payload.edition.media?.length||/\/api\/rssd\/v1\/media\//.test(row.payload.edition.bodyMarkdown||''))&&!this.media)p.fail('Media storage is unavailable',400,'missing_media');
    const prepared=this.media?await this.media.publication(row.orgId,row.workspaceId,row.payload.edition):{edition:row.payload.edition,assets:[],uploads:[]};
    const content=publicContent(prepared.edition);if(!content.metadata.date)content.metadata.date=new Date(row.createdAt).toISOString().slice(0,10);
    const packet=publication({version:1,requestId:row.id,siteId:config.siteId,workspaceId:row.workspaceId,sectionId:row.payload.sectionId,workId:row.workId,locale:row.locale,revision:row.revision,contentHash:row.payload.hash,content,route:path,...(prepared.assets.length?{assets:prepared.assets}:{})});
    for(const upload of prepared.uploads){
      const url=origin(config.origin)+'/api/rssd-receiver/v1/sites/'+encodeURIComponent(config.siteId)+'/media/'+upload.manifest.sha256;
      let stored;try{stored=await this.request(url,{token});}catch(error){if(error.status!==404)throw error;const {bytes}=await this.media.bytes({orgId:row.orgId,admin:true,workspaceIds:null},upload.id);stored=await this.request(url,{token,method:'POST',body:{...upload.manifest,data:bytes.toString('base64')}});}
      if(p.hash(stored)!==p.hash(upload.manifest))p.fail('Site media receipt mismatch',409,'media_conflict');
    }
    const base=origin(config.origin)+'/api/rssd-receiver/v1/sites/'+encodeURIComponent(config.siteId)+'/submissions';
    let receipt;try{receipt=await this.request(base+'/'+row.id,{token});}catch(error){if(error.status!==404)throw error;receipt=await this.request(base,{token,method:'POST',body:packet});}
    if(receipt.state==='failed'&&row.receipt.manualRetry)receipt=await this.request(base+'/'+row.id+'/retry',{token,method:'POST',body:{}});
    if(receipt.requestId!==row.id||receipt.siteId!==config.siteId||receipt.workId!==row.workId||receipt.locale!==row.locale||receipt.revision!==row.revision||receipt.contentHash!==row.payload.hash||receipt.packetHash!==p.hash(packet))return this.finish(row,{state:'blocked',error:'Destination receipt does not match the submitted edition'});
    if(receipt.state==='failed')return this.finish(row,{state:'blocked',receipt,error:'Site build failed: '+String(receipt.error||'unknown failure').slice(0,1000)});
    if(receipt.state!=='success')return this.finish(row,{state:'queued',receipt});
    const publicUrl=config.origin+'/rssd-content/'+contentKey(packet)+'.json';
    const readback=await this.request(publicUrl);
    if(p.hash(readback)!==p.hash(packet))return this.finish(row,{state:'queued',receipt,error:'Public content has not converged to the accepted revision',delay:30000});
    // Receipt URLs are not trusted as fetch targets and cannot redirect secrets.
    return this.finish(row,{state:'published',receipt:{...receipt,publicUrl,url:config.origin+path,verifiedAt:new Date().toISOString()}});
  }
  async tick({orgId=null}={}){if(this.running)return null;this.running=true;let row;try{row=await this.claim(orgId);if(!row)return null;return await this.dispatch(row);}catch(error){
    if(!row)throw error;const classified=classifyDestinationError(error);
    return this.finish(row,{state:classified.blocked?'blocked':'queued',receipt:{...row.receipt,failureCode:classified.code},error:classified.message,delay:Math.min(300000,10000*Math.max(1,row.attempts))});
  }finally{this.running=false;}}
}
function classifyDestinationError(error){
  if(error instanceof p.ProtocolError)return {blocked:true,code:error.code||'invalid_request',message:error.message};
  const status=error.status;
  if(status===401||status===403)return {blocked:true,code:'destination_auth',message:'Destination rejected the publication (HTTP '+status+')'};
  if([400,409,422].includes(status))return {blocked:true,code:'destination_rejected',message:'Destination rejected the publication (HTTP '+status+')'};
  if(typeof status==='number'&&status>=500)return {blocked:false,code:'destination_http',message:'Destination returned HTTP '+status+'; original request will be queried before retry'};
  if(error.code==='ENOSPC')return {blocked:true,code:'destination_storage',message:'Destination storage is full'};
  if(error.name==='AbortError'||error.name==='TimeoutError'||['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNRESET'].includes(error.code)||/fetch failed|network|unreachable|interrupted/i.test(error.message||''))
    return {blocked:false,code:'destination_network',message:'Destination network error; original request will be queried before retry'};
  if(error instanceof SyntaxError)return {blocked:false,code:'destination_protocol',message:'Destination response could not be parsed; original request will be queried before retry'};
  return {blocked:false,code:'destination_unavailable',message:'Destination unavailable; original request will be queried before retry'};
}
module.exports={RssdPublisher,CredentialCipher,classifyDestinationError};
