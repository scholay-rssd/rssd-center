'use strict';
const p=require('./protocol.cjs');
const {admin}=require('./store.cjs');
const one=async(db,sql,...values)=>(await db.$queryRawUnsafe(sql,...values))[0]||null;
const postHash=post=>p.hash({content:post.content,image:JSON.parse(post.image||'[]'),settings:JSON.parse(post.settings||'{}')});
class RssdPostiz {
 constructor(store,{validate,startWorkflow,workflowStatus,uploadMedia}={}){Object.assign(this,{store,db:store.db,validate,startWorkflow,workflowStatus,uploadMedia});}
 async channels(ctx){admin(ctx);return this.db.$queryRawUnsafe('SELECT id,name,"providerIdentifier",disabled,"refreshNeeded" FROM "Integration" WHERE "organizationId"=$1 AND "deletedAt" IS NULL ORDER BY name,id',ctx.orgId);}
 async channel(orgId,id){
  const channel=await one(this.db,'SELECT id,name,"providerIdentifier",disabled,"refreshNeeded" FROM "Integration" WHERE "organizationId"=$1 AND id=$2 AND "deletedAt" IS NULL',orgId,p.id(id));
  if(!channel)p.fail('Channel not found in this organization',404,'channel_not_found');return channel;
 }
 async dispatch(publisher,row,destination,previous){
  // Postiz's generic "update" edits its local scheduling record, not the
  // remote post. Never turn a content revision into an accidental new post.
  if(previous)return publisher.finish(row,{state:'blocked',receipt:{...row.receipt,previous:previous.receipt},error:'此平台连接器暂不支持原帖更新；保留原发布身份，等待人工处理。'});
  const uncertainPrior=await one(this.db,`SELECT id,receipt FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND revision<$5 AND receipt->'postiz'->>'postId' IS NOT NULL ORDER BY revision DESC LIMIT 1`,row.orgId,row.workId,row.locale,row.destinationId,row.revision);
  if(uncertainPrior)return publisher.finish(row,{state:'blocked',receipt:{...row.receipt,previous:uncertainPrior.receipt},error:'原版本已有平台发布任务；请先核对原任务的结果，不能用新版本绕过未确认的发布。'});
  const channel=await this.channel(row.orgId,destination.config.integrationId);
  const id='rssd-'+p.hash([row.orgId,row.id]).slice(0,48),workflowId='post_'+id;
  let saved=await one(this.db,'SELECT * FROM "Post" WHERE id=$1 AND "organizationId"=$2',id,row.orgId);
  let receipt=row.receipt.postiz||{};
  if(saved){
   if(saved.integrationId!==channel.id||saved.deletedAt||receipt.postId!==id||receipt.contentHash!==postHash(saved))p.fail('Postiz publication was changed outside RSSD; reconcile the original post',409,'postiz_conflict');
  }else{
   if(channel.disabled||channel.refreshNeeded)p.fail('渠道已停用或需要重新授权，请在渠道页面处理。',409,'channel_unavailable');
   const edition=row.payload.edition,content=edition.metadata?.platformContent?.[destination.id];
   if(!content)p.fail('缺少此渠道的发布正文与素材：'+destination.id,422,'missing_platform_content');
   const text=p.text(content.text,'platform text',100000,true);
   const ids=[...new Set(p.array(content.mediaIds||[],'platform media',20).map(x=>p.id(x)))];
   if(!text.trim()&&!ids.length)p.fail('Platform content is empty',422,'missing_platform_content');
   const settings={...p.json(content.settings||{},'platform settings',30000),__type:channel.providerIdentifier};
   const media=[];
   for(const mediaId of ids){
    if(!edition.media?.some(m=>m.id===mediaId))p.fail('平台素材不在此语言版本的附件清单中。',422,'missing_media');
    if(!publisher.media||!this.uploadMedia)p.fail('Platform media storage is unavailable',422,'missing_media');
    const {bytes,row:asset}=await publisher.media.bytes({orgId:row.orgId,admin:true,workspaceIds:null},mediaId);
    if(asset.workspaceId!==row.workspaceId)p.fail('Platform media belongs to a different workspace',403);
    let exported=receipt.media?.[mediaId];
    if(!exported){
     exported=await this.uploadMedia({bytes,asset});p.publicUrl(exported.path);
     receipt={...receipt,media:{...receipt.media,[mediaId]:{id:mediaId,path:exported.path}}};
     await publisher.checkpoint(row,{postiz:receipt});
    }
    media.push({id:mediaId,path:exported.path,alt:edition.media.find(m=>m.id===mediaId).alt||''});
   }
   const spec={content:text,image:media,settings};
   const [validation]=await this.validate(row.orgId,[{integration:{id:channel.id},value:[{content:text,image:media}],settings}]);
   if(!validation||!validation.valid||validation.errors!==true||validation.emptyContent||validation.tooLong)p.fail('平台格式或素材校验未通过：'+(validation?.settingsError||String(validation?.errors!==true?validation?.errors:'')||(validation?.tooLong?'正文超出平台长度限制':'缺少正文或素材')),422,'platform_validation');
   receipt={...receipt,postId:id,workflowId,contentHash:p.hash(spec)};
   await publisher.checkpoint(row,{postiz:receipt});
   saved=await this.store.transaction(async db=>{
    await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',id);
    const lease=await one(db,'SELECT id FROM rssd_publications WHERE "orgId"=$1 AND id=$2 AND "leaseToken"=$3 FOR UPDATE',row.orgId,row.id,row.leaseToken);
    if(!lease)p.fail('Publication lease changed',409,'lease_revoked');
    await db.$executeRawUnsafe(`INSERT INTO "Post" (id,"organizationId","integrationId",state,"publishDate",content,"group","batchId",image,settings,"creationMethod","updatedAt")
      VALUES ($1,$2,$3,'QUEUE',CURRENT_TIMESTAMP,$4,$1,$1,$5,$6,'API',CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,id,row.orgId,channel.id,text,JSON.stringify(media),JSON.stringify(settings));
    const post=await one(db,'SELECT * FROM "Post" WHERE id=$1 AND "organizationId"=$2',id,row.orgId);
    if(!post||post.integrationId!==channel.id||postHash(post)!==receipt.contentHash)p.fail('Postiz identity conflict',409,'postiz_conflict');return post;
   });
  }
  if(saved.state==='PUBLISHED'){
   if(!saved.releaseId||!saved.releaseURL)p.fail('Postiz is missing the platform publication receipt',409,'missing_receipt');
   p.publicUrl(saved.releaseURL);
   return publisher.finish(row,{state:'published',receipt:{...row.receipt,postId:id,releaseId:saved.releaseId,url:saved.releaseURL,verification:'postiz-provider-receipt',verifiedAt:new Date().toISOString()}});
  }
  if(saved.state!=='QUEUE')return publisher.finish(row,{state:'blocked',receipt:row.receipt,error:'Postiz 原发布任务需要处理（'+saved.state+'）：'+String(saved.error||'请查看原任务，勿重新创建发布').slice(0,1000)});
  const workflow=await this.workflowStatus(workflowId);
  if(workflow){
   if(receipt.runId&&workflow.runId!==receipt.runId)p.fail('Postiz workflow identity changed',409,'workflow_conflict');
   if(!receipt.runId){receipt={...receipt,runId:workflow.runId};await publisher.checkpoint(row,{postiz:receipt});}
   return publisher.finish(row,{state:workflow.status==='RUNNING'?'queued':'blocked',receipt:row.receipt,delay:15000,error:workflow.status==='RUNNING'?null:'原发布流程已结束，但尚无成功回执；请核对原任务。'});
  }
  if(receipt.startIntent)p.fail('原发布流程启动结果不确定；需先核查原工作流，不能自动新建发布。',409,'uncertain_workflow');
  receipt={...receipt,startIntent:true};await publisher.checkpoint(row,{postiz:receipt});
  const started=await this.startWorkflow({workflowId,postId:id,organizationId:row.orgId,taskQueue:channel.providerIdentifier.split('-')[0].toLowerCase()});
  await publisher.checkpoint(row,{postiz:{...receipt,runId:started.runId}});
  return publisher.finish(row,{state:'queued',receipt:row.receipt,delay:15000});
 }
}
module.exports={RssdPostiz};
