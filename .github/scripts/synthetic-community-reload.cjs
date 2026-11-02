'use strict';
// Synthetic data only; no Center connection and no external forum requests.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHmac}=require('node:crypto');
const {RssdCommunity}=require('/app/rssd/community.cjs');
const secretA='synthetic-community-secret-original',secretB='synthetic-community-secret-replaced';
const source='https://metho.scholay.com/news/synthetic-canary/';
function event(id,secret){
 const raw=Buffer.from(JSON.stringify({post:{topic_id:410001,post_number:1,username:'synthetic-author',cooked:'<small>original topic <a href="'+source+'">source</a></small>'}}));
 return {raw,headers:{'x-discourse-event-signature':'sha256='+createHmac('sha256',secret).update(raw).digest('hex'),'x-discourse-event-id':id,'x-discourse-event':'post_created','x-discourse-instance':'https://enterscholar.com'}};
}
async function main(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rssd-synthetic-community-'));let service;
 try{
  const configPath=path.join(root,'config.json'),secretPath=path.join(root,'secret'),outerPath=path.join(root,'center.json');
  const config=mode=>({mode,authors:['synthetic-author'],sites:[{id:'metho',origin:'https://metho.scholay.com',webRoot:path.join(root,'site')}]});
  await fs.writeFile(path.join(root,'links.sqlite'),'');await fs.writeFile(secretPath,secretA,{mode:0o600});
  await fs.writeFile(configPath,JSON.stringify(config('all')));
  await fs.writeFile(outerPath,JSON.stringify({orgId:'synthetic-org',root,secretFile:secretPath}),{mode:0o600});
  const store={db:{$queryRawUnsafe:async()=>[{url:source}]}};
  service=new RssdCommunity(store,{configFile:outerPath});
  let e=event('one',secretA);assert.equal((await service.accept(e.raw,e.headers)).body.status,'linked');
  const replacement=configPath+'.next';await fs.writeFile(replacement,JSON.stringify(config('off')));await fs.rename(replacement,configPath);
  const future=new Date(Date.now()+3000);await fs.utimes(configPath,future,future);
  e=event('two',secretA);assert.equal((await service.accept(e.raw,e.headers)).body.status,'ignored');
  await fs.writeFile(secretPath,secretB,{mode:0o600});
  e=event('three',secretB);assert.equal((await service.accept(e.raw,e.headers)).statusCode,401);
  await service.close();service=new RssdCommunity(store,{configFile:outerPath});
  e=event('four',secretB);assert.equal((await service.accept(e.raw,e.headers)).body.status,'ignored');
  await fs.writeFile(replacement,JSON.stringify(config('all')));await fs.rename(replacement,configPath);
  const later=new Date(Date.now()+6000);await fs.utimes(configPath,later,later);
  e=event('five',secretB);assert.equal((await service.accept(e.raw,e.headers)).body.status,'unchanged');
  console.log('PASS synthetic inner config hot reload, restart and outer secret caching');
 }finally{if(service)await service.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
