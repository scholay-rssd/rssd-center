'use strict';
const {createHmac,randomBytes,randomUUID,timingSafeEqual}=require('node:crypto');
const {isIP}=require('node:net');
const p=require('./protocol.cjs'),{admin}=require('./store.cjs'),{CredentialCipher}=require('./publisher.cjs');
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args),x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args);
const one=async(db,sql,...args)=>(await q(db,sql,...args))[0]||null;
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const clean=(v,max,required=false)=>{if(typeof v!=='string'||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)||required&&!v.trim())p.fail('字段格式或长度不正确');return v.trim();};
function input(b,config){
 p.object(b,'message');if(Buffer.byteLength(JSON.stringify(b))>16384)p.fail('留言过长',413);
 if(Object.keys(b).some(k=>!['kind','name','message','contact','details','requestKey'].includes(k)))p.fail('存在未知字段');
 const form=config.forms.find(f=>f.id===b.kind);if(!form)p.fail('留言类型不适用于本站');
 if(typeof b.requestKey!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(b.requestKey))p.fail('缺少有效提交编号');
 p.object(b.details,'details');if(Object.keys(b.details).some(k=>!form.fields.some(f=>f.key===k)))p.fail('表单字段不适用于该留言类型');
 return {kind:form.id,name:clean(b.name,60,true),message:clean(b.message,3000,true),contact:clean(b.contact??'',200),details:Object.fromEntries(form.fields.map(f=>[f.key,clean(b.details[f.key]??'',f.max,f.required)]))};
}
class RssdGuestbook{
 constructor(store,{secret,now=Date.now}={}){this.store=store;this.db=store.db;this.cipher=new CredentialCipher(secret);this.now=now;}
 async importLegacy(ctx,bundle,proxyToken){
  admin(ctx);p.id(bundle.siteId);p.id(bundle.workspaceId);p.text(proxyToken,'site proxy credential',200);
  if(proxyToken.length<32||bundle.version!==1||bundle.sourceHash!==p.hash(bundle.source))p.fail('Invalid guestbook archive');
  await this.store.workspace(this.db,ctx,bundle.workspaceId);
  const {siteId,workspaceId,config,source}=bundle,meta=Object.fromEntries(source.guestbook_meta.map(r=>[r.key,r.value]));
  if(meta.site!==siteId||!/^[a-f0-9]{64}$/.test(meta.secret)||config.siteId!==siteId||!Array.isArray(config.forms))p.fail('Guestbook identity is invalid');
  const origin=new URL(config.home);if(origin.protocol!=='https:'||origin.origin!==config.home)p.fail('Invalid guestbook origin');
  new Intl.DateTimeFormat('en',{timeZone:config.timezone});
  for(const r of source.messages){p.id(r.id);if(!['pending','approved','rejected'].includes(r.status)||!/^[a-f0-9]{64}$/.test(r.visitor)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day))p.fail('Invalid archived message');p.integer(r.created,'created');if(r.reviewed!==null)p.integer(r.reviewed,'reviewed');JSON.parse(r.payload);}
  for(const r of source.guard){p.text(r.key,'guard key',300);p.integer(r.count,'guard count');p.integer(r.expires,'guard expiry');}
  return this.store.transaction(async db=>{
   await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))','guestbook:'+siteId);
   const previous=await one(db,'SELECT * FROM rssd_guestbooks WHERE "siteId"=$1 FOR UPDATE',siteId);
   if(previous&&(previous.orgId!==ctx.orgId||previous.workspaceId!==workspaceId||previous.enabled))p.fail('Guestbook already belongs to an active writer',409);
   // The original signed cookie secret is encrypted; the archived copy excludes it.
   const archived={...source,guestbook_meta:source.guestbook_meta.map(r=>r.key==='secret'?{...r,value:null}:r)};
   await x(db,`INSERT INTO rssd_guestbooks ("siteId","orgId","workspaceId",config,"sealedSecret","proxyTokenHash","sourceHash","legacySource") VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb)
    ON CONFLICT ("siteId") DO UPDATE SET config=EXCLUDED.config,"sealedSecret"=EXCLUDED."sealedSecret","proxyTokenHash"=EXCLUDED."proxyTokenHash","sourceHash"=EXCLUDED."sourceHash","legacySource"=EXCLUDED."legacySource"`,siteId,ctx.orgId,workspaceId,JSON.stringify(config),this.cipher.seal(meta.secret,'guestbook:'+ctx.orgId+':'+siteId),p.hash(proxyToken),bundle.sourceHash,JSON.stringify(archived));
   await x(db,'DELETE FROM rssd_guestbook_messages WHERE "siteId"=$1',siteId);await x(db,'DELETE FROM rssd_guestbook_guard WHERE "siteId"=$1',siteId);
   for(const r of source.messages)await x(db,'INSERT INTO rssd_guestbook_messages VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)',siteId,r.id,r.visitor,r.day,r.request_key,r.payload,r.status,r.created,r.reviewed,r.reviewer);
   for(const r of source.guard)await x(db,'INSERT INTO rssd_guestbook_guard VALUES ($1,$2,$3,$4)',siteId,r.key,r.count,r.expires);
   return this.verify(ctx,siteId,db);
  });
 }
 async activate(ctx,siteId,sourceHash,{oldWriterDisabled}={}){
  admin(ctx);if(oldWriterDisabled!==true)p.fail('Disable the original guestbook writer first',409);
  return this.store.transaction(async db=>{
   const row=await one(db,'SELECT * FROM rssd_guestbooks WHERE "siteId"=$1 AND "orgId"=$2 FOR UPDATE',p.id(siteId),ctx.orgId);
   if(!row||row.sourceHash!==sourceHash)p.fail('Guestbook handoff snapshot differs',409);
   if(!row.enabled)await this.verify(ctx,siteId,db);
   await x(db,'UPDATE rssd_guestbooks SET enabled=true WHERE "siteId"=$1',siteId);return {siteId,enabled:true};
  });
 }
 async verify(ctx,siteId,db=this.db){
  admin(ctx);const book=await one(db,'SELECT * FROM rssd_guestbooks WHERE "siteId"=$1 AND "orgId"=$2',p.id(siteId),ctx.orgId);if(!book)p.fail('Guestbook not found',404);
  const source=book.legacySource,secret=this.cipher.open(book.sealedSecret,'guestbook:'+ctx.orgId+':'+siteId);
  const restored={...source,guestbook_meta:source.guestbook_meta.map(r=>r.key==='secret'?{...r,value:secret}:r)};
  // Canonical exports sort rows by their primary key; preserve the original
  // payload text in the archive while comparing live JSONB semantically.
  if(p.hash(restored)!==book.sourceHash)p.fail('Guestbook archived source differs',409);
  const actual=(await q(db,'SELECT * FROM rssd_guestbook_messages WHERE "siteId"=$1 ORDER BY id',siteId)).map(r=>({id:r.id,visitor:r.visitor,day:r.day,request_key:r.requestKey,payload:r.payload,status:r.status,created:Number(r.created),reviewed:r.reviewed===null?null:Number(r.reviewed),reviewer:r.reviewer}));
  const expected=source.messages.map(r=>({...r,payload:JSON.parse(r.payload)})).sort((a,b)=>a.id.localeCompare(b.id));
  const guards=(await q(db,'SELECT key,count,expires FROM rssd_guestbook_guard WHERE "siteId"=$1 ORDER BY key',siteId)).map(r=>({...r,expires:Number(r.expires)}));
  if(p.hash(actual)!==p.hash(expected)||p.hash(guards)!==p.hash([...source.guard].sort((a,b)=>a.key.localeCompare(b.key))))p.fail('Guestbook rows differ from the handoff archive',409);
  return {siteId,messages:actual.length,messageIndexSha256:p.hash(actual),sourceHash:book.sourceHash,enabled:book.enabled};
 }
 async books(ctx){admin(ctx);return q(this.db,'SELECT "siteId","workspaceId",config,enabled,"sourceHash" FROM rssd_guestbooks WHERE "orgId"=$1 ORDER BY "siteId"',ctx.orgId);}
 async authorized(siteId,headers){
  const row=await one(this.db,'SELECT * FROM rssd_guestbooks WHERE "siteId"=$1',p.id(siteId));
  if(!row||!row.enabled||!equal(row.proxyTokenHash,p.hash(String(headers['x-rssd-site-token']||''))))p.fail('Guestbook unavailable',403);
  const clientIp=headers['x-rssd-client-ip'];if(typeof clientIp!=='string'||!isIP(clientIp))p.fail('Trusted site proxy required',403);
  const secret=this.cipher.open(row.sealedSecret,'guestbook:'+row.orgId+':'+siteId),hash=value=>createHmac('sha256',secret).update(siteId+':'+value).digest('hex');
  const cookieName='__Host-today-guest-'+siteId,day=new Intl.DateTimeFormat('en-CA',{timeZone:row.config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(this.now()));
  return {row,hash,cookieName,day,clientIp};
 }
 visitor(context,cookies){const [v,sig]=String(cookies?.[context.cookieName]||'').split('.');return /^[a-f0-9]{48}$/.test(v||'')&&equal(sig,context.hash('cookie:'+v))?v:null;}
 async count(db,c,v){return Number((await one(db,'SELECT count(*)::integer AS n FROM rssd_guestbook_messages WHERE "siteId"=$1 AND visitor=$2 AND day=$3',c.row.siteId,c.hash('visitor:'+v),c.day)).n);}
 async guard(db,c,key,max,windowMs){
  const result=await one(db,`INSERT INTO rssd_guestbook_guard VALUES ($1,$2,1,$3) ON CONFLICT ("siteId",key) DO UPDATE
   SET count=CASE WHEN rssd_guestbook_guard.expires<=$4 THEN 1 ELSE rssd_guestbook_guard.count+1 END,
   expires=CASE WHEN rssd_guestbook_guard.expires<=$4 THEN $3 ELSE rssd_guestbook_guard.expires END RETURNING count`,c.row.siteId,c.hash(key),this.now()+windowMs,this.now());
  if(result.count>max)p.fail('请求过于频繁，请稍后重试',429);
 }
 async session(siteId,headers,cookies){
  const c=await this.authorized(siteId,headers);let v=this.visitor(c,cookies),cookie;
  if(!v){await this.guard(this.db,c,'identity:'+c.clientIp,30,60000);v=randomBytes(24).toString('hex');cookie={name:c.cookieName,value:v+'.'+c.hash('cookie:'+v)};}
  return {cookie,body:{config:c.row.config,csrf:c.hash('csrf:'+v),remaining:Math.max(0,2-await this.count(this.db,c,v)),day:c.day}};
 }
 async submit(siteId,headers,cookies,body){
  const c=await this.authorized(siteId,headers),v=this.visitor(c,cookies);
  if(headers.origin!==c.row.config.home||!v||!equal(headers['x-guestbook-csrf'],c.hash('csrf:'+v)))p.fail('请从本站留言板刷新后提交',403);
  const payload=input(body,c.row.config);await this.guard(this.db,c,'post:'+c.day+':'+c.clientIp,40,86400000);
  return this.store.transaction(async db=>{
   await x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))','guestbook:'+siteId+':'+c.hash('visitor:'+v));
   // Recheck activation inside the transaction so cutover suspension fences writers.
   const active=await one(db,'SELECT enabled FROM rssd_guestbooks WHERE "siteId"=$1 FOR SHARE',siteId);if(!active.enabled)p.fail('留言暂时停止接收',409);
   const old=await one(db,'SELECT id,payload FROM rssd_guestbook_messages WHERE "siteId"=$1 AND visitor=$2 AND "requestKey"=$3',siteId,c.hash('visitor:'+v),body.requestKey);
   const count=await this.count(db,c,v);
   if(old){if(p.hash(old.payload)!==p.hash(payload))p.fail('该提交编号已用于其他内容',409);return {id:old.id,replayed:true,status:'received',remaining:Math.max(0,2-count)};}
   if(count>=2)p.fail('今天已提交两条留言，请明天再来',429);
   const id=randomUUID();await x(db,`INSERT INTO rssd_guestbook_messages ("siteId",id,visitor,day,"requestKey",payload,status,created) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7)`,siteId,id,c.hash('visitor:'+v),c.day,body.requestKey,JSON.stringify(payload),this.now());
   return {id,replayed:false,status:'received',remaining:1-count};
  });
 }
 async publicMessages(siteId,headers){
  await this.authorized(siteId,headers);
  return {messages:(await q(this.db,`SELECT id,payload,created FROM rssd_guestbook_messages WHERE "siteId"=$1 AND status='approved' ORDER BY created DESC,id DESC LIMIT 50`,siteId)).map(r=>({id:r.id,kind:r.payload.kind,name:r.payload.name,message:r.payload.message,created:Number(r.created)}))};
 }
 async moderation(ctx,siteId,status='pending'){
  admin(ctx);if(!['pending','approved','rejected'].includes(status))p.fail('未知审核状态');
  const book=await one(this.db,'SELECT config FROM rssd_guestbooks WHERE "orgId"=$1 AND "siteId"=$2',ctx.orgId,p.id(siteId));if(!book)p.fail('留言板不存在',404);
  return {config:book.config,messages:(await q(this.db,'SELECT id,payload,status,created,reviewed,reviewer FROM rssd_guestbook_messages WHERE "siteId"=$1 AND status=$2 ORDER BY created DESC,id DESC LIMIT 100',siteId,status)).map(r=>({...r,...r.payload,payload:undefined,created:Number(r.created),reviewed:r.reviewed===null?null:Number(r.reviewed)}))};
 }
 async review(ctx,siteId,id,status){
  admin(ctx);if(!['pending','approved','rejected'].includes(status))p.fail('未知审核状态');
  const result=await q(this.db,`UPDATE rssd_guestbook_messages m SET status=$4,reviewed=$5,reviewer=$6 FROM rssd_guestbooks b
   WHERE b."siteId"=m."siteId" AND b.enabled=true AND b."orgId"=$1 AND m."siteId"=$2 AND m.id=$3 RETURNING m.id`,ctx.orgId,p.id(siteId),p.id(id),status,this.now(),ctx.userId||'owner');
  if(result.length!==1)p.fail('留言不存在',404);return {ok:true};
 }
}
module.exports={RssdGuestbook,input};
