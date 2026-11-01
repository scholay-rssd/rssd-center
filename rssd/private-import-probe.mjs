// Short-lived child only: credentials arrive through a private inherited fd.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {assertSecureImportRole} from './private-import-secure-roles.mjs';
const require=createRequire(import.meta.url),{PrismaClient}=require('@prisma/client');let clients=[];
try{
 const raw=readFileSync(3);if(raw.length>16384)throw Error('configuration too large');const cfg=JSON.parse(raw.toString('utf8'));
 for(const key of ['issuer','source','worker'])if(typeof cfg[key]!=='string'||!cfg[key])throw Error('configuration unavailable');
 clients=['issuer','source','worker'].map(key=>new PrismaClient({datasources:{db:{url:cfg[key]}}}));
 await Promise.all(clients.map((client,i)=>client.$transaction(async tx=>{
  // Server-side timeout must be applied on the same connection as each probe;
  // merely killing a client can leave a long server query running.
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
  await assertSecureImportRole(tx,['issuer','source','worker'][i]);
 },{timeout:4000,maxWait:1000})));
}catch{process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.$disconnect()));}
