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
