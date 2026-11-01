// Internal socket adapter. The trusted source role is separate from the
// untrusted staging worker; token never enters URLs or process arguments.
import {createHash} from 'node:crypto';
import {runSourceProcess} from './private-import-source-process.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export class SecurePrivateImport {
 constructor(sourcePrisma,workerPrisma,{sourceUrl}={}){this.sourceUrl=sourceUrl;this.worker=workerPrisma;}
 async open(token,{archive,bundleDigest}){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!Buffer.isBuffer(archive)||sha(archive)!==bundleDigest)throw Error('authorization unavailable');
  return runSourceProcess({sourceUrl:this.sourceUrl,token,archive});
 }
 async stage(token,jobId,ordinal){
  if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=1000)throw Error('original identity unavailable');
  const [r]=await this.worker.$queryRawUnsafe('SELECT public.rssd_restricted_stage_index($1,$2,$3::int) status',token,jobId,ordinal);return {status:r.status};
 }
 async finish(token,jobId){
  const [r]=await this.worker.$queryRawUnsafe('SELECT public.rssd_restricted_finish($1,$2) result',token,jobId);
  return r.result;
 }
}
