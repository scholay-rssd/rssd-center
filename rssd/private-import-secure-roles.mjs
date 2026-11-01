// Fail closed before binding the private socket if DB credentials are overbroad.
export async function assertSecureImportRole(db,kind){
 if(!['worker','source','issuer'].includes(kind))throw Error('Invalid role kind');
 const [r]=await db.$queryRawUnsafe(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,
  pg_has_role(current_user,'rssd_restricted_import_worker','member') AS worker,
  pg_has_role(current_user,'rssd_restricted_source_loader','member') AS source,
  pg_has_role(current_user,'rssd_restricted_grant_issuer','member') AS issuer,
  EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname IN ('rssd_restricted_import_definer','rssd_restricted_auth_definer','rssd_private_import_worker') AND pg_has_role(current_user,x.oid,'member')) AS privileged_member,
  EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(current_user,n.oid,'CREATE')) AS schema_create
  FROM pg_roles r WHERE r.rolname=current_user`);
 const fail=()=>{throw Error('Private import database role is not restricted');};
 if(!r||r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolbypassrls||r.rolreplication||r.schema_create||r.privileged_member||r.worker!==(kind==='worker')||r.source!==(kind==='source')||r.issuer!==(kind==='issuer'))fail();
 const allow=kind==='source'?['rssd_import_grants','rssd_import_jobs','rssd_verified_items','rssd_verified_files','rssd_import_audit']:kind==='issuer'?['rssd_import_grants','rssd_import_audit']:[];
 const [priv]=await db.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f')
  AND NOT (n.nspname='public' AND c.relname=ANY($1::text[])) AND
  (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS excessive`,allow);
 if(priv.excessive)fail();
 if(kind==='source'||kind==='issuer'){
  const [bad]=await db.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND
    (has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
     (c.relname='rssd_import_grants' AND $2::text='source' AND has_any_column_privilege(current_user,c.oid,'INSERT')) OR
     (c.relname='rssd_import_audit' AND has_any_column_privilege(current_user,c.oid,'SELECT')))) AS dangerous,
   EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
    AND has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')
    AND NOT ((c.relname='rssd_import_grants' AND a.attname IN ('state','job_id')) OR (c.relname='rssd_import_jobs' AND a.attname='state'))) AS extra_update`,allow,kind);
  if(bad.dangerous||bad.extra_update)fail();
 }
 if(kind==='source'){
  const [f]=await db.$queryRawUnsafe(`SELECT has_function_privilege(current_user,'public.rssd_restricted_import_authorize(text,text,text,text)','EXECUTE') AS authorize`);
  if(!f.authorize)fail();
 }
 if(kind==='issuer')await assertGrantIssuerPermissions(db);
 if(kind==='worker'){
  const [f]=await db.$queryRawUnsafe(`SELECT has_function_privilege(current_user,'public.rssd_restricted_stage_index(text,text,integer)','EXECUTE') AS stage,has_function_privilege(current_user,'public.rssd_restricted_finish(text,text)','EXECUTE') AS finish`);
  if(!f.stage||!f.finish)fail();
 }
}

export async function assertGrantIssuerPermissions(db){
 const [r]=await db.$queryRawUnsafe(`SELECT
  has_function_privilege(current_user,'public.rssd_restricted_import_authorize(text,text,text,text)','EXECUTE') AS authorize,
  has_table_privilege(current_user,'public.rssd_import_grants','SELECT') AS read_grants,
  has_table_privilege(current_user,'public.rssd_import_grants','INSERT') AS issue_grants,
  has_column_privilege(current_user,'public.rssd_import_grants','state','UPDATE') AS revoke_grants,
  has_table_privilege(current_user,'public.rssd_import_audit','INSERT') AS write_audit`);
 if(!r||!r.authorize||!r.read_grants||!r.issue_grants||!r.revoke_grants||!r.write_audit)throw Error('Private import grant issuer is not configured');
}
