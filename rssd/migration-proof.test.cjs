'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RssdMigration}=require('./migration.cjs'),p=require('./protocol.cjs');
const evidence={receiptId:'run-1:enter',baselineSha256:'a'.repeat(64),receiverRelease:'release-1',rollbackReference:'/private/secret',oldWriterDisabled:true};
const row={siteId:'enter',workspaceId:'enter',state:'active',report:{siteId:'enter',workspaceId:'enter',state:'active',cutover:{...evidence,evidenceHash:p.hash(evidence),activatedAt:'2026-11-03T00:00:00Z',actor:'owner'}}};
const device={orgId:'org',workerId:'device',admin:false,workspaceIds:['enter']};
function fixture(value=row){let calls=[];return {calls,migration:new RssdMigration({db:{$queryRawUnsafe:async(sql,...args)=>{calls.push({sql,args});return value?[value]:[];}}})};}
test('device proof exposes only scoped sanitized evidence and never private report',async()=>{
 const f=fixture(),proof=await f.migration.deviceProof(device,'enter','enter');
 assert.deepEqual(f.calls[0].args,['org','enter','enter']);assert.match(f.calls[0].sql,/"orgId"=\$1 AND "siteId"=\$2 AND "workspaceId"=\$3/);
 assert.deepEqual(Object.keys(proof).sort(),['baselineSha256','evidenceHash','observedAt','receiptId','receiverRelease','runId','siteId','state','workspaceId'].sort());
 assert.equal(proof.runId,'run-1');assert.equal(proof.evidenceHash,p.hash(evidence));assert.ok(Number.isFinite(Date.parse(proof.observedAt)));assert.doesNotMatch(JSON.stringify(proof),/private|secret|owner/);
});
test('owner, absent device and cross-workspace requests are forbidden before DB access',async()=>{
 for(const ctx of [{...device,admin:true,workspaceIds:null},{...device,workerId:null},{...device,workspaceIds:['other']},null]){const f=fixture();await assert.rejects(f.migration.deviceProof(ctx,'enter','enter'),{status:403});assert.equal(f.calls.length,0);}
});
test('missing, staged, malformed or tampered evidence fails closed',async()=>{
 for(const bad of [null,{...row,state:'staged'},{...row,workspaceId:'other'},{...row,report:{...row.report,siteId:'other'}},{...row,report:{...row.report,cutover:{...row.report.cutover,receiptId:'other'}}},{...row,report:{...row.report,cutover:{...row.report.cutover,baselineSha256:'0'.repeat(64)}}},{...row,report:{...row.report,cutover:{...row.report.cutover,receiverRelease:'/private/path'}}}]){const f=fixture(bad);await assert.rejects(f.migration.deviceProof(device,'enter','enter'),e=>e.status===404||e.status===409);}
});
