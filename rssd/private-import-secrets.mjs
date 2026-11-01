import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';

const maximumBytes=16384;
const unavailable=()=>Error('Private import role configuration unavailable');

// Read only a small regular file owned by the service account, in a directory
// not writable by other users. Never put the path or contents in an error.
async function readSecret(path){
 let file;
 try{
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||path.includes('\0'))throw unavailable();
  const parent=dirname(path),directory=await lstat(parent),uid=process.getuid();
  if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o022)!==0||![uid,0].includes(directory.uid)||await realpath(parent)!==parent)throw unavailable();
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await file.stat();
  if(!before.isFile()||before.uid!==uid||(before.mode&0o077)!==0||(before.mode&0o400)===0||before.size>maximumBytes)throw unavailable();
  const buffer=Buffer.alloc(maximumBytes+1);let length=0;
  while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  const after=await file.stat();
  if(length>maximumBytes||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||length!==before.size)throw unavailable();
  const value=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)).replace(/\r?\n$/,'');
  if(!value||/[\r\n\0]/.test(value))throw unavailable();
  const url=new URL(value);if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.pathname||url.pathname==='/')throw unavailable();
  return value;
 }catch{throw unavailable();}finally{if(file)await file.close().catch(()=>{});}
}

// Explicit _FILE takes precedence, including when invalid; never fall back to
// an environment value after a file error. A timer cannot interrupt a kernel
// filesystem call, but it prevents late results from enabling the component.
export async function readPrivateImportSecrets(env,{signal,timeoutMs=8000}={}){
 if(signal?.aborted)throw unavailable();
 const keys=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL'];
 let timer,abort;
 const stopped=new Promise((_,reject)=>{abort=()=>reject(unavailable());timer=setTimeout(abort,timeoutMs);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
 try{
  const values=await Promise.race([Promise.all(keys.map(key=>env[key+'_FILE']!==undefined?readSecret(env[key+'_FILE']):Promise.resolve(env[key]))),stopped]);
  if(values.some(value=>typeof value!=='string'||!value))throw unavailable();
  return {worker:values[0],source:values[1],issuer:values[2]};
 }catch{throw unavailable();}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
