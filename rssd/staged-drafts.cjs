'use strict';
// Staged manuscripts are private branches. They do not alter canonical editions,
// migration status, publication targets or the legacy writer.
const p=require('./protocol.cjs');
const {RssdStore}=require('./store.cjs');
const {RssdMedia}=require('./media.cjs');
const {imageManifest}=require('./rssd-media.cjs');
const {prepareStructuredDraft}=require('./structured-draft.cjs');
const q=(db,sql,...v)=>db.$queryRawUnsafe(sql,...v),x=(db,sql,...v)=>db.$executeRawUnsafe(sql,...v);
const lock=(db,key)=>x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',key);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const publicFields=r=>({articleId:r.articleId,workId:r.workId,locale:r.locale,baseRevision:r.baseRevision,baseHash:r.baseHash,basePublishedVersion:r.basePublishedVersion,overlayRevision:r.overlayRevision});
class StagedDrafts {
 constructor(editorial,inputData){this.editorial=editorial;this.store=editorial.store;this.inputData=inputData;}
 async workspace(ctx,id,db=this.store.db){const s=new RssdStore(db);await s.workspace(db,ctx,p.id(id));return s;}
 async head(db,ctx,workspace,id,locale){return (await q(db,`SELECT * FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 AND "articleId"=$3 AND locale=$4 ORDER BY "overlayRevision" DESC LIMIT 1`,ctx.orgId,workspace,id,locale))[0]||null;}
 async base(editorial,ctx,workspace,id,locale){
  const row=await editorial.find(ctx,workspace,id,{locale});if(!row)p.fail('Manuscript not found',404,'not_found');
  if(!['news','year','history','openSource'].includes(row.kind))p.fail('This record kind remains read-only',409,'read_only');
  const edition=await editorial.store.edition(ctx,row.workId,locale,row.revision);
  const sources=await q(editorial.store.db,'SELECT "sourceHash" FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2 AND "workId"=$3 AND locale=$4 AND "deletedAt" IS NULL',ctx.orgId,(await editorial.workspace(ctx,workspace)).siteId,row.workId,locale);
  if(sources.length!==1||!hex(sources[0].sourceHash)||!hex(edition.hash))p.fail('The original migration source cannot be verified',409,'staged_source_unavailable');
  return {row,revision:row.revision,hash:edition.hash,sourceHash:sources[0].sourceHash,publishedVersion:row.publishedVersion??null};
 }
 async list(ctx,workspace,{locale='zh-CN',after='0',limit='100',generation}={}){
  await this.workspace(ctx,workspace);p.locale(locale);
  const number=(v,name,max)=>{if(typeof v==='string'&&/^\d+$/.test(v))v=Number(v);return p.integer(v,name,0,max);};
  after=number(after,'after',1000000);limit=number(limit,'limit',100);if(!limit)p.fail('Invalid limit');
  const rows=await q(this.store.db,`SELECT DISTINCT ON ("workId",locale) "articleId","workId",locale,"baseRevision","baseHash","basePublishedVersion","overlayRevision" FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 AND locale=$3 ORDER BY "workId",locale,"overlayRevision" DESC`,ctx.orgId,workspace,locale);
  const items=rows.map(publicFields),gen=parseInt(p.hash(items).slice(0,13),16);
  if(generation!==undefined&&number(generation,'generation',Number.MAX_SAFE_INTEGER)!==gen)p.fail('Staged drafts changed; restart pagination',409,'catalog_changed');
  return {items:items.slice(after,after+limit),next:after+limit<items.length?after+limit:null,generation:gen};
 }
 async detail(ctx,workspace,id,{locale='zh-CN'}={}){
  await this.workspace(ctx,workspace);p.id(id);p.locale(locale);
  const overlay=await this.head(this.store.db,ctx,workspace,id,locale);let base;
  try{base=await this.base(this.editorial,ctx,workspace,id,locale);}catch(error){if(!overlay||![404,410,409].includes(error.status))throw error;}
  if(!overlay){const data=await this.editorial.data(ctx,workspace,base.row,base.revision,undefined,{referencedOnly:true});return {articleId:id,workId:base.row.workId,locale,baseRevision:base.revision,baseHash:base.hash,basePublishedVersion:base.publishedVersion,overlayRevision:0,baseState:'current',boundedMediaReads:true,preservesEditorialFieldsOnSave:true,preservesLegacyOptionalBlanksOnSave:true,preservesStructuredDraftsOnSave:true,data};}
  const same=base&&base.row.workId===overlay.workId&&base.revision===overlay.baseRevision&&base.hash===overlay.baseHash&&base.sourceHash===overlay.baseSourceHash&&base.publishedVersion===overlay.basePublishedVersion;
  const assets=[],paths=new Set(overlay.data.markdown.match(/\/article-media\/[A-Za-z0-9._-]+/g)||[]),refs=[];let total=0;
  for(const ref of overlay.data.assets||[]){
   if(!paths.has(ref.path))continue;
   const row=await this.editorial.media.row(ctx,ref.id);
   if(row.workspaceId!==workspace||row.manifest.path!==ref.path)p.fail('Staged draft media identity changed',409,'media_conflict');
   total+=row.manifest.bytes;if(total>2*1024*1024)p.fail('Referenced images exceed the staged draft limit',413,'media_limit');
   refs.push(ref);paths.delete(ref.path);
  }
  if(paths.size)p.fail('Staged draft image is missing',409,'media_conflict');
  for(const ref of refs){const saved=await this.editorial.media.bytes(ctx,ref.id);assets.push({path:ref.path,data:saved.bytes.toString('base64')});}
  return {...publicFields(overlay),baseState:same?'current':'changed',...(!same?{currentBase:base?{revision:base.revision,hash:base.hash,publishedVersion:base.publishedVersion}:null}:{}),boundedMediaReads:true,preservesEditorialFieldsOnSave:true,preservesLegacyOptionalBlanksOnSave:true,preservesStructuredDraftsOnSave:true,data:{...overlay.data,assets}};
 }
 async receipt(ctx,workspace,key){await this.workspace(ctx,workspace);p.id(key);const rows=await q(this.store.db,'SELECT receipt FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3',ctx.orgId,workspace,key);if(!rows.length)p.fail('Draft request not found',404,'not_found');return rows[0].receipt;}
 async promotion(ctx,workspace,id,{locale='zh-CN',overlayRevision}={}){
  await this.workspace(ctx,workspace);p.id(id);p.locale(locale);
  const state=(await q(this.store.db,'SELECT state FROM rssd_migrations WHERE "orgId"=$1 AND "workspaceId"=$2',ctx.orgId,workspace))[0]?.state;
  if(state!=='active')p.fail('Draft reconciliation is still in progress',409,'migration_state_changed');
  if(typeof overlayRevision==='string'&&/^\d+$/.test(overlayRevision))overlayRevision=Number(overlayRevision);
  p.integer(overlayRevision,'overlayRevision',1,2147483647);
  const rows=await q(this.store.db,`SELECT "articleId","workId",locale,"overlayRevision","baseRevision","baseHash","canonicalRevision","requestId" FROM rssd_staged_draft_promotions WHERE "orgId"=$1 AND "workspaceId"=$2 AND "articleId"=$3 AND locale=$4 AND "overlayRevision"=$5 LIMIT 1`,ctx.orgId,workspace,id,locale,overlayRevision);
  if(!rows.length)p.fail('No staged draft promotion was recorded',404,'not_found');return rows[0];
 }
 async save(ctx,workspace,input){
  p.object(input,'staged draft');p.id(input.articleId);p.locale(input.locale);p.integer(input.baseRevision,'baseRevision',1);p.integer(input.overlayRevision,'overlayRevision',0,2147483646);
  const inputKeys=new Set(['requestKey','articleId','workId','locale','baseRevision','baseHash','basePublishedVersion','overlayRevision','data']);
  if(input.workId!==undefined)p.id(input.workId,'workId');
  const dataKeys=new Set(['id','title','summary','markdown','author','date','category','sectionId','locale','assets','translationOf']);
  if(Object.keys(input).some(k=>!inputKeys.has(k))||!input.data||typeof input.data!=='object'||Array.isArray(input.data)||Object.keys(input.data).some(k=>!dataKeys.has(k)))p.fail('Unknown staged draft field');
  if(Buffer.byteLength(JSON.stringify(input))>4*1024*1024)p.fail('Staged draft request exceeds 4 MiB',413,'payload_too_large');
  if(!hex(input.baseHash))p.fail('Invalid base hash');if(input.basePublishedVersion!==null)p.integer(input.basePublishedVersion,'basePublishedVersion',1);
  if(!/^[a-zA-Z0-9_-]{12,128}$/.test(input.requestKey||''))p.fail('Provide a stable request key');
  // Imported legacy records can legitimately omit optional descriptive fields.
  // Keep the editorial validator's image/identity checks without fabricating
  // replacement values for blank author, category or summary.
  const optional={summary:4000,author:100,category:80},check={...input.data};
  for(const [key,max] of Object.entries(optional)){
   const value=input.data[key];
   if(typeof value!=='string'||value.length>max||value.includes('\0'))p.fail('Invalid '+key);
   if(!value.trim())check[key]='-';
  }
  this.inputData({data:check});const data=input.data;
  if(data.id!==input.articleId||(data.locale||'zh-CN')!==input.locale||data.record)p.fail('Staged draft identity mismatch',409,'identity_conflict');
  const fingerprint=p.hash(input);
  return this.store.transaction(async db=>{
   const store=await this.workspace(ctx,workspace,db);
   await lock(db,ctx.orgId+':staged-request:'+workspace+':'+input.requestKey);
   const prior=(await q(db,'SELECT "requestHash",receipt FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3',ctx.orgId,workspace,input.requestKey))[0];
   if(prior){if(prior.requestHash!==fingerprint)p.fail('Request identity was reused with different content',409,'request_conflict');return prior.receipt;}
   const migration=(await q(db,'SELECT state FROM rssd_migrations WHERE "orgId"=$1 AND "workspaceId"=$2 FOR UPDATE',ctx.orgId,workspace))[0];
   if(!migration||migration.state!=='staged')p.fail('Staged draft storage is unavailable',409,'migration_state_changed');
   if(ctx.workerId&&!((await q(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId))[0]))p.fail('Device revoked',401);
   const nested=new this.editorial.constructor(store,this.editorial.media);
   const initial=await this.base(nested,ctx,workspace,input.articleId,input.locale);
   await lock(db,ctx.orgId+':work:'+initial.row.workId);
   const base=await this.base(nested,ctx,workspace,input.articleId,input.locale);
   const previous=await this.head(db,ctx,workspace,input.articleId,input.locale);
   if(base.row.sectionId!==data.sectionId||base.row.workId!==initial.row.workId||(input.workId!==undefined&&input.workId!==base.row.workId))p.fail('Manuscript identity changed',409,'identity_conflict');
   if(base.revision!==input.baseRevision||base.hash!==input.baseHash||base.publishedVersion!==input.basePublishedVersion||previous&&(previous.baseHash!==base.hash||previous.baseRevision!==base.revision||previous.baseSourceHash!==base.sourceHash||previous.basePublishedVersion!==base.publishedVersion))p.fail('The Center snapshot changed; preserve this private draft for reconciliation',409,'staged_base_changed');
   if((previous?.overlayRevision||0)!==input.overlayRevision)p.fail('The staged draft changed; preserve local edits',409,'revision_conflict');
   const original=await nested.data(ctx,workspace,base.row,base.revision,undefined,{referencedOnly:true});
   if(data.translationOf!==undefined&&p.hash(data.translationOf||null)!==p.hash(original.translationOf||null))p.fail('Translation source cannot be changed during migration',409,'source_conflict');
   for(const key of ['summary','author','category']){
    const prior=previous?.data?.[key]??original[key];
    if(!data[key].trim()&&typeof prior==='string'&&prior.trim())p.fail('Only an existing empty '+key+' can remain empty in a private draft');
   }
   let structured=null;
   if(base.row.kind!=='news'){
    const edition=(await store.edition(ctx,base.row.workId,input.locale,base.revision)).payload;
    const source=previous?{...original,...previous.data,record:previous.data.record}:original;
    structured=prepareStructuredDraft({edition,source,proposed:data,expected:{kind:base.row.kind,documentId:base.row.documentId,articleId:base.row.articleId,sectionId:base.row.sectionId,locale:input.locale}});
   }
   // Keep immutable media IDs instead of duplicating image bytes in every revision.
   // All original, unreferenced and earlier overlay attachments remain reachable.
   const assets=new Map(),sourceEdition=await store.edition(ctx,base.row.workId,input.locale,base.revision);
   for(const item of sourceEdition.payload.media||[]){
    const row=await this.editorial.media.row(ctx,item.id);
    if(row.workspaceId!==workspace)p.fail('Original attachment belongs to another workspace',403,'forbidden');
    assets.set(row.manifest.path,{path:row.manifest.path,id:row.id});
   }
   for(const ref of previous?.data?.assets||[]){
    const row=await this.editorial.media.row(ctx,ref.id);
    if(row.workspaceId!==workspace||row.manifest.path!==ref.path)p.fail('Staged draft media identity changed',409,'media_conflict');
    assets.set(ref.path,{path:ref.path,id:ref.id});
   }
   // Canonical edition protocol permits at most 500 retained media references.
   if(new Set([...assets.keys(),...(data.assets||[]).map(a=>a.path)]).size>500)p.fail('The staged draft has too many retained attachments',413,'media_limit');
   store.transaction=fn=>fn(db);
   const media=new RssdMedia(store,{directory:this.editorial.media.directory,origin:this.editorial.media.origin});
   for(const asset of data.assets||[]){
    if(assets.has(asset.path))continue; // inputData already verified its content-addressed path and bytes.
    const manifest=imageManifest(Buffer.from(asset.data,'base64'));
    const uploaded=await media.upload(ctx,{workspaceId:workspace,name:asset.path,...manifest,data:asset.data});
    if(uploaded.manifest.path!==asset.path)p.fail('Staged draft image identity changed',409,'media_conflict');
    assets.set(asset.path,{path:asset.path,id:uploaded.id});
   }
   const payload={id:data.id,title:data.title,summary:data.summary,markdown:data.markdown,author:data.author,date:data.date,category:data.category,sectionId:data.sectionId,
    ...(data.locale?{locale:data.locale}:{}),...(original.translationOf?{translationOf:original.translationOf}:{}),
    ...(structured?{record:{...original.record,fields:{...original.record.fields,...structured.sections,title:data.title}}}:{}),assets:[...assets.values()]};
   const revision=input.overlayRevision+1;
   const receipt={articleId:input.articleId,workId:base.row.workId,locale:input.locale,baseRevision:base.revision,baseHash:base.hash,basePublishedVersion:base.publishedVersion,overlayRevision:revision,status:'draft_saved',requestKey:input.requestKey};
   await x(db,`INSERT INTO rssd_staged_drafts ("orgId","workspaceId","workId",locale,"articleId","baseRevision","baseHash","baseSourceHash","basePublishedVersion","overlayRevision",data,"requestKey","requestHash",receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb)`,ctx.orgId,workspace,base.row.workId,input.locale,input.articleId,base.revision,base.hash,base.sourceHash,base.publishedVersion,revision,JSON.stringify(payload),input.requestKey,fingerprint,JSON.stringify(receipt));
   return receipt;
  });
 }
}
module.exports={StagedDrafts};
