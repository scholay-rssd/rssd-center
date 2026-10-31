'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),p=require('./protocol.cjs'),{admin}=require('./store.cjs');
class RssdCommunity{
 constructor(store,{configFile=process.env.RSSD_COMMUNITY_CONFIG,now=Date.now,lookupPost}={}){this.store=store;this.configFile=configFile;this.now=now;this.lookupPost=lookupPost;this.loading=null;this.sources=new Set();this.refreshed=0;this.refreshing=null;}
 async ready(){
  if(!this.configFile)p.fail('Community mapping is not configured',503,'community_unavailable');
  if(!this.loading)this.loading=(async()=>{
   const info=await fs.stat(this.configFile);if(info.size>16384||process.platform!=='win32'&&(info.mode&0o077))throw Error('Private community configuration required');
   const config=JSON.parse(await fs.readFile(this.configFile,'utf8'));p.id(config.orgId);if(!path.isAbsolute(config.root))throw Error('Absolute community state required');
   await fs.access(path.join(config.root,'links.sqlite'));
   const secretInfo=await fs.stat(config.secretFile);if(secretInfo.size>8192||process.platform!=='win32'&&(secretInfo.mode&0o077))throw Error('Private webhook secret required');
   const secret=(await fs.readFile(config.secretFile,'utf8')).trim(),engine=await import('./community-engine.mjs');
   const links=engine.createCommunityLinks({root:config.root,secret,lookupPost:this.lookupPost,sourceExists:source=>this.sources.has(source.url)});
   this.loaded={config,secret,engine,links};return this.loaded;
  })().catch(e=>{this.loading=null;throw e;});
  return this.loading;
 }
 async refresh(force=false){
  if(!force&&this.refreshed&&this.now()-this.refreshed<60000)return;
  if(this.refreshing)return this.refreshing;
  this.refreshing=(async()=>{
   const {config,engine}=await this.ready();
   const rows=await this.store.db.$queryRawUnsafe(`SELECT DISTINCT receipt->>'url' AS url FROM rssd_publications WHERE "orgId"=$1 AND state IN ('published','legacy_published')`,config.orgId);
   this.sources=new Set(rows.map(r=>engine.normalizedSource(r.url)?.url).filter(Boolean));this.refreshed=this.now();
  })();try{await this.refreshing;}finally{this.refreshing=null;}
 }
 async accept(raw,headers){
  const {secret,engine,links}=await this.ready();
  if(!Buffer.isBuffer(raw)||raw.length>512*1024||!engine.validSignature(raw,headers['x-discourse-event-signature'],secret))return {statusCode:401,body:{error:'Invalid webhook signature'}};
  let value;try{value=JSON.parse(raw);}catch{return {statusCode:400,body:{error:'Invalid JSON'}};}
  const source=engine.normalizedSource(engine.sourceFromPost(value.post||{}));
  // Unknown new sources and topic-only notifications refresh before acceptance;
  // the source must be a published center record, not merely a matching title.
  await this.refresh(Boolean(value.topic)||Boolean(source&&!this.sources.has(source.url)));
  if(source&&!this.sources.has(source.url)&&!['post_destroyed','topic_destroyed'].includes(headers['x-discourse-event']))return {statusCode:503,body:{error:'Published source is not yet available in center; retry delivery'}};
  return links.accept({raw,signature:headers['x-discourse-event-signature'],eventId:headers['x-discourse-event-id'],eventType:headers['x-discourse-event'],instance:headers['x-discourse-instance']});
 }
 async publicLinks(siteId){
  p.id(siteId);const {config,links}=await this.ready(),catalog=JSON.parse(await fs.readFile(path.join(config.root,'config.json'),'utf8'));
  if(!catalog.sites.some(s=>s.id===siteId))p.fail('Community site not found',404);
  await links.flush();
  const file=path.join(config.root,'public',siteId,'links.json');
  try{if((await fs.stat(file)).size>4*1024*1024)throw Error('Community replica is too large');return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {version:1,links:{}};throw error;}
 }
 async status(ctx){
  admin(ctx);if(!this.configFile)return {configured:false};const {config,links}=await this.ready();
  if(config.orgId!==ctx.orgId)p.fail('Community access denied',403);
  return {configured:true,links:links.db.prepare('SELECT count(*) AS n FROM links').get().n,events:links.db.prepare('SELECT count(*) AS n FROM events').get().n};
 }
 async close(){if(this.loaded)await this.loaded.links.close();}
}
module.exports={RssdCommunity};
