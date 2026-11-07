'use strict';
require('reflect-metadata');
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Pool,Client}=require('pg'),{randomUUID}=require('node:crypto');
const {Test}=require('@nestjs/testing');
const {ThrottlerModule}=require('@nestjs/throttler');
const servicePath=require.resolve('../apps/backend/dist/apps/backend/src/rssd/rssd.service.js');
class RssdService {}
require.cache[servicePath]={id:servicePath,filename:servicePath,loaded:true,exports:{RssdService}};
const {RssdController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.controller.js');
const {RssdStore}=require('../apps/backend/dist/rssd/store.cjs');
const {RssdPublisher}=require('../apps/backend/dist/rssd/publisher.cjs');
const {RssdPostiz}=require('../apps/backend/dist/rssd/postiz.cjs');
const {RssdExistingSitePublish,RECEIPT_FIELDS}=require('../apps/backend/dist/rssd/existing-site-publish.cjs');
const schema='rssd_en_site_http_'+randomUUID().replaceAll('-','');let pool,db,store,control;
function adapter(client){return {$queryRawUnsafe:async(sql,...a)=>(await client.query(sql,a)).rows,$executeRawUnsafe:async(sql,...a)=>(await client.query(sql,a)).rowCount,$transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(adapter(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};}
before(async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 if(!/^rssd_.*test/.test(config.database||new URL(config.connectionString).pathname.slice(1)))throw Error('Dedicated test database required');
 control=new Client(config);await control.connect();await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
 await control.query(fs.readFileSync(path.join(__dirname,'postiz-schema.sql'),'utf8'));
 for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await control.query(sql);
 pool=new Pool({...config,max:8,options:'-c search_path='+schema});db=adapter(pool);store=new RssdStore(db);
});
after(async()=>{if(pool)await pool.end();if(control){await control.query('SET search_path TO public');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}});

test('real HTTP create and receipt use Postgres and never leak edition or credentials',async t=>{
 const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null};
 await db.$executeRawUnsafe('INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP)',owner.orgId,'HTTP fixture');
 const integration=randomUUID();
 await db.$executeRawUnsafe('INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,$3,$4,$5,$6)',integration,owner.orgId,'Synthetic channel','linkedin','social','fixture-never-real');
 const postiz=new RssdPostiz(store,{validate:async()=>{throw Error('postiz validate must not run');},startWorkflow:async()=>{throw Error('postiz workflow must not start');},workflowStatus:async()=>null});
 const publisher=new RssdPublisher(store,{secret:'fixture-only-encryption-key-not-production',postiz});
 await store.saveWorkspace(owner,{id:'enter',siteId:'enter',name:'Enter',sections:[{id:'software',name:'Software',policy:{targets:[]}}]});
 await publisher.saveDestination(owner,{id:'site-enter',name:'Enter site',kind:'site',workspaceIds:['enter'],config:{origin:'https://example.test',siteId:'enter'},token:'fixture-only-site-credential-000000000',enabled:true});
 await publisher.saveDestination(owner,{id:'social',name:'Social',kind:'postiz',workspaceIds:['enter'],config:{integrationId:integration},enabled:true});
 await store.saveWorkspace(owner,{id:'enter',siteId:'enter',name:'Enter',sections:[{id:'software',name:'Software',policy:{version:2,targets:[{destinationId:'site-enter',locale:'en'},{destinationId:'social',locale:'en'}]}}]},1);
 const worker=await store.createWorker(owner,{name:'HTTP device',workspaceIds:['enter']});
 const ctx=await store.authenticate(worker.token);
 const workId=randomUUID(),articleId='http-shared';
 await store.submit(owner,{requestId:randomUUID(),workId,workspaceId:'enter',sectionId:'software',editions:[
  {locale:'zh-CN',title:'中文',bodyMarkdown:'完整的中文正文。',metadata:{editorial:{articleId}}},
  {locale:'en',title:'English',bodyMarkdown:'Secret English body.',metadata:{editorial:{articleId}}}
 ]},{publish:false});
 const en=await store.edition(owner,workId,'en',1);
 const existingSitePublish=new RssdExistingSitePublish(store);
 const module=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:{existingSitePublish}}]}).compile();
 const app=module.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd=ctx;next();});
 await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl(),headers={'content-type':'application/json'};
 const body={requestId:randomUUID(),workId,locale:'en',revision:1,hash:en.hash,destinationId:'site-enter',articleId};
 const created=await fetch(origin+'/rssd/v1/site-publications',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal(created.status,201);
 const receipt=await created.json();
 assert.equal(receipt.status,'created');assert.equal(receipt.destinationId,'site-enter');
 assert.deepEqual(Object.keys(receipt).sort(),[...RECEIPT_FIELDS].sort());
 assert.doesNotMatch(JSON.stringify(receipt),/Secret English body|fixture-never-real|fixture-only-site-credential/);
 const recovered=await fetch(origin+'/rssd/v1/site-publications/'+body.requestId);
 assert.equal(recovered.status,200);assert.equal((await recovered.json()).publicationId,receipt.publicationId);
 const social=await fetch(origin+'/rssd/v1/site-publications',{method:'POST',headers,body:JSON.stringify({...body,requestId:randomUUID(),destinationId:'social'})});
 assert.equal(social.status,409);assert.equal((await social.json()).code,'unsupported_destination');
 assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_publications WHERE "orgId"=$1',owner.orgId))[0].n,1);
 assert.equal((await db.$queryRawUnsafe('SELECT "destinationId" FROM rssd_publications WHERE "orgId"=$1',owner.orgId))[0].destinationId,'site-enter');
});
