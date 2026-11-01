import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,realpath,writeFile,lstat,chmod,open as openFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {connect,createServer} from 'node:net';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {trustedLoad,runArchiveVerifier} from './private-import-trusted-source.mjs';
import {runSourceProcess} from './private-import-source-process.mjs';
import {formalLoad} from './private-import-stream-source.mjs';
import {prismaPool} from './private-import-prisma-pool.mjs';
const here=fileURLToPath(new URL('.',import.meta.url)),work=resolve(here,'..');
const PROFILE={version:1,inventoryPath:'INVENTORY.json',metadataExceptions:[],unlistedMetadata:[]};
const require=createRequire(join(work,'package.json')),{Pool}=require('pg'),{PrismaClient}=require('@prisma/client'),{RssdStore}=require(join(work,'rssd/store.cjs')),{RssdPrivateReview}=require(join(work,'rssd/private-review.cjs'));
const {PrivateImportOwner}=await import('file://'+join(work,'rssd/private-import-owner.mjs'));
const {PrivateImportOutcome}=require(join(work,'rssd/private-import-outcome.cjs'));
const {assertSecureImportRole,assertGrantIssuerPermissions}=await import('file://'+join(work,'rssd/private-import-secure-roles.mjs'));
const {SecurePrivateImport}=await import('file://'+join(work,'rssd/private-import-secure-adapter.mjs'));
const {runPrivateImportProbe,boundedSocket}=await import('file://'+join(work,'rssd/private-import-startup.mjs'));
const {createPrivateImportSocket,isImportInfrastructureError}=await import('file://'+join(work,'rssd/private-import-socket.mjs'));
const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(await readFile(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):(()=>{const u=new URL(process.env.RSSD_TEST_DATABASE_URL);return {host:u.hostname,port:Number(u.port||5432),database:u.pathname.slice(1),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};})();
if(!['127.0.0.1','localhost'].includes(config.host)||!['rssd_secure_test','rssd_import_test'].includes(config.database))throw Error('Local dedicated disposable test database required');
const url=(user,password)=>{const u=new URL('postgresql://'+config.host);u.username=user;u.password=password;u.port=config.port;u.pathname='/'+config.database;return u.href;};
let admin,owner,issuerDb,source,worker,workerPool,issuerUrl,sourceUrl,workerUrl;
before(async()=>{admin=new Pool(config);for(const sql of (await readFile(join(work,'rssd/schema.sql'),'utf8')).split(';').filter(s=>s.trim()))await admin.query(sql);
 await admin.query('CREATE TABLE "User" (id TEXT PRIMARY KEY,activated BOOLEAN NOT NULL,"deletedAt" TIMESTAMP)');await admin.query('CREATE TABLE "Organization" (id TEXT PRIMARY KEY,"deletedAt" TIMESTAMP)');await admin.query('CREATE TABLE "UserOrganization" ("userId" TEXT NOT NULL,"organizationId" TEXT NOT NULL,disabled BOOLEAN NOT NULL,role TEXT NOT NULL,PRIMARY KEY("userId","organizationId"))');
 await admin.query(await readFile(join(here,'private-import-secure-policy.sql'),'utf8'));
 const issuerPassword=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE rssd_issuer_test_login LOGIN PASSWORD '${issuerPassword}'`);await admin.query('GRANT rssd_restricted_grant_issuer TO rssd_issuer_test_login');issuerUrl=url('rssd_issuer_test_login',issuerPassword);issuerDb=new PrismaClient({datasources:{db:{url:issuerUrl}}});
 const sourcePassword=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE rssd_source_test_login LOGIN PASSWORD '${sourcePassword}'`);await admin.query('GRANT rssd_restricted_source_loader TO rssd_source_test_login');sourceUrl=url('rssd_source_test_login',sourcePassword);source=new PrismaClient({datasources:{db:{url:sourceUrl}}});const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE rssd_restricted_test_login LOGIN PASSWORD '${password}'`);await admin.query('GRANT rssd_restricted_import_worker TO rssd_restricted_test_login');owner=new PrismaClient({datasources:{db:{url:url(config.user,config.password)}}});workerUrl=url('rssd_restricted_test_login',password);worker=new PrismaClient({datasources:{db:{url:workerUrl}}});workerPool=new Pool({...config,user:'rssd_restricted_test_login',password});});
after(async()=>{await worker?.$disconnect();await source?.$disconnect();await issuerDb?.$disconnect();await owner?.$disconnect();await workerPool?.end();await admin?.end();});
async function fixture(t){const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-secure-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const py=`import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('f',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.fixture(sys.argv[2])))`;const r=spawnSync('python3',['-c',py,join(work,'rssd/private-import-fixture.py'),dir],{encoding:'utf8'});assert.equal(r.status,0);const paths=JSON.parse(r.stdout),org=randomUUID(),actor='owner-'+randomUUID(),ctx={orgId:org,userId:actor,admin:true,workspaceIds:null};await admin.query('INSERT INTO "User"(id,activated) VALUES($1,true)',[actor]);await admin.query('INSERT INTO "Organization"(id) VALUES($1)',[org]);await admin.query('INSERT INTO "UserOrganization"("userId","organizationId",disabled,role) VALUES($1,$2,false,$3)',[actor,org,'ADMIN']);await new RssdStore(owner).saveWorkspace(ctx,{id:'space',siteId:'site',name:'Synthetic',sections:[{id:'news',name:'News',policy:{version:1,targets:[]}}]});const archive=await readFile(paths.archive),issuer=new PrivateImportOwner(issuerDb),grant=await issuer.issue(ctx,{workspace:'space',site:'site',bundleDigest:paths.digest,sourceProfile:PROFILE});return {ctx,actor,org,archive,issuer,grant,paths};}
const load=(f,token=f.grant.token)=>trustedLoad(source,f.ctx,{token,archive:f.archive,site:'site',workspace:'space'});
const stage=(token,id,key)=>worker.$queryRawUnsafe('SELECT public.rssd_restricted_stage_index($1,$2,$3::int) AS state',token,id,key==='request-1'?0:key==='request-2'?1:-1);
const finish=(token,id)=>worker.$queryRawUnsafe("SELECT public.rssd_restricted_finish($1,$2)->>'state' AS state",token,id);
test('runtime refuses overprivileged worker and source role configuration',{timeout:120000},async()=>{
 await assertSecureImportRole(worker,'worker');await assertSecureImportRole(source,'source');await assertSecureImportRole(issuerDb,'issuer');await assertGrantIssuerPermissions(issuerDb);await assert.rejects(assertGrantIssuerPermissions(worker));await assert.rejects(assertSecureImportRole(owner,'worker'));
 for(const [role,grant,revoke] of [[worker,'GRANT rssd_restricted_grant_issuer TO rssd_restricted_test_login','REVOKE rssd_restricted_grant_issuer FROM rssd_restricted_test_login'],[source,'GRANT SELECT ON \"User\" TO rssd_source_test_login','REVOKE SELECT ON \"User\" FROM rssd_source_test_login'],[source,'GRANT DELETE ON rssd_verified_files TO rssd_source_test_login','REVOKE DELETE ON rssd_verified_files FROM rssd_source_test_login']]){await admin.query(grant);try{await assert.rejects(assertSecureImportRole(role,role===worker?'worker':'source'));}finally{await admin.query(revoke);}}
});
test('source profile is grant-bound and cannot except a business path',{timeout:120000},async t=>{
 const f=await fixture(t),bad={...PROFILE,metadataExceptions:[{path:'files/business.md',expectedBytes:1,expectedSha256:'a'.repeat(64),actualBytes:1,actualSha256:'b'.repeat(64)}]};
 await assert.rejects(f.issuer.issue(f.ctx,{workspace:'space',site:'site',bundleDigest:f.paths.digest,sourceProfile:bad}));
 await assert.rejects(source.$executeRawUnsafe("UPDATE rssd_import_grants SET source_profile='{}'::jsonb WHERE id=$1",f.grant.grantId));await assert.rejects(issuerDb.$executeRawUnsafe("UPDATE rssd_import_grants SET source_profile='{}'::jsonb WHERE id=$1",f.grant.grantId));
});
test('restricted role cannot directly read or change private or publication tables',{timeout:120000},async t=>{
 const f=await fixture(t),{jobId}=await load(f);
 await assert.rejects(workerPool.query('SELECT public.rssd_restricted_stage($1,$2,$3)',[f.grant.token,jobId,'request-1']),{code:'42501'});
 for(const table of ['rssd_import_grants','rssd_import_jobs','rssd_import_items','rssd_import_audit','rssd_verified_items','rssd_verified_files','rssd_private_review_items','rssd_private_review_files','rssd_publications']){
  await assert.rejects(workerPool.query(`SELECT * FROM ${table} LIMIT 1`),{code:'42501'});await assert.rejects(workerPool.query(`DELETE FROM ${table} WHERE false`),{code:'42501'});
 }
 await assert.rejects(stage(f.grant.token,randomUUID(),'request-1'));await assert.rejects(stage(randomBytes(32).toString('base64url'),jobId,'request-1'));await assert.rejects(stage(f.grant.token,jobId,'not-in-source'));
 assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_private_review_items WHERE "orgId"=$1',[f.org])).rows[0].n,0);
});
test('full archived evidence, original identity, atomic audit and idempotent recovery',{timeout:120000},async t=>{
 const f=await fixture(t),first=await load(f);assert.equal(first.items,2);assert.deepEqual(first.package_metadata_mismatch,[]);assert.equal((await load(f)).jobId,first.jobId);
 const stored=(await admin.query('SELECT archive FROM rssd_import_jobs WHERE id=$1',[first.jobId])).rows[0].archive;assert.deepEqual(stored,f.archive);
 await assert.rejects(finish(f.grant.token,first.jobId));
 await admin.query("ALTER TABLE rssd_import_audit ADD CONSTRAINT test_no_stage CHECK (action<>'item_staged') NOT VALID");
 try{await assert.rejects(stage(f.grant.token,first.jobId,'request-1'));assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_private_review_items WHERE "orgId"=$1',[f.org])).rows[0].n,0);assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_import_items WHERE job_id=$1',[first.jobId])).rows[0].n,0);}finally{await admin.query('ALTER TABLE rssd_import_audit DROP CONSTRAINT test_no_stage');}
 const result=await Promise.all([stage(f.grant.token,first.jobId,'request-1'),stage(f.grant.token,first.jobId,'request-1')]);assert.deepEqual(result.map(x=>x[0].state).sort(),['duplicate','staged']);
 assert.equal((await stage(f.grant.token,first.jobId,'request-2'))[0].state,'staged');assert.equal((await finish(f.grant.token,first.jobId))[0].state,'needs_reconciliation');assert.equal((await finish(f.grant.token,first.jobId))[0].state,'needs_reconciliation');
 const audit=(await admin.query('SELECT action FROM rssd_import_audit WHERE org=$1',[f.org])).rows;assert.equal(audit.filter(x=>x.action==='item_staged').length,2);assert.equal(audit.filter(x=>x.action==='job_staged').length,1);
 for(const table of ['rssd_submissions','rssd_works','rssd_demands','rssd_publications'])assert.equal((await admin.query('SELECT count(*)::int n FROM '+table+' WHERE "orgId"=$1',[f.org])).rows[0].n,0);
 await f.issuer.revoke(f.ctx,f.grant.grantId);await assert.rejects(stage(f.grant.token,first.jobId,'request-1'));const next=await f.issuer.issue(f.ctx,{workspace:'space',site:'site',bundleDigest:f.paths.digest,sourceProfile:PROFILE});assert.equal((await load(f,next.token)).jobId,first.jobId);assert.equal((await stage(next.token,first.jobId,'request-1'))[0].state,'duplicate');
});
test('database rejects changed attachment, original request identity and revoked membership',{timeout:120000},async t=>{
 const f=await fixture(t),{jobId}=await load(f);const row=(await admin.query("SELECT path,data FROM rssd_verified_files WHERE job_id=$1 AND legacy_key='request-1' ORDER BY path LIMIT 1",[jobId])).rows[0];await admin.query("UPDATE rssd_verified_files SET data=decode('00','hex') WHERE job_id=$1 AND legacy_key='request-1' AND path=$2",[jobId,row.path]);await assert.rejects(stage(f.grant.token,jobId,'request-1'));await admin.query("UPDATE rssd_verified_files SET data=$3 WHERE job_id=$1 AND legacy_key='request-1' AND path=$2",[jobId,row.path,row.data]);
 await admin.query('UPDATE "UserOrganization" SET disabled=true WHERE "userId"=$1',[f.actor]);await assert.rejects(stage(f.grant.token,jobId,'request-1'));await admin.query('UPDATE "UserOrganization" SET disabled=false WHERE "userId"=$1',[f.actor]);await admin.query("UPDATE rssd_import_grants SET expires=clock_timestamp()-interval '1 second' WHERE id=$1",[f.grant.grantId]);await assert.rejects(stage(f.grant.token,jobId,'request-1'));
 assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_private_review_items WHERE "orgId"=$1',[f.org])).rows[0].n,0);
});
test('cross-organization access and omitted original file are rejected',{timeout:120000},async t=>{
 const a=await fixture(t),b=await fixture(t),ja=await load(a),jb=await load(b);
 await assert.rejects(stage(a.grant.token,jb.jobId,'request-1'));await assert.rejects(stage(b.grant.token,ja.jobId,'request-1'));
 await assert.rejects(trustedLoad(source,{...a.ctx,orgId:b.org},{token:a.grant.token,archive:a.archive,site:'site',workspace:'space'}));
 const saved=(await admin.query("SELECT * FROM rssd_verified_files WHERE job_id=$1 AND legacy_key='request-1' ORDER BY path LIMIT 1",[ja.jobId])).rows[0];
 await admin.query("DELETE FROM rssd_verified_files WHERE job_id=$1 AND legacy_key='request-1' AND path=$2",[ja.jobId,saved.path]);await admin.query("UPDATE rssd_verified_items SET expected_paths=expected_paths-$2 WHERE job_id=$1 AND legacy_key='request-1'",[ja.jobId,saved.path]);
 await assert.rejects(stage(a.grant.token,ja.jobId,'request-1'));assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_private_review_items WHERE "orgId"=$1',[a.org])).rows[0].n,0);
});

test('existing identical private-review identity is reused without replacing original records',{timeout:120000},async t=>{
 const f=await fixture(t),{jobId}=await load(f);const [it]=(await admin.query("SELECT * FROM rssd_verified_items WHERE job_id=$1 AND legacy_key='request-1'",[jobId])).rows;
 const files=(await admin.query("SELECT path,sha256,bytes,data FROM rssd_verified_files WHERE job_id=$1 AND legacy_key='request-1'",[jobId])).rows;
 const review=new RssdPrivateReview(new RssdStore(owner));const existing=await review.stage(f.ctx,'space',{siteId:'site',legacyKey:'request-1',articleId:'article-1',bundleDigest:f.paths.digest,metadata:it.metadata,files});
 assert.equal(existing.status,'staged');assert.equal((await stage(f.grant.token,jobId,'request-1'))[0].state,'staged');
 const rows=(await admin.query('SELECT id,fingerprint FROM rssd_private_review_items WHERE "orgId"=$1',[f.org])).rows;assert.equal(rows.length,1);assert.equal(rows[0].id,existing.id);assert.equal(rows[0].fingerprint,it.compat_fingerprint);
});
test('definers are non-login/non-superuser and worker cannot assume them',{timeout:120000},async()=>{
 const roles=(await admin.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname IN ('rssd_restricted_import_definer','rssd_restricted_auth_definer','rssd_restricted_import_worker','rssd_restricted_source_loader') ORDER BY rolname")).rows;assert.equal(roles.length,4);for(const r of roles)assert(!r.rolcanlogin&&!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolbypassrls);
 await assert.rejects(workerPool.query('SET ROLE rssd_restricted_import_definer'),{code:'42501'});await assert.rejects(workerPool.query("SELECT public.rssd_restricted_import_authorize('a','b','c','d')"),{code:'42501'});
 const r=(await admin.query("SELECT has_table_privilege('rssd_restricted_import_definer','public.rssd_publications','INSERT,UPDATE,DELETE') AS pubwrite, has_table_privilege('rssd_restricted_import_definer','public.\"User\"','UPDATE') AS userwrite, has_table_privilege('rssd_restricted_import_worker','public.rssd_verified_files','SELECT') AS sourceread")).rows[0];assert.deepEqual(r,{pubwrite:false,userwrite:false,sourceread:false});
 const l=(await admin.query("SELECT has_table_privilege('rssd_restricted_source_loader','public.rssd_publications','INSERT,UPDATE,DELETE') AS pubwrite,has_table_privilege('rssd_restricted_source_loader','public.\"User\"','SELECT') AS userread,has_table_privilege('rssd_restricted_source_loader','public.rssd_private_review_items','SELECT') AS reviewread")).rows[0];assert.deepEqual(l,{pubwrite:false,userread:false,reviewread:false});
});
test('revoking membership waits for an already-authorized transaction and blocks subsequent stages',{timeout:120000},async t=>{
 const f=await fixture(t),{jobId}=await load(f),client=await workerPool.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT public.rssd_restricted_stage_index($1,$2,$3)',[f.grant.token,jobId,0]);
  let revoked=false;const pending=admin.query('UPDATE "UserOrganization" SET disabled=true WHERE "userId"=$1',[f.actor]).then(()=>{revoked=true;});await new Promise(r=>setTimeout(r,100));assert.equal(revoked,false);await client.query('COMMIT');await pending;assert.equal(revoked,true);
  await assert.rejects(stage(f.grant.token,jobId,'request-2'));assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_private_review_items WHERE "orgId"=$1',[f.org])).rows[0].n,1);
 }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
});

function mutateArchive(input,mode){
 const script=`import sys,io,json,tarfile,hashlib
mode=sys.argv[1]; data=sys.stdin.buffer.read(); entries=[]
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as old:
 for m in old:
  if m.isfile():
   b=old.extractfile(m).read()
   if mode=='business' and m.name.endswith('/notes.json'):b+=b'changed'
   if mode=='absolute' and m.name.endswith('/INVENTORY.json'):
    v=json.loads(b);v['items'][0]['annex']={'files':['/synthetic/root/'+v['items'][0]['paths']['copied'][0]]};b=json.dumps(v).encode()
   if mode=='package' and m.name.endswith('/MANIFEST.json'):
    v=json.loads(b);v['files'].append({'path':'package-info.txt','bytes':3,'sha256':hashlib.sha256(b'old').hexdigest()});b=json.dumps(v).encode()
   entries.append((m.name,b))
if mode=='package':entries.append(('handover/package-info.txt',b'new'))
inv=next(b for name,b in entries if name.endswith('/INVENTORY.json'))
for i,(name,b) in enumerate(entries):
 if name.endswith('/MANIFEST.json'):
  v=json.loads(b)
  for row in v['files']:
   if row['path']=='INVENTORY.json':row['bytes']=len(inv);row['sha256']=hashlib.sha256(inv).hexdigest()
  entries[i]=(name,json.dumps(v).encode())
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:gz') as tar:
 for name,b in entries:
  x=tarfile.TarInfo(name);x.size=len(b);tar.addfile(x,io.BytesIO(b))
sys.stdout.buffer.write(out.getvalue())`;
 const result=spawnSync('python3',['-c',script,mode],{input,maxBuffer:20*1024*1024});assert.equal(result.status,0);return result.stdout;
}
test('business archive tampering is rejected before source storage',{timeout:120000},async t=>{
 const f=await fixture(t),archive=mutateArchive(f.archive,'business'),digest=createHash('sha256').update(archive).digest('hex'),g=await f.issuer.issue(f.ctx,{workspace:'space',site:'site',bundleDigest:digest,sourceProfile:PROFILE});
 await assert.rejects(trustedLoad(source,f.ctx,{token:g.token,archive,site:'site',workspace:'space'}),/archive validation failed/);assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_import_jobs WHERE org=$1',[f.org])).rows[0].n,0);
});
test('known package metadata mismatch remains flagged through pending reconciliation',{timeout:120000},async t=>{
 const f=await fixture(t),archive=mutateArchive(f.archive,'package'),digest=createHash('sha256').update(archive).digest('hex'),profile={...PROFILE,metadataExceptions:[{path:'package-info.txt',expectedBytes:3,expectedSha256:createHash('sha256').update('old').digest('hex'),actualBytes:3,actualSha256:createHash('sha256').update('new').digest('hex')}]},g=await f.issuer.issue(f.ctx,{workspace:'space',site:'site',bundleDigest:digest,sourceProfile:profile});
 const loaded=await trustedLoad(source,f.ctx,{token:g.token,archive,site:'site',workspace:'space'});assert.equal(loaded.package_metadata_mismatch.length,1);assert.equal(loaded.package_metadata_mismatch[0].path,'package-info.txt');
 assert.equal((await stage(g.token,loaded.jobId,'request-1'))[0].state,'staged');assert.equal((await stage(g.token,loaded.jobId,'request-2'))[0].state,'staged');assert.equal((await finish(g.token,loaded.jobId))[0].state,'needs_reconciliation');
 const job=(await admin.query('SELECT archive,package_metadata_mismatch,state FROM rssd_import_jobs WHERE id=$1',[loaded.jobId])).rows[0];assert.deepEqual(job.archive,archive);assert.equal(job.package_metadata_mismatch.length,1);assert.equal(job.state,'needs_reconciliation');
 for(const table of ['rssd_submissions','rssd_works','rssd_demands','rssd_publications'])assert.equal((await admin.query('SELECT count(*)::int n FROM '+table+' WHERE "orgId"=$1',[f.org])).rows[0].n,0);
});

test('absolute original evidence references resolve uniquely to archived files',{timeout:120000},async t=>{
 const f=await fixture(t),archive=mutateArchive(f.archive,'absolute'),digest=createHash('sha256').update(archive).digest('hex'),g=await f.issuer.issue(f.ctx,{workspace:'space',site:'site',bundleDigest:digest,sourceProfile:PROFILE});
 const result=await trustedLoad(source,f.ctx,{token:g.token,archive,site:'site',workspace:'space'});assert.equal((await stage(g.token,result.jobId,'request-1'))[0].state,'staged');
});

async function runPrivateCli(config){
 const child=spawn(process.execPath,[join(work,'rssd/private-import-cli.mjs')],{stdio:['ignore','pipe','pipe','pipe']}),out=[],err=[];
 child.stdout.on('data',x=>out.push(x));child.stderr.on('data',x=>err.push(x));child.stdio[3].end(JSON.stringify(config));const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 const text=Buffer.concat(out).toString(),errors=Buffer.concat(err).toString();assert.equal(code,0,errors);assert(!text.includes(config.token)&&!errors.includes(config.token)&&!text.includes('SYNTHETIC PRIVATE')&&!errors.includes('SYNTHETIC PRIVATE'));return JSON.parse(text);
}
test('oversized archive fails with an actionable CLI message',{timeout:120000},async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-oversize-')),socketPath=join(dir,'socket'),archive=join(dir,'archive');t.after(()=>rm(dir,{recursive:true,force:true}));const f=await openFile(archive,'w');await f.truncate(32*1024*1024+1);await f.close();
 const socket=await createPrivateImportSocket({socketPath,service:{}});t.after(()=>socket.close());const child=spawn(process.execPath,[join(work,'rssd/private-import-cli.mjs')],{stdio:['ignore','pipe','pipe','pipe']}),err=[];child.stderr.on('data',x=>err.push(x));child.stdout.resume();child.stdio[3].end(JSON.stringify({socket:socketPath,token:'synthetic',archive,digest:'a'.repeat(64)}));const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});assert.notEqual(code,0);assert.match(Buffer.concat(err).toString(),/exceeds 32 MiB.*split or offline/);
});
test('protected Unix socket and original CLI recover interrupted import with restricted DB roles',{timeout:120000},async t=>{
 const f=await fixture(t),socketPath=join(f.paths.root,'..','import.sock'),adapter=new SecurePrivateImport(source,worker,{sourceUrl});
 let stagedSignal,releaseStage,holdFirst=true;const staged=new Promise(resolve=>{stagedSignal=resolve;}),hold=new Promise(resolve=>{releaseStage=resolve;});
 const service={open:(...args)=>adapter.open(...args),finish:(...args)=>adapter.finish(...args),async stage(...args){const result=await adapter.stage(...args);if(holdFirst){holdFirst=false;stagedSignal();await hold;}return result;}};
 const socket=await createPrivateImportSocket({socketPath,service});t.after(async()=>{releaseStage();await socket.close();});
 const base={socket:socketPath,token:f.grant.token,archive:f.paths.archive,root:f.paths.root,digest:f.paths.digest,site:'site',workspace:'space'};
 const child=spawn(process.execPath,[join(work,'rssd/private-import-cli.mjs')],{stdio:['ignore','pipe','pipe','pipe']});child.stdout.resume();child.stderr.resume();t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});child.stdio[3].end(JSON.stringify(base));
 await Promise.race([staged,exited.then(()=>{throw Error('CLI exited before first commit');})]);
 assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_private_review_items WHERE "orgId"=$1',[f.org])).rows[0].n,1);
 child.kill('SIGKILL');assert.deepEqual(await exited,{code:null,signal:'SIGKILL'});releaseStage();
 assert.deepEqual(await runPrivateCli(base),{state:'needs_reconciliation',items:2,staged:1,duplicates:1,package_metadata_mismatch:[]});
 assert.deepEqual(await runPrivateCli(base),{state:'needs_reconciliation',items:2,staged:0,duplicates:2,package_metadata_mismatch:[]});
});
test('a hung private role probe cannot block Nest startup or survive its deadline',{timeout:120000},async t=>{
 require('reflect-metadata');const bcryptPath=require.resolve('bcrypt');require.cache[bcryptPath]={id:bcryptPath,filename:bcryptPath,loaded:true,exports:{hashSync:()=>{throw Error('bcrypt unused');},compareSync:()=>{throw Error('bcrypt unused');}}};
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-hung-probe-')),script=join(dir,'hang.mjs');t.after(()=>rm(dir,{recursive:true,force:true}));const requireBase=new URL('file://'+join(work,'package.json')).href;await writeFile(script,`import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(requireBase)}),{Pool}=require('pg'),config=JSON.parse(readFileSync(3,'utf8')),pool=new Pool({connectionString:config.worker,application_name:'rssd-test-hung-probe'}),client=await pool.connect();try{await client.query('BEGIN');await client.query(\"SET LOCAL statement_timeout = '2500ms'\");await client.query('SELECT pg_sleep(30)');}finally{client.release();await pool.end();}`);let probePid;
 const servicePath=require.resolve(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.service.js'));const {RssdService}=require(servicePath),service=Object.create(RssdService.prototype);
 service.importEnabled=true;service.importGeneration=0;service.importStartupTimeoutMs=8000;service.importProbe=(config,options)=>runPrivateImportProbe(config,{...options,scriptPath:script,onSpawn:pid=>{probePid=pid;}});service.privateImport=null;service.importStatus='initializing';service.labels={close(){}};service.community={async close(){}};
 const names=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOCKET','RSSD_GOAL_MAINTENANCE_ENABLED','RSSD_DISPATCH_ENABLED'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));t.after(()=>{for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
 Object.assign(process.env,{RSSD_PRIVATE_IMPORT_DATABASE_URL:workerUrl,RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL:sourceUrl,RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL:issuerUrl,RSSD_PRIVATE_IMPORT_SOCKET:join(dir,'socket'),RSSD_GOAL_MAINTENANCE_ENABLED:'0',RSSD_DISPATCH_ENABLED:'0'});
 const oldError=console.error;console.error=()=>{};t.after(()=>{console.error=oldError;});const started=Date.now();service.onModuleInit();assert(Date.now()-started<200);
 const {Test}=require('@nestjs/testing'),{ThrottlerModule}=require('@nestjs/throttler'),{RssdController}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.controller.js'));const mod=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:service}]}).compile(),app=mod.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={admin:true,userId:'synthetic',orgId:'synthetic'};next();});await app.listen(0,'127.0.0.1');t.after(()=>app.close());const base=await app.getUrl();let active=0;for(let i=0;i<100&&active===0;i++){active=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='rssd-test-hung-probe' AND state='active'")).rows[0].n;if(!active)await new Promise(r=>setTimeout(r,20));}assert.equal(active,1);assert.equal(service.importStatus,'initializing');assert.doesNotThrow(()=>process.kill(probePid,0));assert.equal((await fetch(base+'/rssd/v1/identity')).status,200);assert.equal(service.importStatus,'initializing');
 for(let i=0;i<500&&service.importStatus!=='unavailable';i++)await new Promise(r=>setTimeout(r,20));assert.equal(service.importStatus,'unavailable');assert.equal(service.privateImport,null);assert(probePid>0);assert.throws(()=>process.kill(probePid,0));for(let i=0;i<100;i++){active=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='rssd-test-hung-probe'")).rows[0].n;if(!active)break;await new Promise(r=>setTimeout(r,20));}assert.equal(active,0);assert.equal((await fetch(base+'/rssd/v1/identity')).status,200);await new Promise(r=>setTimeout(r,100));assert.equal(service.importStatus,'unavailable');await service.onModuleDestroy();
});
test('a completely unresponsive probe is killed and reaped at its hard deadline',{timeout:120000},async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-probe-deadline-')),script=join(dir,'hang.mjs');t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(script,'setInterval(()=>{},1000)');let pid;
 await assert.rejects(runPrivateImportProbe({worker:'fixture',source:'fixture',issuer:'fixture'},{scriptPath:script,timeoutMs:150,onSpawn:value=>{pid=value;}}));assert(pid>0);assert.throws(()=>process.kill(pid,0));
});
test('late socket creation is closed after timeout and cannot become ready',async()=>{
 let closed=false;await assert.rejects(boundedSocket(()=>new Promise(resolve=>setTimeout(()=>resolve({async close(){closed=true;}}),80)),{timeoutMs:20}));await new Promise(r=>setTimeout(r,100));assert.equal(closed,true);
});
test('Nest shutdown and restart cannot overlap a disconnected old operation',{timeout:120000},async t=>{
 require('reflect-metadata');const bcryptPath=require.resolve('bcrypt');require.cache[bcryptPath]={id:bcryptPath,filename:bcryptPath,loaded:true,exports:{hashSync:()=>{throw Error('bcrypt unused');},compareSync:()=>{throw Error('bcrypt unused');}}};
 const {RssdService}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.service.js')),{RssdController}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.controller.js')),{Test}=require('@nestjs/testing'),{ThrottlerModule}=require('@nestjs/throttler'),adapter=require(join(work,'apps/backend/dist/rssd/private-import-secure-adapter.mjs')).SecurePrivateImport;
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-nest-restart-')),service=Object.create(RssdService.prototype);t.after(()=>rm(dir,{recursive:true,force:true}));Object.assign(service,{importEnabled:true,importGeneration:0,importProbe:runPrivateImportProbe,importStartupTimeoutMs:8000,privateImport:null,importStatus:'initializing',labels:{close(){}},community:{async close(){}}});
 const names=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOCKET','RSSD_GOAL_MAINTENANCE_ENABLED','RSSD_DISPATCH_ENABLED'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));t.after(async()=>{await service.onModuleDestroy();for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
 Object.assign(process.env,{RSSD_PRIVATE_IMPORT_DATABASE_URL:workerUrl,RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL:sourceUrl,RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL:issuerUrl,RSSD_PRIVATE_IMPORT_SOCKET:join(dir,'first'),RSSD_GOAL_MAINTENANCE_ENABLED:'0',RSSD_DISPATCH_ENABLED:'0'});
 const mod=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:service}]}).compile(),app=mod.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={admin:true,userId:'synthetic',orgId:'synthetic'};next();});await app.listen(0,'127.0.0.1');t.after(()=>app.close());const origin=await app.getUrl();
 const waitState=async expected=>{for(let n=0;n<500;n++){if(service.importStatus===expected)return;await new Promise(r=>setTimeout(r,20));}throw Error('state timeout');};let entered,unblock,finished;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{unblock=r;}),done=new Promise(r=>{finished=r;});const original=adapter.prototype.stage;adapter.prototype.stage=async()=>{entered();await blocked;finished();return {status:'duplicate'};};t.after(()=>{unblock();adapter.prototype.stage=original;});
 service.onModuleInit();await waitState('ready');const client=connect(process.env.RSSD_PRIVATE_IMPORT_SOCKET);client.on('error',()=>{});await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});client.write(JSON.stringify({method:'stage',token:'synthetic',jobId:'synthetic',ordinal:0})+'\n');await started;client.destroy();await new Promise(r=>client.once('close',r));
 const before=Date.now();await service.onModuleDestroy();assert(Date.now()-before<2000);process.env.RSSD_PRIVATE_IMPORT_SOCKET=join(dir,'second');service.importStatus='initializing';const quiet=console.error;console.error=()=>{};try{service.onModuleInit();await waitState('unavailable');}finally{console.error=quiet;}
 assert.equal((await fetch(origin+'/rssd/v1/identity')).status,200);assert.equal(service.privateImport,null);unblock();await done;await new Promise(r=>setImmediate(r));adapter.prototype.stage=original;
 process.env.RSSD_PRIVATE_IMPORT_SOCKET=join(dir,'third');service.importStatus='initializing';service.onModuleInit();await waitState('ready');assert.equal((await fetch(origin+'/rssd/v1/identity')).status,200);
});
test('Nest starts with protected role files and fails closed on a bad explicit file',{timeout:120000},async t=>{
 require('reflect-metadata');const bcryptPath=require.resolve('bcrypt');require.cache[bcryptPath]={id:bcryptPath,filename:bcryptPath,loaded:true,exports:{hashSync:()=>{throw Error('bcrypt unused');},compareSync:()=>{throw Error('bcrypt unused');}}};
 const {RssdService}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.service.js')),service=Object.create(RssdService.prototype),dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-secret-startup-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));Object.assign(service,{importEnabled:true,importGeneration:0,importProbe:runPrivateImportProbe,importStartupTimeoutMs:8000,privateImport:null,importStatus:'initializing',labels:{close(){}},community:{async close(){}}});
 const keys=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL'],names=[...keys,...keys.map(k=>k+'_FILE'),'RSSD_PRIVATE_IMPORT_SOCKET','RSSD_GOAL_MAINTENANCE_ENABLED','RSSD_DISPATCH_ENABLED'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 t.after(async()=>{await service.onModuleDestroy();for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
 for(const [i,url] of [workerUrl,sourceUrl,issuerUrl].entries()){const path=join(dir,'role-'+i);await writeFile(path,url,{mode:0o600});process.env[keys[i]+'_FILE']=path;process.env[keys[i]]='postgresql://invalid:invalid@localhost/invalid';}
 Object.assign(process.env,{RSSD_PRIVATE_IMPORT_SOCKET:join(dir,'socket'),RSSD_GOAL_MAINTENANCE_ENABLED:'0',RSSD_DISPATCH_ENABLED:'0'});
 const waitState=async expected=>{for(let n=0;n<400;n++){if(service.importStatus===expected)return;await new Promise(r=>setTimeout(r,20));}throw Error('state timeout');};
 service.onModuleInit();await waitState('ready');assert(service.privateImport);await service.onModuleDestroy();
 process.env[keys[0]]=workerUrl;process.env[keys[0]+'_FILE']=join(dir,'missing');service.importStatus='initializing';const quiet=console.error;console.error=()=>{};try{service.onModuleInit();await waitState('unavailable');}finally{console.error=quiet;}
 assert.equal(service.privateImport,null);assert.deepEqual(service.privateImportStatus({admin:true,userId:'synthetic'}),{state:'unavailable'});
});
test('SIGKILL leaves an old socket but private-import startup fails independently of the Nest backend',{timeout:120000},async t=>{
 require('reflect-metadata');const bcryptPath=require.resolve('bcrypt');require.cache[bcryptPath]={id:bcryptPath,filename:bcryptPath,loaded:true,exports:{hashSync:()=>{throw Error('bcrypt unused');},compareSync:()=>{throw Error('bcrypt unused');}}};
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-stale-socket-')),socketPath=join(dir,'socket');t.after(()=>rm(dir,{recursive:true,force:true}));
 const moduleUrl=new URL('file://'+join(work,'rssd/private-import-socket.mjs')).href,code=`import {createPrivateImportSocket} from ${JSON.stringify(moduleUrl)};await createPrivateImportSocket({socketPath:process.argv[1],service:{}});process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,socketPath],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('socket child exited early')));});child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));assert((await lstat(socketPath)).isSocket());
 const servicePath=require.resolve(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.service.js'));const {RssdService}=require(servicePath),service=Object.create(RssdService.prototype);
 service.importEnabled=true;service.importGeneration=0;service.importProbe=runPrivateImportProbe;service.importStartupTimeoutMs=8000;service.privateImport=null;service.importStatus='initializing';service.labels={close(){}};service.community={async close(){}};
 const names=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOCKET','RSSD_GOAL_MAINTENANCE_ENABLED','RSSD_DISPATCH_ENABLED'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));t.after(()=>{for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
 Object.assign(process.env,{RSSD_PRIVATE_IMPORT_DATABASE_URL:workerUrl,RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL:sourceUrl,RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL:issuerUrl,RSSD_PRIVATE_IMPORT_SOCKET:socketPath,RSSD_GOAL_MAINTENANCE_ENABLED:'0',RSSD_DISPATCH_ENABLED:'0'});
 const waitState=async expected=>{for(let n=0;n<300;n++){if(service.importStatus===expected)return;await new Promise(r=>setTimeout(r,20));}throw Error('state timeout');};
 const originalError=console.error;console.error=()=>{};try{service.onModuleInit();await waitState('unavailable');}finally{console.error=originalError;}assert.equal(service.privateImport,null);assert.deepEqual(service.privateImportStatus({admin:true,userId:'synthetic'}),{state:'unavailable'});
 const {Test}=require('@nestjs/testing'),{ThrottlerModule}=require('@nestjs/throttler'),{RssdController}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.controller.js'));
 const mod=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:service}]}).compile(),app=mod.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd={admin:true,userId:'synthetic',orgId:'synthetic'};next();});await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const base=await app.getUrl();assert.equal((await fetch(base+'/rssd/v1/identity')).status,200);const status=await fetch(base+'/rssd/v1/private-import/status');assert.equal(status.status,200);assert.deepEqual(await status.json(),{state:'unavailable'});
 // A new socket can start; a later database outage disables only this component.
 process.env.RSSD_PRIVATE_IMPORT_SOCKET=join(dir,'live-socket');service.importStatus='initializing';service.onModuleInit();await waitState('ready');assert.deepEqual(service.privateImportStatus({admin:true,userId:'synthetic'}),{state:'ready'});
 const adapter=require(join(work,'apps/backend/dist/rssd/private-import-secure-adapter.mjs')).SecurePrivateImport,originalOpen=adapter.prototype.open;adapter.prototype.open=async()=>{throw Object.assign(Error('synthetic offline'),{code:'P1001'});};t.after(()=>{adapter.prototype.open=originalOpen;});
 const request={method:'open',token:'a'.repeat(43),bundle:{archive:Buffer.from('x').toString('base64'),bundleDigest:createHash('sha256').update('x').digest('hex')}};
 const priorError=console.error;console.error=()=>{};try{await new Promise((resolve,reject)=>{const c=connect(process.env.RSSD_PRIVATE_IMPORT_SOCKET);c.on('connect',()=>c.write(JSON.stringify(request)+'\n'));c.on('data',()=>{});c.on('error',resolve);c.on('close',resolve);});await new Promise(r=>setTimeout(r,30));}finally{console.error=priorError;}
 assert.deepEqual(service.privateImportStatus({admin:true,userId:'synthetic'}),{state:'unavailable'});assert.equal((await fetch(base+'/rssd/v1/identity')).status,200);
 // Missing role configuration follows the same fail-open-for-Postiz path.
 delete process.env.RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL;service.importStatus='initializing';const quiet=console.error;console.error=()=>{};try{service.onModuleInit();await waitState('unavailable');}finally{console.error=quiet;}assert.deepEqual(service.privateImportStatus({admin:true,userId:'synthetic'}),{state:'unavailable'});assert.equal((await fetch(base+'/rssd/v1/identity')).status,200);await service.onModuleDestroy();
});
test('infrastructure errors disable import without treating invalid grants as outages',()=>{
 for(const error of [{code:'P1001'},{code:'RSSD_VERIFIER_UNAVAILABLE'},{code:'P2010',meta:{code:'08006'}},{code:'P2010',meta:{code:'42501',message:'permission denied for function'}}])assert.equal(isImportInfrastructureError(error),true);
 for(const error of [{code:'P2010',meta:{code:'42501',message:'authorization unavailable'}},{code:'P2010',meta:{code:'P0001',message:'private evidence mismatch'}}])assert.equal(isImportInfrastructureError(error),false);
});
test('database connection failure reports a generic private socket failure',{timeout:120000},async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-socket-failure-')),socketPath=join(dir,'socket');t.after(()=>rm(dir,{recursive:true,force:true}));let notified=false;
 const service={async open(){throw Object.assign(Error('synthetic database failure'),{code:'P1001'});}},server=await createPrivateImportSocket({socketPath,service,onFailure:()=>{notified=true;}});t.after(()=>server.close());
 const response=await new Promise((resolve,reject)=>{const c=connect(socketPath),chunks=[];c.on('connect',()=>c.write(JSON.stringify({method:'open',token:'synthetic',bundle:{archive:'',manifest:'',inventory:'',bundleDigest:'x'}})+'\n'));c.on('data',x=>chunks.push(x));c.on('error',reject);c.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));});
 assert.equal(notified,true);assert.deepEqual(response,{ok:false,code:'private_import_error'});
});
test('archive verifier is asynchronous, bounded and times out safely',{timeout:120000},async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-verifier-')),slow=join(dir,'slow.py'),large=join(dir,'large.py');t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(slow,"import sys,time,json;time.sleep(0.4);print(json.dumps({'digest':sys.argv[1]}))");await writeFile(large,"print('x'*10000)");
 let settled=false;const work=runArchiveVerifier(Buffer.from('x'),'fixture','site','space',PROFILE,{scriptPath:slow,timeoutMs:2000}).then(x=>{settled=true;return x;});await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal((await work).digest,'fixture');
 await assert.rejects(runArchiveVerifier(Buffer.from('x'),'fixture','site','space',PROFILE,{scriptPath:slow,timeoutMs:30}));await assert.rejects(runArchiveVerifier(Buffer.from('x'),'fixture','site','space',PROFILE,{scriptPath:large,maxOutput:100}),{code:'verifier_output_too_large'});
});
test('stream verifier limit codes survive worker transport without disclosing stderr',{timeout:120000},async t=>{
 const f=await fixture(t),dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-source-limit-')),wrapper=join(dir,'python3'),old=process.env.PATH;t.after(async()=>{process.env.PATH=old;await rm(dir,{recursive:true,force:true});});process.env.PATH=dir+':'+old;
 for(const [reported,expected] of [['archive_too_large','archive_too_large'],['expanded_archive_too_large','expanded_archive_too_large'],['evidence_too_large','evidence_too_large'],['metadata_too_large','metadata_too_large'],['archive_entries_exceeded','archive_entries_exceeded'],['frame_too_large','verifier_output_too_large'],['unknown_secret','private_import_error'],['metadata_too_large\\nprivate_secret','private_import_error']]){
  await writeFile(wrapper,`#!/bin/sh\nprintf 'PRIVATE_IMPORT_LIMIT:${reported}\\n' >&2\nexit 1\n`,{mode:0o700});await chmod(wrapper,0o700);
  await assert.rejects(runSourceProcess({sourceUrl,token:f.grant.token,archive:f.archive},{timeoutMs:5000}),error=>{assert.equal(error.code,expected);assert(!String(error).includes('private_secret'));return true;});
 }
 // An oversized individual frame is classified locally before it can be parsed.
 await writeFile(wrapper,`#!/bin/sh\nexec /usr/bin/python3 -c 'import sys; sys.stdout.write("x" * (33 * 1024 * 1024)); sys.stdout.flush()'\n`,{mode:0o700});await chmod(wrapper,0o700);
 await assert.rejects(runSourceProcess({sourceUrl,token:f.grant.token,archive:f.archive},{timeoutMs:15000}),{code:'verifier_output_too_large'});
 assert.equal((await admin.query('SELECT count(*)::int n FROM rssd_import_jobs WHERE org=$1',[f.org])).rows[0].n,0);
});
test('hung database cannot block Postiz event loop and child connection is closed',{timeout:10000},async t=>{
 const sockets=new Set(),server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.resume();});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of sockets)s.destroy();server.close();});const port=server.address().port,url=`postgresql://synthetic:synthetic@127.0.0.1:${port}/rssd_import_test?sslmode=disable`,start=Date.now();let ticked=false;setTimeout(()=>{ticked=true;},30);
 await assert.rejects(runSourceProcess({sourceUrl:url,token:'a'.repeat(43),archive:Buffer.from('synthetic')},{timeoutMs:2000}),{code:'source_outcome_unknown'});assert(ticked);assert(Date.now()-start<5000);for(let n=0;n<100&&sockets.size;n++)await new Promise(r=>setTimeout(r,20));assert.equal(sockets.size,0);
});
test('stuck verifier and its source worker are killed and reaped on deadline',{timeout:10000},async t=>{
 const f=await fixture(t),dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-source-hang-')),pidfile=join(dir,'pid'),wrapper=join(dir,'python3'),old=process.env.PATH;t.after(async()=>{process.env.PATH=old;await rm(dir,{recursive:true,force:true});});await writeFile(wrapper,`#!/bin/sh\nprintf '%s' "$$" > '${pidfile}'\nexec sleep 30\n`,{mode:0o700});await chmod(wrapper,0o700);process.env.PATH=dir+':'+old;
 const pending=runSourceProcess({sourceUrl,token:f.grant.token,archive:f.archive},{timeoutMs:2500});let pid;for(let n=0;n<100;n++){try{pid=Number(await readFile(pidfile,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}assert(pid>1);await assert.rejects(pending,{code:'source_outcome_unknown'});assert.throws(()=>process.kill(pid,0));
});
test('source worker kills its verifier if the Nest parent is SIGKILLed',{timeout:10000},async t=>{
 const f=await fixture(t),dir=await mkdtemp(join(await realpath(tmpdir()),'rssd-parent-death-')),pidfile=join(dir,'pids'),wrapper=join(dir,'python3'),archivePath=join(dir,'archive');t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(archivePath,f.archive);await writeFile(wrapper,`#!/bin/sh\nprintf '%s %s' "$$" "$PPID" > '${pidfile}'\nexec sleep 30\n`,{mode:0o700});
 const moduleUrl=new URL('file://'+join(work,'rssd/private-import-source-process.mjs')).href,code=`import {readFileSync} from 'node:fs';import {runSourceProcess} from ${JSON.stringify(moduleUrl)};const c=JSON.parse(readFileSync(3,'utf8'));await runSourceProcess({sourceUrl:c.url,token:c.token,archive:readFileSync(c.archive)});`,child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','ignore','pipe'],env:{...process.env,PATH:dir+':'+process.env.PATH}});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});child.stdio[3].end(JSON.stringify({url:sourceUrl,token:f.grant.token,archive:archivePath}));
 let pids;for(let n=0;n<150;n++){try{pids=(await readFile(pidfile,'utf8')).trim().split(' ').map(Number);break;}catch{await new Promise(r=>setTimeout(r,20));}}assert(pids?.length===2&&pids.every(x=>x>1));const closed=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await closed;
 const alive=pid=>{const r=spawnSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}),state=r.stdout.trim();return !!state&&!state.startsWith('Z');};for(let n=0;n<150&&pids.some(alive);n++)await new Promise(r=>setTimeout(r,20));assert.equal(pids.some(alive),false);
});
test('late abort after successful source process never signals a process group',{timeout:10000},async t=>{
 const f=await fixture(t),controller=new AbortController(),old=process.kill;let groupSignals=0;process.kill=function(pid,...args){if(pid<0)groupSignals++;return old.call(process,pid,...args);};
 try{const result=await runSourceProcess({sourceUrl,token:f.grant.token,archive:f.archive},{timeoutMs:3000,signal:controller.signal});assert.equal(result.items,2);controller.abort();await new Promise(r=>setTimeout(r,150));assert.equal(groupSignals,0);}finally{process.kill=old;}
});
test('lost Prisma COMMIT acknowledgment reconciles the same job without duplicate audit',{timeout:120000},async t=>{
 const f=await fixture(t),base=prismaPool(source);let lose=true;const proxy={query:(...args)=>base.query(...args),async connect(){const c=await base.connect();return {get commitStarted(){return c.commitStarted;},async query(sql,args){const result=await c.query(sql,args);if(sql==='COMMIT'&&lose){lose=false;throw Error('synthetic lost acknowledgement');}return result;},release:()=>c.release()};}};
 await assert.rejects(formalLoad(proxy,f.ctx,{token:f.grant.token,archive:f.archive,site:'site',workspace:'space'}),{code:'source_outcome_unknown'});const [job]=(await admin.query('SELECT id FROM rssd_import_jobs WHERE org=$1',[f.org])).rows;assert(job);const result=await runSourceProcess({sourceUrl,token:f.grant.token,archive:f.archive});assert.equal(result.jobId,job.id);assert.equal((await admin.query("SELECT count(*)::int n FROM rssd_import_audit WHERE org=$1 AND action='source_verified'",[f.org])).rows[0].n,1);
});
test('admin outcome is scoped, audited, and unknown until a source commit',{timeout:120000},async t=>{
 const f=await fixture(t),outcome=new PrivateImportOutcome(new RssdStore(owner));assert.deepEqual(await outcome.read(f.ctx,f.grant.grantId),{state:'unknown',mayStillBeInFlight:true,revoked:false});
 await assert.rejects(outcome.read({...f.ctx,orgId:randomUUID()},f.grant.grantId));await assert.rejects(outcome.read({...f.ctx,admin:false},f.grant.grantId));await assert.rejects(outcome.read({...f.ctx,workerId:'device'},f.grant.grantId));await assert.rejects(outcome.read({...f.ctx,workspaceIds:[]},f.grant.grantId));
 let entered,release;const locked=new Promise(r=>entered=r),barrier=new Promise(r=>release=r),base=prismaPool(source),proxy={query:(...args)=>base.query(...args),async connect(){const c=await base.connect();return {get commitStarted(){return c.commitStarted;},async query(sql,args){const result=await c.query(sql,args);if(sql.includes('WHERE token_hash=$1 FOR UPDATE')){entered();await barrier;}return result;},release:()=>c.release()};}};t.after(()=>release());
 const pending=formalLoad(proxy,f.ctx,{token:f.grant.token,archive:f.archive,site:'site',workspace:'space'});await locked;const observed=await Promise.race([outcome.read(f.ctx,f.grant.grantId),new Promise((_,reject)=>setTimeout(()=>reject(Error('outcome blocked by source transaction')),1000))]);assert.deepEqual(observed,{state:'unknown',mayStillBeInFlight:true,revoked:false});release();const job=await pending;
 const committed=await outcome.read(f.ctx,f.grant.grantId);assert.deepEqual(committed,{state:'committed',mayStillBeInFlight:true,revoked:false,jobId:job.jobId,reviewState:'staging'});
 let enteredAgain,releaseAgain;const lockedAgain=new Promise(r=>enteredAgain=r),barrierAgain=new Promise(r=>releaseAgain=r),retryProxy={query:(...args)=>base.query(...args),async connect(){const c=await base.connect();return {get commitStarted(){return c.commitStarted;},async query(sql,args){const result=await c.query(sql,args);if(sql.includes('WHERE token_hash=$1 FOR UPDATE')){enteredAgain();await barrierAgain;}return result;},release:()=>c.release()};}};t.after(()=>releaseAgain());
 const retry=formalLoad(retryProxy,f.ctx,{token:f.grant.token,archive:f.archive,site:'site',workspace:'space'});await lockedAgain;const duringRetry=await Promise.race([outcome.read(f.ctx,f.grant.grantId),new Promise((_,reject)=>setTimeout(()=>reject(Error('outcome blocked by retry')),1000))]);assert.deepEqual(duringRetry,{state:'committed',mayStillBeInFlight:true,revoked:false,jobId:job.jobId,reviewState:'staging'});releaseAgain();assert.equal((await retry).jobId,job.jobId);
 const [audit]=(await admin.query("SELECT count(*)::int n FROM rssd_import_audit WHERE org=$1 AND action='source_outcome_checked'",[f.org])).rows;assert.equal(audit.n,4);await admin.query('UPDATE "UserOrganization" SET disabled=true WHERE "userId"=$1',[f.actor]);await assert.rejects(outcome.read(f.ctx,f.grant.grantId));
});
test('issuer outages degrade only private import for issue and revoke; business denials keep it ready',{timeout:120000},async t=>{
 require('reflect-metadata');const bcryptPath=require.resolve('bcrypt');require.cache[bcryptPath]={id:bcryptPath,filename:bcryptPath,loaded:true,exports:{hashSync:()=>{throw Error('bcrypt unused');},compareSync:()=>{throw Error('bcrypt unused');}}};
 const {RssdService}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.service.js')),{RssdController}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.controller.js')),{Test}=require('@nestjs/testing'),{ThrottlerModule}=require('@nestjs/throttler');
 const f=await fixture(t),service=Object.create(RssdService.prototype);Object.assign(service,{importEnabled:true,importGeneration:0,importProbe:runPrivateImportProbe,importStartupTimeoutMs:8000,privateImport:null,importStatus:'initializing',labels:{close(){}},community:{async close(){}}});
 const names=['RSSD_PRIVATE_IMPORT_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL','RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL','RSSD_PRIVATE_IMPORT_SOCKET','RSSD_GOAL_MAINTENANCE_ENABLED','RSSD_DISPATCH_ENABLED'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 t.after(async()=>{await service.onModuleDestroy();for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
 Object.assign(process.env,{RSSD_PRIVATE_IMPORT_DATABASE_URL:workerUrl,RSSD_PRIVATE_IMPORT_SOURCE_DATABASE_URL:sourceUrl,RSSD_PRIVATE_IMPORT_ISSUER_DATABASE_URL:issuerUrl,RSSD_GOAL_MAINTENANCE_ENABLED:'0',RSSD_DISPATCH_ENABLED:'0'});
 const waitState=async expected=>{for(let n=0;n<500;n++){if(service.importStatus===expected)return;await new Promise(r=>setTimeout(r,20));}throw Error('state timeout');};let sequence=0;
 const start=async()=>{process.env.RSSD_PRIVATE_IMPORT_SOCKET=join(f.paths.root,'..','issuer-socket-'+(++sequence));service.importStatus='initializing';service.onModuleInit();await waitState('ready');};
 const mod=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:service}]}).compile(),app=mod.createNestApplication();app.useLogger(false);app.use((req,res,next)=>{req.rssd=f.ctx;next();});await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl(),url=origin+'/rssd/v1/private-import/grants',body={workspace:'space',site:'site',bundleDigest:f.paths.digest,sourceProfile:PROFILE},post=(path,data)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),status=()=>fetch(origin+'/rssd/v1/private-import/status').then(r=>r.json());
 await start();assert.equal((await post('/rssd/v1/private-import/grants',{...body,bundleDigest:'bad'})).status,403);assert.deepEqual(await status(),{state:'ready'});
 await admin.query('UPDATE "UserOrganization" SET disabled=true WHERE "userId"=$1',[f.actor]);try{assert.equal((await post('/rssd/v1/private-import/grants',body)).status,403);assert.deepEqual(await status(),{state:'ready'});}finally{await admin.query('UPDATE "UserOrganization" SET disabled=false WHERE "userId"=$1',[f.actor]);}
 assert.equal((await post('/rssd/v1/private-import/grants/'+randomUUID()+'/revoke',{})).status,404);assert.deepEqual(await status(),{state:'ready'});
 const quiet=console.error;console.error=()=>{};t.after(()=>{console.error=quiet;});
 for(const [privilege,path,data] of [['INSERT','/rssd/v1/private-import/grants',body],['SELECT','/rssd/v1/private-import/grants/'+f.grant.grantId+'/revoke',{}]]){
  if(service.importStatus!=='ready')await start();await admin.query(`REVOKE ${privilege} ON public.rssd_import_grants FROM rssd_restricted_grant_issuer`);
  try{assert.equal((await post(path,data)).status,500);await waitState('unavailable');assert.deepEqual(await status(),{state:'unavailable'});assert.equal((await post(path,data)).status,404);assert.equal((await fetch(origin+'/rssd/v1/identity')).status,200);}
  finally{await admin.query(`GRANT ${privilege} ON public.rssd_import_grants TO rssd_restricted_grant_issuer`);}
 }
 await start();service.importIssuerPrisma.$transaction=async()=>{throw Object.assign(Error('synthetic disconnect'),{code:'P1001'});};assert.equal((await post('/rssd/v1/private-import/grants',body)).status,500);await waitState('unavailable');assert.deepEqual(await status(),{state:'unavailable'});assert.equal((await fetch(origin+'/rssd/v1/identity')).status,200);
});
test('compiled Nest grant routes require a Postiz owner session and never expose an upload endpoint',{timeout:120000},async t=>{
 require('reflect-metadata');const cookieParser=require('cookie-parser'),{Test}=require('@nestjs/testing'),{ThrottlerModule}=require('@nestjs/throttler');
 const bcryptPath=require.resolve('bcrypt');require.cache[bcryptPath]={id:bcryptPath,filename:bcryptPath,loaded:true,exports:{hashSync:()=>{throw Error('bcrypt unused');},compareSync:()=>{throw Error('bcrypt unused');}}};
 const servicePath=require.resolve(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.service.js'));const {RssdService}=require(servicePath);
 const {RssdController}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.controller.js')),{RssdMiddleware}=require(join(work,'apps/backend/dist/apps/backend/src/rssd/rssd.middleware.js')),{AuthMiddleware}=require(join(work,'apps/backend/dist/apps/backend/src/services/auth/auth.middleware.js')),{AuthService}=require(join(work,'apps/backend/dist/libraries/helpers/src/auth/auth.service.js'));
 process.env.JWT_SECRET='synthetic-only-jwt-secret-000000000000000000000000';process.env.FRONTEND_URL='https://fixture.invalid';const f=await fixture(t);let role='ADMIN';
 const orgService={getOrgsByUserId:async id=>id===f.actor?[{id:f.org,apiKey:'synthetic',users:[{userId:id,role,disabled:false}]}]:[],updateApiKey:async()=>{throw Error('unexpected');}},userService={getUserById:async id=>id===f.actor?{id,activated:true,isSuperAdmin:false,email:'fixture@invalid'}:null};
 const middleware=new RssdMiddleware(new AuthMiddleware(orgService,userService),{store:{authenticate:async()=>({orgId:f.org,workerId:'synthetic-device',admin:false,workspaceIds:['space']})}}),service={privateImport:new (require(join(work,'apps/backend/dist/rssd/private-import-owner.mjs')).PrivateImportOwner)(issuerDb),privateImportOutcome:new (require(join(work,'apps/backend/dist/rssd/private-import-outcome.cjs')).PrivateImportOutcome)(new RssdStore(owner)),importStatus:'ready',privateImportStatus:RssdService.prototype.privateImportStatus};
 const mod=await Test.createTestingModule({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:100}])],controllers:[RssdController],providers:[{provide:RssdService,useValue:service}]}).compile();const app=mod.createNestApplication();app.useLogger(false);app.use(cookieParser());app.use((req,res,next)=>{if(!req.path.startsWith('/rssd/v1/'))return next();middleware.use(req,res,next).catch(e=>res.status(e.status||403).json({message:'Private import unavailable'}));});await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const origin=await app.getUrl(),url=origin+'/rssd/v1/private-import/grants',body=JSON.stringify({workspace:'space',site:'site',bundleDigest:f.paths.digest,sourceProfile:PROFILE}),cookie='auth='+AuthService.signJWT({id:f.actor})+'; showorg='+f.org;
 const post=headers=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body});assert.equal((await post({})).status,403);assert.equal((await post({cookie})).status,403);assert.equal((await post({cookie,origin:'https://invalid.example'})).status,403);assert.equal((await post({authorization:'Bearer device'})).status,403);
 const slow=join(f.paths.root,'verifier-delay.py');await writeFile(slow,"import sys,time,json;time.sleep(0.5);print(json.dumps({'digest':sys.argv[1]}))");let completed=false;const validating=runArchiveVerifier(Buffer.from('x'),'fixture','site','space',PROFILE,{scriptPath:slow,timeoutMs:3000}).then(value=>{completed=true;return value;});await new Promise(r=>setTimeout(r,40));const ordinary=await fetch(origin+'/rssd/v1/identity',{headers:{cookie}});assert.equal(ordinary.status,200);assert.equal(completed,false);await validating;
 const adminStatus=await fetch(origin+'/rssd/v1/private-import/status',{headers:{cookie}});assert.equal(adminStatus.status,200);assert.deepEqual(await adminStatus.json(),{state:'ready'});assert.equal((await fetch(origin+'/rssd/v1/private-import/status',{headers:{authorization:'Bearer device'}})).status,403);
 const response=await post({cookie,origin:'https://fixture.invalid'});assert.equal(response.status,201);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('location'),null);const grant=await response.json();assert.equal(grant.expiresIn,300);
 const saved=(await admin.query('SELECT token_hash,org,workspace,site,bundle,actor FROM rssd_import_grants WHERE id=$1',[grant.grantId])).rows[0];assert(!JSON.stringify(saved).includes(grant.token));assert.equal(saved.org,f.org);assert.equal(saved.bundle,f.paths.digest);
 const revoked=await fetch(url+'/'+grant.grantId+'/revoke',{method:'POST',headers:{'content-type':'application/json',cookie,origin:'https://fixture.invalid'},body:'{}'});assert.equal(revoked.status,201);assert.deepEqual(await revoked.json(),{revoked:true});
 role='USER';assert.equal((await post({cookie,origin:'https://fixture.invalid'})).status,403);role='ADMIN';service.privateImport=null;assert.equal((await post({cookie,origin:'https://fixture.invalid'})).status,404);
 const outcomeUrl=url+'/'+grant.grantId+'/outcome',result=await fetch(outcomeUrl,{headers:{cookie}});assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-store/);const outcome=await result.json();assert.deepEqual(outcome,{state:'unknown',mayStillBeInFlight:true,revoked:true});assert(!JSON.stringify(outcome).includes(grant.token));assert.equal((await fetch(outcomeUrl,{headers:{authorization:'Bearer device'}})).status,403);assert.equal((await fetch(outcomeUrl)).status,403);const foreign=await fixture(t);assert.equal((await fetch(url+'/'+foreign.grant.grantId+'/outcome',{headers:{cookie}})).status,404);
 assert.equal((await fetch(origin+'/rssd/v1/private-import/upload',{method:'POST',headers:{'content-type':'application/json',cookie,origin:'https://fixture.invalid'},body:'{}'})).status,404);assert.equal((await fetch(origin+'/rssd/public/v1/private-import/grants',{method:'POST'})).status,404);
});
