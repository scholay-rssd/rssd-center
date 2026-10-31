'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Pool,Client}=require('pg'),{randomUUID}=require('node:crypto');
const {RssdStore}=require('./store.cjs'),{RssdPublisher}=require('./publisher.cjs'),{RssdPostiz}=require('./postiz.cjs');
const schema='rssd_social_'+randomUUID().replaceAll('-','');let pool,db,store,control;
function adapter(client){return {$queryRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rows,$executeRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rowCount,
 $transaction:async fn=>{const connection=await pool.connect();try{await connection.query('BEGIN');const value=await fn(adapter(connection));await connection.query('COMMIT');return value;}catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}}};}
before(async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 if(!/^rssd_.*test/.test(config.database||new URL(config.connectionString).pathname.slice(1)))throw Error('Dedicated test database required');
 control=new Client(config);await control.connect();await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
 await control.query(fs.readFileSync(path.join(__dirname,'postiz-schema.sql'),'utf8'));await control.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
 pool=new Pool({...config,options:'-c search_path='+schema});db=adapter(pool);store=new RssdStore(db);
});
after(async()=>{if(pool)await pool.end();if(control){await control.query('SET search_path TO public');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}});
async function fixture({loseStart=false,unknownStart=false,invalid=false,missingContent=false}={}){
 const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null},integration=randomUUID();
 await db.$executeRawUnsafe('INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP)',owner.orgId,'Synthetic organization');
 await db.$executeRawUnsafe('INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,$3,$4,$5,$6)',integration,owner.orgId,'Synthetic channel','linkedin','social','fixture-never-real');
 await store.saveWorkspace(owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{targets:[]}}]});
 let workflow=null,starts=0;
 const bridge=new RssdPostiz(store,{validate:async()=>[{valid:!invalid,errors:true,emptyContent:false,tooLong:false}],workflowStatus:async()=>workflow,startWorkflow:async()=>{starts++;if(!unknownStart)workflow={runId:randomUUID(),status:'RUNNING'};if(loseStart||unknownStart)throw Error('Simulated lost startup response');return {runId:workflow.runId};}});
 const publisher=new RssdPublisher(store,{postiz:bridge,secret:'fixture-only-encryption-secret-not-production'});
 await publisher.saveDestination(owner,{id:'social',name:'Social',kind:'postiz',workspaceIds:['research'],config:{integrationId:integration},enabled:true});
 await store.saveWorkspace(owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{targets:[{destinationId:'social',locale:'en'}]}}]},1);
 const packet={requestId:randomUUID(),workId:randomUUID(),workspaceId:'research',sectionId:'methods',editions:[{locale:'en',title:'Synthetic article',bodyMarkdown:'An entire article stays in the content library.',metadata:missingContent?{}:{platformContent:{social:{text:'A synthetic platform post.',mediaIds:[],settings:{}}}}}]};
 await store.submit(owner,packet);
 // TIMESTAMPTZ(3) rounds microseconds; make a due fixture unambiguously past.
 const ready=()=>db.$executeRawUnsafe('UPDATE rssd_publications SET "nextAttemptAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "orgId"=$1',owner.orgId);
 await ready();
 const posts=()=>db.$queryRawUnsafe('SELECT * FROM "Post" WHERE "organizationId"=$1',owner.orgId);
 return {owner,integration,bridge,publisher,packet,ready,posts,get starts(){return starts;},tick:()=>publisher.tick({orgId:owner.orgId})};
}
test('lost workflow response recovers the same Postiz post; revisions never create a replacement',async()=>{
 const f=await fixture({loseStart:true});assert.equal((await f.tick()).state,'queued');assert.equal(f.starts,1);
 await f.ready();assert.equal((await f.tick()).state,'queued');assert.equal(f.starts,1);
 const posts=await f.posts();assert.equal(posts.length,1);
 await db.$executeRawUnsafe(`UPDATE "Post" SET state='PUBLISHED',"releaseId"='provider-42',"releaseURL"='https://example.invalid/posts/42' WHERE id=$1`,posts[0].id);
 await f.ready();assert.equal((await f.tick()).state,'published');
 const receipt=(await store.publications(f.owner))[0].receipt;assert.equal(receipt.releaseId,'provider-42');assert.equal(receipt.postId,posts[0].id);assert.equal(receipt.verification,'postiz-provider-receipt');
 await store.submit(f.owner,{...f.packet,requestId:randomUUID(),baseRevisions:{en:1},editions:[{...f.packet.editions[0],title:'Revised article'}]});
 assert.equal((await f.tick()).state,'blocked');assert.equal((await f.posts()).length,1);assert.equal(f.starts,1);
});
test('uncertain workflow absence blocks instead of starting another publication',async()=>{
 const f=await fixture({unknownStart:true});await f.tick();await f.ready();assert.equal((await f.tick()).state,'blocked');assert.equal(f.starts,1);
 const item=(await store.publications(f.owner))[0];await f.publisher.retry(f.owner,item.id);await f.tick();assert.equal(f.starts,1);
 await store.submit(f.owner,{...f.packet,requestId:randomUUID(),baseRevisions:{en:1},editions:[{...f.packet.editions[0],title:'New revision after uncertain result'}]});
 assert.equal((await f.tick()).state,'blocked');assert.equal((await f.posts()).length,1);assert.equal(f.starts,1);
});
test('missing materials and provider validation failures never enter Postiz',async()=>{
 for(const options of [{missingContent:true},{invalid:true}]){const f=await fixture(options);assert.equal((await f.tick()).state,'blocked');assert.equal((await f.posts()).length,0);assert.equal(f.starts,0);assert.equal((await store.work(f.owner,f.packet.workId)).editions.length,1);}
});
test('manual Postiz edits and foreign channel bindings are rejected; channel lists never expose authorization',async()=>{
 const f=await fixture(),other=await fixture();await assert.rejects(f.publisher.saveDestination(f.owner,{id:'foreign',name:'Foreign',kind:'postiz',workspaceIds:['research'],config:{integrationId:other.integration},enabled:true}),{status:404});
 const channels=await f.bridge.channels(f.owner);assert.equal(channels.length,1);assert.equal(channels[0].token,undefined);assert(!JSON.stringify(channels).includes('fixture-never-real'));
 await assert.rejects(f.bridge.channels({...f.owner,admin:false}),{status:403});
 await f.tick();const post=(await f.posts())[0];await db.$executeRawUnsafe('UPDATE "Post" SET content=$2 WHERE id=$1',post.id,'Manual edit');await f.ready();assert.equal((await f.tick()).state,'blocked');assert.equal(f.starts,1);
});

test('claim snapshots include platform requirements without channel credentials',async()=>{
 const f=await fixture();const worker=await store.createWorker(f.owner,{name:'Synthetic PC',workspaceIds:['research']}),ctx=await store.authenticate(worker.token);
 await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Platform task'});const claim=await store.claim(ctx);
 assert.deepEqual(claim.payload.destinations,[{destinationId:'social',locale:'en',name:'Social',kind:'postiz',platform:'linkedin'}]);assert(!JSON.stringify(claim).includes('fixture-never-real'));
});
