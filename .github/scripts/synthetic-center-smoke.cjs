'use strict';
// Synthetic-only data in a network-isolated test database.
const {Client}=require('/app/node_modules/pg');
const protocol=require('/app/rssd/protocol.cjs');
const token='rssd_device_'+'A'.repeat(48);
const evidence={receiptId:'run-1:fixture',baselineSha256:'b'.repeat(64),receiverRelease:'a'.repeat(40),rollbackReference:'/synthetic/private'};
const report={siteId:'fixture',workspaceId:'fixture',state:'active',cutover:{...evidence,evidenceHash:protocol.hash(evidence)}};
async function main(){
 const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
 await db.query('INSERT INTO rssd_workers ("orgId",id,name,"tokenHash","workspaceIds") VALUES ($1,$2,$3,$4,$5::jsonb)', ['synthetic-org','synthetic-device','Synthetic Device',protocol.hash(token),JSON.stringify(['fixture'])]);
 await db.query('INSERT INTO rssd_migrations ("orgId","siteId","workspaceId",state,manifest,ancillary,report) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)', ['synthetic-org','fixture','fixture','active','{}','{}',JSON.stringify(report)]);
 await db.end();
 const root='http://127.0.0.1:5000/api/rssd/v1/';
 async function get(path,withToken=true){return fetch(root+path,{headers:withToken?{Authorization:'Bearer '+token}:{}});}
 let response=await get('identity',false);if(response.status!==401)throw Error('unauthenticated request accepted');
 response=await get('identity');if(response.status!==200)throw Error('device identity request failed: '+response.status);
 const identity=await response.json();if(identity.orgId!=='synthetic-org'||identity.workerId!=='synthetic-device'||identity.admin!==false)throw Error('device identity differs');
 response=await get('migration-proof/fixture/fixture');if(response.status!==200)throw Error('migration proof request failed: '+response.status);
 const proof=await response.json();if(proof.runId!=='run-1'||proof.baselineSha256!==evidence.baselineSha256||proof.receiverRelease!==evidence.receiverRelease||!/no-store/.test(response.headers.get('cache-control'))||JSON.stringify(proof).includes('/synthetic/private'))throw Error('proof contents differ');
 response=await get('migration-proof/fixture/other');if(response.status!==403)throw Error('cross-workspace proof was not forbidden');
 response=await get('migration-proof/other/fixture');if(response.status!==404)throw Error('missing site proof was not rejected');
 console.log('PASS: synthetic device identity, no-cache proof, unauthenticated and cross-workspace gates');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
