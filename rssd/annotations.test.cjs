'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),{RssdStore}=require('./store.cjs'),{RssdAnnotations}=require('./annotations.cjs');
let pool,db,store,annotations,forms;
const adapter=client=>({$queryRawUnsafe:async(sql,...v)=>(await client.query(sql,v)).rows,$executeRawUnsafe:async(sql,...v)=>(await client.query(sql,v)).rowCount,
 $transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(adapter(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}});
before(async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 if(!/^rssd_.*test/.test(config.database||new URL(config.connectionString).pathname.slice(1)))throw Error('Tests require a dedicated rssd_*test database');
 pool=new Pool({...config,max:8});db=adapter(pool);
 // The published writing defaults say which family a section writes in.
 store=new RssdStore(db,{writingDefaults:{catalog:async()=>({workspaces:[{workspaceId:'research',sections:[{id:'methods',familyId:'method'}]}]}),freeze:async()=>null}});
 for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await db.$executeRawUnsafe(sql);
 annotations=new RssdAnnotations(store);forms=await import('./annotation-forms.mjs');
});
after(async()=>{if(pool)await pool.end();});
async function fixture({metadata={},title='倾向得分如何处理混杂'}={}){
 const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null};
 await store.saveWorkspace(owner,{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{version:1,targets:[]}},{id:'plain',name:'Plain',policy:{version:1,targets:[]}}]});
 const device=async name=>store.authenticate((await store.createWorker(owner,{name,workspaceIds:['research']})).token);
 const ctx=await device('First annotator'),workId=randomUUID();
 const save=(revision,sectionId='methods',id=workId)=>store.submit(ctx,{requestId:randomUUID(),workId:id,workspaceId:'research',sectionId,baseRevisions:{'zh-CN':revision-1},editions:[{locale:'zh-CN',title,bodyMarkdown:'正文第 '+revision+' 版。',metadata}]},{publish:false});
 const publish=(revision,id=workId)=>db.$executeRawUnsafe(`INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",state,payload) VALUES ($1,$2,$3,'research','zh-CN',$4,'site-test','published','{}'::jsonb)`,owner.orgId,randomUUID(),id,revision);
 await save(1);
 return {owner,ctx,device,workId,save,publish};
}
const sheet=(work,change={})=>{const out={};for(const item of forms.annotationItemsFor(forms.ANNOTATION_FORM,work))out[item.id]={value:item.type==='scale'?4:item.type==='check'?true:item.options[0].id};return {...out,...change};};

test('only a published revision of an article or a note is annotated, with the questions that apply to it',async()=>{
 const f=await fixture();
 assert.equal((await annotations.form(f.ctx)).version,forms.ANNOTATION_FORM.version);
 await assert.rejects(annotations.describe(f.ctx,{workId:f.workId}),{code:'not_published'});
 await f.publish(1);await f.save(2);
 const shown=await annotations.describe(f.ctx,{workId:f.workId});
 assert.equal(shown.target.revision,1,'the newest published revision, not the newer draft');assert.equal(shown.target.title,'倾向得分如何处理混杂');assert.equal(shown.mine,null);
 assert.deepEqual(shown.target.work,{workType:'article',family:'method'});
 // Form version 2 asks every work the same sections; what the Center knows about the work is still recorded.
 assert.deepEqual(shown.sections.map(s=>s.id),['overall','information-utility','information-quality','style-quality']);
 await assert.rejects(annotations.describe(f.ctx,{workId:f.workId,revision:2}),{code:'not_published'});
 // A card set made for the published revision adds the card questions.
 await db.$executeRawUnsafe(`INSERT INTO rssd_renditions ("orgId",id,"workspaceId","workId",locale,revision,variant,summary,payload) VALUES ($1,$2,'research',$3,'zh-CN',1,'cards','{}'::jsonb,'{"representation":"raster"}'::jsonb)`,f.owner.orgId,randomUUID(),f.workId);
 assert.deepEqual((await annotations.describe(f.ctx,{workId:f.workId})).target.work,{workType:'article',family:'method',cards:true});
 // A section the writing defaults do not list gets the common questions only; a note gets the note questions.
 const plain=randomUUID();await f.save(1,'plain',plain);await f.publish(1,plain);
 assert.deepEqual((await annotations.describe(f.ctx,{workId:plain})).target.work,{workType:'article'});
 const note=await fixture({metadata:{workType:'note',adaptedFrom:{workId:'w-1',revision:1}}});await note.publish(1);
 const noted=await annotations.describe(note.ctx,{workId:note.workId});assert.deepEqual(noted.target.work,{workType:'note',adapted:true});assert.deepEqual(noted.sections.map(s=>s.id),['overall','information-utility','information-quality','style-quality']);
 const record=await fixture({metadata:{record:{kind:'year',documentId:randomUUID(),fields:{}}}}).catch(()=>null);
 if(record){await record.publish(1);await assert.rejects(annotations.describe(record.ctx,{workId:record.workId}),{code:'not_annotatable'});}
});

