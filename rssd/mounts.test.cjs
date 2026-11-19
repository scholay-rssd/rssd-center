'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {Pool}=require('pg'),{RssdStore}=require('./store.cjs'),{RssdMounts}=require('./mounts.cjs'),{RssdMcp}=require('./mcp.cjs'),{publicContent}=require('./publication.cjs');
let pool,db,store,mounts;
const adapter=client=>({$queryRawUnsafe:async(sql,...v)=>(await client.query(sql,v)).rows,$executeRawUnsafe:async(sql,...v)=>(await client.query(sql,v)).rowCount,
 $transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(adapter(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}});
before(async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 if(!/^rssd_.*test/.test(config.database||new URL(config.connectionString).pathname.slice(1)))throw Error('Tests require a dedicated rssd_*test database');
 pool=new Pool({...config,max:8});db=adapter(pool);store=new RssdStore(db);mounts=store.mounts=new RssdMounts(store);
 for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await db.$executeRawUnsafe(sql);
});
after(async()=>{if(pool)await pool.end();});

// A snapshot shaped and hashed the way the persona library compiles one. Every value here is made up.
const sorted=v=>Array.isArray(v)?v.map(sorted):v===null||typeof v!=='object'?v:Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])]));
const H=c=>c.repeat(64),SECRET='Write through an explicitly fictional persona.';
function snapshot(n,{revision=1,founder=n,core='Reads the fine print first.'}={}){
 const id='P'+String(n).padStart(4,'0');
 const payload={schemaVersion:'12monkey.content-persona-snapshot.v1',kind:'preset-persona',fictional:true,
  preset:{id,revision:id.toLowerCase()+'.v'+revision,contentHash:H('a'),personalityHash:H('b'),founder:{id:'M'+String(founder).padStart(2,'0'),revision:'m.v1',personalityHash:H('c')}},
  publicProfile:{chineseScreenName:'示例'+n,englishScreenName:'Example '+n,abbreviation:'EX'+n},
  behavior:{tuningIntent:'More outward.',core,strengths:['Checks sources'],blindSpots:['Slow to object'],communicationStyle:'Plain and exact.',decisionStyle:'Weighs evidence.',collaborationStyle:'Asks for context.',underPressure:'Rechecks.'},
  developerInstructions:SECRET+' '+id+' v'+revision};
 return {...payload,snapshotHash:createHash('sha256').update(JSON.stringify(sorted(payload))).digest('hex')};
}
const persona=(n,options)=>({snapshot:snapshot(n,options),founderName:'Founder'+(options?.founder||n)});
const TITLES=['Alpha waves','Bravo charts','Charlie models','Delta rules','Echo samples','Foxtrot tests','Golf methods','Hotel scales'];
async function fixture({voice,count=3}={}){
 const owner={orgId:randomUUID(),userId:'owner',admin:true,workspaceIds:null};
 const sections=v=>[{id:'methods',name:'Methods',policy:{version:1,targets:[],...(v?{voice:v}:{})}}];
 let revision=0;
 const setVoice=async v=>{await store.saveWorkspace(owner,{id:'research',name:'Research',sections:sections(v)},revision);revision++;};
 await setVoice(null);
 if(count)await mounts.savePersonas(owner,{personas:Array.from({length:count},(_,i)=>persona(i+1))});
 if(voice)await setVoice(voice);
 const device=async name=>store.authenticate((await store.createWorker(owner,{name,workspaceIds:['research']})).token);
 const ctx=await device('Writer');let next=0;
 const order=(extra={})=>store.createDemand(owner,{workspaceId:'research',sectionId:'methods',title:TITLES[next++]+' '+randomUUID().slice(0,6),requiredLocales:['zh-CN'],...extra});
 const packet=(claim,metadata,{workId=randomUUID(),locale='zh-CN',...extra}={})=>({requestId:randomUUID(),workId,workspaceId:'research',sectionId:'methods',demandId:claim.id,claimToken:claim.claimToken,
  editions:[{locale,title:'Work',bodyMarkdown:'Body.',metadata,...extra}]});
 const signed=decision=>({author:decision.persona.founder.name,persona:{id:decision.persona.founder.id},voice:{id:decision.persona.id,revision:decision.persona.revision,snapshotHash:decision.persona.snapshotHash}});
 return {owner,ctx,device,order,packet,signed,setVoice};
}

