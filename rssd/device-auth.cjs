'use strict';
const {randomBytes,randomUUID,createHash,timingSafeEqual}=require('node:crypto');
const p=require('./protocol.cjs');
const CALLBACK='papr://center-auth';
const digest=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const one=async(db,sql,...params)=>(await db.$queryRawUnsafe(sql,...params))[0];
const fail=(code,message)=>p.fail(message,400,code);
function origin(value){const url=new URL(value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('HTTPS center required');return url.origin;}
class DeviceAuthorization {
 constructor(store,{publicOrigin,verifyOwner}={}){this.store=store;this.origin=origin(publicOrigin||process.env.FRONTEND_URL);this.verifyOwner=verifyOwner;}
 async start(input){
  p.object(input,'authorization');const mode=input.mode;if(!['desktop','device'].includes(mode))fail('invalid_request','Invalid authorization mode');
  const name=p.text(input.name,'device name',200);
  if(mode==='desktop'&&(input.redirectUri!==CALLBACK||input.codeChallengeMethod!=='S256'||!/^[-_A-Za-z0-9]{43}$/.test(input.codeChallenge||'')||!/^[-_A-Za-z0-9]{32,128}$/.test(input.state||'')))fail('invalid_request','Invalid native authorization request');
  const id=randomUUID(),deviceCode=secret(),userCode=randomBytes(5).toString('hex').toUpperCase(),expiresIn=mode==='desktop'?300:600;
  const details={mode,name,...(mode==='desktop'?{challenge:input.codeChallenge,state:input.state,redirectUri:CALLBACK}:{})};
  await this.store.db.$executeRawUnsafe('DELETE FROM rssd_device_authorizations WHERE "expiresAt" < CURRENT_TIMESTAMP - interval \'1 day\'');
  await this.store.db.$executeRawUnsafe('INSERT INTO rssd_device_authorizations (id,"deviceHash","userCode",details,"expiresAt") VALUES ($1,$2,$3,$4::jsonb,CURRENT_TIMESTAMP+($5::int*interval \'1 second\'))',id,digest(deviceCode),userCode,JSON.stringify(details),expiresIn);
  const verificationUri=this.origin+'/rssd/authorize';
  return {requestId:id,verificationUri,verificationUriComplete:verificationUri+'?'+new URLSearchParams(mode==='desktop'?{request:id}:{code:userCode}),expiresIn,interval:5,...(mode==='device'?{deviceCode,userCode}:{})};
 }
 async describe(ctx,{requestId,userCode}){
  this.owner(ctx);
  const row=await one(this.store.db,'SELECT id,details,state,"expiresAt" FROM rssd_device_authorizations WHERE id=$1 OR "userCode"=$2',requestId||'',String(userCode||'').replace(/[-\s]/g,'').toUpperCase());
  this.valid(row);return {requestId:row.id,name:row.details.name,mode:row.details.mode,expiresAt:row.expiresAt,state:row.state,center:this.origin};
 }
 owner(ctx){if(!ctx?.admin||!ctx.userId||!ctx.orgId)p.fail('Owner access required',403,'forbidden');}
 valid(row){if(!row||new Date(row.expiresAt).getTime()<=Date.now())fail('expired_token','Authorization expired; start again');}
 async decide(ctx,id,input){
  this.owner(ctx);
  return this.store.transaction(async db=>{
   const row=await one(db,'SELECT * FROM rssd_device_authorizations WHERE id=$1 FOR UPDATE',id);this.valid(row);
   if(row.state!=='pending')fail('invalid_grant','Authorization already handled');
   if(input.approved!==true){await db.$executeRawUnsafe('UPDATE rssd_device_authorizations SET state=\'denied\' WHERE id=$1',id);return {state:'denied',...(row.details.mode==='desktop'?{callback:CALLBACK+'?'+new URLSearchParams({error:'access_denied',state:row.details.state})}:{})};}
   const workspaceIds=[...new Set(p.array(input.workspaceIds,'workspaceIds').map(x=>p.id(x)))];if(!workspaceIds.length)fail('invalid_scope','Select at least one workspace');
   for(const workspace of workspaceIds)await this.store.workspace(db,ctx,workspace);
   const code=secret();
   await db.$executeRawUnsafe('UPDATE rssd_device_authorizations SET state=\'approved\',"orgId"=$2,"userId"=$3,"workspaceIds"=$4::jsonb,"codeHash"=$5 WHERE id=$1',id,ctx.orgId,ctx.userId,JSON.stringify(workspaceIds),digest(code));
   return {state:'approved',...(row.details.mode==='desktop'?{callback:CALLBACK+'?'+new URLSearchParams({code,state:row.details.state})}:{})};
  });
 }
 async exchange(input){
  const device=input.grantType==='device_code';
  if(!device&&input.grantType!=='authorization_code')fail('unsupported_grant_type','Unsupported grant');
  const proof=device?input.deviceCode:input.code;
  if(typeof proof!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(proof))fail('invalid_grant','Invalid authorization proof');
  const result=await this.store.transaction(async db=>{
   const row=await one(db,'SELECT * FROM rssd_device_authorizations WHERE '+(device?'"deviceHash"':'"codeHash"')+'=$1 FOR UPDATE',digest(proof));this.valid(row);
   if(device&&row.details.mode!=='device'||!device&&row.details.mode!=='desktop')fail('invalid_grant','Incorrect grant');
   if(row.state==='denied')fail('access_denied','Authorization was declined');
   if(row.state==='consumed')fail('invalid_grant','Authorization already used');
   if(device){
    const tooSoon=row.nextPollAt&&new Date(row.nextPollAt).getTime()>Date.now();
    await db.$executeRawUnsafe('UPDATE rssd_device_authorizations SET "nextPollAt"=CURRENT_TIMESTAMP+interval \'5 seconds\' WHERE id=$1',row.id);
    if(tooSoon)return {error:'slow_down',message:'Poll less frequently'};
    if(row.state==='pending')return {error:'authorization_pending',message:'Waiting for owner approval'};
   }
   if(!device){
    if(!/^[-_A-Za-z0-9.~]{43,128}$/.test(input.codeVerifier||'')||input.redirectUri!==CALLBACK)fail('invalid_grant','Invalid PKCE verifier');
    const challenge=createHash('sha256').update(input.codeVerifier).digest('base64url');
    if(!equal(challenge,row.details.challenge))fail('invalid_grant','PKCE verification failed');
   }
   if(row.state!=='approved')fail('invalid_grant','Authorization not approved');
   if(!this.verifyOwner||!await this.verifyOwner(row.orgId,row.userId))fail('access_denied','The approving owner no longer has access');
   const workerId=randomUUID(),token='rssd_device_'+randomBytes(36).toString('base64url');
   await db.$executeRawUnsafe('INSERT INTO rssd_workers ("orgId",id,name,"tokenHash","workspaceIds") VALUES ($1,$2,$3,$4,$5::jsonb)',row.orgId,workerId,row.details.name,p.hash(token),JSON.stringify(row.workspaceIds));
   await db.$executeRawUnsafe('UPDATE rssd_device_authorizations SET state=\'consumed\' WHERE id=$1',row.id);
   await db.$executeRawUnsafe('INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,\'device.authorize\',$4::jsonb)',row.orgId,randomUUID(),row.userId,JSON.stringify({workerId,workspaceIds:row.workspaceIds,mode:row.details.mode}));
   return {token,identity:{protocolVersion:1,orgId:row.orgId,workerId,workspaceIds:row.workspaceIds,admin:false}};
  });
  if(result.error)fail(result.error,result.message);return result;
 }
}
module.exports={DeviceAuthorization,CALLBACK};
