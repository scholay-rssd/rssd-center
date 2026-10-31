'use strict';
require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Test}=require('@nestjs/testing');
// Only replace the service dependency; exercise the shipped controller and
// Nest/Express serialization through real HTTP, including explicit JSON null.
const path=require.resolve('../apps/backend/dist/apps/backend/src/rssd/rssd.service.js');
class RssdService {}
require.cache[path]={id:path,filename:path,loaded:true,exports:{RssdService}};
const {RssdController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.controller.js');
const {RssdGuestbookController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.guestbook.controller.js');

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
test('idle and active claims are valid JSON over the production HTTP controller',async t=>{
 let current=null;
 const module=await Test.createTestingModule({controllers:[RssdController],providers:[{provide:RssdService,useValue:{store:{claim:async()=>current,activeClaim:async()=>current}}}]}).compile();
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
