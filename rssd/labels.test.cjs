const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {RssdLabels}=require('./labels.cjs');
test('pinned label sources match their independent public revision manifest',async()=>{
 const directory=path.join(__dirname,'legacy-labels'),source=JSON.parse(await fs.readFile(path.join(directory,'SOURCE.json')));
 for(const [file,hash] of Object.entries(source.files))assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(directory,path.basename(file)))).digest('hex'),hash);
});
test('center labels reads retain prior spend and uncertain reservations without contacting providers',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rssd-labels-'));let service;t.after(async()=>{service?.close();await fs.rm(directory,{recursive:true,force:true});});
 const {openLabelsStore,seedLabelSpend,reserveLabelRequest,uncertainLabelRequest,labelBudget}=await import('./legacy-labels/labels-store.mjs');
 const database=path.join(directory,'labels.sqlite'),db=openLabelsStore(database),now=Date.parse('2026-11-01T04:00:00Z');
 seedLabelSpend(db,{id:'prior-spend',month:'2026-11',costMicros:43000});
 const endpoint={id:'fixture-endpoint',platformId:'bilibili',maxCostMicros:1000,intervalMs:14400000,boardLabel:'Fixture'};
 const request=reserveLabelRequest(db,endpoint,now);uncertainLabelRequest(db,request.request.id,now);const before=labelBudget(db,now);db.close();
 const configFile=path.join(directory,'labels.json');await fs.writeFile(configFile,JSON.stringify({orgId:'fixture-org',database,collectionEnabled:false}),{mode:0o600});
 service=new RssdLabels({configFile,now:()=>now});
 await assert.rejects(service.feed({orgId:'other-org',admin:true}),{status:403});
 const originalFetch=global.fetch;global.fetch=async()=>{throw Error('Cache read attempted a network request');};t.after(()=>{global.fetch=originalFetch;});
 const result=await service.feed({orgId:'fixture-org',workerId:'fixture-device'});assert.deepEqual(result.budget,before);assert.equal(result.budget.spentMicros,43000);assert.equal(result.budget.reservedMicros,1000);
 assert(!JSON.stringify(result).includes(database));assert.equal(result.schemaVersion,1);
 for(let i=1;i<90;i++)await service.feed({orgId:'fixture-org',workerId:'fixture-device'});
 await assert.rejects(service.feed({orgId:'fixture-org',workerId:'fixture-device'}),{status:429});
});
