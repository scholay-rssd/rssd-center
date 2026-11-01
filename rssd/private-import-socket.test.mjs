import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';
import {createPrivateImportSocket} from './private-import-socket.mjs';

const frame=JSON.stringify({method:'stage',token:'synthetic',jobId:'synthetic',ordinal:0})+'\n';
async function fixture(t,service,onFailure=()=>{}){const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-socket-test-')),path=join(dir,'socket'),server=await createPrivateImportSocket({socketPath:path,service,onFailure});t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});return path;}
function request(path,data=frame){return new Promise((resolve,reject)=>{const socket=connect(path),chunks=[];let settled=false;const fail=e=>{if(!settled){settled=true;reject(e);}};socket.setTimeout(3000,()=>socket.destroy(Error('timeout')));socket.on('connect',()=>socket.write(data));socket.on('data',x=>chunks.push(x));socket.on('error',fail);socket.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString());if(!settled){settled=true;resolve(result);}}catch(e){fail(e);}});socket.on('close',()=>fail(Error('closed without response')));});}
test('rapid sequential clients can all complete without waiting for close',{timeout:30000},async t=>{
 const path=await fixture(t,{async stage(){return {status:'duplicate'};}});
 for(let n=0;n<10000;n++)assert.deepEqual(await request(path),{ok:true,result:{status:'duplicate'}});
});
test('a disconnected client does not release an operation still in progress',async t=>{
 let entered,unblock;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{unblock=r;});t.after(()=>unblock());let first=true;
 const path=await fixture(t,{async stage(){if(first){first=false;entered();await blocked;}return {status:'duplicate'};}});
 const client=connect(path);client.on('error',()=>{});await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});client.write(frame);await started;client.destroy();await new Promise(r=>client.once('close',r));
 await assert.rejects(request(path));unblock();await new Promise(r=>setImmediate(r));assert.deepEqual(await request(path),{ok:true,result:{status:'duplicate'}});
});
test('failed operations and malformed frames release their slot',async t=>{
 let calls=0,notifications=0;const path=await fixture(t,{async stage(){if(calls++===0)throw Object.assign(Error('synthetic'),{code:'P1001'});return {status:'duplicate'};}},()=>{notifications++;});
 assert.deepEqual(await request(path),{ok:false,code:'private_import_error'});assert.equal(notifications,1);
 assert.deepEqual(await request(path,'{bad json}\n'),{ok:false,code:'private_import_error'});
 assert.deepEqual(await request(path),{ok:true,result:{status:'duplicate'}});
});
test('closing and reopening a listener cannot overlap a disconnected in-flight operation',async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-socket-restart-')),firstPath=join(dir,'first'),nextPath=join(dir,'next');let entered,unblock,finished;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{unblock=r;}),done=new Promise(r=>{finished=r;});let next;
 t.after(async()=>{unblock();if(next)await next.close();await rm(dir,{recursive:true,force:true});});
 const first=await createPrivateImportSocket({socketPath:firstPath,service:{async stage(){entered();await blocked;finished();return {status:'duplicate'};}}});
 const client=connect(firstPath);client.on('error',()=>{});await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});client.write(frame);await started;client.destroy();await new Promise(r=>client.once('close',r));
 const before=Date.now();await first.close();assert(Date.now()-before<1000,'close must not stall Postiz');
 await assert.rejects(createPrivateImportSocket({socketPath:nextPath,service:{async stage(){return {status:'duplicate'};}}}),/Previous private operation has not settled/);
 unblock();await done;await new Promise(r=>setImmediate(r));next=await createPrivateImportSocket({socketPath:nextPath,service:{async stage(){return {status:'duplicate'};}}});assert.deepEqual(await request(nextPath),{ok:true,result:{status:'duplicate'}});
});
