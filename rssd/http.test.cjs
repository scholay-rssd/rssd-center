'use strict';
require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Test}=require('@nestjs/testing');
const {ThrottlerModule}=require('@nestjs/throttler');
// Only replace the service dependency; exercise the shipped controller and
// Nest/Express serialization through real HTTP, including explicit JSON null.
const path=require.resolve('../apps/backend/dist/apps/backend/src/rssd/rssd.service.js');
class RssdService {}
require.cache[path]={id:path,filename:path,loaded:true,exports:{RssdService}};
const {RssdController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.controller.js');
const {RssdGuestbookController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.guestbook.controller.js');
const {RssdCommunityController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.community.controller.js');
const {RssdAuthController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.auth.controller.js');

test('RSSD MCP connects through the official client without replacing native Postiz MCP',async t=>{
 const {RssdMcp}=require('../apps/backend/dist/rssd/mcp.cjs');
 const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const mcp=new RssdMcp({db:{$executeRawUnsafe:async()=>1}},{overview:async()=>({contractVersion:1,workspaces:[{id:'fixture'}]})});
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{mcp}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={orgId:'fixture',workerId:'device',admin:false,workspaceIds:['fixture']};next();});await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const url=new URL('/rssd/v1/mcp',await app.getUrl()),client=new Client({name:'RSSD contract acceptance',version:'1'});
 const transport=new StreamableHTTPClientTransport(url);await client.connect(transport);t.after(()=>client.close());
 assert((await client.listTools()).tools.some(tool=>tool.name==='rssd_overview'));
 const reply=await client.callTool({name:'rssd_overview',arguments:{}});assert.equal(JSON.parse(reply.content[0].text).workspaces[0].id,'fixture');
 assert.equal((await fetch(url)).status,405);
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'invalid'},body:JSON.stringify({jsonrpc:'2.0',id:8,method:'ping'})})).status,400);
});

