import {createServer} from 'node:net';
import {lstat,realpath,chmod,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {MAX_ARCHIVE_BYTES,MAX_SOCKET_FRAME_BYTES} from './private-import-limits.mjs';

const maxLine=MAX_SOCKET_FRAME_BYTES;
// A closing listener may still have an async handler running after its peer
// disconnects. A new listener in this process must not overlap that handler.
let activeOperation=null;
export function isImportInfrastructureError(error){
 if(['P1000','P1001','P1002','P1003','P1008','P1010','P1011','P1017','P2024','ECONNREFUSED','ECONNRESET','ETIMEDOUT','RSSD_VERIFIER_UNAVAILABLE','source_unavailable','source_outcome_unknown'].includes(error?.code))return true;
 const state=typeof error?.meta?.code==='string'?error.meta.code:'';
 if(/^(08|28|53|57P|3D)/.test(state))return true;
 return state==='42501'&&/permission denied for (?:function|relation|table|schema)/i.test(String(error?.meta?.message||''));
}
function bytes(value){if(typeof value==='string'&&value.length>Math.ceil(MAX_ARCHIVE_BYTES/3)*4)throw Object.assign(Error('Archive exceeds limit'),{code:'archive_too_large'});if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Invalid private payload');const data=Buffer.from(value,'base64');if(data.length>MAX_ARCHIVE_BYTES)throw Object.assign(Error('Archive exceeds limit'),{code:'archive_too_large'});if(data.toString('base64')!==value)throw Error('Invalid private payload');return data;}
export async function createPrivateImportSocket({socketPath,service,onFailure=()=>{}}){
 if(activeOperation)throw Error('Previous private operation has not settled');
 if(typeof socketPath!=='string'||!isAbsolute(socketPath)||resolve(socketPath)!==socketPath||socketPath.includes('\0'))throw Error('Invalid private socket');
 const parent=dirname(socketPath),st=await lstat(parent);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid()||await realpath(parent)!==parent)throw Error('Private socket directory must be owned and private');
 try{await lstat(socketPath);throw Error('Private socket path already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 // Reserve one process-wide slot through the operation, even after peer disconnect.
 // Release it once the response is queued, not when the socket later closes.
 const sockets=new Set(),server=createServer(socket=>{if(activeOperation){socket.destroy();return;}const reservation={};activeOperation=reservation;sockets.add(socket);socket.setTimeout(120000,()=>socket.destroy());let chunks=[],size=0,done=false,processing=false,held=true;
  const release=()=>{if(held){held=false;if(activeOperation===reservation)activeOperation=null;}};
  const reply=value=>socket.end(JSON.stringify(value)+'\n',()=>socket.destroy());
  socket.on('close',()=>{sockets.delete(socket);if(!processing)release();});socket.on('error',()=>{});
  socket.on('data',async chunk=>{if(done)return;size+=chunk.length;if(size>maxLine){done=true;chunks=[];reply({ok:false,code:'archive_too_large'});release();return;}chunks.push(chunk);if(chunk.includes(10)){done=true;processing=true;try{const input=Buffer.concat(chunks,size),newline=input.indexOf(10);if(newline!==input.length-1)throw Error('Invalid frame');const request=JSON.parse(input.subarray(0,newline).toString('utf8'));let result;
    if(request.method==='open')result=await service.open(request.token,{archive:bytes(request.bundle.archive),bundleDigest:request.bundle.bundleDigest});
    else if(request.method==='stage')result=await service.stage(request.token,request.jobId,request.ordinal);
    else if(request.method==='finish')result=await service.finish(request.token,request.jobId);
    else throw Error('Invalid private method');
    reply({ok:true,result});
   }catch(error){if(isImportInfrastructureError(error))onFailure();reply({ok:false,code:typeof error?.code==='string'&&/^[a-z_]{1,40}$/.test(error.code)?error.code:'private_import_error'});}finally{chunks=[];processing=false;release();}}
  });
 });
 server.on('error',()=>onFailure());
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
 let identity;try{identity=await lstat(socketPath);await chmod(socketPath,0o600);}catch(error){await new Promise(resolve=>server.close(resolve));try{const now=await lstat(socketPath);if(identity&&now.isSocket()&&now.ino===identity.ino&&now.dev===identity.dev)await unlink(socketPath);}catch{}throw error;}
 return {async close(){for(const socket of sockets)socket.destroy();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));try{const now=await lstat(socketPath);if(now.isSocket()&&now.ino===identity.ino&&now.dev===identity.dev)await unlink(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
