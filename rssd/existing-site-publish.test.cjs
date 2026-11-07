'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Pool,Client}=require('pg'),{randomUUID}=require('node:crypto');
const {RssdStore}=require('./store.cjs');
const {RssdPublisher}=require('./publisher.cjs');
const {RssdPostiz}=require('./postiz.cjs');
const {RssdCoordination,STORE_ONLY_TRANSLATE_VERSION,STORE_ONLY_TRANSLATE_GUARANTEES,supportsStoreOnlyTranslate,EXISTING_ENGLISH_SITE_PUBLISH_VERSION,EXISTING_ENGLISH_SITE_PUBLISH_GUARANTEES,supportsExistingEnglishSitePublish}=require('./coordination.cjs');
const {RssdMcp}=require('./mcp.cjs');
const {RssdExistingSitePublish,RECEIPT_FIELDS,resolveArticleId}=require('./existing-site-publish.cjs');
const schema='rssd_en_site_'+randomUUID().replaceAll('-','');let pool,db,store,sitePublish,coord,control;
function adapter(client){return {$queryRawUnsafe:async(sql,...a)=>(await client.query(sql,a)).rows,$executeRawUnsafe:async(sql,...a)=>(await client.query(sql,a)).rowCount,$transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(adapter(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};}
function fakeSite(){
 let packet,posts=0,done=false;
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 const receipt=()=>({...packet,packetHash:require('./protocol.cjs').hash(packet),state:done?'success':'queued',release:'example-release'});
 const fetchImpl=async(url,options)=>{
  if(url.includes('/rssd-content/'))return response(packet);
  if(options.method==='POST'){posts++;packet=JSON.parse(options.body);return response(receipt());}
  return packet?response(receipt()):response({},404);
 };
 return {fetchImpl,get posts(){return posts;},complete(){done=true;}};
}
before(async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 if(!/^rssd_.*test/.test(config.database||new URL(config.connectionString).pathname.slice(1)))throw Error('Dedicated test database required');
 control=new Client(config);await control.connect();await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
 await control.query(fs.readFileSync(path.join(__dirname,'postiz-schema.sql'),'utf8'));
 for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await control.query(sql);
 pool=new Pool({...config,max:16,options:'-c search_path='+schema});db=adapter(pool);store=new RssdStore(db);
 sitePublish=new RssdExistingSitePublish(store);coord=new RssdCoordination(store);
});
after(async()=>{if(pool)await pool.end();if(control){await control.query('SET search_path TO public');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}});
async function fixture(){
 const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null};
 await db.$executeRawUnsafe('INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP)',owner.orgId,'Synthetic organization');
 const integration=randomUUID();
 await db.$executeRawUnsafe('INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,$3,$4,$5,$6)',integration,owner.orgId,'Synthetic channel','linkedin','social','fixture-never-real');
 const remote=fakeSite();
 const postiz=new RssdPostiz(store,{validate:async()=>{throw Error('postiz validate must not run');},startWorkflow:async()=>{throw Error('postiz workflow must not start');},workflowStatus:async()=>null});
 const publisher=new RssdPublisher(store,{secret:'fixture-only-encryption-key-not-production',fetchImpl:remote.fetchImpl,postiz});
 await store.saveWorkspace(owner,{id:'enter',siteId:'enter',name:'Enter',sections:[{id:'software',name:'Software',policy:{version:2,targets:[]}}]});
 await store.saveWorkspace(owner,{id:'academic',siteId:'academic',name:'Academic',sections:[{id:'news',name:'News',policy:{targets:[]}}]});
 await publisher.saveDestination(owner,{id:'site-enter',name:'Enter site',kind:'site',workspaceIds:['enter'],config:{origin:'https://example.test',siteId:'enter'},token:'fixture-only-site-credential-000000000',enabled:true});
 await publisher.saveDestination(owner,{id:'site-other',name:'Other site',kind:'site',workspaceIds:['enter'],config:{origin:'https://other.example.test',siteId:'other'},token:'fixture-only-other-credential-00000000',enabled:true});
 await publisher.saveDestination(owner,{id:'social',name:'Social',kind:'postiz',workspaceIds:['enter'],config:{integrationId:integration},enabled:true});
 await publisher.saveDestination(owner,{id:'forum',name:'Forum',kind:'discourse',workspaceIds:['enter'],config:{origin:'https://forum.example.test',username:'bot',categoryId:1},token:'fixture-only-forum-credential-00000000',enabled:true});
 await store.saveWorkspace(owner,{id:'enter',siteId:'enter',name:'Enter',sections:[{id:'software',name:'Software',policy:{version:3,targets:[
  {destinationId:'site-enter',locale:'zh-CN'},{destinationId:'site-enter',locale:'en'},
  {destinationId:'site-other',locale:'en'},{destinationId:'social',locale:'en'},{destinationId:'forum',locale:'en'}
 ]}}]},1);
 const worker=await store.createWorker(owner,{name:'Official device',workspaceIds:['enter']});
 const other=await store.createWorker(owner,{name:'Other workspace',workspaceIds:['academic']});
 const ctx=await store.authenticate(worker.token);
 const stranger=await store.authenticate(other.token);
 const articleId='shared-manuscript';
 const metadata={author:'Author',date:'2026-01-01',category:'Software',editorial:{articleId},publication:{path:'/en/news/shared-manuscript/'}};
 const workId=randomUUID();
 await store.submit(owner,{requestId:randomUUID(),workId,workspaceId:'enter',sectionId:'software',editions:[
  {locale:'zh-CN',title:'中文',bodyMarkdown:'完整的中文正文。',metadata:{...metadata,publication:{path:'/news/shared-manuscript/'}}},
  {locale:'en',title:'English',bodyMarkdown:'Stored English body.',metadata}
 ]},{publish:false});
 const en=await store.edition(owner,workId,'en',1);
 const zh=await store.edition(owner,workId,'zh-CN',1);
 return {owner,ctx,stranger,workId,en,zh,articleId,integration,publisher,remote,input:{requestId:randomUUID(),workId,locale:'en',revision:1,hash:en.hash,destinationId:'site-enter',articleId}};
}
function snapshot(workId,orgId){return Promise.all([
 db.$queryRawUnsafe('SELECT locale,revision,hash FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 ORDER BY locale,revision',orgId,workId),
 db.$queryRawUnsafe('SELECT "destinationId",locale,revision,state FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 ORDER BY "destinationId"',orgId,workId),
]);}

