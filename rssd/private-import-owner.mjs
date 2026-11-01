// Authenticated Postiz owner grant management only; no worker staging methods.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {validateSourceProfile} from './private-import-profile.mjs';
const require=createRequire(import.meta.url),p=require('./protocol.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=403,code='forbidden')=>p.fail(message,status,code);
export class PrivateImportOwner {
 constructor(prisma){this.prisma=prisma;}
 async transaction(fn){return this.prisma.$transaction(async tx=>fn({query:async(sql,args=[])=>{const returns=/^\s*SELECT\b/i.test(sql)||/\bRETURNING\b/i.test(sql);if(returns){const rows=await tx.$queryRawUnsafe(sql,...args);return {rows,rowCount:rows.length};}return {rows:[],rowCount:await tx.$executeRawUnsafe(sql,...args)};}}),{timeout:60000});}
 async authorize(db,g){const [row]=(await db.query('SELECT public.rssd_restricted_import_authorize($1,$2,$3,$4) AS ok',[g.org,g.actor,g.workspace,g.site])).rows;if(!row?.ok)fail('Owner, workspace or site authorization is no longer valid');}
 async issue(ctx,{workspace,site,bundleDigest,sourceProfile,ttlSeconds=300}){
  if(!ctx?.admin||!ctx.userId||ctx.workerId||!ctx.orgId||!(ctx.workspaceIds===null||Array.isArray(ctx.workspaceIds)&&ctx.workspaceIds.includes(workspace))||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>300||!/^[a-f0-9]{64}$/.test(bundleDigest||''))fail('Owner session and bounded grant required');p.id(workspace);p.id(site);
  let profile;try{profile=validateSourceProfile(sourceProfile);}catch{fail('Invalid source profile',400,'invalid_source_profile');}
  const token=randomBytes(32).toString('base64url'),id=randomUUID(),g={org:ctx.orgId,workspace,site,bundle:bundleDigest,actor:ctx.userId};
  return this.transaction(async db=>{await this.authorize(db,g);await db.query("INSERT INTO rssd_import_grants(id,token_hash,org,workspace,site,bundle,actor,source_profile,expires) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,clock_timestamp()+($9::int*interval '1 second'))",[id,sha(token),g.org,workspace,site,bundleDigest,g.actor,JSON.stringify(profile),ttlSeconds]);await db.query("INSERT INTO rssd_import_audit(org,workspace,actor,action) VALUES($1,$2,$3,'grant_created')",[g.org,workspace,g.actor]);return {grantId:id,token,expiresIn:ttlSeconds};});
 }
 async revoke(ctx,grantId){
  if(!ctx?.admin||!ctx.userId||ctx.workerId||!ctx.orgId||typeof grantId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(grantId))fail('Owner session required');
  return this.transaction(async db=>{const [g]=(await db.query('SELECT * FROM rssd_import_grants WHERE id=$1 AND org=$2 FOR UPDATE',[grantId,ctx.orgId])).rows;if(!g||!(ctx.workspaceIds===null||Array.isArray(ctx.workspaceIds)&&ctx.workspaceIds.includes(g.workspace)))fail('Private record unavailable',404,'not_found');await this.authorize(db,{...g,actor:ctx.userId});if(g.state!=='revoked'){await db.query("UPDATE rssd_import_grants SET state='revoked' WHERE id=$1",[g.id]);await db.query("INSERT INTO rssd_import_audit(org,workspace,actor,action,job_id) VALUES($1,$2,$3,'grant_revoked',$4)",[g.org,g.workspace,ctx.userId,g.job_id]);}return {revoked:true};});
 }
}