test('the library keeps every revision unchanged; only the owner writes it, and a list carries no content',async()=>{
 const f=await fixture({count:0});
 assert.deepEqual(await mounts.savePersonas(f.owner,{personas:[persona(1),persona(2)]}),{personas:[{id:'P0001',revision:'p0001.v1',status:'created'},{id:'P0002',revision:'p0002.v1',status:'created'}]});
 assert.deepEqual((await mounts.savePersonas(f.owner,{personas:[persona(1),persona(1,{revision:2})]})).personas.map(x=>x.status),['existing','created']);
 await assert.rejects(mounts.savePersonas(f.owner,{personas:[persona(1,{core:'Rewritten in place.'})]}),{code:'mount_conflict'});
 await assert.rejects(mounts.savePersonas(f.owner,{personas:[{snapshot:snapshot(1),founderName:'Someone else'}]}),{code:'mount_conflict'});
 const edited=snapshot(3);edited.behavior.core='Edited after it was compiled.';
 await assert.rejects(mounts.savePersonas(f.owner,{personas:[{snapshot:edited,founderName:'Founder3'}]}),{code:'persona_hash_mismatch',status:400});
 for(const bad of [{},{personas:[]},{personas:[persona(4),persona(4)]},{personas:[{snapshot:{...snapshot(4),demographics:{age:1}},founderName:'F'}]},{personas:[{snapshot:snapshot(4)}]}])
  await assert.rejects(mounts.savePersonas(f.owner,bad),{status:400});
 await assert.rejects(mounts.savePersonas(f.ctx,{personas:[persona(5)]}),{code:'forbidden'});
 await assert.rejects(mounts.personas(f.ctx),{code:'forbidden'});
 const listed=await mounts.personas(f.owner);
 assert.deepEqual(listed.personas.map(x=>[x.id,x.revision,x.revisions,x.founder,x.active]),[['P0001','p0001.v2',['p0001.v1','p0001.v2'],{id:'M01',name:'Founder1'},true],['P0002','p0002.v1',['p0002.v1'],{id:'M02',name:'Founder2'},true]]);
 assert.equal(JSON.stringify(listed).includes(SECRET),false);
 // Retiring holds for revisions that arrive later, until the persona is restored.
 assert.deepEqual(await mounts.retirePersona(f.owner,'P0001'),{id:'P0001',retired:true});
 await mounts.savePersonas(f.owner,{personas:[persona(1,{revision:3})]});
 assert.equal((await mounts.personas(f.owner)).personas[0].active,false);
 await mounts.retirePersona(f.owner,'P0001',{retired:false});
 assert.deepEqual((await mounts.personas(f.owner)).personas.map(x=>[x.revision,x.active]),[['p0001.v3',true],['p0002.v1',true]]);
 await assert.rejects(mounts.retirePersona(f.owner,'P0099'),{code:'not_found'});
 await assert.rejects(mounts.retirePersona(f.ctx,'P0001'),{code:'forbidden'});
 // Another organization has its own library.
 assert.deepEqual(await mounts.personas({orgId:randomUUID(),userId:'other',admin:true,workspaceIds:null}),{personas:[]});
});

