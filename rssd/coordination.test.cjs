'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Pool,Client}=require('pg'),{randomUUID}=require('node:crypto');
const {RssdStore}=require('./store.cjs'),{RssdCoordination,windowFor}=require('./coordination.cjs'),{RssdMcp}=require('./mcp.cjs');
const schema='rssd_coord_'+randomUUID().replaceAll('-','');let pool,db,store,coord,control;
function adapter(client){return {$queryRawUnsafe:async(sql,...a)=>(await client.query(sql,a)).rows,$executeRawUnsafe:async(sql,...a)=>(await client.query(sql,a)).rowCount,$transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(adapter(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};}
before(async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 if(!/^rssd_.*test/.test(config.database||new URL(config.connectionString).pathname.slice(1)))throw Error('Dedicated test database required');
 control=new Client(config);await control.connect();await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
 await control.query(fs.readFileSync(path.join(__dirname,'postiz-schema.sql'),'utf8'));for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await control.query(sql);
 pool=new Pool({...config,max:16,options:'-c search_path='+schema});db=adapter(pool);store=new RssdStore(db);coord=new RssdCoordination(store);
});
after(async()=>{if(pool)await pool.end();if(control){await control.query('SET search_path TO public');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}});
async function fixture(){const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null};await db.$executeRawUnsafe('INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP)',owner.orgId,'Isolated test');for(const id of ['a','b'])await store.saveWorkspace(owner,{id,name:id,sections:[{id:'news',name:'News',policy:{targets:[]}}]});const worker=await store.createWorker(owner,{name:'Test device',workspaceIds:['a']});return {owner,worker,ctx:await store.authenticate(worker.token)};}
test('goal periods use the configured timezone across day, week and month boundaries',()=>{
 assert.deepEqual(windowFor('Asia/Tokyo','week',new Date('2026-11-01T16:00:00Z')),{start:'2026-11-02',end:'2026-11-09'});
 assert.deepEqual(windowFor('America/New_York','month',new Date('2026-11-01T00:00:00Z')),{start:'2026-10-01',end:'2026-11-01'});
});
test('demand edits are replayable and concurrent edits conflict; a claim freezes the edited rules',async()=>{
 const f=await fixture(),d=await store.createDemand(f.owner,{workspaceId:'a',sectionId:'news',title:'Original'});
 const input={baseGeneration:0,requestId:randomUUID(),changes:{title:'Edited',brief:'Frozen direction',requiredLocales:['en']}};
 const first=await coord.editDemand(f.ctx,d.id,input);assert.equal(first.generation,1);assert.equal((await coord.editDemand(f.ctx,d.id,input)).generation,1);
 await assert.rejects(coord.editDemand(f.ctx,d.id,{...input,requestId:randomUUID()}),{code:'revision_conflict'});
 const claim=await store.claim(f.ctx,{demandId:d.id});assert.equal(claim.payload.brief,'Frozen direction');
 await assert.rejects(coord.editDemand(f.ctx,d.id,{...input,baseGeneration:claim.generation,requestId:randomUUID()}),{code:'demand_frozen'});
 const other=await store.createDemand(f.owner,{workspaceId:'b',sectionId:'news',title:'Other'});await assert.rejects(coord.editDemand(f.ctx,other.id,input),{code:'forbidden'});
});
test('goal maintainer serializes concurrent runs and counts a bilingual work once without publishing',async()=>{
 const f=await fixture(),input={id:'weekly',baseRevision:0,requestId:randomUUID(),goal:{workspaceId:'a',sectionId:'news',period:'week',timezone:'Asia/Tokyo',target:2,title:'Goal brief',brief:'Verified sources required',requiredLocales:['zh-CN','en'],enabled:true}};
 await assert.rejects(coord.saveGoal(f.ctx,input),{code:'forbidden'});await coord.saveGoal(f.owner,input);await coord.saveGoal(f.owner,input);
 const now=new Date();const runs=await Promise.all(Array.from({length:4},()=>coord.maintainGoal(f.owner.orgId,'weekly',now)));assert.equal(runs.reduce((n,r)=>n+r.created,0),2);
 const claim=await store.claim(f.ctx,{workspaceIds:['a']});const workId=randomUUID();
 await store.submit(f.ctx,{requestId:randomUUID(),workId,workspaceId:'a',sectionId:'news',demandId:claim.id,claimToken:claim.claimToken,editions:[{locale:'zh-CN',title:'中文',bodyMarkdown:'Original Chinese'}]});
 assert.equal((await coord.goals(f.owner))[0].completed,0);
 await store.submit(f.ctx,{requestId:randomUUID(),workId,workspaceId:'a',sectionId:'news',demandId:claim.id,claimToken:claim.claimToken,editions:[{locale:'en',title:'English',bodyMarkdown:'Original English'}]});
 const goal=(await coord.goals(f.owner))[0];assert.equal(goal.completed,1);assert.equal(goal.pending,1);assert.equal(goal.published,0);
 assert.equal((await coord.maintainGoal(f.owner.orgId,'weekly',now)).created,0);assert.equal((await store.publications(f.owner)).length,0);
});
test('unified calendar preserves native posts and scoped channels without leaking unmapped accounts',async()=>{
 const f=await fixture(),integration=randomUUID();await db.$executeRawUnsafe('INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,$3,$4,$5,$6)',integration,f.owner.orgId,'Private social','linkedin','social','never-return-this');
 const post=randomUUID();await db.$executeRawUnsafe('INSERT INTO "Post" (id,"organizationId","integrationId",state,"publishDate",content,"group","updatedAt") VALUES ($1,$2,$3,\'QUEUE\',CURRENT_TIMESTAMP,$4,$1,CURRENT_TIMESTAMP)',post,f.owner.orgId,integration,'Original native post');
 assert.equal((await coord.calendar(f.owner)).items.length,1);assert.equal((await coord.calendar(f.ctx)).items.length,0);
 assert.equal((await coord.channels(f.ctx)).channels.length,0);assert(!JSON.stringify(await coord.channels(f.owner)).includes('never-return-this'));
 const after=(await db.$queryRawUnsafe('SELECT content,state FROM "Post" WHERE id=$1',post))[0];assert.equal(after.content,'Original native post');assert.equal(after.state,'QUEUE');
});
test('MCP lists role-specific tools, rejects notification mutations and shares scope and audit rules',async()=>{
 const f=await fixture(),mcp=new RssdMcp(store,coord),call=(method,params)=>mcp.handle(f.ctx,{jsonrpc:'2.0',id:1,method,params});
 const names=(await call('tools/list')).result.tools.map(t=>t.name);assert(names.includes('rssd_claim'));assert(names.includes('rssd_create_demand'));assert(!names.includes('rssd_save_goal'));assert(!names.includes('rssd_schedule_publication'));assert(!names.includes('rssd_grant_capability'));
 assert.equal((await mcp.handle(f.ctx,{jsonrpc:'2.0',method:'tools/call',params:{name:'rssd_claim'}})).error.code,-32600);
 const read=await call('tools/call',{name:'rssd_overview',arguments:{workspaceIds:'a'}});assert.equal(JSON.parse(read.result.content[0].text).workspaces.length,1);
 const forbidden=await call('tools/call',{name:'rssd_overview',arguments:{workspaceIds:'b'}});assert(forbidden.result.isError);
 const ownerNames=(await mcp.handle(f.owner,{jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.map(t=>t.name);assert(ownerNames.includes('rssd_grant_capability'));assert(ownerNames.includes('rssd_schedule_publication'));
 const logs=await db.$queryRawUnsafe('SELECT action FROM rssd_audit WHERE "orgId"=$1',f.owner.orgId);assert(logs.some(r=>r.action==='mcp.rssd_overview'));
});
test('scheduling preserves the original publication, replays after a lost response and fences a started delivery',async()=>{
 const f=await fixture(),id=randomUUID(),workId=randomUUID();
 await db.$executeRawUnsafe('INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",payload) VALUES ($1,$2,$3,\'a\',\'en\',1,\'site-a\',\'{"edition":{"title":"Original"}}\')',f.owner.orgId,id,workId);
 const old=(await store.publications(f.owner))[0],input={requestId:randomUUID(),expectedUpdatedAt:old.updatedAt.toISOString(),scheduledAt:new Date(Date.now()+86400000).toISOString()};
 await assert.rejects(coord.schedule(f.ctx,id,input),{code:'forbidden'});
 const first=await coord.schedule(f.owner,id,input);assert.equal(first.id,id);assert.equal((await coord.schedule(f.owner,id,input)).id,id);
 assert.equal((await store.publications(f.owner)).length,1);
 await db.$executeRawUnsafe('UPDATE rssd_publications SET attempts=1 WHERE "orgId"=$1 AND id=$2',f.owner.orgId,id);
 await assert.rejects(coord.schedule(f.owner,id,{...input,requestId:randomUUID(),expectedUpdatedAt:first.updatedAt.toISOString()}),{code:'publication_started'});
 const event=(await coord.calendar(f.owner)).items[0];assert.equal(event.hasSchedule,true);assert.equal(event.workId,workId);
});
test('Owner-granted publication scheduling is scoped, revocable and read back; unauthorized devices stay 403',async()=>{
 const f=await fixture(),id=randomUUID(),other=randomUUID(),workId=randomUUID();
 await db.$executeRawUnsafe('INSERT INTO rssd_destinations ("orgId",id,name,kind,"workspaceIds",config,enabled) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,true)',f.owner.orgId,'site-a','Site A','site',JSON.stringify(['a']),'{}');
 await db.$executeRawUnsafe('INSERT INTO rssd_destinations ("orgId",id,name,kind,"workspaceIds",config,enabled) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,true)',f.owner.orgId,'site-other','Other','site',JSON.stringify(['a']),'{}');
 await db.$executeRawUnsafe('INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",payload) VALUES ($1,$2,$3,\'a\',\'en\',1,\'site-a\',\'{"edition":{"title":"Original"}}\')',f.owner.orgId,id,workId);
 await db.$executeRawUnsafe('INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",payload) VALUES ($1,$2,$3,\'a\',\'en\',1,\'site-other\',\'{"edition":{"title":"Out of scope"}}\')',f.owner.orgId,other,workId);
 const wide=await store.createWorker(f.owner,{name:'Wide',workspaceIds:['a','b']});
 const grantInput={workerId:wide.id,operation:'publicationScheduling',workspaceIds:['a'],destinationIds:['site-a'],requestId:randomUUID()};
 await assert.rejects(coord.grantCapability(f.ctx,grantInput),{code:'forbidden'});
 const grant=await coord.grantCapability(f.owner,grantInput);assert.equal((await coord.grantCapability(f.owner,grantInput)).id,grant.id);
 await assert.rejects(coord.grantCapability(f.owner,{workerId:f.worker.id,operation:'publicationScheduling',workspaceIds:['b'],destinationIds:['site-a'],requestId:randomUUID()}),{code:'forbidden'});
 await assert.rejects(coord.grantCapability(f.owner,{...grantInput,requestId:randomUUID(),workspaceIds:['b']}),{code:'invalid_destination'});
 await assert.rejects(coord.grantCapability(f.owner,{...grantInput,requestId:randomUUID(),destinationIds:['missing']}),{status:404});
 const authed=await store.authenticate(wide.token),stranger=await store.authenticate((await store.createWorker(f.owner,{name:'No grant',workspaceIds:['a']})).token);
 assert.equal((await coord.overview(authed,{workspaceIds:'a'})).capabilities.publicationScheduling,true);
 assert.equal((await coord.overview(authed,{workspaceIds:'b'})).capabilities.publicationScheduling,false);
 assert.equal((await coord.overview(stranger)).capabilities.publicationScheduling,false);
 const mcp=new RssdMcp(store,coord);
 assert((await mcp.handle(authed,{jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.some(t=>t.name==='rssd_schedule_publication'));
 const listed=await store.workers(f.owner);assert.equal(listed.find(w=>w.id===wide.id).grants[0].id,grant.id);
 const row=(await store.publications(f.owner)).find(item=>item.id===id),input={requestId:randomUUID(),expectedUpdatedAt:row.updatedAt.toISOString(),scheduledAt:new Date(Date.now()+86400000).toISOString()};
 await assert.rejects(coord.schedule(stranger,id,input),{code:'forbidden'});
 const first=await coord.schedule(authed,id,input);assert.equal(first.id,id);assert.equal((await coord.schedule(authed,id,input)).id,id);
 const outside=(await store.publications(f.owner)).find(item=>item.id===other);
 await assert.rejects(coord.schedule(authed,other,{requestId:randomUUID(),expectedUpdatedAt:outside.updatedAt.toISOString(),scheduledAt:input.scheduledAt}),{code:'forbidden'});
 await coord.revokeCapability(f.owner,{id:grant.id,requestId:randomUUID()});
 const after=await store.authenticate(f.worker.token);
 assert.equal((await coord.overview(after)).capabilities.publicationScheduling,false);
 await assert.rejects(coord.schedule(after,id,{...input,requestId:randomUUID(),expectedUpdatedAt:first.updatedAt.toISOString()}),{code:'forbidden'});
 assert(!(await mcp.handle(after,{jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.some(t=>t.name==='rssd_schedule_publication'));
});
test('paused and staged goals cannot create new demands and goal updates require current revision',async()=>{
 const f=await fixture(),input={id:'disabled',baseRevision:0,requestId:randomUUID(),goal:{workspaceId:'a',sectionId:'news',period:'day',timezone:'UTC',target:2,title:'Paused goal',requiredLocales:['en'],enabled:false}};
 await coord.saveGoal(f.owner,input);assert.equal((await coord.maintainGoal(f.owner.orgId,input.id)).created,0);
 await assert.rejects(coord.saveGoal(f.owner,{...input,requestId:randomUUID()}),{code:'revision_conflict'});
 await db.$executeRawUnsafe('INSERT INTO rssd_migrations ("orgId","siteId","workspaceId",state,manifest,ancillary) VALUES ($1,\'a\',\'a\',\'staged\',\'{}\',\'{}\')',f.owner.orgId);
 await assert.rejects(coord.saveGoal(f.owner,{...input,requestId:randomUUID(),baseRevision:1,goal:{...input.goal,enabled:true}}),{code:'migration_staged'});
 assert.equal((await store.demands(f.owner)).length,0);
});