test('answers are checked against the form, only ever added, and the newest of one annotator counts',async()=>{
 const f=await fixture();await f.publish(1);
 const work={workType:'article',family:'method'},version=forms.ANNOTATION_FORM.version,base={workId:f.workId,formVersion:version};
 await assert.rejects(annotations.submit(f.ctx,{...base,formVersion:'0',answers:sheet(work)}),{code:'form_changed'});
 await assert.rejects(annotations.submit(f.ctx,{...base,answers:{}}),error=>error.code==='invalid_annotation'&&/Missing answer/.test(error.message));
 await assert.rejects(annotations.submit(f.ctx,{...base,answers:sheet(work,{'overall-confidence':{value:9}})}),{code:'invalid_annotation'});
 await assert.rejects(annotations.submit(f.ctx,{...base,answers:sheet(work,{'no-such-item':{value:true}})}),{code:'invalid_annotation'});
 await assert.rejects(annotations.submit(f.ctx,{...base,editionHash:'0'.repeat(64),answers:sheet(work)}),{code:'source_conflict'});
 await assert.rejects(annotations.submit(f.ctx,{...base,revision:2,answers:sheet(work)}),{code:'not_published'});
 const first=await annotations.submit(f.ctx,{...base,answers:sheet(work,{'iq1-factuality':{value:true,note:'第三段的年份查不到出处'}})});
 assert.equal(first.annotatorKind,'person');assert.equal(first.annotatorId,'device:'+f.ctx.workerId);assert.equal(first.revision,1);assert.equal(first.answers['iq1-factuality'].note,'第三段的年份查不到出处');
 const second=await annotations.submit(f.ctx,{...base,answers:sheet(work,{'overall-confidence':{value:2}})});
 assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_annotations WHERE "orgId"=$1',f.owner.orgId))[0].n,2,'a changed answer is a new row');
 const mine=(await annotations.describe(f.ctx,{workId:f.workId})).mine;assert.equal(mine.id,second.id);assert.equal(mine.answers['overall-confidence'].value,2);
 const listed=await annotations.list(f.ctx,{workId:f.workId});assert.deepEqual(listed.map(row=>row.id),[second.id]);
 assert.equal((await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM rssd_audit WHERE "orgId"=$1 AND action='annotation.submit'`,f.owner.orgId))[0].n,2);
 // Annotating never touches the work: no new revision, same hash.
 assert.equal((await store.work(f.ctx,f.workId)).editions[0].revision,1);
});

test('people answer blind, a model answers under its own name, and the owner sees everyone',async()=>{
 const f=await fixture();await f.publish(1);
 const work={workType:'article',family:'method'},base={workId:f.workId,formVersion:forms.ANNOTATION_FORM.version},second=await f.device('Second annotator');
 const a=await annotations.submit(f.ctx,{...base,answers:sheet(work)});
 const model=await annotations.submit(f.ctx,{...base,annotator:{kind:'model',id:'claude-test-1'},answers:sheet(work,{'overall-confidence':{value:2}})});
 assert.equal(model.annotatorKind,'model');assert.equal(model.annotatorId,'claude-test-1');
 await assert.rejects(annotations.submit(f.ctx,{...base,annotator:{kind:'person',id:'someone-else'},answers:sheet(work)}),{code:'invalid_annotation'});
 // The model's sheet is its own: the person's answers are still theirs.
 assert.equal((await annotations.describe(f.ctx,{workId:f.workId})).mine.id,a.id);
 assert.equal((await annotations.describe(f.ctx,{workId:f.workId,annotator:{kind:'model',id:'claude-test-1'}})).mine.id,model.id);
 // The second person has not answered yet: they see nothing of this revision.
 assert.deepEqual(await annotations.list(second,{workId:f.workId}),[]);assert.equal((await annotations.describe(second,{workId:f.workId})).mine,null);
 const b=await annotations.submit(second,{...base,answers:sheet(work,{'overall-confidence':{value:1}})});
 assert.deepEqual((await annotations.list(second,{workId:f.workId})).map(row=>row.id).sort(),[a.id,b.id,model.id].sort());
 assert.deepEqual((await annotations.list(f.owner,{workspaceId:'research'})).map(row=>row.id).sort(),[a.id,b.id,model.id].sort());
 // Another organization's device reaches nothing.
 const other=await fixture();await assert.rejects(annotations.describe(other.ctx,{workId:f.workId}),{code:'not_found'});
 assert.deepEqual(await annotations.list(other.ctx,{workId:f.workId}),[]);
 await assert.rejects(annotations.list(second,{workspaceId:'elsewhere'}),{code:'forbidden'});
});
