// Isolation prototype only. Trusted backend verifier holds privileged DB access.
// Never expose this as a public or worker-accessible endpoint.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateSourceProfile} from './private-import-profile.mjs';
import {MAX_ARCHIVE_BYTES,MAX_VERIFIER_OUTPUT_BYTES} from './private-import-limits.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
// Streaming I/O keeps the Nest event loop responsive while the verifier runs.
// The bounded output is accumulated for structured decoding; production memory
// limits still require independent assessment before enabling the feature.
export function runArchiveVerifier(archive,digest,site,workspace,profile,{scriptPath=fileURLToPath(new URL('./private-import-verified-archive.py',import.meta.url)),timeoutMs=120000,maxOutput=MAX_VERIFIER_OUTPUT_BYTES}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn('python3',[scriptPath,digest,site,workspace],{stdio:['pipe','pipe','pipe','pipe']}),chunks=[],errors=[];let size=0,stderrSize=0,failed=false,unavailable=false,outputLimit=false;
  const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},timeoutMs);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxOutput){failed=true;outputLimit=true;child.kill('SIGKILL');}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{stderrSize+=chunk.length;if(stderrSize>8192){failed=true;child.kill('SIGKILL');}else errors.push(chunk);});
  child.stdin.on('error',()=>{});child.stdio[3].on('error',()=>{});child.stdio[3].end(JSON.stringify(profile));
  child.once('error',error=>{failed=true;unavailable=error?.code==='ENOENT';});
  child.once('close',code=>{clearTimeout(timer);if(failed||code!==0){const match=/^PRIVATE_IMPORT_LIMIT:(archive_too_large|expanded_archive_too_large|evidence_too_large|metadata_too_large|archive_entries_exceeded)\s*$/.exec(Buffer.concat(errors).toString('utf8'));const failure=unavailable?'RSSD_VERIFIER_UNAVAILABLE':outputLimit?'verifier_output_too_large':match?.[1];return reject(Object.assign(Error('archive validation failed'),failure?{code:failure}:{}));}try{resolve(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));}catch{return reject(Error('archive validation failed'));}});
  child.stdin.end(archive);
 });
}
export async function trustedLoad(prisma,ctx,{token,archive,site,workspace}) {
 if(!ctx?.admin || !ctx.orgId || !ctx.userId || ctx.workerId || !(ctx.workspaceIds===null || Array.isArray(ctx.workspaceIds)&&ctx.workspaceIds.includes(workspace)))throw Error('owner session required');
 if(Buffer.isBuffer(archive)&&archive.length>MAX_ARCHIVE_BYTES)throw Object.assign(Error('Archive exceeds limit'),{code:'archive_too_large'});
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!Buffer.isBuffer(archive))throw Error('invalid source input');
 const digest=sha(archive),[preview]=await prisma.$queryRawUnsafe('SELECT *,expires>clock_timestamp() AS valid FROM rssd_import_grants WHERE token_hash=$1',sha(token));
 if(!preview||!preview.valid||!['issued','used'].includes(preview.state)||preview.org!==ctx.orgId||preview.actor!==ctx.userId||preview.workspace!==workspace||preview.site!==site||preview.bundle!==digest)throw Error('authorization unavailable');
 const profile=validateSourceProfile(preview.source_profile),verified=await runArchiveVerifier(archive,digest,site,workspace,profile);
 if(verified.digest!==digest)throw Error('archive verification mismatch');
 const manifest=Buffer.from(verified.manifest,'base64'),inventory=Buffer.from(verified.inventory,'base64');
 return prisma.$transaction(async tx=>{
  const rows=await tx.$queryRawUnsafe('SELECT *,expires>clock_timestamp() AS valid FROM rssd_import_grants WHERE token_hash=$1 FOR UPDATE',sha(token));const g=rows[0];
  if(!g||!g.valid||!['issued','used'].includes(g.state)||g.org!==ctx.orgId||g.actor!==ctx.userId||g.workspace!==workspace||g.site!==site||g.bundle!==digest||canonical(g.source_profile)!==canonical(profile))throw Error('authorization unavailable');
  const [member]=await tx.$queryRawUnsafe('SELECT public.rssd_restricted_import_authorize($1,$2,$3,$4) AS ok',g.org,g.actor,workspace,site);if(!member.ok)throw Error('authorization unavailable');
  const id=randomUUID();await tx.$executeRawUnsafe(`INSERT INTO rssd_import_jobs(id,org,workspace,site,bundle,actor,archive,manifest,inventory,manifest_hash,inventory_hash,package_metadata_mismatch,source_profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) ON CONFLICT(org,workspace,bundle) DO NOTHING`,id,g.org,workspace,site,digest,g.actor,archive,manifest,inventory,sha(manifest),sha(inventory),JSON.stringify(verified.package_metadata_mismatch),JSON.stringify(profile));
  const [job]=await tx.$queryRawUnsafe('SELECT * FROM rssd_import_jobs WHERE org=$1 AND workspace=$2 AND site=$3 AND bundle=$4 FOR UPDATE',g.org,workspace,site,digest);
  if(!job||sha(job.archive)!==digest||sha(job.manifest)!==sha(manifest)||sha(job.inventory)!==sha(inventory)||canonical(job.package_metadata_mismatch)!==canonical(verified.package_metadata_mismatch)||canonical(job.source_profile)!==canonical(profile)||(g.job_id&&g.job_id!==job.id))throw Error('source conflict');
  for(const [ordinal,item] of verified.items.entries()){
   const files=item.files.map(({path,sha256,bytes})=>({path,sha256,bytes})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const fingerprint=sha(Buffer.from(canonical({org:g.org,workspace,site,legacyKey:item.legacyKey,articleId:item.articleId,bundleDigest:digest,metadata:item.metadata,files})));
   const paths=item.files.map(f=>f.path).sort();await tx.$executeRawUnsafe('INSERT INTO rssd_verified_items(job_id,ordinal,legacy_key,article_id,metadata,expected_paths,compat_fingerprint) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT DO NOTHING',job.id,ordinal,item.legacyKey,item.articleId,JSON.stringify(item.metadata),JSON.stringify(paths),fingerprint);
   const [stored]=await tx.$queryRawUnsafe('SELECT * FROM rssd_verified_items WHERE job_id=$1 AND legacy_key=$2',job.id,item.legacyKey);
   if(!stored||stored.ordinal!==ordinal||stored.article_id!==item.articleId||stored.compat_fingerprint!==fingerprint||canonical(stored.metadata)!==canonical(item.metadata)||canonical(stored.expected_paths)!==canonical(paths))throw Error('item conflict');
   for(const f of item.files){
    const bytes=Buffer.from(f.data,'base64');if(bytes.length!==f.bytes||sha(bytes)!==f.sha256)throw Error('evidence conflict');
    await tx.$executeRawUnsafe('INSERT INTO rssd_verified_files(job_id,legacy_key,path,sha256,bytes,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',job.id,item.legacyKey,f.path,f.sha256,f.bytes,bytes);
    const [saved]=await tx.$queryRawUnsafe('SELECT sha256,bytes,data FROM rssd_verified_files WHERE job_id=$1 AND legacy_key=$2 AND path=$3',job.id,item.legacyKey,f.path);
    if(!saved||saved.sha256!==f.sha256||saved.bytes!==f.bytes||!Buffer.from(saved.data).equals(bytes))throw Error('evidence conflict');
   }
   const [{n}]=await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_verified_files WHERE job_id=$1 AND legacy_key=$2',job.id,item.legacyKey);if(n!==item.files.length)throw Error('unexpected evidence');
  }
  const [{n}]=await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM rssd_verified_items WHERE job_id=$1',job.id);if(n!==verified.items.length)throw Error('unexpected source item');
  if(!g.job_id){await tx.$executeRawUnsafe("UPDATE rssd_import_grants SET state='used',job_id=$2 WHERE id=$1",g.id,job.id);await tx.$executeRawUnsafe("INSERT INTO rssd_import_audit(org,workspace,actor,action,job_id) VALUES($1,$2,$3,'source_verified',$4)",g.org,workspace,g.actor,job.id);}
  const [{valid}]=await tx.$queryRawUnsafe('SELECT expires>clock_timestamp() AS valid FROM rssd_import_grants WHERE id=$1',g.id);if(!valid)throw Error('authorization unavailable');
  return {jobId:job.id,items:n,package_metadata_mismatch:verified.package_metadata_mismatch};
 },{timeout:120000});
}
