'use strict';
const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {Pool} = require('pg');
const {RssdStore} = require('./store.cjs');
const {RssdPublisher,CredentialCipher}=require('./publisher.cjs');
const {RssdMedia}=require('./media.cjs');
const mediaProtocol=require('./rssd-media.cjs');
const {RssdMigration}=require('./migration.cjs');
const p=require('./protocol.cjs');
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

async function publishingFixture(fetchImpl){
  const f=await fixture(),publisher=new RssdPublisher(store,{secret:'fixture-only-encryption-key-not-production',fetchImpl});
  await publisher.saveDestination(f.owner,{id:'site',name:'Example site',kind:'site',workspaceIds:['research'],config:{origin:'https://example.test',siteId:'demo'},token:'fixture-only-site-credential-000000000',enabled:true});
  await store.saveWorkspace(f.owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:2,targets:[{destinationId:'site',locale:'en'}]}}]},1);
  const submitted=await store.submit(f.ctx,f.packet);
  // timestamptz(3) rounds sub-millisecond timestamps. Put the fixture safely
  // in the past instead of depending on how quickly the next transaction runs.
  const ready=()=>db.$executeRawUnsafe('UPDATE rssd_publications SET "nextAttemptAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "orgId"=$1',f.owner.orgId);
  await ready();
  return {...f,publisher,submitted,ready,tick:()=>publisher.tick({orgId:f.owner.orgId})};
}
function fakeSite({losePost=false,wrongReadback=false}={}){
  let packet,posts=0,done=false;
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const receipt=()=>({...packet,packetHash:p.hash(packet),state:done?'success':'queued',release:'example-release'});
  const fetchImpl=async(url,options)=>{
    assert.equal(options.redirect,'error');
    if(url.includes('/rssd-content/')){assert.equal(options.headers.Authorization,undefined);return response(wrongReadback?{wrong:true}:packet);}
    assert.match(options.headers.Authorization,/^Bearer fixture-only/);
    if(options.method==='POST'){posts++;packet=JSON.parse(options.body);if(losePost){done=true;throw Error('Lost response');}return response(receipt());}
    return packet?response(receipt()):response({},404);
  };
  return {fetchImpl,get posts(){return posts;},complete(){done=true;}};
}
test('publication waits for successful build and matching unauthenticated public readback',async()=>{
  const remote=fakeSite(),f=await publishingFixture(remote.fetchImpl);
  assert.equal((await f.tick()).state,'queued');assert.equal(remote.posts,1);
  remote.complete();await f.ready();assert.equal((await f.tick()).state,'published');assert.equal(remote.posts,1);
  assert.equal((await store.publications(f.ctx))[0].receipt.verifiedAt.length>0,true);
});
test('lost publication response is queried under the original identity without another POST',async()=>{
  const remote=fakeSite({losePost:true}),f=await publishingFixture(remote.fetchImpl);
  assert.equal((await f.tick()).state,'queued');await f.ready();assert.equal((await f.tick()).state,'published');assert.equal(remote.posts,1);
});
test('a successful receipt cannot hide mismatched public content',async()=>{
  const remote=fakeSite({wrongReadback:true}),f=await publishingFixture(remote.fetchImpl);
  await f.tick();remote.complete();await f.ready();assert.equal((await f.tick()).state,'queued');assert.match((await store.publications(f.ctx))[0].error,/converged/);
});
test('destination credentials are encrypted, scoped to their identity, and omitted from reads',async()=>{
  const f=await publishingFixture(fakeSite().fetchImpl);const visible=await f.publisher.destinations(f.owner);
  assert.equal(visible[0].hasCredential,true);assert.equal(visible[0].config.sealedToken,undefined);assert(!JSON.stringify(visible).includes('fixture-only-site-credential'));
  const raw=await db.$queryRawUnsafe('SELECT config FROM rssd_destinations WHERE "orgId"=$1',f.owner.orgId);assert(!JSON.stringify(raw).includes('fixture-only-site-credential'));
  const cipher=new CredentialCipher('fixture-only-encryption-key-not-production');assert.throws(()=>cipher.open(raw[0].config.sealedToken,'other-org:site'));
  await assert.rejects(f.publisher.destinations(f.ctx),{status:403});
});
test('concurrent publisher instances cannot acquire the same publication lease',async()=>{
  const f=await publishingFixture(fakeSite().fetchImpl);
  const results=await Promise.all(Array.from({length:6},()=>f.publisher.claim(f.owner.orgId)));
  assert.equal(results.filter(Boolean).length,1);
});
test('private center media is idempotent, workspace-scoped and rewritten only for publication',async()=>{
 const f=await fixture(),directory=await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(),'rssd-media-test-'));
 try{
  const media=new RssdMedia(store,{directory,origin:'https://center.example'}),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=','base64'),manifest=mediaProtocol.imageManifest(bytes);
  const input={workspaceId:'research',name:'figure.png',...manifest,data:bytes.toString('base64')};const a=await media.upload(f.ctx,input),b=await media.upload(f.ctx,input);assert.equal(a.id,b.id);assert.deepEqual((await media.bytes(f.ctx,a.id)).bytes,bytes);
  await assert.rejects(media.status({...f.ctx,workspaceIds:[]},a.id),{status:403});await assert.rejects(media.status({...f.owner,orgId:randomUUID()},a.id),{status:404});
  const edition={...f.packet.editions[0],bodyMarkdown:'![Evidence]('+a.url+')',media:[{id:a.id,alt:'Evidence'}]},packet={...f.packet,editions:[edition]};await store.submit(f.ctx,packet);
  const output=await media.publication(f.owner.orgId,'research',edition);assert.equal(output.edition.bodyMarkdown,'![Evidence]('+manifest.path+')');assert.deepEqual(output.assets,[manifest]);assert.equal(output.uploads[0].id,a.id);
  const platformOnly=await media.publication(f.owner.orgId,'research',{...edition,bodyMarkdown:'Article without an inline image.'});assert.deepEqual(platformOnly.assets,[]);assert.deepEqual(platformOnly.uploads,[]);
  await assert.rejects(media.publication(f.owner.orgId,'research',{...edition,media:[]}),{code:'missing_media'});
  await store.revokeWorker(f.owner,f.worker.id);await assert.rejects(media.upload(f.ctx,input),{status:401});
 }finally{await fs.promises.rm(directory,{recursive:true,force:true});}
});