test('a fixed voice: decided and frozen at the claim, the snapshot handed to the claiming device only, required on the work',async()=>{
 const f=await fixture({voice:{mode:'fixed',persona:'P0002'}});
 const demand=await f.order(),claim=await store.claim(f.ctx,{demandId:demand.id}),decision=claim.payload.voiceDecision;
 assert.deepEqual(decision,{state:'chosen',method:'fixed',persona:{id:'P0002',revision:'p0002.v1',snapshotHash:snapshot(2).snapshotHash,founder:{id:'M02',name:'Founder2'}},byline:'persona'});
 assert.deepEqual(claim.mounts,{voice:snapshot(2)});
 assert.deepEqual((await store.activeClaim(f.ctx)).mounts,{voice:snapshot(2)});
 // The demand itself keeps the decision, never the content: listing demands shows no snapshot.
 const listed=(await store.demands(f.owner,{workspaceId:'research'})).find(row=>row.id===demand.id);
 assert.deepEqual(listed.payload.voiceDecision,decision);assert.equal('mounts' in listed,false);assert.equal(JSON.stringify(listed).includes(SECRET),false);
 // A later change of the section, or a newer revision of the persona, does not reach the claim.
 await f.setVoice({mode:'fixed',persona:'P0001'});await mounts.savePersonas(f.owner,{personas:[persona(2,{revision:2})]});
 assert.equal((await store.activeClaim(f.ctx)).mounts.voice.preset.revision,'p0002.v1');
 const good=f.signed(decision);
 for(const [metadata,code] of [[{},'voice_conflict'],[{author:'Founder2',persona:{id:'M02'}},'voice_conflict'],[{...good,voice:{...good.voice,revision:'p0002.v2'}},'voice_conflict'],
  [{...good,voice:{...good.voice,id:'P0001'}},'voice_conflict'],[{...good,author:'Research desk'},'byline_conflict'],[{...good,persona:{id:'M01'}},'byline_conflict'],[{voice:good.voice},'byline_conflict']])
  await assert.rejects(store.submit(f.ctx,f.packet(claim,metadata)),{code});
 const packet=f.packet(claim,good),receipt=await store.submit(f.ctx,packet);
 assert.equal(receipt.demandState,'completed');
 const edition=await store.edition(f.ctx,packet.workId,'zh-CN',1);
 assert.deepEqual(edition.payload.metadata,good);
 // The site receives the founder's name and nothing about the preset that wrote.
 const sent=publicContent(edition.payload);
 assert.deepEqual(sent.metadata,{author:'Founder2'});assert.equal(JSON.stringify(sent).includes('P0002'),false);
});

test('a section may use a persona and still sign with the site',async()=>{
 const f=await fixture({voice:{mode:'fixed',persona:'P0001',byline:'site'}});
 const claim=await store.claim(f.ctx,{demandId:(await f.order()).id}),voice=f.signed(claim.payload.voiceDecision).voice;
 assert.equal(claim.payload.voiceDecision.byline,'site');assert.equal(claim.mounts.voice.preset.id,'P0001');
 await assert.rejects(store.submit(f.ctx,f.packet(claim,{author:'Founder1',persona:{id:'M01'},voice})),{code:'byline_conflict'});
 await assert.rejects(store.submit(f.ctx,f.packet(claim,{author:'Research desk'})),{code:'voice_conflict'});
 const packet=f.packet(claim,{author:'Research desk',voice});await store.submit(f.ctx,packet);
 assert.deepEqual(publicContent((await store.edition(f.ctx,packet.workId,'zh-CN',1)).payload).metadata,{author:'Research desk'});
});

