'use strict';
const p=require('./protocol.cjs');

// Discourse's external_id is the durable topic identity. Its lookup may redirect
// to the canonical topic URL; credentials must never follow another origin.
async function discourseRequest(fetchImpl,origin,path,{token,username,method='GET',body,form}={}){
 let url=new URL(path,origin);
 for(let redirects=0;redirects<4;redirects++){
  if(url.origin!==origin||url.username||url.password)p.fail('Forum redirected outside its configured origin',409,'unsafe_redirect');
  const response=await fetchImpl(url.href,{method,redirect:'manual',headers:{Accept:'application/json',...(token?{'Api-Key':token,'Api-Username':username}:{}),...(body?{'Content-Type':'application/json'}:{})},body:form|| (body?JSON.stringify(body):undefined),signal:AbortSignal.timeout(20000)});
  if([301,302,303,307,308].includes(response.status)){
   if(method!=='GET'||!response.headers.get('location'))p.fail('Unexpected forum mutation redirect',409,'unsafe_redirect');
   url=new URL(response.headers.get('location'),url);await response.body?.cancel();continue;
  }
  if(!response.ok){await response.body?.cancel();throw Object.assign(Error('Forum returned HTTP '+response.status),{status:response.status});}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>8*1024*1024)throw Error('Forum response is too large');chunks.push(next.value);}}finally{await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }
 p.fail('Too many forum redirects',409,'unsafe_redirect');
}
const positive=value=>Number.isSafeInteger(value)&&value>0;
async function dispatchDiscourse(publisher,row,destination,old){
 const config=destination.config,externalId='rssd-'+p.hash([row.orgId,destination.id,row.workId,row.locale]).slice(0,40);
 const token=publisher.cipher().open(config.sealedToken,row.orgId+':'+destination.id);
 const request=(path,options={})=>discourseRequest(publisher.fetch,config.origin,path,{token,username:config.username,...options});
 const edition=row.payload.edition;let raw=edition.bodyMarkdown;
 for(const asset of edition.media||[]){
  if(!publisher.media)p.fail('Forum image storage is unavailable',400,'missing_media');
  const {bytes,row:mediaRow}=await publisher.media.bytes({orgId:row.orgId,admin:true,workspaceIds:null},asset.id);
  if(mediaRow.workspaceId!==row.workspaceId)p.fail('Forum media belongs to another workspace',403);
  const form=new FormData();form.set('type','composer');form.append('files[]',new Blob([bytes],{type:mediaRow.manifest.mime}),mediaRow.manifest.path.split('/').at(-1));
  const uploaded=await request('/uploads.json',{method:'POST',form});
  let url;try{url=new URL(uploaded.url,config.origin);}catch{p.fail('Forum returned an invalid image URL',409);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)p.fail('Forum returned an unsafe image URL',409);
  const escaped=asset.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  raw=raw.replace(new RegExp('(?:https?:\\/\\/[^/\\s)]+)?/api/rssd/v1/media/'+escaped+'/raw','g'),url.href);
 }
 if(/\/api\/rssd\/v1\/media\//.test(raw))p.fail('Forum article references an undeclared image',400,'missing_media');
 const marker=`<!-- rssd:${externalId}:${row.revision}:${row.payload.hash} -->`,expected=raw+'\n\n'+marker;
 let topic;
 try{topic=await request(old?.receipt.topicId?'/t/'+old.receipt.topicId+'.json':'/t/external_id/'+externalId+'.json');}
 catch(error){if(error.status!==404)throw error;}
 if(!topic){
  if(old||row.receipt.createIntent)p.fail('Forum topic is missing after a prior publication attempt; reconcile the original request before resending',409,'uncertain_creation');
  await publisher.checkpoint(row,{createIntent:true,externalId});
  const created=await request('/posts.json',{method:'POST',body:{title:edition.title,raw:expected,category:config.categoryId,external_id:externalId,auto_track:false}});
  if(!positive(created.topic_id)||!positive(created.id))p.fail('Forum returned no durable publication identity',409,'unverified_publication');
  await publisher.checkpoint(row,{topicId:created.topic_id,postId:created.id});
  topic=await request('/t/'+created.topic_id+'.json');
 }
 if(!positive(topic.id))p.fail('Invalid forum topic identity',409);
 const postId=row.receipt.postId||old?.receipt.postId||topic.post_stream?.posts?.find(post=>post.post_number===1)?.id;
 if(!positive(postId))p.fail('Forum topic has no first post',409);
 let post=await request('/posts/'+postId+'.json');
 if(post.topic_id!==topic.id||post.post_number!==1)p.fail('Forum post identity mismatch',409);
 if(post.raw!==expected){
  // Only overwrite the exact previous version accepted by this center. A
  // human edit on the forum or an uncertain older send needs reconciliation.
  if(!old?.receipt.rawHash||p.hash(post.raw)!==old.receipt.rawHash)p.fail('Forum content changed outside this revision; both versions are retained',409,'destination_conflict');
  await request('/posts/'+postId+'.json',{method:'PUT',body:{post:{raw:expected,original_text:post.raw,edit_reason:'RSSD revision '+row.revision}}});
  post=await request('/posts/'+postId+'.json');
 }
 if(topic.title!==edition.title){
  if(!old||topic.title!==old.receipt.title)p.fail('Forum title differs from the accepted revision',409,'destination_conflict');
  await request('/t/'+topic.id+'.json',{method:'PUT',body:{title:edition.title}});
  topic=await request('/t/'+topic.id+'.json');
 }
 if(post.raw!==expected||topic.title!==edition.title)p.fail('Forum readback does not match this revision',409,'unverified_publication');
 // Public destinations must be visible without administrator credentials.
 const visible=await discourseRequest(publisher.fetch,config.origin,'/t/'+topic.id+'.json');
 if(visible.id!==topic.id||!visible.post_stream?.posts?.some(x=>x.id===postId&&x.post_number===1))p.fail('Forum publication is not publicly visible',409,'unverified_publication');
 return publisher.finish(row,{state:'published',receipt:{externalId,topicId:topic.id,postId,url:config.origin+'/t/'+topic.id,revision:row.revision,contentHash:row.payload.hash,title:edition.title,rawHash:p.hash(expected),verifiedAt:new Date().toISOString()}});
}
module.exports={dispatchDiscourse,discourseRequest};
