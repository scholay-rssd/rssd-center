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
 assert.equal(await service.freeze({...demand,generation:1}),null);
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