test('choosing: the writer sees candidates without content, settles one with a reason, and only then gets the snapshot',async()=>{
 const f=await fixture({count:8,voice:{mode:'choose',range:'all',fallback:'P0008'}});
 const claim=await store.claim(f.ctx,{demandId:(await f.order()).id}),pending=claim.payload.voiceDecision;
 assert.equal(pending.state,'pending');assert.equal(pending.candidates.length,5);assert.equal(pending.fallback.id,'P0008');
 assert.equal('mounts' in claim,false);assert.equal(JSON.stringify(claim).includes(SECRET),false);
 assert.deepEqual(Object.keys(pending.candidates[0]).sort(),['founder','id','revision','snapshotHash','summary']);
 const pick=pending.candidates[1].id,other=pending.candidates[2].id,outside=['P0001','P0002','P0003','P0004','P0005','P0006','P0007','P0008'].find(id=>!pending.candidates.some(c=>c.id===id));
 const answer={demandId:claim.id,claimToken:claim.claimToken};
 await assert.rejects(mounts.chooseVoice(f.ctx,{...answer,personaId:outside,reason:'Fits.'}),{code:'voice_not_offered'});
 await assert.rejects(mounts.chooseVoice(f.ctx,{...answer,personaId:pick}),{code:'voice_reason_required'});
 await assert.rejects(mounts.chooseVoice(f.ctx,{...answer,claimToken:randomUUID(),personaId:pick,reason:'Fits.'}),{code:'claim_revoked'});
 await assert.rejects(mounts.chooseVoice(await f.device('Another'),{...answer,personaId:pick,reason:'Fits.'}),{code:'claim_revoked'});
 await assert.rejects(mounts.chooseVoice(f.owner,{...answer,personaId:pick,reason:'Fits.'}),{status:403});
 const settled=await mounts.chooseVoice(f.ctx,{...answer,personaId:pick,reason:'Explains conditions carefully.'});
 assert.deepEqual([settled.voiceDecision.state,settled.voiceDecision.method,settled.voiceDecision.persona.id,settled.voiceDecision.reason],['chosen','chosen',pick,'Explains conditions carefully.']);
 assert.equal(settled.mounts.voice.preset.id,pick);
 // Asking again reads the same answer back; another persona is refused.
 assert.deepEqual(await mounts.chooseVoice(f.ctx,{...answer,personaId:pick,reason:'Again.'}),settled);
 assert.deepEqual(await mounts.chooseVoice(f.ctx,answer),settled);
 await assert.rejects(mounts.chooseVoice(f.ctx,{...answer,personaId:other,reason:'Changed my mind.'}),{code:'voice_not_pending'});
 assert.equal((await store.activeClaim(f.ctx)).mounts.voice.preset.id,pick);
 await assert.rejects(store.submit(f.ctx,f.packet(claim,f.signed({persona:pending.candidates.find(c=>c.id===other)}))),{code:'voice_conflict'});
 assert.equal((await store.submit(f.ctx,f.packet(claim,f.signed(settled.voiceDecision)))).demandState,'completed');
});

test('a writer that never chooses gets the fallback, or no persona where the section names none',async()=>{
 const f=await fixture({count:4,voice:{mode:'choose',range:['P0001','P0002','P0003'],fallback:'P0004',byline:'site'}});
 const claim=await store.claim(f.ctx,{demandId:(await f.order()).id});
 assert.equal(claim.payload.voiceDecision.candidates.length,3);
 await assert.rejects(store.submit(f.ctx,f.packet(claim,{})),{code:'voice_conflict'});
 // Declining settles it the same way and hands over the fallback's snapshot.
 const declined=await mounts.chooseVoice(f.ctx,{demandId:claim.id,claimToken:claim.claimToken});
 assert.deepEqual([declined.voiceDecision.method,declined.voiceDecision.persona.id,declined.mounts.voice.preset.id],['fallback','P0004','P0004']);
 await store.submit(f.ctx,f.packet(claim,{voice:f.signed(declined.voiceDecision).voice}));
 await f.setVoice({mode:'choose',range:['P0001','P0002']});
 const bare=await store.claim(f.ctx,{demandId:(await f.order()).id});
 assert.equal(bare.payload.voiceDecision.fallback,null);
 await assert.rejects(store.submit(f.ctx,f.packet(bare,f.signed({persona:bare.payload.voiceDecision.candidates[0]}))),{code:'voice_conflict'});
 const packet=f.packet(bare,{author:'Research desk'});await store.submit(f.ctx,packet);
 const closed=(await store.demands(f.owner,{workspaceId:'research',state:'completed'})).find(row=>row.id===bare.id);
 assert.deepEqual(closed.payload.voiceDecision,{state:'none'},'the lapse is recorded on the demand');
});