test('existing English site publish binds shared articleId, does not rewrite editions, and ignores extra policy destinations',async()=>{
 const f=await fixture();
 assert.equal(resolveArticleId(f.workId,'en',f.en.payload),f.articleId);
 assert.equal(resolveArticleId(f.workId,'zh-CN',f.zh.payload),f.articleId);
 const [before]=await snapshot(f.workId,f.owner.orgId);
 const created=await sitePublish.publish(f.ctx,f.input);
 assert.equal(created.status,'created');assert.equal(created.locale,'en');assert.equal(created.revision,1);
 assert.equal(created.destinationId,'site-enter');assert.equal(created.destinationKind,'site');
 assert.equal(created.hash,f.en.hash);assert.equal(created.articleId,f.articleId);
 assert.equal(created.publicationState,'queued');
 assert.deepEqual(Object.keys(created).sort(),[...RECEIPT_FIELDS].sort());
 assert.doesNotMatch(JSON.stringify(created),/Stored English body|fixture-never-real|sealedToken|privateEditorial/);
 const replay=await sitePublish.publish(f.ctx,f.input);
 assert.deepEqual(replay,created);
 assert.deepEqual(await sitePublish.receipt(f.ctx,f.input.requestId),created);
 const second=await sitePublish.publish(f.ctx,{...f.input,requestId:randomUUID()});
 assert.equal(second.status,'existing');assert.equal(second.publicationId,created.publicationId);
 const [after,pubs]=await snapshot(f.workId,f.owner.orgId);
 assert.deepEqual(after,before);
 assert.equal(pubs.length,1);assert.equal(pubs[0].destinationId,'site-enter');assert.equal(pubs[0].locale,'en');
 await db.$executeRawUnsafe('UPDATE rssd_publications SET "nextAttemptAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "orgId"=$1',f.owner.orgId);
 assert.equal((await f.publisher.tick({orgId:f.owner.orgId})).state,'queued');
 f.remote.complete();
 await db.$executeRawUnsafe('UPDATE rssd_publications SET "nextAttemptAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "orgId"=$1',f.owner.orgId);
 assert.equal((await f.publisher.tick({orgId:f.owner.orgId})).state,'published');
 assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_publications WHERE "orgId"=$1 AND "destinationId"<>$2',f.owner.orgId,'site-enter'))[0].n,0);
 assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "Post" WHERE "organizationId"=$1',f.owner.orgId))[0].n,0);
 assert.equal(f.remote.posts,1);
});

