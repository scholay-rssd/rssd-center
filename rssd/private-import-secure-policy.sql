BEGIN;
-- ISOLATED PROTOTYPE ONLY. Install via trusted database owner after base schema.
CREATE TABLE public.rssd_verified_items (
 job_id TEXT NOT NULL REFERENCES public.rssd_import_jobs(id), ordinal INTEGER NOT NULL CHECK(ordinal>=0), legacy_key TEXT NOT NULL,
 article_id TEXT NOT NULL, metadata JSONB NOT NULL, expected_paths JSONB NOT NULL, compat_fingerprint TEXT NOT NULL,
 PRIMARY KEY(job_id,legacy_key),UNIQUE(job_id,ordinal));
CREATE TABLE public.rssd_verified_files (
 job_id TEXT NOT NULL, legacy_key TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL, data BYTEA NOT NULL, PRIMARY KEY(job_id,legacy_key,path),
 FOREIGN KEY(job_id,legacy_key) REFERENCES public.rssd_verified_items(job_id,legacy_key));
ALTER TABLE public.rssd_import_jobs ADD COLUMN package_metadata_mismatch JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.rssd_import_jobs ADD COLUMN source_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE ROLE rssd_restricted_import_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
-- Trusted, internal archive verifier; never give these privileges to a worker.
CREATE ROLE rssd_restricted_source_loader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE rssd_restricted_grant_issuer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE rssd_restricted_auth_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE rssd_restricted_import_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO rssd_restricted_auth_definer,rssd_restricted_import_definer,rssd_restricted_source_loader,rssd_restricted_grant_issuer;
-- UPDATE on one identity column is required for PostgreSQL row locking; the
-- static definer function exposes no mutation operation or dynamic SQL.
GRANT SELECT,UPDATE ("userId") ON public."UserOrganization" TO rssd_restricted_auth_definer;
GRANT SELECT,UPDATE (id) ON public."User",public."Organization",public.rssd_workspaces TO rssd_restricted_auth_definer;
CREATE FUNCTION public.rssd_restricted_import_authorize(p_org text,p_user text,p_workspace text,p_site text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $auth$
DECLARE allowed boolean;
BEGIN
 SELECT true INTO allowed FROM public."UserOrganization" m
 JOIN public."User" u ON u.id=m."userId" JOIN public."Organization" o ON o.id=m."organizationId"
 JOIN public.rssd_workspaces w ON w."orgId"=o.id AND w.id=p_workspace
 WHERE m."organizationId"=p_org AND m."userId"=p_user AND NOT m.disabled
 AND m.role IN ('ADMIN','SUPERADMIN') AND u.activated AND u."deletedAt" IS NULL
 AND o."deletedAt" IS NULL AND w.payload->>'siteId'=p_site FOR SHARE OF m,u,o,w;
 RETURN coalesce(allowed,false);
END $auth$;
ALTER FUNCTION public.rssd_restricted_import_authorize(TEXT,TEXT,TEXT,TEXT) OWNER TO rssd_restricted_auth_definer;
REVOKE ALL ON FUNCTION public.rssd_restricted_import_authorize(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rssd_restricted_import_authorize(TEXT,TEXT,TEXT,TEXT) TO rssd_restricted_import_definer,rssd_restricted_source_loader,rssd_restricted_grant_issuer;
GRANT SELECT ON public.rssd_import_grants,public.rssd_import_jobs,public.rssd_import_items,public.rssd_verified_items,public.rssd_verified_files,public.rssd_private_review_items,public.rssd_private_review_files TO rssd_restricted_import_definer;
GRANT UPDATE (state) ON public.rssd_import_grants,public.rssd_import_jobs TO rssd_restricted_import_definer;
GRANT INSERT ON public.rssd_import_items,public.rssd_import_audit,public.rssd_private_review_items,public.rssd_private_review_files TO rssd_restricted_import_definer;
GRANT SELECT ON public.rssd_import_grants,public.rssd_import_jobs,public.rssd_verified_items,public.rssd_verified_files TO rssd_restricted_source_loader;
GRANT INSERT ON public.rssd_import_jobs,public.rssd_verified_items,public.rssd_verified_files,public.rssd_import_audit TO rssd_restricted_source_loader;
GRANT UPDATE (state,job_id) ON public.rssd_import_grants TO rssd_restricted_source_loader;
GRANT UPDATE (state) ON public.rssd_import_jobs TO rssd_restricted_source_loader;
GRANT SELECT,INSERT ON public.rssd_import_grants TO rssd_restricted_grant_issuer;
GRANT UPDATE (state,job_id) ON public.rssd_import_grants TO rssd_restricted_grant_issuer;
GRANT INSERT ON public.rssd_import_audit TO rssd_restricted_grant_issuer;
REVOKE ALL ON public.rssd_import_grants,public.rssd_import_jobs,public.rssd_import_items,public.rssd_import_audit,public.rssd_verified_items,public.rssd_verified_files,public.rssd_private_review_items,public.rssd_private_review_files FROM PUBLIC,rssd_restricted_import_worker;
GRANT USAGE ON SCHEMA public TO rssd_restricted_import_worker;
CREATE FUNCTION public.rssd_bound_import_grant(p_token TEXT,p_job TEXT) RETURNS public.rssd_import_grants
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g public.rssd_import_grants;
BEGIN
 IF p_token !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'authorization unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM public.rssd_import_grants WHERE token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') FOR UPDATE;
 IF NOT FOUND OR g.state<>'used' OR g.expires<=clock_timestamp() OR g.job_id IS DISTINCT FROM p_job
  OR NOT public.rssd_restricted_import_authorize(g.org,g.actor,g.workspace,g.site)
  OR NOT EXISTS(SELECT 1 FROM public.rssd_import_jobs j WHERE j.id=g.job_id AND j.org=g.org AND j.workspace=g.workspace AND j.site=g.site AND j.bundle=g.bundle AND j.source_profile=g.source_profile)
 THEN RAISE EXCEPTION 'authorization unavailable' USING ERRCODE='42501'; END IF;
 RETURN g;
END $f$;
ALTER FUNCTION public.rssd_bound_import_grant(TEXT,TEXT) OWNER TO rssd_restricted_import_definer;
REVOKE ALL ON FUNCTION public.rssd_bound_import_grant(TEXT,TEXT) FROM PUBLIC,rssd_restricted_import_worker;
CREATE FUNCTION public.rssd_restricted_stage(p_token TEXT,p_job TEXT,p_legacy_key TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g public.rssd_import_grants; j public.rssd_import_jobs; it public.rssd_verified_items; metadata JSONB; item_count INTEGER; actual_files INTEGER; prep JSONB; receipt JSONB; rid TEXT; old public.rssd_private_review_items; n INTEGER; required TEXT[]:='{}'::text[]; ref TEXT; rel TEXT; matches INTEGER;
BEGIN
 g:=public.rssd_bound_import_grant(p_token,p_job);
 SELECT * INTO STRICT j FROM public.rssd_import_jobs WHERE id=g.job_id FOR UPDATE;
 IF encode(sha256(j.archive),'hex')<>j.bundle OR encode(sha256(j.manifest),'hex')<>j.manifest_hash OR encode(sha256(j.inventory),'hex')<>j.inventory_hash THEN RAISE EXCEPTION 'source evidence mismatch'; END IF;
 SELECT * INTO it FROM public.rssd_verified_items WHERE job_id=p_job AND legacy_key=p_legacy_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'private item unavailable' USING ERRCODE='42501'; END IF;
 IF it.compat_fingerprint !~ '^[a-f0-9]{64}$' OR p_legacy_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR it.article_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR octet_length(convert_to(it.metadata::text,'UTF8'))>2000000 THEN RAISE EXCEPTION 'invalid evidence identity'; END IF;
 SELECT count(*),min(value::text)::jsonb INTO item_count,metadata FROM jsonb_array_elements(convert_from(j.inventory,'UTF8')::jsonb->'items') x(value) WHERE value->>'requestKey'=p_legacy_key;
 IF item_count<>1 OR metadata IS DISTINCT FROM it.metadata OR metadata->>'articleId' IS DISTINCT FROM it.article_id OR metadata->>'siteId' IS DISTINCT FROM g.site OR metadata->>'spaceId' IS DISTINCT FROM g.workspace THEN RAISE EXCEPTION 'original identity mismatch'; END IF;
 IF jsonb_typeof(it.expected_paths)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(it.expected_paths) z(v) WHERE jsonb_typeof(v)<>'string') OR (SELECT count(*) FROM jsonb_array_elements_text(it.expected_paths))<>(SELECT count(DISTINCT v) FROM jsonb_array_elements_text(it.expected_paths) z(v)) THEN RAISE EXCEPTION 'invalid evidence list'; END IF;
 IF jsonb_typeof(it.metadata->'paths'->'copied') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid original paths'; END IF;
 FOR rel IN SELECT value FROM jsonb_array_elements_text(it.metadata->'paths'->'copied') LOOP
  IF rel='' OR rel LIKE '/%' OR position(chr(92) IN rel)>0 OR string_to_array(rel,'/') && ARRAY['.','..','']::text[] OR rel=ANY(required) THEN RAISE EXCEPTION 'invalid original paths'; END IF;
  required:=array_append(required,rel);
 END LOOP;
 FOR ref IN
  SELECT value FROM jsonb_array_elements_text(coalesce(it.metadata->'annex'->'files','[]'::jsonb))
  UNION ALL SELECT value FROM jsonb_array_elements_text(coalesce(it.metadata->'imageRights'->'files','[]'::jsonb))
  UNION ALL SELECT value FROM jsonb_array_elements_text(coalesce(it.metadata->'editorialBackup'->'files','[]'::jsonb))
  UNION ALL SELECT it.metadata->'manuscript'->>'preparedPath' WHERE coalesce(it.metadata->'manuscript'->>'preparedPath','')<>''
  UNION ALL SELECT it.metadata->'notes'->>'internalNotesPath' WHERE coalesce((it.metadata->'notes'->>'present')::boolean,false)
 LOOP
  IF ref IS NULL OR ref='' OR position(chr(92) IN ref)>0 OR array_position(string_to_array(ref,'/'),'..') IS NOT NULL THEN RAISE EXCEPTION 'invalid evidence reference'; END IF;
  SELECT count(*),min(substring(v->>'path' FROM 7)) INTO matches,rel FROM jsonb_array_elements(convert_from(j.manifest,'UTF8')::jsonb->'files') m(v)
   WHERE v->>'path' LIKE 'files/%' AND (ref=substring(v->>'path' FROM 7) OR right(ref,length(v->>'path')-5)='/'||substring(v->>'path' FROM 7));
  IF matches<>1 THEN RAISE EXCEPTION 'ambiguous evidence reference'; END IF;
  IF NOT rel=ANY(required) THEN required:=array_append(required,rel); END IF;
 END LOOP;
 IF coalesce(jsonb_array_length(it.metadata->'bilingual'->'enVariantHits'),0)>0 OR coalesce(jsonb_array_length(it.metadata->'bilingual'->'publishingFlowJobs'),0)>0 OR coalesce(jsonb_array_length(it.metadata->'cloudSync'->'found'),0)>0 THEN RAISE EXCEPTION 'related data requires review'; END IF;
 IF cardinality(required)<>jsonb_array_length(it.expected_paths) OR EXISTS(SELECT 1 FROM unnest(required) x(v) WHERE NOT (it.expected_paths ? v)) THEN RAISE EXCEPTION 'evidence list differs'; END IF;
 SELECT count(*) INTO actual_files FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key;
 IF actual_files>500 OR (SELECT coalesce(sum(bytes),0) FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key)>200*1024*1024 OR actual_files<>jsonb_array_length(it.expected_paths) OR EXISTS(
  SELECT 1 FROM public.rssd_verified_files f WHERE f.job_id=p_job AND f.legacy_key=p_legacy_key AND (
    NOT (it.expected_paths ? f.path) OR f.path='' OR length(f.path)>2000 OR f.bytes>20*1024*1024 OR f.bytes<0 OR f.path LIKE '/%' OR position(chr(92) IN f.path)>0 OR string_to_array(f.path,'/') && ARRAY['.','..','']::text[] OR f.bytes<>octet_length(f.data) OR f.sha256<>encode(sha256(f.data),'hex') OR
    (SELECT count(*) FROM jsonb_array_elements(convert_from(j.manifest,'UTF8')::jsonb->'files') m(v) WHERE v->>'path'='files/'||f.path AND v->>'sha256'=f.sha256 AND (v->>'bytes')::bigint=f.bytes)<>1))
 THEN RAISE EXCEPTION 'private evidence mismatch'; END IF;
 IF (SELECT count(*) FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key AND regexp_replace(path,'^.*/','')='prepared.json')<>1 OR
    (SELECT count(*) FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key AND regexp_replace(path,'^.*/','')='receipt.json')<>1 THEN RAISE EXCEPTION 'identity files missing'; END IF;
 SELECT convert_from(data,'UTF8')::jsonb INTO prep FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key AND regexp_replace(path,'^.*/','')='prepared.json';
 SELECT convert_from(data,'UTF8')::jsonb INTO receipt FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key AND regexp_replace(path,'^.*/','')='receipt.json';
 IF prep->>'requestKey' IS DISTINCT FROM p_legacy_key OR receipt->>'requestKey' IS DISTINCT FROM p_legacy_key OR prep->'data'->>'id' IS DISTINCT FROM it.article_id OR coalesce(prep->>'sourceSha256','') !~ '^[a-f0-9]{64}$' OR prep->>'sourceSha256' IS DISTINCT FROM receipt->>'sourceSha256' THEN RAISE EXCEPTION 'original receipt identity mismatch'; END IF;
 INSERT INTO public.rssd_private_review_items("orgId","workspaceId","siteId","legacyKey","articleId",id,fingerprint,"bundleDigest",metadata)
 VALUES(g.org,g.workspace,g.site,p_legacy_key,it.article_id,gen_random_uuid()::text,it.compat_fingerprint,g.bundle,it.metadata)
 ON CONFLICT("orgId","workspaceId","legacyKey") DO NOTHING RETURNING id INTO rid;
 IF rid IS NULL THEN
  SELECT * INTO old FROM public.rssd_private_review_items WHERE "orgId"=g.org AND "workspaceId"=g.workspace AND "legacyKey"=p_legacy_key;
  IF old."siteId"<>g.site OR old."articleId"<>it.article_id OR old.fingerprint<>it.compat_fingerprint OR old."bundleDigest"<>g.bundle OR old.metadata<>it.metadata OR
   (SELECT count(*) FROM public.rssd_private_review_files WHERE "orgId"=g.org AND "workspaceId"=g.workspace AND "legacyKey"=p_legacy_key)<>actual_files OR EXISTS(
    SELECT 1 FROM public.rssd_verified_files f LEFT JOIN public.rssd_private_review_files r ON r."orgId"=g.org AND r."workspaceId"=g.workspace AND r."legacyKey"=p_legacy_key AND r.path=f.path
    WHERE f.job_id=p_job AND f.legacy_key=p_legacy_key AND (r.path IS NULL OR r.sha256<>f.sha256 OR r.bytes<>f.bytes OR r.data<>f.data)) THEN RAISE EXCEPTION 'staged evidence conflict'; END IF;
  rid:=old.id;
 ELSE
  INSERT INTO public.rssd_private_review_files("orgId","workspaceId","legacyKey",path,sha256,bytes,data)
  SELECT g.org,g.workspace,p_legacy_key,path,sha256,bytes,data FROM public.rssd_verified_files WHERE job_id=p_job AND legacy_key=p_legacy_key;
 END IF;
 INSERT INTO public.rssd_import_items(job_id,review_id) VALUES(p_job,rid) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n=1 THEN INSERT INTO public.rssd_import_audit(org,workspace,actor,action,job_id,review_id) VALUES(g.org,g.workspace,g.actor,'item_staged',p_job,rid); END IF;
 IF g.expires<=clock_timestamp() THEN RAISE EXCEPTION 'authorization unavailable' USING ERRCODE='42501'; END IF;
 RETURN CASE WHEN n=1 THEN 'staged' ELSE 'duplicate' END;
END $f$;
ALTER FUNCTION public.rssd_restricted_stage(TEXT,TEXT,TEXT) OWNER TO rssd_restricted_import_definer;
REVOKE ALL ON FUNCTION public.rssd_restricted_stage(TEXT,TEXT,TEXT) FROM PUBLIC;
CREATE FUNCTION public.rssd_restricted_stage_index(p_token TEXT,p_job TEXT,p_index INTEGER) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g public.rssd_import_grants; k TEXT; metadata JSONB; source JSONB;
BEGIN
 g:=public.rssd_bound_import_grant(p_token,p_job);
 IF p_index IS NULL OR p_index<0 OR p_index>=1000 THEN RAISE EXCEPTION 'private item unavailable' USING ERRCODE='42501'; END IF;
 SELECT i.legacy_key,i.metadata INTO k,metadata FROM public.rssd_verified_items i WHERE i.job_id=p_job AND i.ordinal=p_index;
 SELECT convert_from(j.inventory,'UTF8')::jsonb->'items'->p_index INTO source FROM public.rssd_import_jobs j WHERE j.id=p_job;
 IF k IS NULL OR source IS NULL OR source<>metadata THEN RAISE EXCEPTION 'private item unavailable' USING ERRCODE='42501'; END IF;
 RETURN public.rssd_restricted_stage(p_token,p_job,k);
END $f$;
ALTER FUNCTION public.rssd_restricted_stage_index(TEXT,TEXT,INTEGER) OWNER TO rssd_restricted_import_definer;
REVOKE ALL ON FUNCTION public.rssd_restricted_stage_index(TEXT,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rssd_restricted_stage_index(TEXT,TEXT,INTEGER) TO rssd_restricted_import_worker;
CREATE FUNCTION public.rssd_restricted_finish(p_token TEXT,p_job TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g public.rssd_import_grants; j public.rssd_import_jobs; expected INTEGER; actual INTEGER;
BEGIN
 g:=public.rssd_bound_import_grant(p_token,p_job);
 SELECT * INTO STRICT j FROM public.rssd_import_jobs WHERE id=p_job FOR UPDATE;
 IF encode(sha256(j.archive),'hex')<>j.bundle OR encode(sha256(j.manifest),'hex')<>j.manifest_hash OR encode(sha256(j.inventory),'hex')<>j.inventory_hash THEN RAISE EXCEPTION 'source evidence mismatch'; END IF;
 expected:=jsonb_array_length(convert_from(j.inventory,'UTF8')::jsonb->'items');
 SELECT count(*) INTO actual FROM public.rssd_verified_items WHERE job_id=p_job;
 IF expected<1 OR expected<>actual OR EXISTS(SELECT 1 FROM jsonb_array_elements(convert_from(j.inventory,'UTF8')::jsonb->'items') x(v) LEFT JOIN public.rssd_verified_items i ON i.job_id=p_job AND i.legacy_key=x.v->>'requestKey' WHERE i.legacy_key IS NULL OR i.metadata<>x.v) OR
  (SELECT count(*) FROM public.rssd_import_items WHERE job_id=p_job)<>expected OR EXISTS(
   SELECT 1 FROM public.rssd_verified_items i LEFT JOIN public.rssd_private_review_items r ON r."orgId"=g.org AND r."workspaceId"=g.workspace AND r."legacyKey"=i.legacy_key LEFT JOIN public.rssd_import_items l ON l.job_id=i.job_id AND l.review_id=r.id WHERE i.job_id=p_job AND l.review_id IS NULL)
 THEN RAISE EXCEPTION 'evidence staging incomplete'; END IF;
 IF j.state<>'needs_reconciliation' THEN
  UPDATE public.rssd_import_jobs SET state='needs_reconciliation' WHERE id=p_job;
  INSERT INTO public.rssd_import_audit(org,workspace,actor,action,job_id) VALUES(g.org,g.workspace,g.actor,'job_staged',p_job);
 END IF;
 IF g.expires<=clock_timestamp() THEN RAISE EXCEPTION 'authorization unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('state','needs_reconciliation','items',expected,'package_metadata_mismatch',j.package_metadata_mismatch);
END $f$;
ALTER FUNCTION public.rssd_restricted_finish(TEXT,TEXT) OWNER TO rssd_restricted_import_definer;
REVOKE ALL ON FUNCTION public.rssd_restricted_finish(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rssd_restricted_finish(TEXT,TEXT) TO rssd_restricted_import_worker;
COMMIT;