test('an order comes before the section: it may name a persona the library has, or ask for none',async()=>{
 const f=await fixture({voice:{mode:'fixed',persona:'P0001'}});
 await assert.rejects(f.order({voice:{persona:'P0009'}}),{code:'unknown_persona'});
 await mounts.retirePersona(f.owner,'P0003');
 await assert.rejects(f.order({voice:{persona:'P0003'}}),{code:'unknown_persona'});
 const named=await store.claim(f.ctx,{demandId:(await f.order({voice:{persona:'P0002'}})).id});
 assert.deepEqual([named.payload.voiceDecision.method,named.payload.voiceDecision.persona.id,named.mounts.voice.preset.id],['named','P0002','P0002']);
 await store.submit(f.ctx,f.packet(named,f.signed(named.payload.voiceDecision)));
 const none=await store.claim(f.ctx,{demandId:(await f.order({voice:'none'})).id});
 assert.deepEqual(none.payload.voiceDecision,{state:'none'});assert.equal('mounts' in none,false);
 await assert.rejects(store.submit(f.ctx,f.packet(none,{author:'Founder1',persona:{id:'M01'}})),{code:'voice_conflict'});
 await store.submit(f.ctx,f.packet(none,{author:'Research desk'}));
 // A persona retired after the order was placed falls back, and here there is no fallback.
 const late=await f.order({voice:{persona:'P0002'}});await mounts.retirePersona(f.owner,'P0002');
 assert.deepEqual((await store.claim(f.ctx,{demandId:late.id})).payload.voiceDecision,{state:'none'});
});

test('a translation and a note rewritten from an article keep the voice of what they came from',async()=>{
 const f=await fixture({voice:{mode:'fixed',persona:'P0001'}});
 const first=await store.claim(f.ctx,{demandId:(await f.order()).id}),article=f.packet(first,f.signed(first.payload.voiceDecision));
 await store.submit(f.ctx,article);
 // The section moves on and the persona gets a newer revision, then retires.
 await f.setVoice({mode:'fixed',persona:'P0002',byline:'site'});
 await mounts.savePersonas(f.owner,{personas:[persona(1,{revision:2})]});await mounts.retirePersona(f.owner,'P0001');
 const translate=await store.createDemand(f.owner,{workspaceId:'research',sectionId:'methods',title:'Translate',kind:'translate',source:{workId:article.workId,locale:'zh-CN',revision:1},requiredLocales:['en']});
 const claim=await store.claim(f.ctx,{demandId:translate.id});
 assert.deepEqual([claim.payload.voiceDecision.method,claim.payload.voiceDecision.persona.revision,claim.payload.voiceDecision.byline,claim.mounts.voice.preset.revision],['kept','p0001.v1','persona','p0001.v1']);
 await store.submit(f.ctx,f.packet(claim,f.signed(first.payload.voiceDecision),{workId:article.workId,locale:'en',translationOf:{workId:article.workId,locale:'zh-CN',revision:1}}));
 const note=await store.claim(f.ctx,{demandId:(await f.order({workType:'note',adaptedFrom:{workId:article.workId,revision:1}})).id});
 assert.deepEqual([note.payload.voiceDecision.method,note.payload.voiceDecision.persona.id,note.payload.voiceDecision.byline],['kept','P0001','persona']);
 await assert.rejects(store.submit(f.ctx,f.packet(note,{author:'Research desk'})),{code:'voice_conflict'});
 await store.submit(f.ctx,f.packet(note,f.signed(note.payload.voiceDecision)));
 // A source that had no voice gives none, whatever the section says now.
 const plain=await fixture({count:1}),old=await store.claim(plain.ctx,{demandId:(await plain.order()).id}),work=plain.packet(old,{author:'Research desk'});
 assert.equal('voiceDecision' in old.payload,false);await store.submit(plain.ctx,work);
 await plain.setVoice({mode:'fixed',persona:'P0001'});
 const rewritten=await store.claim(plain.ctx,{demandId:(await plain.order({workType:'note',adaptedFrom:{workId:work.workId,revision:1}})).id});
 assert.deepEqual(rewritten.payload.voiceDecision,{state:'none'});
});