test('wrong language, revision, hash, destination, articleId and extra fields are rejected',async()=>{
 const f=await fixture();
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,locale:'zh-CN'}),{code:'english_only'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,revision:9}),{code:'not_found'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,hash:'a'.repeat(64)}),{code:'source_conflict'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,destinationId:'social'}),{code:'unsupported_destination'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,destinationId:'forum'}),{code:'unsupported_destination'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,destinationId:'site-other'}),{code:'unsupported_destination'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,articleId:'other-manuscript'}),{code:'identity_conflict'});
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,publish:true}),{code:'invalid_request'});
 await assert.rejects(sitePublish.publish(f.stranger,f.input),{code:'forbidden'});
 await db.$executeRawUnsafe('INSERT INTO rssd_editorial_states ("orgId","workId",locale,visibility) VALUES ($1,$2,\'en\',\'withdrawn\')',f.owner.orgId,f.workId);
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,requestId:randomUUID()}),{code:'edition_withdrawn'});
 assert.equal((await store.publications(f.owner)).length,0);
 const [editions]=await snapshot(f.workId,f.owner.orgId);
 assert.equal(editions.length,2);
});

test('duplicate and concurrent callers cannot create a second publication; retry is not a create',async()=>{
 const f=await fixture();
 const raced=await Promise.all(Array.from({length:8},()=>sitePublish.publish(f.ctx,{...f.input,requestId:randomUUID()})));
 const ids=new Set(raced.map(row=>row.publicationId));
 assert.equal(ids.size,1);
 assert.equal(raced.filter(row=>row.status==='created').length,1);
 assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2',f.owner.orgId,f.workId))[0].n,1);
 const publicationId=[...ids][0];
 await db.$executeRawUnsafe('UPDATE rssd_publications SET state=\'blocked\',attempts=3 WHERE "orgId"=$1 AND id=$2',f.owner.orgId,publicationId);
 const again=await sitePublish.publish(f.ctx,{...f.input,requestId:randomUUID()});
 assert.equal(again.status,'existing');assert.equal(again.publicationId,publicationId);assert.equal(again.publicationState,'blocked');
 const row=(await db.$queryRawUnsafe('SELECT state,attempts FROM rssd_publications WHERE "orgId"=$1 AND id=$2',f.owner.orgId,publicationId))[0];
 assert.equal(row.state,'blocked');assert.equal(row.attempts,3);
 await sitePublish.publish(f.ctx,f.input);
 await assert.rejects(sitePublish.publish(f.ctx,{...f.input,hash:f.zh.hash}),{code:'request_conflict'});
});

