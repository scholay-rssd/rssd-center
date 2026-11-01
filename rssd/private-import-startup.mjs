import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Probe runs separately so a stuck Prisma engine can be killed and reaped.
// Credential-bearing URLs are sent on fd 3, never arguments or logs.
export function runPrivateImportProbe(config,{signal,timeoutMs=8000,scriptPath=fileURLToPath(new URL('./private-import-probe.mjs',import.meta.url)),onSpawn=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[scriptPath],{stdio:['ignore','ignore','ignore','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:process.env.LANG||'C.UTF-8',NODE_ENV:'production'}});let reason='';onSpawn(child.pid);
  const stop=()=>{reason='Private import initialization timed out';child.kill('SIGKILL');};
  const timer=setTimeout(stop,timeoutMs);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(JSON.stringify(config));
  child.once('error',()=>{reason='Private import initialization unavailable';});
  child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(reason||code!==0)reject(Error(reason||'Private import initialization unavailable'));else resolve();});
 });
}
// If a local bind finishes after the deadline, close its owned socket and do
// not let its late result change the component's status.
export function boundedSocket(open,{signal,timeoutMs=8000}={}){
 return new Promise((resolve,reject)=>{let settled=false;
  const stop=()=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(Error('Private import socket unavailable'));};
  const timer=setTimeout(stop,timeoutMs);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
  Promise.resolve().then(open).then(socket=>{if(settled){void socket.close().catch(()=>{});return;}settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve(socket);},()=>{if(!settled){settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(Error('Private import socket unavailable'));}});
 });
}
