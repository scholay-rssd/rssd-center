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
const {RssdGuestbook}=require('./guestbook.cjs');
const {RssdEditorial,archiveBundle,legacyFingerprint}=require('./editorial.cjs');
const {RssdEditorialActions}=require('./editorial-actions.cjs');
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

async function editorialFixture({origin='https://example.org'}={}){
 const f=await fixture();
 const publisher=new RssdPublisher(store,{secret:'synthetic editorial fixture secret key'});
 for(const id of ['site-research-site','external'])await publisher.saveDestination(f.owner,{id,name:id,kind:'site',workspaceIds:['research'],config:{origin,siteId:'research-site'},token:'synthetic-token-000000000000000000000000',enabled:true});
 await store.saveWorkspace(f.owner,{id:'research',siteId:'research-site',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:2,targets:[{destinationId:'site-research-site',locale:'zh-CN'},{destinationId:'site-research-site',locale:'en'},{destinationId:'external',locale:'en'}]}}]},1);
 const media=new RssdMedia(store,{directory:fs.mkdtempSync(path.join(require('node:os').tmpdir(),'rssd-editorial-test-'))});
 const service=new RssdEditorial(store,media);
 publisher.media=media;service.actions=new RssdEditorialActions(store,media,publisher,service);
 const packet={requestKey:randomUUID(),expectedVersion:0,expectedPublishedVersion:null,data:{id:'synthetic-manuscript',title:'Synthetic title',summary:'Synthetic summary',markdown:'Complete original body',author:'Author',date:'2026-01-01',category:'Methods',sectionId:'methods',assets:[]}};
 return {...f,service,media,packet,publisher};
}

async function actionHttpFixture(t){
 const contract=require('./publication.cjs'),requests=new Map(),heads=new Map(),visible=new Map(),publicPackets=new Map();
 const state={posts:0,loseNextResponse:false,converge:true};
 const server=require('node:http').createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;
  const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  try{
   const protectedPath=path.startsWith('/api/rssd-receiver/');
   if(protectedPath&&req.headers.authorization!=='Bearer synthetic-token-000000000000000000000000')return send({error:'denied'},401);
   if(path.includes('/heads/')){const [,workId,locale]=path.split('/heads/')[1].match(/^([^/]+)\/(.+)$/)||[];const head=heads.get(workId+':'+locale);return send(head||{},head?200:404);}
   const marker='/submissions';
   if(path.endsWith(marker)&&req.method==='POST'){
    let raw='';for await(const chunk of req)raw+=chunk;
    const packet=contract.publication(JSON.parse(raw)),key=packet.workId+':'+packet.locale,old=heads.get(key),operation=packet.operation||'publish';
    if(requests.has(packet.requestId))return send(requests.get(packet.requestId));
    if(operation!=='publish'&&(!old||packet.expectedRevision!==old.revision||packet.expectedOperationSequence!==old.operationSequence))return send({message:'head conflict'},409);
    if(operation==='publish'&&old&&(['withdraw','delete'].includes(old.operation)||packet.revision<=old.revision))return send({message:'stale publish'},409);
    state.posts++;const sequence=packet.operationSequence||(old?.operationSequence||0)+1;
    const receipt={requestId:packet.requestId,siteId:packet.siteId,workId:packet.workId,locale:packet.locale,revision:packet.revision,contentHash:packet.contentHash,packetHash:p.hash(packet),operation,operationSequence:sequence,state:'success',release:'synthetic-'+sequence};
    requests.set(packet.requestId,receipt);heads.set(key,{siteId:packet.siteId,workId:packet.workId,locale:packet.locale,revision:packet.revision,contentHash:packet.contentHash,operation,operationSequence:sequence,route:packet.route});visible.set(packet.route,contract.visible(packet));
    if(state.converge)publicPackets.set(contract.contentKey(packet),packet);state.lastPacket=packet;
    if(state.loseNextResponse){state.loseNextResponse=false;req.socket.destroy();return;}
    return send(receipt);
   }
   if(path.includes(marker+'/')){const value=requests.get(path.split(marker+'/')[1]);return send(value||{},value?200:404);}
   if(path.startsWith('/rssd-content/')){const value=publicPackets.get(path.split('/').at(-1).replace(/\.json$/,''));return send(value||{},value?200:404);}
   res.statusCode=visible.get(path)?200:404;res.end(visible.get(path)?'<article>Synthetic body</article>':'Not found');
  }catch(error){send({message:error.message},500);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const f=await editorialFixture({origin:'http://127.0.0.1:'+server.address().port});
 return {...f,state,heads,requests,publicPackets,tick:async()=>{await db.$executeRawUnsafe('UPDATE rssd_editorial_actions SET "nextAttemptAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "orgId"=$1',f.ctx.orgId);return f.service.actions.tick({orgId:f.ctx.orgId});}};
}

test('editorial HTTP actions withdraw, edit, restore and soft-delete with original-request recovery and public readback',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);assert.equal((await f.publisher.tick({orgId:f.ctx.orgId})).state,'published');
 const first=await f.service.detail(f.ctx,'research',f.packet.data.id);const action=(name,version,published)=>({requestKey:randomUUID(),articleId:f.packet.data.id,action:name,expectedVersion:version,expectedPublishedVersion:published,confirmed:true});
 const withdraw=action('withdraw',1,1);assert.equal((await f.service.actions.submit(f.ctx,'research',withdraw)).status,'queued');
 await assert.rejects(store.submit(f.ctx,{requestId:randomUUID(),workId:first.workId,workspaceId:'research',sectionId:'methods',baseRevisions:{'zh-CN':1},editions:[{locale:'zh-CN',title:'Concurrent edit',bodyMarkdown:'Retained client result'}]}),{code:'publication_pending'});
 assert.equal((await f.tick()).state,'published');assert.equal((await f.service.detail(f.ctx,'research',f.packet.data.id)).publishedVersion,null);
 await assert.rejects(f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1}),{code:'edition_withdrawn'});
 await f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1,data:{...f.packet.data,markdown:'Updated while withdrawn'}},{intent:'draft'});
 const restore=action('publish',2,null);await f.service.actions.submit(f.ctx,'research',restore);f.state.loseNextResponse=true;
 assert.equal((await f.tick()).state,'queued');const count=f.state.posts;assert.equal((await f.tick()).state,'published');assert.equal(f.state.posts,count);
 assert.equal((await f.service.actions.status(f.ctx,'research',restore.requestKey)).status,'success');assert.equal((await f.service.detail(f.ctx,'research',f.packet.data.id)).publishedVersion,2);
 const deletion=action('delete',2,2);await f.service.actions.submit(f.ctx,'research',deletion);f.state.converge=false;
 assert.equal((await f.tick()).state,'queued');assert.equal((await f.service.detail(f.ctx,'research',f.packet.data.id)).publishedVersion,2);
 f.state.publicConverged=true;f.publicPackets.set(require('./publication.cjs').contentKey(f.state.lastPacket),f.state.lastPacket);
 assert.equal((await f.tick()).state,'published');assert.equal((await f.service.actions.status(f.ctx,'research',deletion.requestKey)).deleted,true);
 await assert.rejects(f.service.detail(f.ctx,'research',f.packet.data.id),{status:410});
 await assert.rejects(store.submit(f.ctx,{requestId:randomUUID(),workId:first.workId,workspaceId:'research',sectionId:'methods',baseRevisions:{'zh-CN':2},editions:[{locale:'zh-CN',title:'Automatic stale recovery',bodyMarkdown:'Retained original'}]}),{code:'edition_deleted'});
 const undelete=action('restore',2,null);await f.service.actions.submit(f.ctx,'research',undelete);f.state.converge=true;assert.equal((await f.tick()).state,'published');
 const restored=await f.service.detail(f.ctx,'research',f.packet.data.id);assert.equal(restored.workId,first.workId);assert.equal(restored.revision,2);assert.equal(restored.data.markdown,'Updated while withdrawn');assert.equal(restored.publishedVersion,2);
 const all=await qForTest('SELECT revision FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2',f.ctx.orgId,first.workId);assert.deepEqual(all.map(r=>r.revision),[1,2]);
 assert.equal(f.heads.get(first.workId+':zh-CN').operationSequence,5);
});
async function qForTest(sql,...values){return db.$queryRawUnsafe(sql,...values);}