test('open store-only fence blocks this path; after store-only completion the same EN revision can be published once',async()=>{
 const f=await fixture();
 const other=randomUUID();
 await store.submit(f.owner,{requestId:randomUUID(),workId:other,workspaceId:'enter',sectionId:'software',editions:[{locale:'zh-CN',title:'另一篇',bodyMarkdown:'完整的中文正文。'}]},{publish:false});
 const storeOnly=await store.createDemand(f.ctx,{workspaceId:'enter',sectionId:'software',kind:'translate',title:'仅存英文',requiredLocales:['en'],source:{workId:other,locale:'zh-CN',revision:1},storeOnly:true});
 await assert.rejects(sitePublish.publish(f.ctx,{requestId:randomUUID(),workId:other,locale:'en',revision:1,hash:'a'.repeat(64),destinationId:'site-enter'}),{code:'store_only_conflict'});
 const claim=await store.claim(f.ctx,{demandId:storeOnly.id,storeOnly:true});
 const packet={requestId:randomUUID(),workId:other,workspaceId:'enter',sectionId:'software',demandId:claim.id,claimToken:claim.claimToken,baseRevisions:{en:0},editions:[{locale:'en',title:'Stored later',bodyMarkdown:'Store-only English.',translationOf:{workId:other,locale:'zh-CN',revision:1}}]};
 const accepted=await store.submit(f.ctx,packet);
 assert.equal(accepted.storeOnly,true);assert.deepEqual(accepted.publicationIds,[]);
 const en=await store.edition(f.owner,other,'en',1);
 const published=await sitePublish.publish(f.ctx,{requestId:randomUUID(),workId:other,locale:'en',revision:1,hash:en.hash,destinationId:'site-enter'});
 assert.equal(published.status,'created');assert.equal(published.revision,1);assert.equal(published.hash,en.hash);
 assert.equal((await store.work(f.ctx,other)).editions.find(e=>e.locale==='en').revision,1);
 assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2',f.owner.orgId,other))[0].n,1);
});

test('overview advertises existingEnglishSitePublish separately from store-only; MCP forwards the schema',async()=>{
 const f=await fixture();
 const device=await coord.overview(f.ctx);
 assert.equal(device.contracts.storeOnlyTranslate.version,STORE_ONLY_TRANSLATE_VERSION);
 assert.deepEqual(device.contracts.storeOnlyTranslate.guarantees,[...STORE_ONLY_TRANSLATE_GUARANTEES]);
 assert.equal(supportsStoreOnlyTranslate(device),true);
 assert.equal(device.contracts.existingEnglishSitePublish.version,EXISTING_ENGLISH_SITE_PUBLISH_VERSION);
 assert.deepEqual(device.contracts.existingEnglishSitePublish.guarantees,[...EXISTING_ENGLISH_SITE_PUBLISH_GUARANTEES]);
 assert.equal(supportsExistingEnglishSitePublish(device),true);
 assert.equal(supportsExistingEnglishSitePublish({contracts:{storeOnlyTranslate:device.contracts.storeOnlyTranslate}}),false);
 const mcp=new RssdMcp(store,coord,sitePublish);
 const listed=(await mcp.handle(f.ctx,{jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools;
 assert.equal(listed.some(t=>t.name==='rssd_publish_existing_english_site'),true);
 const tool=listed.find(t=>t.name==='rssd_publish_existing_english_site');
 assert.deepEqual(tool.inputSchema.required,['requestId','workId','locale','revision','hash','destinationId']);
 const extra=await mcp.handle(f.ctx,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'rssd_publish_existing_english_site',arguments:{...f.input,retry:true}}});
 assert.equal(extra.error.code,-32602);
 const ok=JSON.parse((await mcp.handle(f.ctx,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'rssd_publish_existing_english_site',arguments:f.input}})).result.content[0].text);
 assert.equal(ok.status,'created');assert.equal(ok.destinationId,'site-enter');
 const recovered=JSON.parse((await mcp.handle(f.ctx,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'rssd_existing_english_site_receipt',arguments:{requestId:f.input.requestId}}})).result.content[0].text);
 assert.equal(recovered.publicationId,ok.publicationId);
});
