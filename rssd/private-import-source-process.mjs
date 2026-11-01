import {safeLimitCode} from './private-import-limits.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// The direct child owns all source DB access. Stop only that child; its Python
// verifier observes parent death. Never send a signal to a negative process group.
export function runSourceProcess({sourceUrl,token,archive},{timeoutMs=125000,signal}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./private-import-source-worker.mjs',import.meta.url))],{stdio:['pipe','pipe','ignore','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:process.env.LANG||'C.UTF-8',NODE_ENV:'production'}});const chunks=[];let size=0,reason='',state='running',forceTimer;
  const stop=()=>{if(state!=='running')return;state='stopping';reason='source_outcome_unknown';clearTimeout(timer);signal?.removeEventListener('abort',stop);child.kill('SIGTERM');forceTimer=setTimeout(()=>{if(state==='stopping')child.kill('SIGKILL');},500);};
  const timer=setTimeout(stop,timeoutMs);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
  child.stdin.on('error',()=>{});child.stdio[3].on('error',()=>{});child.stdio[3].end(JSON.stringify({sourceUrl,token,parentPid:process.pid}));child.stdin.end(archive);
  const exited=()=>{state='exited';clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',stop);};
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>8192){if(!reason)reason='source_outcome_unknown';stop();}else chunks.push(chunk);});child.once('error',()=>{exited();if(!reason)reason='source_unavailable';});child.once('exit',exited);
  child.once('close',code=>{exited();try{if(reason||code!==0)throw Object.assign(Error('Private import unavailable'),{code:reason||'source_outcome_unknown'});const value=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(!value?.ok)throw Object.assign(Error('Private import unavailable'),{code:['source_outcome_unknown','source_unavailable'].includes(value?.code)?value.code:safeLimitCode(value?.code)||'private_import_error'});resolve(value.result);}catch(error){reject(error?.code?error:Object.assign(Error('Private import unavailable'),{code:'source_outcome_unknown'}));}});
 });
}
