const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {health,backupStatus}=require('./health.cjs');
test('health is owner-only and all operational queries are organization-scoped',async()=>{
 let queries=0;const store={db:{$queryRawUnsafe:async(sql,org)=>{queries++;assert.equal(org,'owner-org');assert.match(sql,/WHERE "orgId"=\$1/);return [];}}};
 await assert.rejects(health(store,{admin:false,orgId:'worker-org'}),{status:403});assert.equal(queries,0);
 const value=await health(store,{admin:true,orgId:'owner-org'},{dispatchEnabled:false});assert.equal(queries,4);assert.equal(value.backup.state,'not_configured');assert.equal(value.dispatchEnabled,false);
});
test('backup health distinguishes fresh, stale and failed while excluding private paths',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rssd-health-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'status.json'),now=Date.now();
 await fs.writeFile(file,JSON.stringify({state:'healthy',secret:'never expose',lastSuccess:{verifiedAt:new Date(now).toISOString(),bytes:10,name:'/private/backup'}}));
 const value=await backupStatus(file,now);assert.equal(value.state,'healthy');assert(!JSON.stringify(value).includes('private'));assert(!JSON.stringify(value).includes('secret'));
 assert.equal((await backupStatus(file,now+37*3600000)).state,'stale');
 await fs.writeFile(file,JSON.stringify({state:'failed',lastSuccess:{verifiedAt:new Date(now).toISOString()}}));assert.equal((await backupStatus(file,now)).state,'failed');
});
