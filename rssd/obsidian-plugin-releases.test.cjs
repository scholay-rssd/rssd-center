'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,readdir,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path');
const {createHash,generateKeyPairSync,sign}=require('node:crypto');
const {PluginReleases,publish,descriptor,signedText,compareVersions}=require('./obsidian-plugin-releases.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function keyPair(){
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 return {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),privateKey};
}
// Signed the way the plugin's release command signs: Node crypto, IEEE P1363.
async function fixture(root,version,{keys,code='module.exports=class{};'}={}){
 const dir=join(root,'in-'+version+'-'+hash(code+keys.publicKey).slice(0,8));await mkdir(dir,{recursive:true});
 const main=Buffer.from(code),manifest=Buffer.from(JSON.stringify({id:'rssd',name:'RSSD',version,minAppVersion:'1.11.4'}));
 await writeFile(join(dir,'main.js'),main);await writeFile(join(dir,'manifest.json'),manifest);
 const release={format:1,id:'rssd',version,minAppVersion:'1.11.4',commit:'c'.repeat(40),coreCommit:'d'.repeat(40),publishedAt:'2026-11-19T00:00:00.000Z',
  files:[{name:'main.js',sha256:hash(main),size:main.length},{name:'manifest.json',sha256:hash(manifest),size:manifest.length}],signature:'A'.repeat(86)+'=='};
 release.signature=sign('sha256',Buffer.from(signedText(release)),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 await writeFile(join(dir,'release.json'),JSON.stringify(release));
 const keyFile=join(root,'key-'+hash(keys.publicKey).slice(0,6)+'.pub');await writeFile(keyFile,keys.publicKey+'\n');
 return {dir,release,main,keyFile};
}
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'center-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,target:join(root,'releases'),keys:keyPair()};
}
test('versions compare numerically',()=>{
 assert.equal(compareVersions('0.2.10','0.2.9'),1);assert.equal(compareVersions('0.2.0','0.10.0'),-1);assert.equal(compareVersions('1.0.0','1.0.0'),0);
});
test('a release has exactly the expected shape',()=>{
 const good={format:1,id:'rssd',version:'0.2.1',minAppVersion:'1.11.4',commit:'c'.repeat(40),coreCommit:'d'.repeat(40),publishedAt:'2026-11-19T00:00:00.000Z',
  files:[{name:'main.js',sha256:'a'.repeat(64),size:1},{name:'manifest.json',sha256:'b'.repeat(64),size:1}],signature:'A'.repeat(86)+'=='};
 assert.equal(descriptor(good).files[0].name,'main.js');
 assert.equal(signedText(good),JSON.stringify((({signature,...rest})=>rest)(good)));
 for(const bad of [{...good,extra:1},{...good,id:'other'},{...good,version:'0.2'},{...good,version:'01.2.3'},{...good,signature:'short'},{...good,commit:'c'},{...good,coreCommit:undefined},
  {...good,files:[good.files[0]]},{...good,files:[good.files[0],{...good.files[1],name:'styles.css'}]},{...good,files:[good.files[0],{...good.files[1],size:0}]}])
  assert.throws(()=>descriptor(bad),e=>e.code==='plugin_release_invalid');
});
test('the first publish pins its key, and only releases signed with that key are published',async t=>{
 const {root,target,keys}=await setup(t),other=keyPair(),first=await fixture(root,'0.2.1',{keys});
 await assert.rejects(publish(first.dir,target),e=>e.code==='plugin_release_key');
 const forged=await fixture(root,'0.2.1',{keys:other});
 await assert.rejects(publish(forged.dir,target,{keyFile:first.keyFile}),e=>e.code==='plugin_release_key');
 await assert.rejects(readFile(join(target,'release-key.pub')),e=>e.code==='ENOENT');
 assert.equal((await publish(first.dir,target,{keyFile:first.keyFile})).version,'0.2.1');
 assert.equal((await readFile(join(target,'release-key.pub'),'utf8')).trim(),keys.publicKey);
 await assert.rejects(publish((await fixture(root,'0.2.2',{keys:other})).dir,target),e=>e.code==='plugin_release_key');
 await assert.rejects(publish((await fixture(root,'0.2.2',{keys})).dir,target,{keyFile:forged.keyFile}),e=>e.code==='plugin_release_key');
});
test('publishing never lowers or reuses a version, repeats safely and keeps only the newest files',async t=>{
 const {root,target,keys}=await setup(t),service=new PluginReleases({directory:target});
 await assert.rejects(service.latest(),e=>e.status===404&&e.code==='plugin_release_unavailable');
 const first=await fixture(root,'0.2.1',{keys});await publish(first.dir,target,{keyFile:first.keyFile});
 assert.equal((await service.latest()).version,'0.2.1');
 assert.deepEqual((await service.raw(hash(first.main))).body,first.main);
 assert.deepEqual(await publish(first.dir,target),{version:'0.2.1',unchanged:true});
 await assert.rejects(publish((await fixture(root,'0.2.1',{keys,code:'other code'})).dir,target),e=>e.code==='plugin_release_order');
 await assert.rejects(publish((await fixture(root,'0.2.0',{keys,code:'older code'})).dir,target),e=>e.code==='plugin_release_order');
 const later=[];
 for(const v of ['0.2.2','0.2.3','0.2.4']){const r=await fixture(root,v,{keys,code:'code '+v});await publish(r.dir,target);later.push(r);}
 assert.equal((await service.latest()).version,'0.2.4');
 // Every release stays on record; only the newest three keep their files.
 assert.deepEqual((await readdir(join(target,'releases'))).sort(),['0.2.1.json','0.2.2.json','0.2.3.json','0.2.4.json']);
 await assert.rejects(service.raw(hash(first.main)),e=>e.status===404);
 for(const r of later)assert.deepEqual((await service.raw(hash(r.main))).body,r.main);
 // An older archived release can't come back as the latest.
 await assert.rejects(publish(later[0].dir,target),e=>e.code==='plugin_release_order');
});
test('a release whose files or manifest disagree with it is refused, and a busy or damaged store is handled',async t=>{
 const {root,target,keys}=await setup(t);
 const changed=await fixture(root,'0.3.0',{keys});await writeFile(join(changed.dir,'main.js'),'changed after signing');
 await assert.rejects(publish(changed.dir,target,{keyFile:changed.keyFile}),/main\.js does not match/);
 const good=await fixture(root,'0.3.1',{keys});
 await mkdir(target,{recursive:true});await writeFile(join(target,'.publish.lock'),'1');
 await assert.rejects(publish(good.dir,target,{keyFile:good.keyFile}),e=>e.code==='plugin_release_busy');
 await rm(join(target,'.publish.lock'));
 // A file left truncated by an interrupted write is replaced on the next publish of that content.
 await mkdir(join(target,'files'),{recursive:true});await writeFile(join(target,'files',hash(good.main)),'trunc');
 await publish(good.dir,target,{keyFile:good.keyFile});
 assert.deepEqual(await readFile(join(target,'files',hash(good.main))),good.main);
});
test('files are served by hash with caching headers, and errors never reveal paths',async t=>{
 const {root,target,keys}=await setup(t),service=new PluginReleases({directory:target}),first=await fixture(root,'0.2.1',{keys});
 await publish(first.dir,target,{keyFile:first.keyFile});
 const found=await service.raw(hash(first.main));
 assert.equal(found.status,200);assert.equal(found.headers.ETag,'"'+hash(first.main)+'"');assert.equal(found.headers['X-Content-Type-Options'],'nosniff');
 assert.equal((await service.raw(hash(first.main),'"'+hash(first.main)+'"')).status,304);
 for(const name of ['../latest.json','A'.repeat(64),'a'.repeat(63),'d'.repeat(64)])await assert.rejects(service.raw(name),e=>e.status===404);
 await writeFile(join(target,'files',hash(first.main)),'tampered');
 await assert.rejects(service.raw(hash(first.main)),e=>e.status===503&&!e.message.includes('/'));
 await writeFile(join(target,'latest.json'),'{"not":"a release"}');
 await assert.rejects(service.latest(),e=>e.status===503&&!e.message.includes('/'));
});
module.exports={fixture,keyPair};