test('device bootstrap routes are no-store, independently rate-limited and preserve protocol errors',async t=>{
 const {ThrottlerModule}=require('@nestjs/throttler'),{ProtocolError}=require('../apps/backend/dist/rssd/protocol.cjs');
 let started=0;
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdAuthController],providers:[{provide:RssdService,useValue:{authorization:{start:async()=>{started++;return {requestId:'synthetic-request'};},exchange:async()=>{throw new ProtocolError('Waiting for approval',400,'authorization_pending');}}}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl();const post=path=>fetch(origin+'/rssd/v1/auth/'+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 const token=await post('token');assert.equal(token.status,400);assert.equal((await token.json()).code,'authorization_pending');
 for(let i=0;i<6;i++){const response=await post('start');assert.equal(response.status,201);assert.equal(response.headers.get('cache-control'),'no-store');}
 assert.equal((await post('start')).status,429);assert.equal(started,6);
});

test('forum webhook receives original signed bytes and enforces the small raw body limit',async t=>{
 const original=Buffer.from('{ "post": { "cooked": "虚构正文" } }\n');let calls=0;
 const module=await Test.createTestingModule({controllers:[RssdCommunityController],providers:[{provide:RssdService,useValue:{community:{accept:async(raw,headers)=>{calls++;assert(Buffer.isBuffer(raw));assert(raw.equals(original));assert.equal(headers['x-discourse-event-signature'],'fixture-signature');return {statusCode:200,body:{ok:true}};}}}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use('/rssd/public/v1/community/discourse',require('express').raw({type:'application/json',limit:'512kb'}));await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const url=await app.getUrl()+'/rssd/public/v1/community/discourse',headers={'content-type':'application/json','x-discourse-event-signature':'fixture-signature'};
 assert.equal((await fetch(url,{method:'POST',headers,body:original})).status,200);
 assert.equal((await fetch(url,{method:'POST',headers,body:'x'.repeat(512*1024+1)})).status,413);assert.equal(calls,1);
});

test('guestbook HTTP session keeps secure same-site cookies and owner fields out of public messages',async t=>{
 const service={guestbook:{
  session:async(site,headers)=>{assert.equal(site,'fixture');assert.equal(headers['x-rssd-site-token'],'fixture-token');return {cookie:{name:'__Host-today-guest-fixture',value:'fixture-cookie'},body:{csrf:'fixture-csrf',remaining:2,config:{siteId:site}}};},
  publicMessages:async()=>({messages:[{id:'message-1',kind:'message',name:'Synthetic',message:'Approved',created:1}]}),
  submit:async(site,headers,cookies,body)=>({id:body.requestKey,replayed:false,status:'received',remaining:1}),
 }};
 const module=await Test.createTestingModule({controllers:[RssdGuestbookController],providers:[{provide:RssdService,useValue:service}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);await app.listen(0,'127.0.0.1');t.after(()=>app.close());const origin=await app.getUrl(),base=origin+'/rssd/public/v1/guestbooks/fixture';
 const session=await fetch(base+'/session',{headers:{'x-rssd-site-token':'fixture-token'}});assert.equal(session.status,200);assert.equal(session.headers.get('cache-control'),'no-store');
 const cookie=session.headers.get('set-cookie');for(const attr of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert(cookie.includes(attr));assert(!cookie.includes('Domain='));
 assert.equal((await session.json()).remaining,2);
 const posted=await fetch(base+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestKey:'original-request'})});assert.equal(posted.status,201);assert.equal((await posted.json()).id,'original-request');
 const publicResult=await(await fetch(base+'/messages')).json();assert.deepEqual(Object.keys(publicResult.messages[0]).sort(),['created','id','kind','message','name']);
});
test('HTTP schedule and grant writes return 403 from coordination, not from MCP listing',async t=>{
 const {ProtocolError}=require('../apps/backend/dist/rssd/protocol.cjs');
 const coordination={
  schedule:async()=>{throw new ProtocolError('Owner access required',403,'forbidden');},
  grantCapability:async()=>{throw new ProtocolError('Owner access required',403,'forbidden');},
 };
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{coordination}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={orgId:'org',workerId:'device',admin:false,workspaceIds:['a']};next();});
 await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl(),headers={'content-type':'application/json'};
 const schedule=await fetch(origin+'/rssd/v1/publications/pub-1/schedule',{method:'POST',headers,body:JSON.stringify({requestId:'req-schedule',expectedUpdatedAt:'2026-01-01T00:00:00.000Z',scheduledAt:'2026-01-02T00:00:00.000Z'})});
 assert.equal(schedule.status,403);assert.equal((await schedule.json()).code,'forbidden');
 const grant=await fetch(origin+'/rssd/v1/workers/worker-1/grants',{method:'POST',headers,body:JSON.stringify({requestId:'req-grant',operation:'publicationScheduling',workspaceIds:['a'],destinationIds:['site']})});
 assert.equal(grant.status,403);assert.equal((await grant.json()).code,'forbidden');
});

test('HTTP existing English site publish forwards identity fields and recovers the receipt',async t=>{
 const {ProtocolError}=require('../apps/backend/dist/rssd/protocol.cjs');
 const calls=[];
 const existingSitePublish={
  publish:async(ctx,body)=>{calls.push(['publish',body]);if(body.retry)throw new ProtocolError('Unknown field',400,'invalid_request');return {status:'created',requestId:body.requestId,locale:'en',destinationId:body.destinationId,publicationIds:undefined};},
  receipt:async(ctx,requestId)=>{calls.push(['receipt',requestId]);return {status:'existing',requestId,locale:'en'};},
 };
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{existingSitePublish}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={orgId:'org',workerId:'device',admin:false,workspaceIds:['enter']};next();});
 await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl(),headers={'content-type':'application/json'};
 const body={requestId:'req-site',workId:'work-1',locale:'en',revision:1,hash:'a'.repeat(64),destinationId:'site-enter',articleId:'shared-manuscript'};
 const created=await fetch(origin+'/rssd/v1/site-publications',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal(created.status,201);assert.equal((await created.json()).destinationId,'site-enter');assert.deepEqual(calls[0][1],body);
 const bad=await fetch(origin+'/rssd/v1/site-publications',{method:'POST',headers,body:JSON.stringify({...body,retry:true})});
 assert.equal(bad.status,400);assert.equal((await bad.json()).code,'invalid_request');
 const recovered=await fetch(origin+'/rssd/v1/site-publications/req-site');
 assert.equal(recovered.status,200);assert.equal((await recovered.json()).requestId,'req-site');assert.deepEqual(calls[2],['receipt','req-site']);
});

test('HTTP demands, claims, drafts and submissions forward storeOnly and publish flags',async t=>{
 const {ProtocolError}=require('../apps/backend/dist/rssd/protocol.cjs');
 const calls=[];
 const store={
  createDemand:async(ctx,body)=>{calls.push(['create',body]);if(body.storeOnly!==undefined&&typeof body.storeOnly!=='boolean')throw new ProtocolError('storeOnly must be a boolean',400,'invalid_request');return {status:'created',storeOnly:body.storeOnly===true};},
  claim:async(ctx,body)=>{calls.push(['claim',body]);return {id:'demand-1',payload:{storeOnly:body.storeOnly===true}};},
  submit:async(ctx,body,opts={})=>{calls.push(['submit',opts.publish===false?'draft':'publish',body.requestId]);return {status:opts.publish===false?'draft_saved':'accepted',publicationIds:[],demandState:opts.publish===false?undefined:'completed'};},
 };
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{store}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={orgId:'org',workerId:'device',admin:false,workspaceIds:['research']};next();});
 await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl(),headers={'content-type':'application/json'};
 const created=await fetch(origin+'/rssd/v1/demands',{method:'POST',headers,body:JSON.stringify({workspaceId:'research',sectionId:'methods',kind:'translate',title:'en',storeOnly:true})});
 assert.equal(created.status,201);assert.equal((await created.json()).storeOnly,true);assert.equal(calls.find(c=>c[0]==='create')[1].storeOnly,true);
 const invalid=await fetch(origin+'/rssd/v1/demands',{method:'POST',headers,body:JSON.stringify({workspaceId:'research',sectionId:'methods',title:'bad',storeOnly:'true'})});
 assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'invalid_request');
 const claimed=await fetch(origin+'/rssd/v1/claims',{method:'POST',headers,body:JSON.stringify({demandId:'demand-1',storeOnly:true})});
 assert.equal(claimed.status,201);assert.equal(calls.find(c=>c[0]==='claim')[1].storeOnly,true);
 const draft=await fetch(origin+'/rssd/v1/drafts',{method:'POST',headers,body:JSON.stringify({requestId:'req-draft'})});
 assert.equal(draft.status,201);assert.equal((await draft.json()).status,'draft_saved');
 const submitted=await fetch(origin+'/rssd/v1/submissions',{method:'POST',headers,body:JSON.stringify({requestId:'req-sub'})});
 assert.equal(submitted.status,201);assert.equal((await submitted.json()).status,'accepted');
 assert.deepEqual(calls.filter(c=>c[0]==='submit').map(c=>c[1]),['draft','publish']);
});