test('legacy import preserves revisions and receipts, is replayable, and fences the old writer handoff',async()=>{
 const f=await fixture(),directory=await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(),'rssd-migration-test-'));
 try{
  const siteId='fixture-site',media=new RssdMedia(store,{directory:path.join(directory,'media')}),migration=new RssdMigration(store,media),payload=p.edition(f.packet.editions[0]);
  const source={document:{id:'original-doc',updated:1700000000000,published_revision:1,permalink:'/en/news/original/'},revisions:[{version:1,payload:JSON.stringify({title:'Original',markdown:'Full body'}),actor:'original-owner'}],requests:[{key:'original-request',revision:1}],jobs:[],tombstone:null};
  const value={version:1,siteId,workspaceId:'research',workId:f.packet.workId,sectionId:'methods',locale:'en',source,sourceHash:p.hash(source),editions:[{revision:1,payload,hash:p.hash(payload),createdAt:'2026-01-01T00:00:00.000Z'}]};
  const save=async(name,data)=>{const raw=JSON.stringify(data);await fs.promises.writeFile(path.join(directory,name),raw);return {path:name,sha256:p.hash(raw)};};
  const doc=await save('document.json',value),baseline=await save('baseline.json',{}),ancillary=await save('ancillary.json',{requests:source.requests});
  const manifest={version:1,site:{id:siteId,spaceId:'research',origin:'https://example.test'},workspace:{id:'research',siteId,name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:1,targets:[]}}]},databaseSha256:'a'.repeat(64),documents:[{...doc,documentId:'original-doc',workId:value.workId,locale:'en',sourceHash:value.sourceHash,revisions:1,publishedRevision:1,deleted:false}],media:[],baseline,ancillary,counts:{documents:1,revisions:1,published:1,deleted:0,media:0}};
  await save('manifest.json',manifest);
  const first=await migration.import(f.owner,directory),second=await migration.import(f.owner,directory);assert.equal(first.editionIndexSha256,second.editionIndexSha256);
  assert.equal((await store.work(f.owner,value.workId)).editions[0].hash,value.editions[0].hash);
  const pubs=await store.publications(f.owner);assert.equal(pubs.length,1);assert.equal(pubs[0].state,'legacy_published');assert.equal(pubs[0].receipt.requests[0].key,'original-request');
  await assert.rejects(store.submit(f.owner,{...f.packet,baseRevisions:{en:1}}),{code:'migration_staged'});
  assert.equal((await store.registry(f.owner)).workspaces[0].writable,false);
  await assert.rejects(store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Cannot start before cutover'}),{code:'migration_staged'});
  assert.equal(await store.claim(f.ctx),null);
  await fs.promises.writeFile(path.join(directory,'document.json'),'corrupted');await assert.rejects(migration.import(f.owner,directory),/checksum/);
  assert.equal((await migration.inspect(f.owner,siteId)).state,'staged');
  const evidence={receiptId:'fixture-cutover',oldWriterDisabled:true,inFlightCount:0,pendingWorkReconciled:true,receiverRelease:'fixture-release',rollbackReference:'fixture-only-readonly-snapshot',sourceDatabaseSha256:manifest.databaseSha256,editionIndexSha256:first.editionIndexSha256,baselineSha256:manifest.baseline.sha256};
  await assert.rejects(migration.activate(f.owner,siteId,{...evidence,oldWriterDisabled:false}),{code:'handoff_incomplete'});
  await assert.rejects(migration.activate(f.owner,siteId,{...evidence,baselineSha256:'b'.repeat(64)}),{code:'stale_snapshot'});
  assert.equal((await migration.activate(f.owner,siteId,evidence)).state,'active');
  assert.equal((await migration.activate(f.owner,siteId,evidence)).state,'active');
  await assert.rejects(migration.import(f.owner,directory),/active workspace/);
  assert.equal((await store.registry(f.owner)).workspaces[0].writable,true);
  await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Now available'});assert.ok(await store.claim(f.ctx));
 }finally{await fs.promises.rm(directory,{recursive:true,force:true});}
});

