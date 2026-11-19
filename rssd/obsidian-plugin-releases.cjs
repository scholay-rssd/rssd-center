'use strict';
// Signed releases of the RSSD Obsidian plugin, published here so every vault on every device can update itself.
// The Center stores and serves them. A vault installs a release only when its signature verifies against the
// key compiled into the plugin it already runs, so this server cannot make a vault run other code. Publishing
// also checks the signature, against the key pinned at the first publish, so a wrongly signed release never
// becomes the latest.
const {readFile,writeFile,mkdir,rename,rm,readdir}=require('node:fs/promises');
const {join}=require('node:path');
const {createHash,randomUUID,verify}=require('node:crypto');
const {ProtocolError}=require('./protocol.cjs');
const FILES=['main.js','manifest.json'],MAX_DESCRIPTOR=65536,MAX_FILE=16*1024*1024,KEEP_RELEASES=3;
const HEX=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/,VERSION=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const KEY=/^[A-Za-z0-9+/]{40,200}={0,2}$/;
const fail=(message,status=400,code='plugin_release_invalid')=>{throw new ProtocolError(message,status,code);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function compareVersions(a,b){
 const x=a.split('.').map(Number),y=b.split('.').map(Number);
 for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;
 return 0;
}
/** A release exactly as served: these fields only, in this order, files in name order. Throws on anything else. */
function descriptor(value){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('A release must be an object');
 if(Object.keys(value).some(key=>!['format','id','version','minAppVersion','commit','coreCommit','publishedAt','files','signature'].includes(key)))fail('The release has unknown fields');
 if(value.format!==1||value.id!=='rssd')fail('This is not an RSSD plugin release');
 if(!VERSION.test(value.version||'')||!VERSION.test(value.minAppVersion||''))fail('The release version is invalid');
 if(!COMMIT.test(value.commit||'')||!COMMIT.test(value.coreCommit||''))fail('The release commits are invalid');
 if(typeof value.publishedAt!=='string'||!Number.isFinite(Date.parse(value.publishedAt)))fail('The release time is invalid');
 if(!Array.isArray(value.files)||value.files.length!==FILES.length)fail('The release files are invalid');
 const files=[...value.files].sort((a,b)=>String(a?.name)<String(b?.name)?-1:1);
 files.forEach((file,i)=>{
  if(!file||typeof file!=='object'||Object.keys(file).sort().join()!=='name,sha256,size'||file.name!==FILES[i]||!HEX.test(file.sha256||'')||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE)fail('A release file is invalid');
 });
 // ECDSA P-256 in IEEE P1363 form: 64 bytes, base64.
 if(typeof value.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(value.signature))fail('The release signature is invalid');
 return {format:1,id:'rssd',version:value.version,minAppVersion:value.minAppVersion,commit:value.commit,coreCommit:value.coreCommit,publishedAt:value.publishedAt,
  files:files.map(file=>({name:file.name,sha256:file.sha256,size:file.size})),signature:value.signature};
}
/** The text the signature covers: the release without its signature, as the plugin builds it. */
function signedText(release){const {signature,...signed}=descriptor(release);return JSON.stringify(signed);}
function signedBy(release,publicKey){
 try{return verify('sha256',Buffer.from(signedText(release)),{key:Buffer.from(publicKey,'base64'),format:'der',type:'spki',dsaEncoding:'ieee-p1363'},Buffer.from(release.signature,'base64'));}
 catch{return false;}
}

class PluginReleases {
 constructor({directory=process.env.RSSD_PLUGIN_RELEASES_DIR||'/config/rssd-obsidian-plugin'}={}){this.directory=directory;}
 async latest(){
  let bytes;
  try{bytes=await readFile(join(this.directory,'latest.json'));}
  catch(e){if(e.code==='ENOENT')fail('No plugin release is published',404,'plugin_release_unavailable');fail('The plugin release is unavailable',503,'plugin_release_unavailable');}
  try{if(bytes.length>MAX_DESCRIPTOR)throw Error('size');return descriptor(JSON.parse(bytes));}
  catch{fail('The plugin release is unavailable',503,'plugin_release_unavailable');}
 }
 // A file is named by its hash, so its bytes never change and a reader may keep them.
 async raw(hash,ifNoneMatch){
  if(!HEX.test(hash||''))fail('Release file not found',404,'plugin_release_file');
  const etag='"'+hash+'"',headers={'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=31536000, immutable',ETag:etag,'X-Content-Type-Options':'nosniff'};
  if(String(ifNoneMatch||'').split(',').map(tag=>tag.trim().replace(/^W\//,'')).some(tag=>tag===etag||tag==='*'))return {status:304,headers};
  let bytes;
  try{bytes=await readFile(join(this.directory,'files',hash));}
  catch(e){if(e.code==='ENOENT')fail('Release file not found',404,'plugin_release_file');fail('The release file is unavailable',503,'plugin_release_file');}
  if(bytes.length>MAX_FILE||sha256(bytes)!==hash)fail('The release file is unavailable',503,'plugin_release_file');
  return {status:200,headers:{...headers,'Content-Length':String(bytes.length)},body:bytes};
 }
}

async function writeAtomically(path,bytes){
 const temporary=path+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,bytes,{flag:'wx',mode:0o644});await rename(temporary,path);}
 finally{await rm(temporary,{force:true});}
}
async function archivedVersions(target){
 const names=await readdir(join(target,'releases')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 return names.map(name=>name.slice(0,-5)).filter(name=>VERSION.test(name)).sort(compareVersions);
}
async function pinnedKey(target,keyFile){
 const pinned=await readFile(join(target,'release-key.pub'),'utf8').then(text=>text.trim(),e=>{if(e.code==='ENOENT')return null;throw e;});
 const offered=keyFile?(await readFile(keyFile,'utf8')).trim():null;
 if(offered!==null&&!KEY.test(offered))fail('The offered release key is not a base64 public key');
 if(pinned&&offered!==null&&offered!==pinned)fail('The offered release key differs from the pinned one; vaults only trust the pinned key',409,'plugin_release_key');
 if(pinned)return {key:pinned,pin:false};
 if(offered===null)fail('No release key is pinned yet; pass --key <release-key.pub> on the first publish',409,'plugin_release_key');
 return {key:offered,pin:true};
}

/**
 * Publish one release from a folder holding release.json and the files it names. The signature must verify
 * against the pinned key. Files are kept by hash; a version is never lowered or reused, counting every archived
 * release; publishing the same release again changes nothing; latest.json is replaced atomically. Only the
 * newest few releases keep their files, which bounds what backups of /config carry.
 */
async function publish(source,target,{keyFile=null}={}){
 const raw=await readFile(join(source,'release.json'));if(raw.length>MAX_DESCRIPTOR)fail('The release is too large');
 const release=descriptor(JSON.parse(raw)),blobs=new Map();
 for(const file of release.files){
  const bytes=await readFile(join(source,file.name));
  if(bytes.length!==file.size||sha256(bytes)!==file.sha256)fail(file.name+' does not match the release');
  blobs.set(file.name,bytes);
 }
 let manifest;try{manifest=JSON.parse(blobs.get('manifest.json'));}catch{fail('manifest.json is not JSON');}
 if(manifest?.id!=='rssd'||manifest.version!==release.version||manifest.minAppVersion!==release.minAppVersion)fail('manifest.json does not match the release');
 await mkdir(join(target,'files'),{recursive:true,mode:0o755});await mkdir(join(target,'releases'),{recursive:true,mode:0o755});
 // One publish at a time: two at once could otherwise leave the lower version as the latest.
 const lock=join(target,'.publish.lock');
 try{await writeFile(lock,String(process.pid),{flag:'wx',mode:0o644});}
 catch(e){if(e.code==='EEXIST')fail('Another publish is running (or one was interrupted: remove '+lock+')',409,'plugin_release_busy');throw e;}
 try{
  const trusted=await pinnedKey(target,keyFile);
  if(!signedBy(release,trusted.key))fail('The release is not signed with the pinned release key',409,'plugin_release_key');
  // The first release pins the key it verified with; later ones must match it.
  if(trusted.pin)await writeAtomically(join(target,'release-key.pub'),trusted.key+'\n');
  const text=JSON.stringify(release)+'\n',archive=join(target,'releases',release.version+'.json');
  const versions=await archivedVersions(target),highest=versions[versions.length-1];
  if(versions.includes(release.version)){
   if(await readFile(archive,'utf8')!==text)fail('Release '+release.version+' was already published with other content',409,'plugin_release_order');
  }else if(highest&&compareVersions(release.version,highest)<0)fail('Release '+release.version+' is older than the published '+highest,409,'plugin_release_order');
  let current=null;
  try{current=await new PluginReleases({directory:target}).latest();}catch(e){if(e.status!==404)throw e;}
  const unchanged=current&&JSON.stringify(current)+'\n'===text;
  if(current&&!unchanged&&compareVersions(release.version,current.version)<0)fail('Release '+release.version+' is older than the published '+current.version,409,'plugin_release_order');
  for(const file of release.files){
   const path=join(target,'files',file.sha256),stored=await readFile(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   // A file left damaged by an interrupted write is replaced with the verified bytes, even on a repeat publish.
   if(!stored||sha256(stored)!==file.sha256)await writeAtomically(path,blobs.get(file.name));
  }
  if(unchanged)return {version:release.version,unchanged:true};
  if(!versions.includes(release.version))await writeAtomically(archive,text);
  await writeAtomically(join(target,'latest.json'),text);
  // Vaults roll back from their own copy, so older releases need not keep their files here. Tidying is best
  // effort: the release is live once latest.json is replaced.
  try{
   const keep=new Set();
   for(const version of (await archivedVersions(target)).slice(-KEEP_RELEASES))
    for(const file of JSON.parse(await readFile(join(target,'releases',version+'.json'),'utf8')).files)keep.add(file.sha256);
   for(const name of await readdir(join(target,'files')))if(HEX.test(name)&&!keep.has(name))await rm(join(target,'files',name),{force:true});
  }catch(e){console.error('Old release files were not removed: '+e.message);}
  return {version:release.version,files:release.files};
 }finally{await rm(lock,{force:true});}
}

module.exports={PluginReleases,publish,descriptor,signedText,compareVersions};
if(require.main===module){
 const [, ,command,source,target,...rest]=process.argv,keyAt=rest.indexOf('--key');
 if(command!=='publish'||!source||!target||(keyAt>=0&&!rest[keyAt+1])){console.error('Usage: node obsidian-plugin-releases.cjs publish <release folder> <releases folder> [--key <release-key.pub>]');process.exitCode=1;}
 else publish(source,target,{keyFile:keyAt>=0?rest[keyAt+1]:null}).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
