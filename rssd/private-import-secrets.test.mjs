import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readPrivateImportSecrets} from './private-import-secrets.mjs';

const keys=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL'];
const env=()=>Object.fromEntries(keys.map((key,i)=>[key,`postgresql://synthetic-${i}:synthetic-only@localhost/db`]));
const error={message:'Private import role configuration unavailable'};
async function directory(t){const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-secret-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('environment credentials remain compatible; protected files take precedence',async t=>{
 const dir=await directory(t),values=env(),paths=[];
 for(let i=0;i<keys.length;i++){const path=join(dir,'secret-'+i);await writeFile(path,`postgresql://file-${i}:synthetic-only@localhost/db${i===0?'\n':i===1?'\r\n':''}`,{mode:i===0?0o400:0o600});values[keys[i]+'_FILE']=path;paths.push(path);}
 assert.deepEqual(await readPrivateImportSecrets(env()),{worker:env()[keys[0]],source:env()[keys[1]],issuer:env()[keys[2]]});
 assert.deepEqual(await readPrivateImportSecrets(values),{worker:'postgresql://file-0:synthetic-only@localhost/db',source:'postgresql://file-1:synthetic-only@localhost/db',issuer:'postgresql://file-2:synthetic-only@localhost/db'});
 delete values[keys[1]+'_FILE'];assert.equal((await readPrivateImportSecrets(values)).source,values[keys[1]]);
});
test('explicit bad file never falls back or leaks its path or contents',async t=>{
 const dir=await directory(t),values=env(),path=join(dir,'sensitive-synthetic-name');values[keys[0]+'_FILE']=path;
 await assert.rejects(readPrivateImportSecrets(values),error);
 await writeFile(path,'sensitive-synthetic-value',{mode:0o600});await assert.rejects(readPrivateImportSecrets(values),error);
 await writeFile(path,'postgresql://user:password@localhost/db\nextra');await assert.rejects(readPrivateImportSecrets(values),error);
 await writeFile(path,Buffer.from([0xff,0xfe]));await assert.rejects(readPrivateImportSecrets(values),error);
 await writeFile(path,Buffer.alloc(16385,65));await assert.rejects(readPrivateImportSecrets(values),error);
 values[keys[0]+'_FILE']='';await assert.rejects(readPrivateImportSecrets(values),error);
});
test('rejects unprotected files, symlinks, writable parents and FIFOs',async t=>{
 const dir=await directory(t),values=env(),path=join(dir,'value'),link=join(dir,'link'),fifo=join(dir,'fifo');await writeFile(path,'postgresql://u:p@localhost/db',{mode:0o600});values[keys[0]+'_FILE']=path;
 await chmod(path,0o640);await assert.rejects(readPrivateImportSecrets(values),error);await chmod(path,0o600);
 await chmod(path,0o000);await assert.rejects(readPrivateImportSecrets(values),error);await chmod(path,0o600);
 await symlink(path,link);values[keys[0]+'_FILE']=link;await assert.rejects(readPrivateImportSecrets(values),error);values[keys[0]+'_FILE']=path;
 const parentLink=join(dir,'parent-link');await symlink(dir,parentLink);values[keys[0]+'_FILE']=join(parentLink,'value');await assert.rejects(readPrivateImportSecrets(values),error);values[keys[0]+'_FILE']=path;
 await chmod(dir,0o777);try{await assert.rejects(readPrivateImportSecrets(values),error);}finally{await chmod(dir,0o700);}
 assert.equal(spawnSync('mkfifo',[fifo]).status,0);values[keys[0]+'_FILE']=fifo;await assert.rejects(readPrivateImportSecrets(values,{timeoutMs:1000}),error);
});
test('aborted initialization rejects even when environment values are valid',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(readPrivateImportSecrets(env(),{signal:controller.signal}),error);
});
