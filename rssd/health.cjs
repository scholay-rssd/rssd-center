'use strict';
const fs=require('node:fs/promises');
const {admin}=require('./store.cjs');
async function backupStatus(file,now=Date.now()){
 if(!file)return {state:'not_configured'};
 try{
  if((await fs.stat(file)).size>16384)throw Error('Oversize status');
  const value=JSON.parse(await fs.readFile(file,'utf8')),last=value.lastSuccess?.verifiedAt;
  const time=Date.parse(last),fresh=Number.isFinite(time)&&time<=now+60000&&now-time<36*3600000;
  return {state:value.state==='failed'?'failed':value.state==='running'?'running':fresh?'healthy':'stale',lastVerifiedAt:Number.isFinite(time)?last:null,bytes:Number(value.lastSuccess?.bytes)||0};
 }catch{return {state:'unavailable'};}
}
async function health(store,ctx,{backupFile=process.env.RSSD_BACKUP_STATUS_FILE,dispatchEnabled=process.env.RSSD_DISPATCH_ENABLED==='1',now=Date.now()}={}){
 admin(ctx);
 const [demands,publications,workers,works,actions,backup]=await Promise.all([
  store.db.$queryRawUnsafe('SELECT state,count(*)::integer AS count FROM rssd_demands WHERE "orgId"=$1 GROUP BY state',ctx.orgId),
  store.db.$queryRawUnsafe('SELECT state,count(*)::integer AS count FROM rssd_publications WHERE "orgId"=$1 GROUP BY state',ctx.orgId),
  store.db.$queryRawUnsafe('SELECT id,name,state,"heartbeatAt" FROM rssd_workers WHERE "orgId"=$1 AND "revokedAt" IS NULL ORDER BY name,id',ctx.orgId),
  store.db.$queryRawUnsafe('SELECT count(*)::integer AS count FROM rssd_works WHERE "orgId"=$1',ctx.orgId),
  store.db.$queryRawUnsafe('SELECT state,count(*)::integer AS count FROM rssd_editorial_actions WHERE "orgId"=$1 GROUP BY state',ctx.orgId),backupStatus(backupFile,now)
 ]);
 return {checkedAt:new Date(now).toISOString(),dispatchEnabled,works:works[0]?.count||0,demands,publications,actions,
  workers:workers.map(w=>({...w,online:Boolean(w.heartbeatAt)&&now-new Date(w.heartbeatAt).getTime()<120000})),backup};
}
module.exports={health,backupStatus};
