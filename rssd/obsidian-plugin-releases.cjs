'use strict';
// Signed releases of the RSSD Obsidian plugin, published here so every vault on every device can update itself.
// The Center only stores and serves them. A vault installs a release only when its signature verifies against
// the key compiled into the plugin it already runs, so this server cannot make a vault run other code.
const {readFile,writeFile,mkdir,rename,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {ProtocolError}=require('./protocol.cjs');
const FILES=['main.js','manifest.json'],MAX_DESCRIPTOR=65536,MAX_FILE=16*1024*1024;
const HEX=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/,VERSION=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const fail=(message,status=400,code='plugin_release_invalid')=>{throw new ProtocolError(message,status,code);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function compareVersions(a,b){
 const x=a.split('.').map(Number),y=b.split('.').map(Number);
 for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;
 return 0;
}
/** A release exactly as served: these fields only, files in name order. Throws on anything else. */
function descriptor(value){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('A release must be an object');
 if(Object.keys(value).some(key=>!['format','id','version','minAppVersion','commit','publishedAt','files','signature'].includes(key)))fail('The release has unknown fields');
 if(value.format!==1||value.id!=='rssd')fail('This is not an RSSD plugin release');
 if(!VERSION.test(value.version||'')||!VERSION.test(value.minAppVersion||''))fail('The release version is invalid');
 if(!COMMIT.test(value.commit||''))fail('The release commit is invalid');
 if(typeof value.publishedAt!=='string'||!Number.isFinite(Date.parse(value.publishedAt)))fail('The release time is invalid');
 if(!Array.isArray(value.files)||value.files.length!==FILES.length)fail('The release files are invalid');
 const files=[...value.files].sort((a,b)=>String(a?.name)<String(b?.name)?-1:1);
 files.forEach((file,i)=>{
  if(!file||typeof file!=='object'||Object.keys(file).sort().join()!=='name,sha256,size'||file.name!==FILES[i]||!HEX.test(file.sha256||'')||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE)fail('A release file is invalid');
 });
 // ECDSA P-256 in IEEE P1363 form: 64 bytes, base64.
 if(typeof value.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(value.signature))fail('The release signature is invalid');
 return {format:1,id:'rssd',version:value.version,minAppVersion:value.minAppVersion,commit:value.commit,publishedAt:value.publishedAt,
  files:files.map(file=>({name:file.name,sha256:file.sha256,size:file.size})),signature:value.signature};
}

class PluginReleases {
 constructor({directory=process.env.RSSD_PLUGIN_RELEASES_DIR||'/config/rssd-obsidian-plugin'}={}){this.directory=directory;}
 async latest(){
  let bytes;
  try{bytes=await readFile(join(this.directory,'latest.json'));}
  catch(e){if(e.code==='ENOENT')fail('No plugin release is published',404,'plugin_release_unavailable');throw e;}
  try{if(bytes.length>MAX_DESCRIPTOR)throw Error('size');return descriptor(JSON.parse(bytes));}
  catch{fail('The published plugin release is unreadable',503,'plugin_release_unavailable');}
 }
 async file(hash){
  if(!HEX.test(hash||''))fail('Release file not found',404,'plugin_release_file');
  let bytes;
  try{bytes=await readFile(join(this.directory,'files',hash));}
  catch(e){if(e.code==='ENOENT')fail('Release file not found',404,'plugin_release_file');throw e;}
  if(bytes.length>MAX_FILE||sha256(bytes)!==hash)fail('The release file is damaged',503,'plugin_release_file');
  return bytes;
 }
}

/**
 * Publish one release from a folder holding release.json and the files it names. Files are kept by hash and
 * never change; a version is never lowered or reused for other content; publishing the same release again
 * changes nothing. latest.json is replaced atomically, so readers see the old release or the new one.
 */
async function publish(source,target){
 const raw=await readFile(join(source,'release.json'));if(raw.length>MAX_DESCRIPTOR)fail('The release is too large');
 const release=descriptor(JSON.parse(raw)),blobs=new Map();
 for(const file of release.files){
  const bytes=await readFile(join(source,file.name));
  if(bytes.length!==file.size||sha256(bytes)!==file.sha256)fail(file.name+' does not match the release');
  blobs.set(file.name,bytes);
 }
 let manifest;try{manifest=JSON.parse(blobs.get('manifest.json'));}catch{fail('manifest.json is not JSON');}
 if(manifest?.id!=='rssd'||manifest.version!==release.version||manifest.minAppVersion!==release.minAppVersion)fail('manifest.json does not match the release');
 let current=null;
 try{current=await new PluginReleases({directory:target}).latest();}catch(e){if(e.status!==404)throw e;}
 const text=JSON.stringify(release)+'\n';
 if(current){
  const order=compareVersions(release.version,current.version);
  if(order<0)fail('Release '+release.version+' is older than the published '+current.version,409,'plugin_release_order');
  if(order===0){if(JSON.stringify(current)+'\n'===text)return {version:release.version,unchanged:true};fail('Release '+release.version+' was already published with other content',409,'plugin_release_order');}
 }
 await mkdir(join(target,'files'),{recursive:true,mode:0o755});await mkdir(join(target,'releases'),{recursive:true,mode:0o755});
 for(const file of release.files){
  const path=join(target,'files',file.sha256);
  try{await writeFile(path,blobs.get(file.name),{flag:'wx',mode:0o644});}
  catch(e){if(e.code!=='EEXIST')throw e;if(sha256(await readFile(path))!==file.sha256)fail('The stored file '+file.sha256+' is damaged',500,'plugin_release_file');}
 }
 const archive=join(target,'releases',release.version+'.json');
 try{await writeFile(archive,text,{flag:'wx',mode:0o644});}
 catch(e){if(e.code!=='EEXIST')throw e;if(await readFile(archive,'utf8')!==text)fail('Release '+release.version+' was already archived with other content',409,'plugin_release_order');}
 const temporary=join(target,'latest.json.'+randomUUID()+'.tmp');
 try{await writeFile(temporary,text,{flag:'wx',mode:0o644});await rename(temporary,join(target,'latest.json'));}
 finally{await rm(temporary,{force:true});}
 return {version:release.version,files:release.files};
}

module.exports={PluginReleases,publish,descriptor,compareVersions};
if(require.main===module){
 const [, ,command,source,target='/config/rssd-obsidian-plugin']=process.argv;
 if(command!=='publish'||!source){console.error('Usage: node obsidian-plugin-releases.cjs publish <release folder> [releases folder]');process.exitCode=1;}
 else publish(source,target).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