test('editorial stale blocked actions cannot capture a newer publication on retry',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);await f.publisher.tick({orgId:f.ctx.orgId});
 const current=await f.service.detail(f.ctx,'research',f.packet.data.id),head=f.heads.get(current.workId+':zh-CN');head.state='queued';
 const action={requestKey:randomUUID(),articleId:f.packet.data.id,action:'withdraw',expectedVersion:1,expectedPublishedVersion:1,confirmed:true};
 const queued=await f.service.actions.submit(f.ctx,'research',action);assert.equal((await f.tick()).state,'blocked');head.state='success';
 await f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1,expectedPublishedVersion:1,data:{...f.packet.data,markdown:'New public revision'}});await f.publisher.tick({orgId:f.ctx.orgId});
 const posts=f.state.posts;await assert.rejects(f.service.actions.retry(f.ctx,'research',action.requestKey,{confirmed:true,jobId:queued.job.id}),{code:'stale_action'});
 assert.equal(f.state.posts,posts);assert.equal((await f.service.detail(f.ctx,'research',f.packet.data.id)).publishedVersion,2);
});

test('editorial original actions become superseded instead of waiting forever for newer public state',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);await f.publisher.tick({orgId:f.ctx.orgId});
 const current=await f.service.detail(f.ctx,'research',f.packet.data.id),contract=require('./publication.cjs'),key=contract.contentKey({workId:current.workId,locale:'zh-CN'}),original=f.publicPackets.get(key);
 const action={requestKey:randomUUID(),articleId:f.packet.data.id,action:'withdraw',expectedVersion:1,expectedPublishedVersion:1,confirmed:true};await f.service.actions.submit(f.ctx,'research',action);f.state.converge=false;assert.equal((await f.tick()).state,'queued');
 f.state.converge=true;
 const later=contract.publication({...original,requestId:'later-visibility-request',operation:'restore',operationSequence:3,expectedOperationSequence:2,expectedRevision:1});
 const origin=(await qForTest('SELECT config FROM rssd_destinations WHERE "orgId"=$1 AND id=\'site-research-site\'',f.ctx.orgId))[0].config.origin;
 await f.publisher.request(origin+'/api/rssd-receiver/v1/sites/research-site/submissions',{token:'synthetic-token-000000000000000000000000',method:'POST',body:later});const posts=f.state.posts;
 assert.equal((await f.tick()).state,'superseded');assert.equal(f.state.posts,posts);assert.equal((await f.service.actions.status(f.ctx,'research',action.requestKey)).superseded,true);
 await f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1,expectedPublishedVersion:1},{intent:'draft'});
});