test('HTTP pagination accepts numeric query strings and searches full latest bodies without crossing scope',async()=>{
 const f=await fixture();
 for(let i=0;i<3;i++)await store.submit(f.owner,{...f.packet,requestId:randomUUID(),workId:randomUUID(),editions:[{...f.packet.editions[0],title:'Untitled '+i,bodyMarkdown:'Body-only needle '+i}]},{publish:false});
 const first=await store.works(f.owner,{search:'Body-only needle',limit:'2',offset:'0'}),second=await store.works(f.owner,{search:'Body-only needle',limit:'2',offset:'2'});
 assert.equal(first.length,2);assert.equal(second.length,1);assert.equal(new Set([...first,...second].map(w=>w.id)).size,3);
 assert.deepEqual(await store.works({...f.ctx,workspaceIds:[]},{search:'Body-only needle',limit:'2'}),[]);
 for(const limit of ['1.5','Infinity','-1','201'])await assert.rejects(store.works(f.owner,{limit}),{status:400});
 await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Untitled demand',brief:'Brief-only needle'});
 assert.equal((await store.demands(f.owner,{search:'Brief-only needle',limit:'1',offset:'0'})).length,1);
 assert.deepEqual(await store.publications(f.owner,{limit:'1',offset:'0'}),[]);
});

test('forum dispatch persists uncertain creation before sending and recovers one public topic',async()=>{
 const f=await fixture();let topic=null,post=null,creates=0;
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
 const publisher=new RssdPublisher(store,{secret:'fixture-only-encryption-key-not-production',fetchImpl:async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.startsWith('/t/external_id/'))return topic?response(topic):response({},404);
  if(path==='/posts.json'){creates++;const body=JSON.parse(options.body);topic={id:17,title:body.title,post_stream:{posts:[{id:21,post_number:1}]}};post={id:21,topic_id:17,post_number:1,raw:body.raw};throw Error('Response lost after database commit');}
  if(path==='/t/17.json')return response(topic);
  if(path==='/posts/21.json')return response(post);
  throw Error('Unexpected forum route');
 }});
 await publisher.saveDestination(f.owner,{id:'forum',name:'Example forum',kind:'discourse',workspaceIds:['research'],config:{origin:'https://forum.example',username:'publisher',categoryId:5},token:'fixture-only-forum-credential-000000000',enabled:true});
 await store.saveWorkspace(f.owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:2,targets:[{destinationId:'forum',locale:'en'}]}}]},1);
 await store.submit(f.ctx,f.packet);
 const tick=async()=>{await db.$executeRawUnsafe('UPDATE rssd_publications SET "nextAttemptAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "orgId"=$1',f.owner.orgId);return publisher.tick({orgId:f.owner.orgId});};
 assert.equal((await tick()).state,'queued');assert.equal((await store.publications(f.ctx))[0].receipt.createIntent,true);
 assert.equal((await tick()).state,'published');assert.equal(creates,1);assert.equal((await store.publications(f.ctx))[0].receipt.topicId,17);
});
