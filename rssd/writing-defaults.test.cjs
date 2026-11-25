'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,writeFile,readFile,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path');
const rules=require('./writing-defaults-v1.cjs');
const {WritingDefaults,publish,validateWritingDelivery}=require('./writing-defaults.cjs');
function fixture(version='fixture.1'){
 const content='Synthetic writing instructions',policy='Synthetic public/private protocol';
 const body={schemaVersion:1,version,source:{repository:'scholay-rssd/rssd',commit:'a'.repeat(40),files:[{path:'contracts/fixture.cjs',sha256:'b'.repeat(64)}]},writingPolicy:{version:'fixture',instructions:policy,sha256:rules.textHash(policy)},skills:[{id:'fixture-skill',name:'fixture-skill',version,content,contentHash:rules.textHash(content)}],references:[{path:'fixture/images.md',content,contentHash:rules.textHash(content)}],workspaces:[{workspaceId:'fixture',siteId:'fixture',name:'Synthetic fixture',sections:[{id:'section',name:'Section',mode:'design',familyId:'visual',scope:'Describe the actual fixture',requiredElements:['actual object'],skillIds:['fixture-skill'],referencePaths:['fixture/images.md'],images:{minimum:1,sourceMode:'actual-object',dataFigures:'computed-only'}}]}]};return {...body,hash:rules.hash(body)};
}
test('publishing is atomic and retains immutable catalogs; an old claim keeps its original baseline',async t=>{
 const root=await mkdtemp(join(tmpdir(),'center-writing-'));t.after(()=>rm(root,{recursive:true,force:true}));const input=join(root,'input.json'),active=join(root,'active.json'),service=new WritingDefaults({file:active});
 await assert.rejects(service.catalog(),e=>e.status===503);
 await writeFile(input,JSON.stringify(fixture()));const first=await publish(input,active);assert.equal((await service.catalog()).hash,first.catalogHash);
 const demand={workspaceId:'fixture',sectionId:'section',kind:'write',generation:0,payload:{}};const baseline=await service.freeze(demand);
 await writeFile(input,JSON.stringify(fixture('fixture.2')));await publish(input,active);
 assert.notEqual((await service.freeze(demand)).hash,baseline.hash);
 assert.equal((await service.freeze({...demand,generation:1,payload:{writingDefaults:baseline}})).hash,baseline.hash);
 // Claimed before rules existed, then released or expired with nothing delivered: the next claim freezes the current rules.
 assert.equal((await service.freeze({...demand,generation:1})).hash,(await service.freeze(demand)).hash);
 // Part of the demand was delivered without rules; finishing it keeps that contract. Continuations never freeze.
 assert.equal(await service.freeze({...demand,generation:1,payload:{submittedLocales:['zh-CN'],workId:'work-1'}}),null);
 assert.equal(await service.freeze({...demand,kind:'translate'}),null);
 assert.equal(JSON.parse(await readFile(join(root,first.catalogHash+'.json'))).hash,first.catalogHash);
 await assert.rejects(service.resolve('fixture','retired'),e=>e.status===404);
});
test('a new writing delivery needs its actual baseline and a captioned image in the public body',()=>{
 const b=rules.resolve(fixture(),'fixture','section'),ref={baselineHash:b.hash,catalogHash:b.catalogHash,sourceCommit:b.source.commit};
 const edition={bodyMarkdown:'Synthetic text',metadata:{writingDefaults:ref,notebook:{blocks:[]}}};
 assert.throws(()=>validateWritingDelivery(edition,b),e=>e.code==='writing_delivery_incomplete');
 edition.metadata.notebook.blocks=[{id:'image',type:'image',state:'ready',text:'https://example.org/fixture.png',alt:'Synthetic fixture image'},{type:'annotation',role:'caption',targetId:'image',state:'ready',text:'Synthetic image attribution'}];
 assert.throws(()=>validateWritingDelivery(edition,b),/absent/);
 edition.bodyMarkdown+='\n![Synthetic](https://example.org/fixture.png)';assert.doesNotThrow(()=>validateWritingDelivery(edition,b));
 edition.metadata.writingDefaults.baselineHash='c'.repeat(64);assert.throws(()=>validateWritingDelivery(edition,b),e=>e.status===409);
});
module.exports={fixture};
test('new baseline checks alt bounds and explicit body budgets while notes cannot substitute for body',()=>{
 const c=fixture('fixture.3'),s=c.workspaces[0].sections[0];s.delivery={version:1,format:'notebook-v2-flat',altLength:true};s.images.altMin=20;s.images.altMax=60;delete c.hash;c.hash=rules.hash(c);
 const b=rules.resolve(c,'fixture','section'),image={id:'image',type:'image',state:'ready',text:'https://example.org/fixture.png',alt:'白底展示两枚真实图标及空心与实心轮廓的对照关系'};
 const n={blocks:[{id:'body',type:'paragraph',state:'ready',text:'甲乙丙丁戊己庚辛壬癸'},image,{type:'annotation',role:'caption',targetId:'image',state:'ready',text:'Synthetic attribution'}],internalNotes:{verification:'备'.repeat(1000)}};
 const ref={baselineHash:b.hash,catalogHash:b.catalogHash,sourceCommit:b.source.commit,bodyLengthAdjustment:{unit:'han',minimum:9,target:10,maximum:11}};
 const edition={bodyMarkdown:'![Fixture]('+image.text+')',metadata:{writingDefaults:ref,notebook:n}};
 assert.doesNotThrow(()=>validateWritingDelivery(edition,b));
 image.alt='𠀀'.repeat(61);assert.throws(()=>validateWritingDelivery(edition,b),/当前 61/);
 image.alt='𠀀'.repeat(20);n.blocks[0].text='甲';assert.throws(()=>validateWritingDelivery(edition,b),/当前 1/);
 ref.bodyLengthAdjustment.minimum=20;assert.throws(()=>validateWritingDelivery(edition,b),e=>e.code==='writing_defaults_conflict');
});
test('a section that takes notes freezes its note form with the claim',async t=>{
 const root=await mkdtemp(join(tmpdir(),'center-writing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {hash,...body}=fixture('fixture.note');body.workspaces[0].sections[0].note={skillIds:['fixture-skill'],requiredElements:['one point']};
 const input=join(root,'input.json'),active=join(root,'active.json'),service=new WritingDefaults({file:active});
 await writeFile(input,JSON.stringify({...body,hash:rules.hash(body)}));await publish(input,active);
 const baseline=await service.freeze({workspaceId:'fixture',sectionId:'section',kind:'write',generation:0,payload:{workType:'note'}});
 assert.deepEqual(baseline.note.requiredElements,['one point']);assert.match(baseline.note.instructions,/作品类型：笔记/);
 assert.equal(rules.compose(baseline,{workType:'note'}).workType,'note');
 assert.equal(rules.compose(baseline).instructions.includes('作品类型：笔记'),false);
});
test('a section that offers another writing family freezes it with the claim, and delivery follows the chosen family',async t=>{
 const root=await mkdtemp(join(tmpdir(),'center-writing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {hash,...body}=fixture('fixture.family'),section=body.workspaces[0].sections[0];
 section.delivery={version:2,format:'notebook-v2-flat',altLength:true,captions:true};Object.assign(section.images,{altMin:1,altMax:200});
 section.alternates=[{familyId:'walkthrough',skillIds:['fixture-skill'],requiredElements:['actual object','interface steps'],images:{minimum:1,sourceMode:'source-or-illustration',dataFigures:'computed-only',altMin:1,altMax:200}}];
 const input=join(root,'input.json'),active=join(root,'active.json'),service=new WritingDefaults({file:active});
 await writeFile(input,JSON.stringify({...body,hash:rules.hash(body)}));await publish(input,active);
 const b=await service.freeze({workspaceId:'fixture',sectionId:'section',kind:'write',generation:0,payload:{}});
 assert.deepEqual(b.alternates.map(a=>a.familyId),['walkthrough']);assert.match(b.alternates[0].instructions,/文体：walkthrough/);
 // A demonstration caption names no maker or source: refused in the default actual-object form, accepted in the chosen one.
 const image={id:'image',type:'image',state:'ready',text:'https://example.org/fixture.png',alt:'Synthetic fixture image'};
 const ref={baselineHash:b.hash,catalogHash:b.catalogHash,sourceCommit:b.source.commit,adjustmentOrigin:'task'};
 const edition={bodyMarkdown:'![Fixture](https://example.org/fixture.png)',metadata:{writingDefaults:ref,notebook:{blocks:[image,{type:'annotation',role:'caption',targetId:'image',state:'ready',text:'图：界面演示：第一轮回答。'}]}}};
 assert.throws(()=>validateWritingDelivery(edition,b),e=>e.code==='writing_delivery_incomplete');
 ref.familyAdjustment='walkthrough';assert.doesNotThrow(()=>validateWritingDelivery(edition,b));
 ref.familyAdjustment='unknown';assert.throws(()=>validateWritingDelivery(edition,b),e=>e.code==='writing_defaults_conflict');
});
