'use strict';
const p=require('./protocol.cjs');
const {randomUUID}=require('node:crypto');
const {schedulingGranted}=require('./store.cjs');
const string={type:'string'},number={type:'integer'},object={type:'object'};
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
class RssdMcp {
 constructor(store,coordination){this.store=store;this.coordination=coordination;}
 definitions(ctx){
  const reads={
   rssd_overview:['Read workspace goals, real progress and capabilities',schema({workspaceIds:string}),(a)=>this.coordination.overview(ctx,a)],
   rssd_demands:['Read the demand pool; preserve generation when editing',schema({workspaceId:string,state:string,search:string,limit:number,offset:number}),(a)=>this.store.demands(ctx,a)],
   rssd_works:['Search accepted works without counting language editions twice',schema({workspaceId:string,search:string,limit:number,offset:number}),(a)=>this.store.works(ctx,a)],
   rssd_work:['Read original work and language revisions',schema({workId:string},['workId']),(a)=>this.store.work(ctx,a.workId)],
   rssd_calendar:['Read original Postiz posts and RSSD publications; source identities are retained',schema({workspaceIds:string,from:string,to:string,limit:number,offset:number}),(a)=>this.coordination.calendar(ctx,a)],
   rssd_channels:['Read scoped destination and channel status without credentials',schema({workspaceIds:string}),(a)=>this.coordination.channels(ctx,a)],
   rssd_goals:['Read goal definitions, periods and maintainer results',schema({workspaceIds:string}),(a)=>this.coordination.goals(ctx,a)],
   rssd_receipt:['Recover the original submission before considering retry',schema({requestId:string},['requestId']),(a)=>this.store.submissionStatus(ctx,a.requestId)],
  };
  const writes={
   rssd_edit_demand:['Edit a queued demand using its generation and a stable requestId; claimed rules are frozen',schema({id:string,baseGeneration:number,requestId:string,changes:object},['id','baseGeneration','requestId','changes']),(a)=>this.coordination.editDemand(ctx,a.id,a)],
   rssd_create_demand:['Create one queued demand; translation of an existing work binds the source revision and hash, skips locales that already exist, and reuses an open task. storeOnly=true freezes a center-only English continuation that cannot be claimed or published by default consumers',schema({workspaceId:string,sectionId:string,kind:string,title:string,brief:string,requiredLocales:{type:'array',items:string},source:object,priority:number,id:string,storeOnly:{type:'boolean'}},['workspaceId','sectionId','title']),(a)=>this.store.createDemand(ctx,a)],
  };
  if(ctx.admin){
   writes.rssd_save_goal=['Save a goal; enabling maintenance creates queued demands only, never claims or publishes',schema({id:string,baseRevision:number,requestId:string,goal:object},['id','baseRevision','requestId','goal']),(a)=>this.coordination.saveGoal(ctx,a)];
   writes.rssd_grant_capability=['Owner-only grant of a minimal device capability; devices cannot self-authorize',schema({workerId:string,operation:string,workspaceIds:{type:'array',items:string},destinationIds:{type:'array',items:string},requestId:string},['workerId','operation','workspaceIds','destinationIds','requestId']),(a)=>this.coordination.grantCapability(ctx,a)];
   writes.rssd_revoke_capability=['Owner-only revoke of a previously granted device capability',schema({id:string,requestId:string},['id','requestId']),(a)=>this.coordination.revokeCapability(ctx,a)];
  }
  if(ctx.admin||ctx.workerId){
   writes.rssd_schedule_publication=['Reschedule an unstarted RSSD publication using its unchanged identity; native Postiz posts are managed in the original calendar',schema({id:string,expectedUpdatedAt:string,requestId:string,scheduledAt:string},['id','expectedUpdatedAt','requestId','scheduledAt']),(a)=>this.coordination.schedule(ctx,a.id,a)];
  }
  if(ctx.workerId){
   reads.rssd_current_claim=['Read this device claim for explicit recovery',schema(),()=>this.store.activeClaim(ctx)];
   writes.rssd_claim=['Claim one demand for this device; exclusive center claim rules apply. Store-only translates require storeOnly=true and belong to the creating device',schema({demandId:string,workspaceIds:{type:'array',items:string},sectionIds:{type:'array',items:string},storeOnly:{type:'boolean'}}),(a)=>this.store.claim(ctx,a)];
   writes.rssd_release=['Explicitly release this device claim; preserve local work before releasing',schema({id:string,claimToken:string},['id','claimToken']),(a)=>this.store.changeDemand(ctx,a.id,{action:'release',claimToken:a.claimToken})];
   writes.rssd_submit=['Submit a claimed work with original requestId, claimToken and base revisions; query receipt after timeout',schema({packet:object},['packet']),(a)=>this.store.submit(ctx,a.packet)];
  }
  return Object.fromEntries([...Object.entries(reads).map(([k,v])=>[k,{description:v[0],inputSchema:v[1],run:v[2],readOnly:true}]),...Object.entries(writes).map(([k,v])=>[k,{description:v[0],inputSchema:v[1],run:v[2],readOnly:false}])]);
 }
 async handle(ctx,message){
  const error=(code,message,id=null)=>({jsonrpc:'2.0',id,error:{code,message}});
  if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')return error(-32600,'Invalid request');
  const id=message.id;
  if(id===undefined)return ['notifications/initialized','notifications/cancelled'].includes(message.method)?null:error(-32600,'Requests require an id');
  if(typeof id!=='string'&&typeof id!=='number')return error(-32600,'Invalid request id');
  const result=value=>({jsonrpc:'2.0',id,result:value});
  if(message.method==='initialize')return result({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'RSSD Center',version:'1.1.0'},instructions:'Use the center as the only authority for claims and publishing. Query original receipts after timeout. Never put credentials in tool arguments.'});
  if(message.method==='ping')return result({});
  const definitions=this.definitions(ctx);
  if(message.method==='tools/list')return result({tools:Object.entries(definitions).filter(([name])=>name!=='rssd_schedule_publication'||schedulingGranted(ctx)).map(([name,d])=>({name,description:d.description,inputSchema:d.inputSchema,annotations:{readOnlyHint:d.readOnly,destructiveHint:!d.readOnly,idempotentHint:d.readOnly||['rssd_edit_demand','rssd_save_goal','rssd_schedule_publication','rssd_submit','rssd_create_demand','rssd_grant_capability','rssd_revoke_capability'].includes(name),openWorldHint:!d.readOnly}}))});
  if(message.method!=='tools/call')return error(-32601,'Method not found',id);
  const name=message.params?.name,d=definitions[name],args=message.params?.arguments||{};
  if(!d)return error(-32602,'Unknown or unavailable tool',id);
  if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!Object.hasOwn(d.inputSchema.properties,k))||d.inputSchema.required.some(k=>args[k]===undefined))return error(-32602,'Invalid tool arguments',id);
  try{
   const output=await d.run(args);
   await this.store.db.$executeRawUnsafe('INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,randomUUID(),ctx.workerId||ctx.userId,'mcp.'+name,JSON.stringify({argumentHash:p.hash(args),readOnly:d.readOnly}));
   return result({content:[{type:'text',text:JSON.stringify(output)}]});
  }catch(e){return result({isError:true,content:[{type:'text',text:JSON.stringify({code:e.code||'service_unavailable',message:e instanceof p.ProtocolError?e.message:'中心暂时不可用，请保留原请求并查询回执'})}]});}
 }
}
module.exports={RssdMcp};
