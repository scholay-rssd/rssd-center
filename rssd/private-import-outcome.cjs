'use strict';
const p=require('./protocol.cjs');
function missing(){p.fail('Private record unavailable',404,'not_found');}
class PrivateImportOutcome {
 constructor(store){this.store=store;}
 async read(ctx,id){
  if(!ctx?.admin||!ctx.orgId||!ctx.userId||ctx.workerId)p.fail('Owner session required',403,'forbidden');
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))missing();
  return this.store.transaction(async db=>{
   await db.$executeRawUnsafe("SET LOCAL statement_timeout = '5000ms'");
   // MVCC read does not wait for an in-flight source transaction. Its absence
   // is always unknown; state/revocation reflects the last committed snapshot.
   const [g]=await db.$queryRawUnsafe('SELECT id,org,workspace,site,state,job_id FROM rssd_import_grants WHERE id=$1 AND org=$2',id,ctx.orgId);
   if(!g||!(ctx.workspaceIds===null||Array.isArray(ctx.workspaceIds)&&ctx.workspaceIds.includes(g.workspace)))missing();
   const [member]=await db.$queryRawUnsafe(`SELECT true AS ok FROM public."UserOrganization" m JOIN public."User" u ON u.id=m."userId" JOIN public."Organization" o ON o.id=m."organizationId" JOIN public.rssd_workspaces w ON w."orgId"=o.id AND w.id=$3 WHERE m."organizationId"=$1 AND m."userId"=$2 AND NOT m.disabled AND m.role IN ('ADMIN','SUPERADMIN') AND u.activated AND u."deletedAt" IS NULL AND o."deletedAt" IS NULL AND w.payload->>'siteId'=$4 FOR SHARE OF m,u,o,w`,g.org,ctx.userId,g.workspace,g.site);if(!member?.ok)missing();
   let result={state:'unknown',mayStillBeInFlight:true,revoked:g.state==='revoked'};
   if(g.job_id){const [j]=await db.$queryRawUnsafe('SELECT id,state FROM rssd_import_jobs WHERE id=$1 AND org=$2 AND workspace=$3 AND site=$4',g.job_id,g.org,g.workspace,g.site);if(!j)missing();result={state:'committed',mayStillBeInFlight:true,revoked:g.state==='revoked',jobId:j.id,reviewState:j.state};}
   await db.$executeRawUnsafe("INSERT INTO rssd_import_audit(org,workspace,actor,action,job_id) VALUES($1,$2,$3,'source_outcome_checked',$4)",g.org,g.workspace,ctx.userId,g.job_id);return result;
  });
 }
}
module.exports={PrivateImportOutcome};
