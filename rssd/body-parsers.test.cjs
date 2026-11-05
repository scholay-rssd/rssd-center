'use strict';
require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {NestFactory}=require('@nestjs/core');
const {Controller,Module,Post,Req}=require('@nestjs/common');
const {registerBodyParsers}=require('./body-parsers.cjs');

class BodyProbe {
  echo(req) {
    return {body:Buffer.isBuffer(req.body)?req.body.toString('utf8'):req.body,
      rawBody:req.rawBody?.toString('utf8')??null};
  }
}
Controller()(BodyProbe);
Post(['rssd/v1/heartbeat','rssd/v1/claims','auth/login','rssd/v1/editorial/fixture/publish',
  'rssd/v1/editorial/fixture/staged-drafts',
  'rssd/v1/submissions','rssd/v1/drafts','rssd/v1/media','rssd/public/v1/community/discourse'])(
  BodyProbe.prototype,'echo',Object.getOwnPropertyDescriptor(BodyProbe.prototype,'echo'));
Req()(BodyProbe.prototype,'echo',0);
class ProbeModule {}
Module({controllers:[BodyProbe]})(ProbeModule);

async function start(t) {
  const app=await NestFactory.create(ProbeModule,{rawBody:true,logger:false});
  registerBodyParsers(app);
  t.after(()=>app.close());
  await app.listen(0,'127.0.0.1');
  const origin=await app.getUrl();
  return (path,body)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body});
}

test('production parser setup preserves default JSON bodies, raw bytes and the small request limit',async t=>{
  const post=await start(t),body='{ "state": "idle", "message": "synthetic" }\n';
  for(const path of ['/rssd/v1/heartbeat','/rssd/v1/claims','/auth/login']) {
    const response=await post(path,body);
    assert.equal(response.status,201,path);
    assert.deepEqual(await response.json(),{body:JSON.parse(body),rawBody:body},path);
    const oversized=await post(path,JSON.stringify({message:'x'.repeat(101*1024)}));
    assert.equal(oversized.status,413,path);
  }
});

test('staged draft bodies are bounded before parsing without changing publication limits',async t=>{
 const post=await start(t),path='/rssd/v1/editorial/fixture/staged-drafts';
 assert.equal((await post(path,JSON.stringify({value:'x'.repeat(3*1024*1024)}))).status,201);
 assert.equal((await post(path,JSON.stringify({value:'x'.repeat(4*1024*1024)}))).status,413);
});

test('editorial and submission parsers retain their larger payload support',async t=>{
  const post=await start(t),body=JSON.stringify({requestKey:'original-request',bodyMarkdown:'x'.repeat(200*1024)});
  for(const path of ['/rssd/v1/editorial/fixture/publish','/rssd/v1/submissions','/rssd/v1/drafts','/rssd/v1/media']) {
    const response=await post(path,body);
    assert.equal(response.status,201,path);
    assert.deepEqual((await response.json()).body,JSON.parse(body),path);
  }
});

test('signed forum webhooks keep their exact original bytes and 512 KiB limit',async t=>{
  const post=await start(t),path='/rssd/public/v1/community/discourse',body='{ "post": { "cooked": "虚构正文" } }\n';
  const response=await post(path,body);
  assert.equal(response.status,201);
  assert.equal((await response.json()).body,body);
  assert.equal((await post(path,'x'.repeat(512*1024+1))).status,413);
});