test('editorial local visibility generations reject stale actions even when the content revision is unchanged',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 const current=await f.service.detail(f.ctx,'research',f.packet.data.id),head={siteId:'research-site',workId:current.workId,locale:'zh-CN',revision:0,operationSequence:0,operation:'publish',route:current.url,contentHash:null,state:'queued'};
 f.heads.set(current.workId+':zh-CN',head);
 const input={requestKey:randomUUID(),articleId:f.packet.data.id,action:'delete',expectedVersion:1,expectedPublishedVersion:null,confirmed:true},old=await f.service.actions.submit(f.ctx,'research',input);
 assert.equal((await f.tick()).state,'blocked');head.state='legacy';
 await f.service.actions.submit(f.ctx,'research',{...input,requestKey:randomUUID()});assert.equal((await f.tick()).state,'published');
 await f.service.actions.submit(f.ctx,'research',{...input,action:'restore',requestKey:randomUUID()});assert.equal((await f.tick()).state,'published');
 await assert.rejects(f.service.actions.retry(f.ctx,'research',input.requestKey,{confirmed:true,jobId:old.job.id}),{code:'stale_action'});
 assert.equal((await f.service.detail(f.ctx,'research',f.packet.data.id)).publishedVersion,null);assert.equal(f.state.posts,0);
});

test('editorial undelete restores the approved public revision and retains the newer unpublished draft',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);await f.publisher.tick({orgId:f.ctx.orgId});
 await f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1,expectedPublishedVersion:1,data:{...f.packet.data,markdown:'Unapproved newer draft'}},{intent:'draft'});
 const input={requestKey:randomUUID(),articleId:f.packet.data.id,action:'delete',expectedVersion:2,expectedPublishedVersion:1,confirmed:true};await f.service.actions.submit(f.ctx,'research',input);assert.equal((await f.tick()).state,'published');
 await f.service.actions.submit(f.ctx,'research',{...input,requestKey:randomUUID(),action:'restore',expectedPublishedVersion:null});assert.equal((await f.tick()).state,'published');
 const cloud=await f.service.detail(f.ctx,'research',f.packet.data.id),live=await f.service.detail(f.ctx,'research',f.packet.data.id,{scope:'published'});
 assert.equal(cloud.revision,2);assert.equal(cloud.data.markdown,'Unapproved newer draft');assert.equal(cloud.publishedVersion,1);assert.equal(live.data.markdown,f.packet.data.markdown);assert.equal(f.state.lastPacket.revision,1);
});

test('editorial undelete of a previously withdrawn work restores only the private manuscript',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);await f.publisher.tick({orgId:f.ctx.orgId});
 const input={requestKey:randomUUID(),articleId:f.packet.data.id,action:'withdraw',expectedVersion:1,expectedPublishedVersion:1,confirmed:true};await f.service.actions.submit(f.ctx,'research',input);await f.tick();
 await f.service.actions.submit(f.ctx,'research',{...input,requestKey:randomUUID(),action:'delete',expectedPublishedVersion:null});await f.tick();const count=f.state.posts;
 const restore={...input,requestKey:randomUUID(),action:'restore',expectedPublishedVersion:null};await f.service.actions.submit(f.ctx,'research',restore);assert.equal((await f.tick()).state,'published');
 const result=await f.service.actions.status(f.ctx,'research',restore.requestKey);assert.equal(result.deleted,false);assert.equal(result.draftRestored,true);assert.equal(result.publishedVersion,null);assert.equal(f.state.posts,count);
});

test('editorial website publication retries cannot bypass queued visibility actions or a divergent receiver head',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);await f.publisher.tick({orgId:f.ctx.orgId});
 const second={...f.packet,requestKey:randomUUID(),expectedVersion:1,expectedPublishedVersion:1,data:{...f.packet.data,markdown:'Second version'}};
 const receipt=await f.service.submit(f.ctx,'research',second);await db.$executeRawUnsafe("UPDATE rssd_publications SET state='blocked' WHERE \"orgId\"=$1 AND id=$2",f.ctx.orgId,receipt.job.id);
 const action={requestKey:randomUUID(),articleId:f.packet.data.id,action:'withdraw',expectedVersion:2,expectedPublishedVersion:1,confirmed:true};await f.service.actions.submit(f.ctx,'research',action);
 await assert.rejects(f.publisher.retry(f.owner,receipt.job.id),{code:'publication_pending'});await assert.rejects(f.service.retry(f.ctx,'research',second.requestKey,{jobId:receipt.job.id}),{code:'publication_pending'});
 const work=await f.service.detail(f.ctx,'research',f.packet.data.id),head=f.heads.get(work.workId+':zh-CN');head.revision=2;head.operationSequence=2;const posts=f.state.posts;
 assert.equal((await f.tick()).state,'blocked');assert.equal(f.state.posts,posts);
});

