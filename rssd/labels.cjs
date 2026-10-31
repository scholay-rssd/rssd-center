'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),p=require('./protocol.cjs');
async function configuration(file=process.env.RSSD_LABELS_CONFIG){
 if(!file)p.fail('标签缓存尚未迁移到中心',503,'labels_unavailable');
 const info=await fs.stat(file);if(info.size>16384||process.platform!=='win32'&&(info.mode&0o077))throw Error('Labels configuration must be private');
 const config=JSON.parse(await fs.readFile(file,'utf8'));p.id(config.orgId);if(!path.isAbsolute(config.database))throw Error('Absolute labels database path required');
 if(!(await fs.stat(config.database)).isFile())throw Error('Existing migrated labels ledger is required');
 return config;
}
class RssdLabels{
 constructor({configFile,now=Date.now}={}){this.configFile=configFile;this.now=now;this.cached=null;this.reads=new Map();}
 async feed(ctx){
  const config=await configuration(this.configFile);
  if(!ctx?.orgId||ctx.orgId!==config.orgId||!ctx.admin&&!ctx.workerId)p.fail('标签缓存访问被拒绝',403);
  const key=ctx.workerId||ctx.userId||'owner',now=this.now();for(const [id,row] of this.reads)if(row.until<=now)this.reads.delete(id);
  const read=this.reads.get(key)||{count:0,until:now+60000};if(++read.count>90)p.fail('标签缓存读取过于频繁',429);this.reads.set(key,read);
  const {labelsFeed}=await import('./legacy-labels/labels-store.mjs');
  const {DatabaseSync}=await import('node:sqlite');
  if(this.cached?.path!==config.database){this.cached?.db.close();this.cached={path:config.database,db:new DatabaseSync(config.database,{readOnly:true})};}
  return labelsFeed(this.cached.db,now);
 }
 close(){this.cached?.db.close();this.cached=null;}
}
module.exports={RssdLabels,configuration};