test('balanced gives the next work to the persona the section used least; a released claim leaves no decision behind',async()=>{
 const f=await fixture({count:2,voice:{mode:'balanced',range:'all'}}),second=await f.device('Second writer');
 const a=await store.claim(f.ctx,{demandId:(await f.order()).id}),b=await store.claim(second,{demandId:(await f.order()).id});
 assert.equal(a.payload.voiceDecision.method,'balanced');
 assert.deepEqual([a.payload.voiceDecision.persona.id,b.payload.voiceDecision.persona.id].sort(),['P0001','P0002']);
 await store.submit(f.ctx,f.packet(a,f.signed(a.payload.voiceDecision)));
 await store.submit(second,f.packet(b,f.signed(b.payload.voiceDecision)));
 const c=await store.claim(f.ctx,{demandId:(await f.order()).id});
 await store.changeDemand(f.ctx,c.id,{action:'release',claimToken:c.claimToken});
 await f.setVoice(null);
 const again=await store.claim(f.ctx,{demandId:c.id});
 assert.equal('voiceDecision' in again.payload,false);assert.equal('mounts' in again,false);
 assert.equal((await store.submit(f.ctx,f.packet(again,{author:'Research desk'}))).demandState,'completed');
});

test('the tools: a device may choose, the owner keeps the library',async()=>{
 const f=await fixture({voice:{mode:'choose',range:'all'}}),mcp=new RssdMcp(store,{});
 const device=Object.keys(mcp.definitions(f.ctx)),owner=Object.keys(mcp.definitions(f.owner));
 assert.ok(device.includes('rssd_choose_voice'));assert.ok(!device.includes('rssd_save_personas'));assert.ok(!device.includes('rssd_personas'));
 for(const name of ['rssd_personas','rssd_save_personas','rssd_retire_persona'])assert.ok(owner.includes(name),name);
 assert.ok(!owner.includes('rssd_choose_voice'));
 const claim=await store.claim(f.ctx,{demandId:(await f.order()).id}),pick=claim.payload.voiceDecision.candidates[0].id;
 const call=(ctx,name,args)=>mcp.handle(ctx,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}).then(reply=>JSON.parse(reply.result.content[0].text));
 const chosen=await call(f.ctx,'rssd_choose_voice',{demandId:claim.id,claimToken:claim.claimToken,personaId:pick,reason:'Suits the topic.'});
 assert.equal(chosen.mounts.voice.preset.id,pick);
 assert.equal((await call(f.ctx,'rssd_choose_voice',{demandId:claim.id,claimToken:claim.claimToken,personaId:'P0000',reason:'x'})).code,'voice_not_pending');
 assert.equal((await call(f.owner,'rssd_personas',{})).personas.length,3);
 const created=await call(f.ctx,'rssd_create_demand',{workspaceId:'research',sectionId:'methods',title:'Hotel scales '+randomUUID().slice(0,6),voice:'none'});
 assert.equal(created.payload.voice,'none');
});

test('a queued order may gain, change and lose its persona; a claim freezes it',async()=>{
 const {RssdCoordination}=require('./coordination.cjs'),coordination=new RssdCoordination(store);
 const f=await fixture({voice:{mode:'fixed',persona:'P0001'}}),demand=await f.order();
 const edit=(generation,changes)=>coordination.editDemand(f.owner,demand.id,{baseGeneration:generation,requestId:randomUUID(),changes});
 await assert.rejects(edit(demand.generation,{voice:{persona:'P0009'}}),{code:'unknown_persona'});
 const named=await edit(demand.generation,{voice:{persona:'P0003'}});assert.deepEqual(named.payload.voice,{persona:'P0003'});
 const cleared=await edit(named.generation,{voice:null});assert.equal('voice' in cleared.payload,false);
 const none=await edit(cleared.generation,{voice:'none'});assert.equal(none.payload.voice,'none');
 const claim=await store.claim(f.ctx,{demandId:demand.id});assert.deepEqual(claim.payload.voiceDecision,{state:'none'});
 await assert.rejects(edit(claim.generation,{voice:{persona:'P0002'}}),{code:'demand_frozen'});
});