test('editorial unpublished deletion is reversible without sending a receiver publication',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 const action={requestKey:randomUUID(),articleId:f.packet.data.id,action:'delete',expectedVersion:1,expectedPublishedVersion:null,confirmed:true};
 await f.service.actions.submit(f.ctx,'research',action);assert.equal((await f.tick()).state,'published');assert.equal(f.state.posts,0);
 const restore={...action,requestKey:randomUUID(),action:'restore'};await f.service.actions.submit(f.ctx,'research',restore);assert.equal((await f.tick()).state,'published');assert.equal(f.state.posts,0);
 const result=await f.service.detail(f.ctx,'research',f.packet.data.id);assert.equal(result.publishedVersion,null);assert.equal(result.version,1);
 await assert.rejects(f.service.actions.submit(f.ctx,'research',{...restore,action:'withdraw'}),{code:'request_conflict'});
});

test('editorial legacy revision-zero tombstones restore a private draft until a separate explicit publish',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 const current=await f.service.detail(f.ctx,'research',f.packet.data.id);
 f.heads.set(current.workId+':zh-CN',{siteId:'research-site',workId:current.workId,locale:'zh-CN',revision:0,operationSequence:0,operation:'delete',route:current.url,contentHash:null,state:'legacy'});
 await db.$executeRawUnsafe(`INSERT INTO rssd_editorial_states ("orgId","workId",locale,visibility) VALUES ($1,$2,'zh-CN','deleted')`,f.ctx.orgId,current.workId);
 const restore={requestKey:randomUUID(),articleId:f.packet.data.id,action:'restore',expectedVersion:1,expectedPublishedVersion:null,confirmed:true};
 await f.service.actions.submit(f.ctx,'research',restore);assert.equal((await f.tick()).state,'published');assert.equal(f.state.posts,0);
 const receipt=await f.service.actions.status(f.ctx,'research',restore.requestKey);assert.equal(receipt.deleted,false);assert.equal(receipt.draftRestored,true);assert.equal(receipt.requiresExplicitPublish,true);assert.equal(receipt.publishedVersion,null);
 await assert.rejects(f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1}),{code:'edition_withdrawn'});
 const publish={...restore,requestKey:randomUUID(),action:'publish'};await f.service.actions.submit(f.ctx,'research',publish);assert.equal((await f.tick()).state,'published');assert.equal(f.state.posts,1);
 assert.equal((await f.service.detail(f.ctx,'research',f.packet.data.id)).publishedVersion,1);
});

test('editorial website actions block unfinished receiver heads and resume only after explicit original-job retry',async t=>{
 const f=await actionHttpFixture(t);await f.service.submit(f.ctx,'research',f.packet);await f.publisher.tick({orgId:f.ctx.orgId});
 const current=await f.service.detail(f.ctx,'research',f.packet.data.id),head=f.heads.get(current.workId+':zh-CN');head.state='queued';
 const action={requestKey:randomUUID(),articleId:f.packet.data.id,action:'withdraw',expectedVersion:1,expectedPublishedVersion:1,confirmed:true};
 const queued=await f.service.actions.submit(f.ctx,'research',action),posts=f.state.posts;
 assert.equal((await f.tick()).state,'blocked');assert.equal(f.state.posts,posts);assert.equal((await f.service.actions.status(f.ctx,'research',action.requestKey)).status,'failed');
 head.state='success';await assert.rejects(f.service.actions.retry(f.ctx,'research',action.requestKey,{jobId:queued.job.id}),{code:'request_conflict'});
 await f.service.actions.retry(f.ctx,'research',action.requestKey,{jobId:queued.job.id,confirmed:true});assert.equal((await f.tick()).state,'published');assert.equal(f.state.posts,posts+1);
});

test('editorial migrated requests retain historical job identities and never become new publications',async()=>{
 const f=await editorialFixture();await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 const current=await f.service.detail(f.ctx,'research',f.packet.data.id),key='original-legacy-request',source={document:{kind:'news',permalink:current.url,latest_revision:1,published_revision:1},revisions:[{version:1,payload:JSON.stringify(f.packet.data)}],requests:[{key,revision:1,job_id:'original-legacy-job'}],drafts:[],jobs:[{id:'original-legacy-job',status:'success',release:'original-release'}],actions:[{key:'original-action-request',action:'publish',job_id:'original-legacy-job'}],sourceArchives:[]};
 await db.$executeRawUnsafe(`INSERT INTO rssd_legacy_documents ("orgId","siteId","documentId","workId",locale,"sourceHash",source) VALUES ($1,'research-site','original-document',$2,'zh-CN',$3,$4::jsonb)`,f.ctx.orgId,current.workId,p.hash(source),JSON.stringify(source));
 const receipt=await f.service.receipt(f.ctx,'research',key);assert.equal(receipt.job.id,'original-legacy-job');assert.equal(receipt.job.release,'original-release');assert.equal(receipt.legacy,true);
 await assert.rejects(f.service.submit(f.ctx,'research',{...f.packet,requestKey:key,expectedVersion:1}),{code:'legacy_request_exists'});
 await assert.rejects(f.service.submit(f.ctx,'research',{...f.packet,requestKey:key,expectedVersion:1},{intent:'draft'}),{code:'legacy_request_exists'});
 assert.equal((await f.service.actions.status(f.ctx,'research','original-action-request')).job.id,'original-legacy-job');
 await assert.rejects(f.service.actions.submit(f.ctx,'research',{requestKey:'original-action-request',articleId:f.packet.data.id,action:'delete',expectedVersion:1,expectedPublishedVersion:null,confirmed:true}),{code:'legacy_action_exists'});
 assert.equal((await store.publications(f.ctx)).length,0);
});

