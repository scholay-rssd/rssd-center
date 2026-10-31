'use strict';
const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {Pool} = require('pg');
const {RssdStore} = require('./store.cjs');
let pool,db,store;
function adapter(client) {
  return {$queryRawUnsafe:async(sql,...values)=>(await client.query(sql,values)).rows,
    $executeRawUnsafe:async(sql,...values)=>(await client.query(sql,values)).rowCount,
    $transaction:async fn=>{const connection=await pool.connect();try{await connection.query('BEGIN');const result=await fn(adapter(connection));await connection.query('COMMIT');return result;}catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}}};
}
before(async()=>{
  const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
  const database=config.database || new URL(config.connectionString).pathname.slice(1);
  if(!/^rssd_.*test/.test(database))throw Error('Tests require a dedicated rssd_*test database');
  pool=new Pool({...config,max:24});db=adapter(pool);store=new RssdStore(db);
  for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "Media" (id TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL,"deletedAt" TIMESTAMP)');
});
after(async()=>{if(pool)await pool.end();});
async function fixture() {
  const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null};
  await store.saveWorkspace(owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:1,targets:[]}}]});
  const worker=await store.createWorker(owner,{name:'Linux worker',workspaceIds:['research']});
  const ctx=await store.authenticate(worker.token);
  const packet={requestId:randomUUID(),workId:randomUUID(),workspaceId:'research',sectionId:'methods',editions:[{locale:'en',title:'English original',bodyMarkdown:'Original body.'}]};
  return {owner,worker,ctx,packet};
}
test('one demand is claimed exactly once by concurrent devices',async()=>{
  const f=await fixture();await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'One task'});
  const contexts=await Promise.all(Array.from({length:12},async(_,i)=>store.authenticate((await store.createWorker(f.owner,{name:'Device '+i,workspaceIds:['research']})).token)));
  const results=await Promise.all(contexts.map(ctx=>store.claim(ctx)));
  assert.equal(results.filter(Boolean).length,1);
});
test('concurrent requests on one device cannot acquire two tasks',async()=>{
  const f=await fixture();for(let i=0;i<2;i++)await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Task '+i});
  const results=await Promise.allSettled([store.claim(f.ctx),store.claim(f.ctx)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'worker_busy');
});
test('concurrent replay is idempotent; changed content cannot reuse its request identity',async()=>{
  const f=await fixture();const results=await Promise.all(Array.from({length:8},()=>store.submit(f.ctx,f.packet)));
  results.forEach(r=>assert.deepEqual(r,results[0]));
  assert.equal((await store.work(f.ctx,f.packet.workId)).editions[0].revision,1);
  await assert.rejects(store.submit(f.ctx,{...f.packet,editions:[{...f.packet.editions[0],bodyMarkdown:'Changed'}]}),{code:'request_conflict'});
});
test('competing editors retain the first revision and reject stale saves',async()=>{
  const f=await fixture();await store.submit(f.ctx,f.packet);
  const update={...f.packet,requestId:randomUUID(),baseRevisions:{en:1}};
  const results=await Promise.allSettled([store.submit(f.ctx,update),store.submit(f.owner,{...update,requestId:randomUUID(),editions:[{...update.editions[0],title:'Other editor'}]})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'revision_conflict');
});
test('released claims and revoked credentials cannot publish late results',async()=>{
  const f=await fixture();await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Release me'});
  const claim=await store.claim(f.ctx);await store.changeDemand(f.owner,claim.id,{action:'release'});
  await assert.rejects(store.submit(f.ctx,{...f.packet,demandId:claim.id,claimToken:claim.claimToken}),{code:'claim_revoked'});
  await store.revokeWorker(f.owner,f.worker.id);
  await assert.rejects(store.authenticate(f.worker.token),{status:401});
  await assert.rejects(store.submit(f.ctx,f.packet),{status:401});
});
test('Chinese publishes before English and policy is frozen at claim time',async()=>{
  const f=await fixture();
  await db.$executeRawUnsafe('INSERT INTO rssd_destinations ("orgId",id,name,kind,"workspaceIds",config,enabled) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,true)',f.owner.orgId,'site','Example site','site','["research"]','{}');
  await store.saveWorkspace(f.owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:2,targets:[{destinationId:'site',locale:'zh-CN'},{destinationId:'site',locale:'en'}]}}]},1);
  await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Bilingual'});const claim=await store.claim(f.ctx);
  await store.saveWorkspace(f.owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:3,targets:[]}}]},2);
  const first={...f.packet,demandId:claim.id,claimToken:claim.claimToken,editions:[{locale:'zh-CN',title:'中文先发',bodyMarkdown:'完整的中文正文。'}]};
  const zh=await store.submit(f.ctx,first);assert.equal(zh.publicationIds.length,1);assert.equal(zh.demandState,'claimed');
  await assert.rejects(store.submit(f.ctx,{...f.packet,requestId:randomUUID(),workId:randomUUID(),demandId:claim.id,claimToken:claim.claimToken}),/original submission work identity/);
  const en=await store.submit(f.ctx,{...f.packet,requestId:randomUUID(),demandId:claim.id,claimToken:claim.claimToken});
  assert.equal(en.publicationIds.length,1);assert.equal(en.demandState,'completed');
  assert.equal((await store.publications(f.ctx)).length,2);
  assert.equal(await store.activeClaim(f.ctx),null);
});
test('draft save creates no publication and foreign tenants cannot read works or receipts',async()=>{
  const a=await fixture(),b=await fixture();
  const saved=await store.submit(a.owner,a.packet,{publish:false});assert.equal(saved.status,'draft_saved');assert.deepEqual(saved.publicationIds,[]);
  await assert.rejects(store.work(b.owner,a.packet.workId),{status:404});
  await assert.rejects(store.submissionStatus(b.owner,a.packet.requestId),{status:404});
  const constrained={...a.ctx,workspaceIds:[]};await assert.rejects(store.work(constrained,a.packet.workId),{status:403});
  assert.deepEqual(await store.works(constrained),[]);assert.deepEqual((await store.registry(constrained)).workspaces,[]);
});
test('invalid second edition rolls back the complete submission',async()=>{
  const f=await fixture();
  await assert.rejects(store.submit(f.ctx,{...f.packet,editions:[...f.packet.editions,{locale:'zh-CN',title:'中文',bodyMarkdown:'正文',media:[{id:'missing-media'}]}]}),{code:'invalid_media'});
  await assert.rejects(store.work(f.ctx,f.packet.workId),{status:404});
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM rssd_editions WHERE "orgId"=$1',f.owner.orgId)).length,0);
});
