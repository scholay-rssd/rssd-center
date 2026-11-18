'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path');
const {createHash}=require('node:crypto');
const {PluginReleases,publish,descriptor,compareVersions}=require('./obsidian-plugin-releases.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// The Center checks a release's shape and files; vaults check its signature. A well-formed placeholder is enough here.
async function fixture(root,version,code='module.exports=class{};'){
 const dir=join(root,'in-'+version+'-'+hash(code).slice(0,6));await mkdir(dir,{recursive:true});
 const main=Buffer.from(code),manifest=Buffer.from(JSON.stringify({id:'rssd',name:'RSSD',version,minAppVersion:'1.11.4'}));
 await writeFile(join(dir,'main.js'),main);await writeFile(join(dir,'manifest.json'),manifest);
 const release={format:1,id:'rssd',version,minAppVersion:'1.11.4',commit:'c'.repeat(40),publishedAt:'2026-11-19T00:00:00.000Z',
  files:[{name:'manifest.json',sha256:hash(manifest),size:manifest.length},{name:'main.js',sha256:hash(main),size:main.length}],signature:'A'.repeat(86)+'=='};
 await writeFile(join(dir,'release.json'),JSON.stringify(release));return {dir,release,main};
}
test('versions compare numerically',()=>{
 assert.equal(compareVersions('0.2.10','0.2.9'),1);assert.equal(compareVersions('0.2.0','0.10.0'),-1);assert.equal(compareVersions('1.0.0','1.0.0'),0);
});
test('a release has exactly the expected shape',()=>{
 const good={format:1,id:'rssd',version:'0.2.1',minAppVersion:'1.11.4',commit:'c'.repeat(40),publishedAt:'2026-11-19T00:00:00.000Z',
  files:[{name:'main.js',sha256:'a'.repeat(64),size:1},{name:'manifest.json',sha256:'b'.repeat(64),size:1}],signature:'A'.repeat(86)+'=='};
 assert.equal(descriptor(good).files[0].name,'main.js');
 for(const bad of [{...good,extra:1},{...good,id:'other'},{...good,version:'0.2'},{...good,version:'01.2.3'},{...good,signature:'short'},{...good,commit:'c'},
  {...good,files:[good.files[0]]},{...good,files:[good.files[0],{...good.files[1],name:'styles.css'}]},{...good,files:[good.files[0],{...good.files[1],size:0}]}])
  assert.throws(()=>descriptor(bad),e=>e.code==='plugin_release_invalid');
});
test('publishing keeps files by hash, never lowers or reuses a version, and repeats safely',async t=>{
 const root=await mkdtemp(join(tmpdir(),'center-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'releases'),service=new PluginReleases({directory:target});
 await assert.rejects(service.latest(),e=>e.status===404&&e.code==='plugin_release_unavailable');
 const first=await fixture(root,'0.2.1');
 assert.equal((await publish(first.dir,target)).version,'0.2.1');
 assert.equal((await service.latest()).version,'0.2.1');
 assert.deepEqual(await service.file(hash(first.main)),first.main);
 assert.deepEqual(await publish(first.dir,target),{version:'0.2.1',unchanged:true});
 await assert.rejects(publish((await fixture(root,'0.2.1','other code')).dir,target),e=>e.status===409);
 await assert.rejects(publish((await fixture(root,'0.2.0','older code')).dir,target),e=>e.status===409);
 const second=await fixture(root,'0.2.2','newer code');await publish(second.dir,target);
 assert.equal((await service.latest()).version,'0.2.2');
 // The older release's files and record stay, so a vault can still roll back to them.
 assert.deepEqual(await service.file(hash(first.main)),first.main);
 assert.equal(JSON.parse(await readFile(join(target,'releases','0.2.1.json'))).version,'0.2.1');
});
test('a release whose files or manifest disagree with it is refused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'center-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'releases'),changed=await fixture(root,'0.3.0');await writeFile(join(changed.dir,'main.js'),'changed after signing');
 await assert.rejects(publish(changed.dir,target),/main\.js does not match/);
 const wrong=await fixture(root,'0.3.1');const manifest=Buffer.from(JSON.stringify({id:'rssd',version:'9.9.9',minAppVersion:'1.11.4'}));
 await writeFile(join(wrong.dir,'manifest.json'),manifest);
 await writeFile(join(wrong.dir,'release.json'),JSON.stringify({...wrong.release,files:[{name:'manifest.json',sha256:hash(manifest),size:manifest.length},wrong.release.files[1]]}));
 await assert.rejects(publish(wrong.dir,target),/manifest\.json does not match/);
 await assert.rejects(new PluginReleases({directory:target}).latest(),e=>e.status===404);
});
test('only stored, undamaged files are served',async t=>{
 const root=await mkdtemp(join(tmpdir(),'center-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'releases'),service=new PluginReleases({directory:target}),first=await fixture(root,'0.2.1');await publish(first.dir,target);
 for(const name of ['../latest.json','A'.repeat(64),'a'.repeat(63)])await assert.rejects(service.file(name),e=>e.status===404);
 await assert.rejects(service.file('d'.repeat(64)),e=>e.status===404);
 await writeFile(join(target,'files',hash(first.main)),'tampered');
 await assert.rejects(service.file(hash(first.main)),e=>e.status===503);
 await writeFile(join(target,'latest.json'),'{"not":"a release"}');
 await assert.rejects(service.latest(),e=>e.status===503);
});
module.exports={fixture};
