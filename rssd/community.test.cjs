const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHmac}=require('node:crypto');
const {RssdCommunity}=require('./community.cjs');
const source='https://metho.scholay.com/news/example/',secret='synthetic-community-webhook-secret';
const post=(url=source)=>({topic_id:415123,post_number:1,username:'fixture-author',cooked:'<small>original topic <a href="'+url+'">source</a></small>'});
function event(value,id='original-event',type='post_created'){
 const raw=Buffer.from(JSON.stringify(value));return {raw,headers:{'x-discourse-event-signature':'sha256='+createHmac('sha256',secret).update(raw).digest('hex'),'x-discourse-event-id':id,'x-discourse-event':type,'x-discourse-instance':'https://enterscholar.com'}};
}
async function fixture(t,{lookupPost}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rssd-community-'));let service;t.after(async()=>{await service?.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(root,'links.sqlite'),'');await fs.writeFile(path.join(root,'secret'),secret,{mode:0o600});
 await fs.writeFile(path.join(root,'config.json'),JSON.stringify({mode:'all',authors:['fixture-author'],sites:[{id:'metho',origin:'https://metho.scholay.com',webRoot:path.join(root,'no-static-site-here')}]}));
 const configFile=path.join(root,'center.json');await fs.writeFile(configFile,JSON.stringify({orgId:'fixture-org',root,secretFile:path.join(root,'secret')}),{mode:0o600});
 const published=[source],queries=[];const store={db:{$queryRawUnsafe:async(sql,org)=>{assert.equal(org,'fixture-org');assert.match(sql,/rssd_publications/);queries.push(sql);return published.map(url=>({url}));}}};
 service=new RssdCommunity(store,{configFile,lookupPost});return {root,service,published,queries};
}
test('signed forum events preserve mapping and dedupe while using center publication identities',async t=>{
 const {service,queries}=await fixture(t),e=event({post:post()});
 assert.equal((await service.accept(e.raw,{...e.headers,'x-discourse-event-signature':'sha256='+'0'.repeat(64)})).statusCode,401);assert.equal(queries.length,0);
 assert.equal((await service.accept(e.raw,e.headers)).body.status,'linked');assert.equal((await service.accept(e.raw,e.headers)).body.status,'duplicate');
 assert.deepEqual(await service.publicLinks('metho'),{version:1,links:{'/news/example/':'https://enterscholar.com/t/-/415123'}});
 const removed=event({post:post()},'delete-event','post_destroyed');assert.equal((await service.accept(removed.raw,removed.headers)).body.status,'removed');assert.deepEqual((await service.publicLinks('metho')).links,{});
 const restored=event({post:post()},'restore-event','post_recovered');assert.equal((await service.accept(restored.raw,restored.headers)).body.status,'linked');
 await assert.rejects(service.status({orgId:'other-org',admin:true}),{status:403});await assert.rejects(service.publicLinks('not-configured'),{status:404});
});
test('unavailable sources keep webhook retry eligibility and topic-only recovery resolves the public first post',async t=>{
 const other='https://metho.scholay.com/news/new/',f=await fixture(t,{lookupPost:async()=>post(other)});
 const e=event({post:post(other)});assert.equal((await f.service.accept(e.raw,e.headers)).statusCode,503);
 assert.equal((await f.service.status({orgId:'fixture-org',admin:true})).events,0);
 const topic=event({topic:{id:415123,archetype:'regular',created_by:{username:'fixture-author'}}},'topic-event','topic_created');
 assert.equal((await f.service.accept(topic.raw,topic.headers)).statusCode,503);assert.equal((await f.service.status({orgId:'fixture-org',admin:true})).events,0);
 f.published.push(other);assert.equal((await f.service.accept(topic.raw,topic.headers)).body.status,'linked');
 assert.equal((await f.service.publicLinks('metho')).links['/news/new/'],'https://enterscholar.com/t/-/415123');
});