test('idle and active claims are valid JSON over the production HTTP controller',async t=>{
 let current=null;
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{store:{claim:async()=>current,activeClaim:async()=>current}}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);
 await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl();
 for(const expected of [null,{id:'claim',claimToken:'fixture'}]){
  current=expected;
  for(const [path,method] of [['/claims','POST'],['/claims/current','GET']]){
   const response=await fetch(origin+'/rssd/v1'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
   assert.equal(response.status,method==='POST'?201:200);
   assert.match(response.headers.get('content-type'),/application\/json/);
   assert.deepEqual(await response.json(),expected);
  }
 }
});

test('editorial HTTP bridge preserves nested paths, query options, request keys and domain errors',async t=>{
 const calls=[];const {ProtocolError}=require('../apps/backend/dist/rssd/protocol.cjs');
 const service={editorial:{api:async(ctx,workspace,method,path,query,body)=>{
   calls.push({ctx,workspace,method,path,query,body});
   if(path.join('/')==='actions')throw new ProtocolError('Action awaits receiver handover',409,'center_action_pending');
   return {centerManaged:true,path,requestKey:body?.requestKey};
 }}};
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:service}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={orgId:'synthetic',workspaceIds:['research']};next();});
 await app.listen(0,'127.0.0.1');t.after(()=>app.close());const base=await app.getUrl()+'/rssd/v1/editorial/research';
 let response=await fetch(base+'/drafts/requests/original-request');assert.equal(response.status,200);assert.deepEqual((await response.json()).path,['drafts','requests','original-request']);
 response=await fetch(base+'/catalog?scope=all&after=80&locale=en');assert.equal(response.status,200);assert.deepEqual({...calls.at(-1).query},{scope:'all',after:'80',locale:'en'});assert.equal(calls.at(-1).workspace,'research');
 response=await fetch(base+'/cloud/batch/read?locale=en&ids=one%2Ctwo');assert.equal(response.status,200);assert.deepEqual((await response.json()).path,['cloud','batch','read']);assert.deepEqual({...calls.at(-1).query},{locale:'en',ids:'one,two'});
 response=await fetch(base+'/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestKey:'original-request'})});assert.equal(response.status,201);assert.equal((await response.json()).requestKey,'original-request');assert.equal(calls.at(-1).ctx.orgId,'synthetic');
 response=await fetch(base+'/actions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,409);assert.equal((await response.json()).code,'center_action_pending');
});

test('migration proof HTTP route enforces device scope and never caches evidence',async t=>{
 const {RssdMigration}=require('../apps/backend/dist/rssd/migration.cjs');
 const p=require('../apps/backend/dist/rssd/protocol.cjs');
 const evidence={receiptId:'run:enter',baselineSha256:'a'.repeat(64),receiverRelease:'rev-1',rollbackReference:'/private/path'};
 const report={siteId:'enter',workspaceId:'enter',state:'active',cutover:{...evidence,evidenceHash:p.hash(evidence)}};
 const migration=new RssdMigration({db:{$queryRawUnsafe:async(sql,...args)=>args[0]==='org'&&args[1]==='enter'&&args[2]==='enter'?[{siteId:'enter',workspaceId:'enter',state:'active',report}]:[]}});
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{migration}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={orgId:'org',workerId:'device',admin:false,workspaceIds:['enter']};next();});await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const base=await app.getUrl(),ok=await fetch(base+'/rssd/v1/migration-proof/enter/enter');assert.equal(ok.status,200);assert.match(ok.headers.get('cache-control'),/no-store/);const proof=await ok.json();assert.equal(proof.runId,'run');assert.doesNotMatch(JSON.stringify(proof),/private/);
 const denied=await fetch(base+'/rssd/v1/migration-proof/enter/other');assert.equal(denied.status,403);const missing=await fetch(base+'/rssd/v1/migration-proof/other/enter');assert.equal(missing.status,404);
});
