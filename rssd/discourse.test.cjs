'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {dispatchDiscourse,discourseRequest}=require('./discourse.cjs');
const p=require('./protocol.cjs');
function fixture({lost=false,externalRedirect=false,missing=false,privateTopic=false}={}){
 let topic=null,post=null,creates=0,updates=0;
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
 const row={orgId:'example',id:'request-1',workId:'work',locale:'en',revision:1,workspaceId:'workspace',payload:{hash:'a'.repeat(64),edition:{title:'A complete original title',bodyMarkdown:'A complete original body.'}},receipt:{}};
 const destination={id:'forum',config:{origin:'https://forum.example',sealedToken:'sealed',username:'publisher',categoryId:5}};
 const publisher={cipher:()=>({open:()=> 'fixture-api-key'}),checkpoint:async(r,data)=>{r.receipt={...r.receipt,...data};},finish:async(r,out)=>out,
  fetch:async(url,options)=>{
   assert.equal(new URL(url).origin,destination.config.origin);assert.equal(options.redirect,'manual');
   if(options.headers['Api-Key'])assert.equal(options.headers['Api-Username'],'publisher');
   const path=new URL(url).pathname;
   if(path.startsWith('/t/external_id/'))return topic&&!missing?new Response(null,{status:302,headers:{location:externalRedirect?'https://untrusted.example/':'/t/9.json'}}):response({},404);
   if(path==='/posts.json'){
    creates++;const body=JSON.parse(options.body);topic={id:9,title:body.title,post_stream:{posts:[{id:12,post_number:1}]}};
    post={id:12,topic_id:9,post_number:1,raw:body.raw};if(lost)throw Error('Response lost after commit');return response(post);
   }
   if(path==='/t/9.json'){
    if(privateTopic&&!options.headers['Api-Key'])return response({},403);
    if(options.method==='PUT')topic.title=JSON.parse(options.body).title;
    return response(topic);
   }
   if(path==='/posts/12.json'){
    if(options.method==='PUT'){updates++;const change=JSON.parse(options.body).post;assert.equal(change.original_text,post.raw);post.raw=change.raw;}
    return response(post);
   }
   throw Error('Unexpected mock route '+path);
  }};
 return {row,destination,publisher,send:old=>dispatchDiscourse(publisher,row,destination,old),get creates(){return creates;},get updates(){return updates;},edit:()=>{post.raw='Human changed this on the forum';}};
}
test('forum response loss recovers the original external identity and updates it without creating a topic',async()=>{
 const f=fixture({lost:true});await assert.rejects(f.send(),/Response lost/);assert.equal(f.row.receipt.createIntent,true);
 const first=await f.send();assert.equal(first.state,'published');assert.equal(f.creates,1);
 f.row.id='request-2';f.row.revision=2;f.row.receipt={};f.row.payload.edition={title:'An updated original title',bodyMarkdown:'Revised complete body.'};f.row.payload.hash='b'.repeat(64);
 const second=await f.send({receipt:first.receipt});assert.equal(second.state,'published');assert.equal(second.receipt.postId,first.receipt.postId);assert.equal(f.creates,1);assert.equal(f.updates,1);
});
test('a missing topic after uncertain creation is never blindly recreated',async()=>{
 const f=fixture({lost:true,missing:true});await assert.rejects(f.send());await assert.rejects(f.send(),{code:'uncertain_creation'});assert.equal(f.creates,1);
});
test('manual forum edits are retained and block only this destination',async()=>{
 const f=fixture();const first=await f.send();f.edit();f.row.revision=2;f.row.receipt={};await assert.rejects(f.send({receipt:first.receipt}),{code:'destination_conflict'});assert.equal(f.creates,1);assert.equal(f.updates,0);
});
test('lookup redirects cannot leak credentials to a different origin',async()=>{
 const f=fixture({lost:true,externalRedirect:true});await assert.rejects(f.send());await assert.rejects(f.send(),{code:'unsafe_redirect'});assert.equal(f.creates,1);
});
test('administrator-only readback cannot be reported as public publication',async()=>{
 const f=fixture({privateTopic:true});await assert.rejects(f.send(),{status:403});assert.equal(f.creates,1);
});

test('media prepared only for another platform is not uploaded with the forum article',async()=>{
 const f=fixture();f.row.payload.edition.media=[{id:'platform-only-image',alt:'Social artwork'}];
 assert.equal((await f.send()).state,'published');assert.equal(f.creates,1);
});