test('editorial native structured works expose a valid stable legacy record identity and retain their center work',async()=>{
 const f=await editorialFixture(),workId='native:calendar:identity';
 await store.submit(f.ctx,{requestId:randomUUID(),workId,workspaceId:'research',sectionId:'methods',editions:[{locale:'zh-CN',title:'Synthetic calendar',summary:'Calendar summary',bodyMarkdown:'# Synthetic calendar\n\n## 摘要\n\nCalendar summary\n\n## 正文\n\nCalendar body',metadata:{author:'Author',date:'2026-01-01',category:'Methods',record:{kind:'year',fields:{id:'year:synthetic',category:'Methods',start:'2026-01-01'}}}}]},{publish:false});
 const catalog=await f.service.catalog(f.ctx,'research',{scope:'all'}),id=catalog.items[0].articleId;
 assert.match(id,/^record-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 const detail=await f.service.detail(f.ctx,'research',id);assert.equal(detail.data.id,'record-'+detail.data.record.documentId);assert.equal(detail.data.record.fields.sectionId,'methods');
 await f.service.submit(f.ctx,'research',{requestKey:randomUUID(),expectedVersion:1,expectedPublishedVersion:null,data:detail.data},{intent:'draft'});
 const updated=await f.service.detail(f.ctx,'research',id);assert.equal(updated.workId,workId);assert.equal(updated.version,2);assert.equal(updated.data.record.fields.body,'Calendar body');
});

test('editorial submissions retain stable requests, conflicts, original IDs and atomic concurrent bases',async()=>{
 const f=await editorialFixture();
 const result=await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 assert.equal(result.status,'draft_saved');assert.equal(result.version,1);assert.equal(result.articleId,f.packet.data.id);assert.equal(result.centerManaged,true);
 const again=await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});assert.deepEqual(again,result);
 const changed={...f.packet,data:{...f.packet.data,title:'Different request body'}};
 await assert.rejects(f.service.submit(f.ctx,'research',changed,{intent:'draft'}),{code:'request_conflict'});
 const next={...f.packet,expectedVersion:1,requestKey:randomUUID()};
 const results=await Promise.allSettled([f.service.submit(f.ctx,'research',next,{intent:'draft'}),f.service.submit(f.ctx,'research',{...next,requestKey:randomUUID()},{intent:'draft'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'revision_conflict');
 const detail=await f.service.detail(f.ctx,'research',f.packet.data.id);assert.equal(detail.version,2);assert.equal(detail.data.markdown,f.packet.data.markdown);assert.equal(detail.url,'/news/'+f.packet.data.id+'/');
 assert.equal((await f.service.index(f.ctx,'research')).items[0].id,f.packet.data.id);
 await assert.rejects(f.service.receipt({...f.ctx,workspaceIds:[]},'research',f.packet.requestKey,{intent:'draft'}),{status:403});
});

test('editorial publishing only reports the website receipt and retries the same website identity',async()=>{
 const f=await editorialFixture();f.packet.data={...f.packet.data,locale:'en'};
 const receipt=await f.service.submit(f.ctx,'research',f.packet);assert.equal(receipt.job.status,'queued');
 const pubs=await store.publications(f.ctx);assert.equal(pubs.length,2);
 const site=pubs.find(p=>p.destinationId==='site-research-site'),external=pubs.find(p=>p.destinationId==='external');assert.equal(receipt.job.id,site.id);
 await db.$executeRawUnsafe("UPDATE rssd_publications SET state='blocked',error='Synthetic channel failure' WHERE \"orgId\"=$1 AND id=$2",f.ctx.orgId,external.id);
 assert.equal((await f.service.receipt(f.ctx,'research',f.packet.requestKey)).job.status,'queued');
 await db.$executeRawUnsafe("UPDATE rssd_publications SET state='blocked',error='Synthetic website failure' WHERE \"orgId\"=$1 AND id=$2",f.ctx.orgId,site.id);
 await assert.rejects(f.service.retry(f.ctx,'research',f.packet.requestKey,{jobId:external.id}),{code:'request_conflict'});
 assert.equal((await f.service.retry(f.ctx,'research',f.packet.requestKey,{jobId:site.id})).job.status,'queued');
 await db.$executeRawUnsafe(`UPDATE rssd_publications SET state='published',receipt='{"release":"synthetic-release"}' WHERE "orgId"=$1 AND id=$2`,f.ctx.orgId,site.id);
 const complete=await f.service.receipt(f.ctx,'research',f.packet.requestKey);assert.equal(complete.job.status,'success');assert.equal(complete.job.release,'synthetic-release');
 assert.equal((await f.service.submit(f.ctx,'research',f.packet)).job.id,site.id);
 assert.equal((await store.publications(f.ctx)).length,2);
 const after=await f.service.detail(f.ctx,'research',f.packet.data.id,{scope:'published'});assert.equal(after.revision,1);assert.equal(after.data.locale,'en');
});

test('editorial translations retain their work identity and exact source version while English originals stay independent',async()=>{
 const f=await editorialFixture();await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 const source=await f.service.detail(f.ctx,'research',f.packet.data.id),translation={...f.packet,requestKey:randomUUID(),data:{...f.packet.data,id:'english-translation',locale:'en',translationOf:{articleId:f.packet.data.id,revision:1,sha256:legacyFingerprint(source.data)}}};
 await f.service.submit(f.ctx,'research',translation,{intent:'draft'});
 const en=await f.service.detail(f.ctx,'research',translation.data.id);assert.equal(en.workId,source.workId);assert.deepEqual(en.data.translationOf,translation.data.translationOf);assert.equal(en.data.centerTranslationOf,undefined);
 await assert.rejects(f.service.submit(f.ctx,'research',{...translation,requestKey:randomUUID(),expectedVersion:1,data:{...translation.data,translationOf:{...translation.data.translationOf,sha256:'0'.repeat(64)}}},{intent:'draft'}),{code:'source_conflict'});
 const alone={...f.packet,requestKey:randomUUID(),data:{...f.packet.data,id:'english-original',locale:'en'}};await f.service.submit(f.ctx,'research',alone,{intent:'draft'});
 const independent=await f.service.detail(f.ctx,'research',alone.data.id);assert.notEqual(independent.workId,source.workId);assert.equal(independent.data.translationOf,undefined);
});

test('editorial private originals round-trip exact bytes, keep author notes private and reject changed editions',async()=>{
 const f=await editorialFixture();await f.service.submit(f.ctx,'research',f.packet,{intent:'draft'});
 const notes={version:1,bodySha:'a'.repeat(64),internalNotes:{writing:'Private writing note'},modelSignatures:[]},bytes=Buffer.from(JSON.stringify(notes));
 const bundle={articleId:f.packet.data.id,revision:1,files:[{path:'.local/today-publication/internal-notes.json',sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')}]};
 const saved=await f.service.saveArchive(f.ctx,'research',bundle),expected=require('node:crypto').createHash('sha256').update(JSON.stringify(bundle)).digest('hex');assert.equal(saved.archiveId,expected);
 assert.deepEqual((await f.service.archive(f.ctx,'research',saved.archiveId)).bundle,bundle);
 assert.equal((await f.service.privateNotes(f.ctx,'research',f.packet.data.id)).privateEditorial.internalNotes.writing,'Private writing note');
 assert(!(JSON.stringify(await f.service.catalog(f.ctx,'research',{scope:'all'}))).includes('Private writing note'));
 await assert.rejects(f.service.archive({...f.ctx,orgId:randomUUID()},'research',saved.archiveId),{status:404});
 await assert.rejects(f.service.saveArchive(f.ctx,'research',{...bundle,files:[{...bundle.files[0],path:'../unsafe'}]}),{status:400});
 await f.service.submit(f.ctx,'research',{...f.packet,requestKey:randomUUID(),expectedVersion:1},{intent:'draft'});
 await assert.rejects(f.service.saveArchive(f.ctx,'research',bundle),{code:'revision_conflict'});
});

test('editorial migration fencing, revocation and a missing website policy retain manuscripts without publication',async()=>{
 const f=await editorialFixture();
 await db.$executeRawUnsafe(`INSERT INTO rssd_migrations ("orgId","siteId","workspaceId",state,manifest,ancillary) VALUES ($1,'research-site','research','staged','{}','{}')`,f.ctx.orgId);
 await assert.rejects(f.service.submit(f.ctx,'research',f.packet),{code:'migration_staged'});
 assert.equal((await store.works(f.ctx)).length,0);
 await db.$executeRawUnsafe("UPDATE rssd_migrations SET state='active' WHERE \"orgId\"=$1",f.ctx.orgId);
 await store.revokeWorker(f.owner,f.worker.id);
 await assert.rejects(f.service.submit(f.ctx,'research',f.packet),{status:401});
 assert.equal((await store.works(f.owner)).length,0);
 const g=await editorialFixture();await store.saveWorkspace(g.owner,{id:'research',siteId:'research-site',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:3,targets:[]}}]},2);
 await assert.rejects(g.service.submit(g.ctx,'research',g.packet),{code:'missing_destination'});
 assert.equal((await store.works(g.ctx)).length,0);
});

test('editorial projection retains legacy identity, language, original archives and published revision',async()=>{
 const f=await fixture();
 await store.saveWorkspace(f.owner,{id:'research',siteId:'research-site',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:1,targets:[]}}]},1);
 const packet={...f.packet,editions:[{locale:'zh-CN',title:'Published title',bodyMarkdown:'Published body',summary:'Summary',metadata:{author:'Author',date:'2026-01-01',category:'Methods',publication:{path:'/news/original-article/'}}}]};
 await store.submit(f.ctx,packet,{publish:false});
 const edition=(await store.work(f.ctx,packet.workId)).editions[0];
 await db.$executeRawUnsafe(`INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",state,payload,receipt) VALUES ($1,$2,$3,'research','zh-CN',1,'site-research-site','legacy_published',$4::jsonb,$5::jsonb)`,f.owner.orgId,randomUUID(),packet.workId,JSON.stringify({edition:edition.payload}),JSON.stringify({legacy:true,url:'https://example.org/news/original-article/'}));
 await store.submit(f.ctx,{...packet,requestId:randomUUID(),baseRevisions:{'zh-CN':1},editions:[{...packet.editions[0],title:'Private newer title'}]},{publish:false});
 const original={articleId:'original-article',revision:1,files:[{path:'notes.txt',data:Buffer.from('Private original').toString('base64'),sha256:require('node:crypto').createHash('sha256').update('Private original').digest('hex')}]};
 const raw=JSON.stringify(original),archiveId=require('node:crypto').createHash('sha256').update(raw).digest('hex'),bytes=require('node:zlib').gzipSync(raw);
 const archive={id:archiveId,payload:bytes.toString('base64'),sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
 const source={document:{kind:'news',source_key:'news:original-article',permalink:'/news/original-article/'},revisions:[{version:1,payload:JSON.stringify({id:'original-article'})}],sourceArchives:[archive]};
 await db.$executeRawUnsafe(`INSERT INTO rssd_legacy_documents ("orgId","siteId","documentId","workId",locale,"sourceHash",source) VALUES ($1,'research-site','legacy-document',$2,'zh-CN',$3,$4::jsonb)`,f.owner.orgId,packet.workId,p.hash(source),JSON.stringify(source));
 await db.$executeRawUnsafe(`INSERT INTO rssd_migrations ("orgId","siteId","workspaceId",state,manifest,ancillary) VALUES ($1,'research-site','research','staged',$2::jsonb,'{}')`,f.owner.orgId,JSON.stringify({site:{origin:'https://example.org'}}));
 const editorial=new RssdEditorial(store,new RssdMedia(store));
 const published=await editorial.catalog(f.ctx,'research'),all=await editorial.catalog(f.ctx,'research',{scope:'all'});
 assert.equal(published.items[0].title,'Published title');assert.equal(all.items[0].title,'Private newer title');
 assert.equal(published.items[0].revision,1);assert.equal(all.items[0].revision,2);assert.equal(all.items[0].publishedVersion,1);
 assert.equal(all.items[0].articleId,'original-article');assert.equal(all.items[0].url,'https://example.org/news/original-article/');
 const detail=await editorial.detail(f.ctx,'research','original-article');assert.equal(detail.workId,packet.workId);assert.equal(detail.data.markdown,'Published body');
 assert.deepEqual((await editorial.archive(f.ctx,'research',archiveId)).bundle,original);
 await assert.rejects(editorial.archive({...f.ctx,workspaceIds:[]},'research',archiveId),{status:403});
 await assert.rejects(editorial.detail({...f.ctx,orgId:randomUUID()},'research','original-article'),{status:404});
 assert.throws(()=>archiveBundle({...archive,sha256:'0'.repeat(64)}),{code:'archive_conflict'});
 await db.$executeRawUnsafe('UPDATE rssd_legacy_documents SET "deletedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1',f.owner.orgId);
 assert.equal((await editorial.catalog(f.ctx,'research',{scope:'all'})).items.length,0);
 await assert.rejects(editorial.detail(f.ctx,'research','original-article'),{status:410});
});

