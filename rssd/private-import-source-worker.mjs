// The parent passes credentials and authorization only over fd 3. No URLs,
// tokens, archive bytes, or private metadata are written to logs or arguments.
import {readFileSync,readSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {formalLoad} from './private-import-stream-source.mjs';
import {prismaPool} from './private-import-prisma-pool.mjs';
import {isImportInfrastructureError} from './private-import-socket.mjs';
const require=createRequire(import.meta.url),{PrismaClient}=require('@prisma/client');let prisma,committed=false;const stopController=new AbortController();let stopping=false;const stop=()=>{if(stopping)return;stopping=true;stopController.abort();setTimeout(()=>process.exit(1),700).unref();};process.once('SIGTERM',stop);
try{
 const configBytes=readFileSync(3);if(configBytes.length>16384)throw Error('invalid configuration');const config=JSON.parse(configBytes.toString('utf8'));if(typeof config.sourceUrl!=='string'||!config.sourceUrl||!Number.isSafeInteger(config.parentPid)||config.parentPid<2)throw Error('invalid configuration');
 const watch=setInterval(()=>{if(process.ppid!==config.parentPid){clearInterval(watch);stop();}},250);watch.unref();
 const buffer=Buffer.allocUnsafe(32*1024*1024+1);let size=0;while(size<buffer.length){const n=readSync(0,buffer,size,buffer.length-size,null);if(!n)break;size+=n;}if(size>32*1024*1024)throw Error('archive too large');const archive=buffer.subarray(0,size);prisma=new PrismaClient({datasources:{db:{url:config.sourceUrl}}});const pool=prismaPool(prisma);
 const tokenHash=createHash('sha256').update(config.token).digest('hex'),[g]=(await pool.query('SELECT org,actor,workspace,site,expires>clock_timestamp() valid FROM rssd_import_grants WHERE token_hash=$1',[tokenHash])).rows;if(!g?.valid)throw Error('authorization unavailable');
 const ctx={orgId:g.org,userId:g.actor,admin:true,workspaceIds:[g.workspace]},result=await formalLoad(pool,ctx,{token:config.token,archive,site:g.site,workspace:g.workspace,signal:stopController.signal});committed=true;const output=JSON.stringify({ok:true,result});if(Buffer.byteLength(output)>8192)throw Error('response too large');process.stdout.write(output);
}catch(error){const code=committed||error?.code==='source_outcome_unknown'?'source_outcome_unknown':error?.code==='source_unavailable'||isImportInfrastructureError(error)?'source_unavailable':'private_import_error';process.stdout.write(JSON.stringify({ok:false,code}));}
finally{await prisma?.$disconnect().catch(()=>{});}