test('editorial pagination rejects changed generations and scopes English-only editions independently',async()=>{
 const f=await fixture();await store.submit(f.ctx,f.packet,{publish:false});
 const editorial=new RssdEditorial(store,new RssdMedia(store));
 assert.equal((await editorial.catalog(f.ctx,'research',{scope:'all'})).items.length,0);
 const before=await editorial.catalog(f.ctx,'research',{scope:'all',locale:'en',limit:1});assert.equal(before.items.length,1);assert.equal(before.next,null);
 await store.submit(f.ctx,{...f.packet,requestId:randomUUID(),workId:randomUUID()},{publish:false});
 await assert.rejects(editorial.catalog(f.ctx,'research',{scope:'all',locale:'en',generation:before.generation}),{code:'catalog_changed'});
 const first=await editorial.catalog(f.ctx,'research',{scope:'all',locale:'en',limit:1});
 const second=await editorial.catalog(f.ctx,'research',{scope:'all',locale:'en',limit:1,after:first.next,generation:first.generation});
 assert.notEqual(first.items[0].articleId,second.items[0].articleId);assert.equal(second.next,null);
 assert.equal((await editorial.index(f.ctx,'research')).items.length,2);
});

async function guestFixture(){
 const f=await fixture(),siteId='fixture-'+randomUUID(),secret='a'.repeat(64),proxyToken='fixture-'+randomUUID();
 const service=new RssdGuestbook(store,{secret:'test encryption key '.repeat(3),now:()=>Date.parse('2026-11-01T04:00:00Z')});
 const bundle={version:1,siteId,workspaceId:'research',config:{siteId,name:'Fixture',home:'https://example.org',timezone:'Asia/Shanghai',dailyLimit:2,forms:[{id:'message',label:'交流',fields:[]}]},source:{guestbook_meta:[{key:'site',value:siteId},{key:'secret',value:secret}],messages:[],guard:[]}};
 bundle.sourceHash=p.hash(bundle.source);await service.importLegacy(f.owner,bundle,proxyToken);
 const headers={'x-rssd-site-token':proxyToken,'x-rssd-client-ip':'192.0.2.1',origin:'https://example.org'};
 return {...f,siteId,secret,proxyToken,service,bundle,headers};
}
test('guestbook migration keeps signed visitor identity, old receipt, moderation and quota',async()=>{
 const f=await guestFixture(),v='b'.repeat(48),hash=value=>require('node:crypto').createHmac('sha256',f.secret).update(f.siteId+':'+value).digest('hex');
 const payload={kind:'message',name:'Synthetic visitor',message:'Archived message',contact:'private@example.org',details:{}};
 f.bundle.source.messages.push({id:randomUUID(),visitor:hash('visitor:'+v),day:'2026-11-01',request_key:'original-request-key',payload:JSON.stringify(payload),status:'approved',created:1793505600000,reviewed:1793505600001,reviewer:'original-owner'});
 f.bundle.sourceHash=p.hash(f.bundle.source);await f.service.importLegacy(f.owner,f.bundle,f.proxyToken);
 await assert.rejects(f.service.session(f.siteId,f.headers,{}),{status:403});
 await assert.rejects(f.service.activate(f.owner,f.siteId,f.bundle.sourceHash,{}),{status:409});
 await f.service.activate(f.owner,f.siteId,f.bundle.sourceHash,{oldWriterDisabled:true});
 const cookies={['__Host-today-guest-'+f.siteId]:v+'.'+hash('cookie:'+v)},session=await f.service.session(f.siteId,f.headers,cookies);
 assert.equal(session.cookie,undefined);assert.equal(session.body.remaining,1);
 const result=await f.service.submit(f.siteId,{...f.headers,'x-guestbook-csrf':session.body.csrf},cookies,{...payload,requestKey:'original-request-key'});
 assert.equal(result.replayed,true);assert.equal(result.id,f.bundle.source.messages[0].id);assert.equal(result.remaining,1);
 const publicResult=await f.service.publicMessages(f.siteId,f.headers);assert.equal(publicResult.messages[0].message,payload.message);assert(!JSON.stringify(publicResult).includes('private@example.org'));
 assert.equal((await f.service.moderation(f.owner,f.siteId,'approved')).messages[0].contact,payload.contact);
 const stored=await oneForTest('SELECT * FROM rssd_guestbooks WHERE "siteId"=$1',f.siteId);assert(!JSON.stringify(stored).includes(f.secret));
 await assert.rejects(f.service.importLegacy(f.owner,f.bundle,f.proxyToken),{status:409});
});
const oneForTest=async(sql,...values)=>(await db.$queryRawUnsafe(sql,...values))[0];
test('concurrent guestbook posts admit two per browser and preserve replay without exposing contacts',async()=>{
 const f=await guestFixture();await f.service.activate(f.owner,f.siteId,f.bundle.sourceHash,{oldWriterDisabled:true});
 const session=await f.service.session(f.siteId,f.headers,{}),cookies={[session.cookie.name]:session.cookie.value},headers={...f.headers,'x-guestbook-csrf':session.body.csrf};
 const body={kind:'message',name:'Fixture',message:'Plain <script>text</script>',contact:'private phone',details:{}};
 const requests=Array.from({length:4},(_,i)=>({...body,requestKey:'fixture-request-'+i}));
 const results=await Promise.allSettled(requests.map(b=>f.service.submit(f.siteId,headers,cookies,b)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);results.filter(r=>r.status==='rejected').forEach(r=>assert.equal(r.reason.status,429));
 assert.deepEqual((await f.service.publicMessages(f.siteId,headers)).messages,[]);
 const i=results.findIndex(r=>r.status==='fulfilled'),first=results[i].value;
 assert.equal((await f.service.submit(f.siteId,headers,cookies,requests[i])).id,first.id);
 await assert.rejects(f.service.submit(f.siteId,headers,cookies,{...requests[i],message:'different'}),{status:409});
 await f.service.review(f.owner,f.siteId,first.id,'approved');
 assert.deepEqual(Object.keys((await f.service.publicMessages(f.siteId,headers)).messages[0]).sort(),['created','id','kind','message','name']);
 await assert.rejects(f.service.review({...f.owner,orgId:randomUUID()},f.siteId,first.id,'rejected'),{status:404});
 await assert.rejects(f.service.moderation(f.ctx,f.siteId),{status:403});
 await assert.rejects(f.service.submit(f.siteId,{...headers,origin:'https://evil.example'},cookies,requests[i]),{status:403});
 await assert.rejects(f.service.session(f.siteId,{...headers,'x-rssd-site-token':'wrong'},cookies),{status:403});
 await assert.rejects(f.service.session(f.siteId,{...headers,'x-rssd-client-ip':'spoofed'},cookies),{status:403});
});
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
  const pubs=await store.publications(f.owner);assert.equal(pubs.length,1);assert.equal(pubs[0].state,'legacy_published');assert.equal(pubs[0].receipt.requests[0].key,'original-request');assert.equal(pubs[0].title,payload.title);assert.equal('payload' in pubs[0],false);assert.equal('bodyMarkdown' in pubs[0],false);
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
