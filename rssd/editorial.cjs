'use strict';
// Projection for the existing manuscript editor. The center edition remains
// authoritative; legacy identifiers and private originals remain attached.
const {createHash}=require('node:crypto');
const {gunzipSync,gzipSync}=require('node:zlib');
const p=require('./protocol.cjs');
const {RssdStore}=require('./store.cjs');
const {RssdMedia}=require('./media.cjs');
const {imageManifest}=require('./rssd-media.cjs');
const {record,recordFields}=require('./rssd-record.cjs');
const {StagedDrafts}=require('./staged-drafts.cjs');
const {prepareStructuredDraft}=require('./structured-draft.cjs');
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args);
const x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args);
const digest=value=>createHash('sha256').update(value).digest('hex');
const lock=(db,key)=>x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',key);
const page=(value,fallback,max)=>{if(value===undefined)return fallback;if(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value))value=Number(value);return p.integer(value,'page',0,max);};
const articleId=row=>row.articleId||'center-'+p.hash([row.workId,row.locale]).slice(0,48);
const documentId=row=>{const h=p.hash([row.workId,row.locale]).slice(0,32);return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');};
function editorRecordFields(kind,fields,id,sectionId,createdAt){
  const trim=value=>typeof value==='string'?value.trim():value;
  const url=value=>value?new URL(value).href:'';
  const result=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,trim(value)]));
  // Match the existing editor's deterministic defaults. Stable internal IDs
  // prevent its validator from generating a fresh identity on every read of a
  // native center record that did not previously carry a legacy record ID.
  if(kind==='year'){
    result.id=result.id||'year:editor:'+id;
    result.tags=Array.isArray(result.tags)?[...new Set(result.tags.map(trim).filter(Boolean))]:[];
    result.end=result.end||null;result.bodyTruncated=Boolean(result.bodyTruncated);
    result.provenance=result.provenance||'原文资料';
    result.reviewedAt=['已核验官网','已核验'].includes(result.provenance)?result.reviewedAt||new Date(createdAt).toISOString():null;
    result.sourceUrl=url(result.sourceUrl);
    if(result.recurrence)result.recurrence={frequency:result.recurrence.frequency,monthDay:result.recurrence.monthDay,leapDay:result.recurrence.leapDay||'skip'};
  }else if(kind==='history'){
    result.id=result.id||'history:editor:'+id;result.preciseToDay=Boolean(result.preciseToDay);
    if(Array.isArray(result.sources))result.sources=result.sources.map(s=>({label:trim(s.label||'原始来源'),url:url(s.url)}));
  }else if(kind==='openSource'){
    result.url=url(result.url);result.relatedUrl=url(result.relatedUrl);result.status=result.status||'公开收录';
  }
  return {...result,sectionId};
}
function legacyFingerprint(data){
  const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
  if(data.record){const {assets,...fields}=data.record.fields||{};return digest(JSON.stringify({id:data.id,record:{documentId:data.record.documentId,kind:data.record.kind,fields:ordered(fields)},assets:(data.assets||[]).map(x=>x.path).sort()}));}
  const content=Object.fromEntries(['id','title','summary','markdown','date','category','author','sectionId'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]));
  content.assets=(data.assets||[]).map(x=>x.path).sort();return digest(JSON.stringify(content));
}
function inputData(input,{allowOptionalBlanks=false}={}){
  p.object(input,'editorial request');const data=p.object(input.data,'manuscript');
  if(!/^[a-z0-9][a-z0-9-]{2,99}$/.test(data.id||''))p.fail('Invalid manuscript identity');
  for(const [field,max] of [['title',500],['summary',4000],['markdown',160000],['author',100],['category',80]]){
    const optional=allowOptionalBlanks&&['summary','author','category'].includes(field);
    if(optional&&typeof data[field]!=='string')p.fail('Invalid '+field);
    p.text(data[field],field,max,optional);
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(data.date||'')||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)p.fail('Invalid manuscript date');
  p.locale(data.locale||'zh-CN');p.id(data.sectionId,'sectionId');
  const assets=p.array(data.assets||[],'assets',12);let total=0;
  for(const asset of assets){
    p.object(asset,'asset');if(typeof asset.data!=='string'||asset.data.length>2800000)p.fail('Invalid image bytes');
    const bytes=Buffer.from(asset.data,'base64'),manifest=imageManifest(bytes);total+=bytes.length;
    if(bytes.toString('base64')!==asset.data||asset.path!==manifest.path||total>2*1024*1024)p.fail('Manuscript media checksum mismatch or exceeds 2 MiB');
  }
  // Authenticated center media references are never accepted from the legacy
  // envelope: every local asset must carry its content-addressed bytes.
  for(const match of data.markdown.matchAll(/\/article-media\/[A-Za-z0-9._-]+/g))if(!assets.some(a=>a.path===match[0]))p.fail('Manuscript image is missing its bytes');
  if(/\/api\/rssd\/v1\/media\//.test(data.markdown))p.fail('Pack center media before submitting an editorial envelope');
  if(data.record){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.record.documentId||'')||data.id!=='record-'+data.record.documentId)p.fail('Structured manuscript identity mismatch');
    recordFields(record(data.record),{title:data.title,bodyMarkdown:data.markdown});
  }
  return data;
}
function archiveBundle(row){
  const bytes=Buffer.from(row.payload,'base64');
  if(row.sha256&&digest(bytes)!==row.sha256)p.fail('Archived original checksum mismatch',409,'archive_conflict');
  const raw=gunzipSync(bytes,{maxOutputLength:68*1024*1024});
  if(digest(raw)!==row.id)p.fail('Archived original identity mismatch',409,'archive_conflict');
  return {archiveId:row.id,archiveSha256:row.id,bundle:JSON.parse(raw.toString('utf8'))};
}
// Native producers already save author-only fields with the immutable edition.
// Read only the private-note contract here; never return the full notebook,
// blocks, mounts or arbitrary metadata to the public manuscript projection.
function nativePrivateEditorial(notebook,bodyMarkdown){
  if(!notebook||typeof notebook!=='object'||Array.isArray(notebook))return null;
  if(!['internalNotes','blockNotes','modelSignatures'].some(key=>Object.hasOwn(notebook,key)))return null;
  const fields=new Set(['supplement','writing','images','verification','other']);
  const notes=value=>{
    if(value===undefined)return {};
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,text])=>!fields.has(key)||typeof text!=='string'||text.length>16000))p.fail('Invalid native author notes',409,'private_notes_invalid');
    return value;
  };
  const internalNotes=notes(notebook.internalNotes),source=notebook.blockNotes||{};
  if(typeof source!=='object'||Array.isArray(source)||Object.keys(source).length>500)p.fail('Invalid native row notes',409,'private_notes_invalid');
  const blockNotes=Object.fromEntries(Object.entries(source).map(([id,entry])=>{
    if(!id||id.length>200||!entry||typeof entry!=='object'||Array.isArray(entry)||!entry.notes)p.fail('Invalid native row notes',409,'private_notes_invalid');
    const block=Array.isArray(notebook.blocks)?notebook.blocks.find(item=>item.id===id):null,anchor=block?{type:block.type,text:block.text}:entry.anchor;
    if(anchor&&(!['heading','paragraph','image','markdown','annotation'].includes(anchor.type)||typeof anchor.text!=='string'))p.fail('Invalid native note anchor',409,'private_notes_invalid');
    return [id,{notes:notes(entry.notes),...(anchor?{anchor}:{})}];
  }));
  const modelSignatures=notebook.modelSignatures||[];
  if(!Array.isArray(modelSignatures)||modelSignatures.length>2000||modelSignatures.some(record=>!record||typeof record.runId!=='string'||typeof record.agentId!=='string'||typeof record.agentName!=='string'||typeof record.startedAt!=='string'||typeof record.action!=='string'||!['running','completed','interrupted'].includes(record.status)||(record.modelId!==null&&typeof record.modelId!=='string')||(record.modelName!==null&&typeof record.modelName!=='string')||(record.device!=null&&(typeof record.device!=='string'||record.device.length>120))))p.fail('Invalid native model records',409,'private_notes_invalid');
  const result={version:1,bodySha:digest(bodyMarkdown),internalNotes,...(Object.keys(blockNotes).length?{blockNotes}:{}),modelSignatures};
  if(JSON.stringify(result).length>1000000)p.fail('Native author notes exceed the private-note limit',409,'private_notes_invalid');
  return JSON.parse(JSON.stringify(result));
}
class RssdEditorial {
  constructor(store,media){this.store=store;this.media=media;}
  async workspace(ctx,workspaceId){
    const {row}=await this.store.workspace(this.store.db,ctx,p.id(workspaceId));
    const migration=(await q(this.store.db,'SELECT manifest FROM rssd_migrations WHERE "orgId"=$1 AND "workspaceId"=$2',ctx.orgId,workspaceId))[0];
    return {...row.payload,origin:migration?.manifest?.site?.origin||''};
  }
  async entries(ctx,workspaceId){
    const workspace=await this.workspace(ctx,workspaceId);
    const rows=await q(this.store.db,`SELECT w.id AS "workId",w."sectionId",e.locale,e.revision,
      e.payload->>'title' AS title,e.payload->>'summary' AS summary,e.payload->'metadata' AS metadata,e.payload->'sources' AS sources,
      e."createdAt",l."documentId",l."deletedAt",l.source->'document'->>'kind' AS "legacyKind",
      l.source->'document'->>'source_key' AS "legacyKey",l.source->'document'->>'permalink' AS "legacyRoute",
      (l.source->'revisions'->-1->>'payload')::jsonb->>'id' AS "legacyArticleId",
      pub.revision AS "publishedVersion",pub.receipt AS "publishedReceipt",
      pe.payload->>'title' AS "publishedTitle",pe.payload->>'summary' AS "publishedSummary",pe.payload->'metadata' AS "publishedMetadata",pe.payload->'sources' AS "publishedSources",pe."createdAt" AS "publishedAt",
      visibility.visibility AS visibility,visibility."updatedAt" AS "visibilityUpdatedAt",visibility.generation AS "visibilityGeneration"
      FROM rssd_works w JOIN LATERAL
        (SELECT DISTINCT ON (locale) * FROM rssd_editions WHERE "orgId"=w."orgId" AND "workId"=w.id ORDER BY locale,revision DESC) e ON true
      LEFT JOIN rssd_legacy_documents l ON l."orgId"=w."orgId" AND l."workId"=w.id AND l.locale=e.locale AND l."siteId"=$3
      LEFT JOIN LATERAL (SELECT revision,receipt FROM rssd_publications WHERE "orgId"=w."orgId" AND "workId"=w.id AND locale=e.locale
        AND "destinationId"=$4 AND state IN ('published','legacy_published') ORDER BY revision DESC LIMIT 1) pub ON true
      LEFT JOIN rssd_editions pe ON pe."orgId"=w."orgId" AND pe."workId"=w.id AND pe.locale=e.locale AND pe.revision=pub.revision
      LEFT JOIN rssd_editorial_states visibility ON visibility."orgId"=w."orgId" AND visibility."workId"=w.id AND visibility.locale=e.locale
      WHERE w."orgId"=$1 AND w."workspaceId"=$2 ORDER BY w.id,e.locale`,ctx.orgId,workspaceId,workspace.siteId,'site-'+workspace.siteId);
    return rows.map(row=>{
      const kind=row.legacyKind||row.metadata?.record?.kind||'news';
      const recordId=row.documentId||row.metadata?.editorial?.documentId||(kind==='news'?null:documentId(row));
      const id=kind==='news'?(row.legacyArticleId||row.metadata?.editorial?.articleId):'record-'+recordId;
      return {...row,deletedAt:row.visibility==='deleted'?row.visibilityUpdatedAt:row.visibility?null:row.deletedAt,
        publishedVersion:['withdrawn','deleted'].includes(row.visibility)?null:row.publishedVersion,
        documentId:recordId,kind,origin:workspace.origin,articleId:articleId({...row,articleId:id}),url:row.legacyRoute||row.metadata?.publication?.path||((row.locale==='en'?'/en':'')+'/news/'+p.hash(row.workId).slice(0,32)+'/')};
    });
  }
  async find(ctx,workspaceId,id,{allowDeleted=false,locale}={}){
    p.id(id);if(locale!==undefined)p.locale(locale);
    const rows=(await this.entries(ctx,workspaceId)).filter(row=>row.articleId===id&&(locale===undefined||row.locale===locale));
    if(rows.length>1)p.fail('Several editions claim this manuscript identity',409,'identity_conflict');
    const row=rows[0]||null;
    if(row?.deletedAt&&!allowDeleted)p.fail('This historical manuscript was deleted',410,'edition_deleted');
    return row;
  }
  async catalog(ctx,workspaceId,options={}){
    const {scope='published',locale='zh-CN'}=options;p.locale(locale);
    if(!['published','all'].includes(scope))p.fail('Invalid catalog scope');
    const rows=(await this.entries(ctx,workspaceId)).filter(row=>!row.deletedAt&&row.locale===locale&&(scope==='all'||row.publishedVersion));
    // Include publication progress in the snapshot identity. A changed page is
    // retried from its beginning rather than silently spliced into older rows.
    const generation=parseInt(p.hash(rows.map(r=>[r.workId,r.locale,r.revision,r.publishedVersion,r.url])).slice(0,13),16);
    if(options.generation!==undefined&&Number(options.generation)!==generation)p.fail('Center catalog changed; restart pagination',409,'catalog_changed');
    const after=page(options.after,0,1000000),limit=page(options.limit,80,100);if(limit<1)p.fail('Invalid catalog limit');
    const items=rows.slice(after,after+limit).map(row=>{
      const r=scope==='published'?{...row,title:row.publishedTitle,summary:row.publishedSummary,metadata:row.publishedMetadata,sources:row.publishedSources,createdAt:row.publishedAt}:row;
      const fields=r.metadata?.record?.fields||{},sourceUrls=r.sources?.length?r.sources.map(s=>({label:s.title||'',url:s.url})):fields.sources|| (fields.sourceUrl?[{label:fields.sourceName||'原始来源',url:fields.sourceUrl}]:fields.url?[{label:'项目',url:fields.url}]:[]);
      return {
      documentId:r.documentId||r.workId,articleId:r.articleId,kind:r.kind,key:r.legacyKey||r.kind+':'+r.articleId,
      title:r.title,summary:r.summary,category:r.metadata?.category||'',sectionId:r.sectionId,
      revision:scope==='published'?r.publishedVersion:r.revision,version:r.revision,publishedVersion:r.publishedVersion,
      publicationState:r.publishedVersion?'published':'unpublished',locale:r.locale,path:r.url,url:r.origin+r.url,
      detailPage:true,lastmod:new Date(r.createdAt).toISOString(),dateLabel:r.kind==='history'?`${fields.year} 年 ${fields.dateKey}`:fields.start?fields.start+(fields.end?' — '+fields.end:''):r.metadata?.date||'',sourceUrls
    };});
    return {scope,generation,items,next:after+limit<rows.length?after+limit:null};
  }
  async index(ctx,workspaceId,options={}){
    const rows=(await this.entries(ctx,workspaceId)).filter(row=>!row.deletedAt);
    const generation=parseInt(p.hash(rows.map(r=>[r.articleId,r.revision,r.publishedVersion])).slice(0,13),16);
    if(options.generation!==undefined&&Number(options.generation)!==generation)p.fail('Center index changed; restart pagination',409,'catalog_changed');
    const after=page(options.after,0,1000000),limit=page(options.limit,100,200);if(limit<1)p.fail('Invalid index limit');
    return {generation,checkedAt:new Date().toISOString(),items:rows.slice(after,after+limit).map(r=>({id:r.articleId,version:r.revision,publishedVersion:r.publishedVersion,url:r.url})),next:after+limit<rows.length?after+limit:null};
  }
  async data(ctx,workspaceId,row,revision,entries,options={}){
    const edition=await this.store.edition(ctx,row.workId,row.locale,revision),e=edition.payload;
    if(options.referencedOnly&&!options.fingerprintOnly){
      let bytes=0;
      for(const item of e.media||[]){
        if(!e.bodyMarkdown.includes('/api/rssd/v1/media/'+item.id+'/raw'))continue;
        const media=await this.media.row(ctx,item.id);
        if(media.workspaceId!==workspaceId)p.fail('Media belongs to a different workspace',403,'forbidden');
        bytes+=media.manifest.bytes;
        if(bytes>(options.maxAssetBytes||2*1024*1024))p.fail('Referenced images exceed the staged draft limit',413,'media_limit');
      }
    }
    let material;
    if(options.fingerprintOnly){
      let bodyMarkdown=e.bodyMarkdown;
      const ids=[...new Set([...(e.media||[]).map(item=>item.id),...p.referencedMediaIds(bodyMarkdown)])];
      for(const id of ids){
        const media=await this.media.row(ctx,id);
        if(media.workspaceId!==workspaceId)p.fail('Media belongs to a different workspace',403,'forbidden');
        const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        bodyMarkdown=bodyMarkdown.replace(new RegExp('(?:https?:\\/\\/[^/\\s)]+)?/api/rssd/v1/media/'+escaped+'/raw','g'),media.manifest.path);
      }
      if(/\/api\/rssd\/v1\/media\//.test(bodyMarkdown))p.fail('Article references media missing from its edition manifest',400,'missing_media');
      material={edition:{...e,bodyMarkdown}};
    }else material=await this.media.publication(ctx.orgId,workspaceId,e);
    const assets=[];
    // Preserve unreferenced attachments too; they can be used by a channel or
    // retained in an original manuscript even when absent from the current body.
    const assetIds=[...new Set([...(e.media||[]).map(item=>item.id),...p.referencedMediaIds(e.bodyMarkdown)])];
    for(const id of assetIds){
      if(options.referencedOnly){
        const media=await this.media.row(ctx,id);
        if(media.workspaceId!==workspaceId)p.fail('Media belongs to a different workspace',403,'forbidden');
        if(options.fingerprintOnly){assets.push({path:media.manifest.path});continue;}
        if(!material.edition.bodyMarkdown.includes(media.manifest.path))continue;
      }
      const {bytes,row:media}=await this.media.bytes(ctx,id);assets.push({path:media.manifest.path,data:bytes.toString('base64')});
    }
    const value={id:row.articleId,title:e.title,summary:e.summary,markdown:material.edition.bodyMarkdown,
      author:e.metadata?.author||'',date:e.metadata?.date||new Date(edition.createdAt).toISOString().slice(0,10),
      category:e.metadata?.category||'',sectionId:row.sectionId,assets};
    if(e.metadata?.record){const id=row.documentId||row.workId;value.record={documentId:id,kind:e.metadata.record.kind,fields:editorRecordFields(e.metadata.record.kind,recordFields(e.metadata.record,material.edition),id,row.sectionId,edition.createdAt)};}
    if(e.locale!=='zh-CN')value.locale=e.locale;
    if(e.translationOf){
      const source=(entries||await this.entries(ctx,workspaceId)).find(r=>r.workId===e.translationOf.workId&&r.locale===e.translationOf.locale);
      if(!source)p.fail('Translation source is missing',409,'source_conflict');
      // Existing editor sources use a different fingerprint; retain its exact
      // original reference for migrated editions until the transport converts it.
      const legacy=(await q(this.store.db,`SELECT source->'revisions' AS revisions FROM rssd_legacy_documents WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3`,ctx.orgId,row.workId,row.locale))[0];
      const original=legacy?.revisions?.find(r=>r.version===revision);
      if(original)value.translationOf=JSON.parse(original.payload).translationOf;
      if(e.locale==='en'&&e.translationOf.locale==='zh-CN'){
        const sourceData=await this.data(ctx,workspaceId,source,e.translationOf.revision,entries,options.referencedOnly?{...options,fingerprintOnly:true}:options);
        value.translationOf={articleId:source.articleId,revision:e.translationOf.revision,sha256:legacyFingerprint(sourceData)};
      }
    }
    return value;
  }
  async detail(ctx,workspaceId,id,{scope='cloud',locale,media}={}){
    if(!['cloud','published','status'].includes(scope))p.fail('Invalid edition scope');
    if(media!==undefined&&media!=='referenced')p.fail('Invalid media mode');
    const row=await this.find(ctx,workspaceId,id,{locale});
    if(!row){if(scope==='status')return {version:0,publishedVersion:null,data:null};p.fail('Manuscript not found',404,'not_found');}
    if(scope==='published'&&!row.publishedVersion)p.fail('Manuscript has no published website edition',404,'not_published');
    const revision=scope==='published'?row.publishedVersion:row.revision;
    const options=media==='referenced'?{referencedOnly:true}:{};
    const data=await this.data(ctx,workspaceId,row,revision,undefined,options);
    return {id:row.documentId||row.workId,articleId:row.articleId,workId:row.workId,locale:row.locale,
      preservesEditorialFieldsOnSave:true,preservesLegacyOptionalBlanksOnSave:true,preservesStructuredDraftsOnSave:true,...(media==='referenced'?{boundedMediaReads:true}:{}),version:row.revision,revision,publishedVersion:row.publishedVersion,url:row.url,data,
      ...(scope==='status'?{published:row.publishedVersion?await this.data(ctx,workspaceId,row,row.publishedVersion,undefined,options):null}:{})};
  }
  // Read small batches without exposing private archives. Resolve the complete identity map
  // once per batch so a missing, duplicate, deleted or oversized item cannot hide others.
  async cloudBatch(ctx,workspaceId,{locale,ids,media}={}){
    p.locale(locale);
    if(media!==undefined&&media!=='referenced')p.fail('Invalid media mode');
    if(typeof ids!=='string'||!ids||ids.length>1100)p.fail('Invalid batch IDs');
    const requested=ids.split(',');
    if(requested.length>8||requested.some(id=>!id)||new Set(requested).size!==requested.length)p.fail('Invalid batch IDs');
    for(const id of requested)p.id(id);
    // entries() enforces the same workspace/tenant authorization as single cloud reads.
    const entries=await this.entries(ctx,workspaceId),items=[];
    let budget=4*1024*1024-4096;
    for(const articleId of requested){
      let item;
      try{
        const matches=entries.filter(row=>row.articleId===articleId&&row.locale===locale);
        if(matches.length>1)p.fail('Several editions claim this manuscript identity',409,'identity_conflict');
        const row=matches[0];
        if(!row)p.fail('Manuscript not found',404,'not_found');
        if(row.deletedAt)p.fail('This historical manuscript was deleted',410,'edition_deleted');
        const data=await this.data(ctx,workspaceId,row,row.revision,entries,media==='referenced'?{referencedOnly:true}:{});
        const detail={id:row.documentId||row.workId,articleId:row.articleId,workId:row.workId,locale:row.locale,
          preservesEditorialFieldsOnSave:true,preservesLegacyOptionalBlanksOnSave:true,preservesStructuredDraftsOnSave:true,...(media==='referenced'?{boundedMediaReads:true}:{}),version:row.revision,revision:row.revision,publishedVersion:row.publishedVersion,url:row.url,data};
        item={articleId,ok:true,detail};
        const bytes=Buffer.byteLength(JSON.stringify(item));
        if(bytes>budget)item={articleId,ok:false,error:{code:'batch_response_limit',status:413,message:'Read this work individually'}};
        else budget-=bytes+1;
      }catch(error){
        // Internal errors can contain private paths or SQL; never include their raw message.
        const safe=error instanceof p.ProtocolError;
        const code=safe&&/^[a-zA-Z0-9_-]{1,64}$/.test(error.code||'')?error.code:'batch_item_error';
        const message=safe?String(error.message||'Unable to read this work').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]').slice(0,160):'Unable to read this work';
        item={articleId,ok:false,error:{code,status:safe?error.status:500,message}};
      }
      items.push(item);
    }
    return {locale,items};
  }
  async archive(ctx,workspaceId,id){
    await this.workspace(ctx,workspaceId);if(!/^[a-f0-9]{64}$/.test(id))p.fail('Invalid archive identity');
    const saved=(await q(this.store.db,'SELECT id,payload,sha256 FROM rssd_editorial_archives WHERE "orgId"=$1 AND "workspaceId"=$2 AND id=$3',ctx.orgId,workspaceId,id))[0];
    if(saved)return archiveBundle(saved);
    const rows=await q(this.store.db,`SELECT a.value AS archive FROM rssd_legacy_documents l JOIN rssd_works w ON w."orgId"=l."orgId" AND w.id=l."workId",
      LATERAL jsonb_array_elements(l.source->'sourceArchives') a WHERE l."orgId"=$1 AND w."workspaceId"=$2 AND a.value->>'id'=$3`,ctx.orgId,workspaceId,id);
    if(!rows.length)p.fail('Archived original not found',404,'not_found');
    return archiveBundle(rows[0].archive);
  }
  async legacyRequest(ctx,workspaceId,key,intent){
    await this.workspace(ctx,workspaceId);p.id(key);
    const field=intent==='draft'?'drafts':'requests';
    const row=(await q(this.store.db,`SELECT l."documentId",l."workId",l.locale,l.source->'document' AS document,
      l.source->'jobs' AS jobs,l.source->'revisions' AS revisions,r.value AS request
      FROM rssd_legacy_documents l JOIN rssd_works w ON w."orgId"=l."orgId" AND w.id=l."workId",
      LATERAL jsonb_array_elements(l.source->$4::text) r WHERE l."orgId"=$1 AND w."workspaceId"=$2 AND r.value->>'key'=$3`,ctx.orgId,workspaceId,key,field))[0];
    if(!row)return null;
    const original=JSON.parse(row.revisions.at(-1).payload),id=row.document.kind==='news'?original.id:'record-'+row.documentId;
    const result={centerManaged:true,legacy:true,id:row.documentId,articleId:id,requestKey:key,revision:row.request.revision,url:row.document.permalink};
    if(intent==='draft')return {...result,status:'draft_saved',version:row.document.latest_revision,publishedVersion:row.document.published_revision};
    const job=row.jobs.find(j=>j.id===row.request.job_id);
    return {...result,job:job?{id:job.id,status:job.status,error:job.error,release:job.release}:{id:row.request.job_id,status:'failed',error:'Historical job receipt is missing; reconcile the archived request'}};
  }
  websiteJob(pub){
    const status=['published','legacy_published'].includes(pub.state)?'success':pub.state==='dispatching'?'running':pub.state==='queued'?'queued':'failed';
    return {id:pub.id,status,error:pub.error||null,release:pub.receipt.latestVisibilityAction?.release||pub.receipt.release||pub.receipt.releaseId||null};
  }
  async nativeWebsiteRequest(ctx,workspaceId,key,intent){
    if(intent!=='publish')return null;
    const workspace=await this.workspace(ctx,workspaceId),destinationId='site-'+workspace.siteId;
    const byJob=(await q(this.store.db,'SELECT id,state,error,receipt,"workId" FROM rssd_publications WHERE "orgId"=$1 AND "workspaceId"=$2 AND id=$3 AND "destinationId"=$4',ctx.orgId,workspaceId,key,destinationId))[0];
    if(byJob)return {centerManaged:true,requestKey:key,workId:byJob.workId,job:this.websiteJob(byJob)};
    const submission=(await q(this.store.db,'SELECT result FROM rssd_submissions WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestId"=$3',ctx.orgId,workspaceId,key))[0];
    const ids=submission?.result?.publicationIds||[];
    if(!ids.length)return null;
    const pubs=await q(this.store.db,`SELECT id,state,error,receipt,"workId" FROM rssd_publications WHERE "orgId"=$1 AND "workspaceId"=$2 AND "destinationId"=$3 AND id IN (SELECT jsonb_array_elements_text($4::jsonb))`,ctx.orgId,workspaceId,destinationId,JSON.stringify(ids));
    if(!pubs.length)return null;
    if(pubs.length>1)p.fail('Several website jobs belong to this submission; recover the original publication identity',409,'identity_conflict');
    return {centerManaged:true,requestKey:key,workId:pubs[0].workId,job:this.websiteJob(pubs[0])};
  }
  async receipt(ctx,workspaceId,key,{intent='publish'}={}){
    await this.workspace(ctx,workspaceId);p.id(key);
    const row=(await q(this.store.db,'SELECT * FROM rssd_editorial_requests WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3',ctx.orgId,workspaceId,key))[0];
    if(!row){const old=await this.legacyRequest(ctx,workspaceId,key,intent);if(old)return old;const native=await this.nativeWebsiteRequest(ctx,workspaceId,key,intent);if(native)return native;p.fail('Editorial request not found',404,'not_found');}
    if(row.intent!==intent)p.fail('Editorial request not found',404,'not_found');
    const result={...row.receipt,centerManaged:true};
    if(intent==='draft'){
      const head=(await q(this.store.db,'SELECT max(revision) AS version FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,row.workId,row.locale))[0];
      const pub=(await q(this.store.db,`SELECT max(revision) AS version FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('published','legacy_published')`,ctx.orgId,row.workId,row.locale,row.destinationId))[0];
      return {...result,status:'draft_saved',version:head.version,publishedVersion:pub.version};
    }
    const pub=(await q(this.store.db,'SELECT id,state,error,receipt FROM rssd_publications WHERE "orgId"=$1 AND id=$2',ctx.orgId,row.publicationId))[0];
    if(!pub)p.fail('Website publication receipt is missing',409,'receipt_missing');
    return {...result,job:this.websiteJob(pub)};
  }
  async submit(ctx,workspaceId,input,{intent='publish'}={}){
    if(!['publish','draft'].includes(intent))p.fail('Invalid editorial submission intent');
    const data=inputData(input,{allowOptionalBlanks:intent==='draft'});if(!/^[a-zA-Z0-9_-]{12,128}$/.test(input.requestKey||''))p.fail('Provide the original stable editorial request key');
    p.integer(input.expectedVersion,'expectedVersion',0);
    if(input.expectedPublishedVersion!==null)p.integer(input.expectedPublishedVersion,'expectedPublishedVersion',1);
    const fingerprint=p.hash({intent,data,expectedVersion:input.expectedVersion,expectedPublishedVersion:input.expectedPublishedVersion});
    await this.store.transaction(async db=>{
      await lock(db,ctx.orgId+':editorial-request:'+workspaceId+':'+input.requestKey);
      const previous=(await q(db,'SELECT * FROM rssd_editorial_requests WHERE "orgId"=$1 AND "workspaceId"=$2 AND "requestKey"=$3',ctx.orgId,workspaceId,input.requestKey))[0];
      if(previous){if(previous.payloadHash!==fingerprint||previous.intent!==intent)p.fail('Request identity was reused with different content',409,'request_conflict');return;}
      const nested=new RssdStore(db);nested.transaction=fn=>fn(db);
      const media=new RssdMedia(nested,{directory:this.media.directory,origin:this.media.origin}),editorial=new RssdEditorial(nested,media);
      const workspace=await editorial.workspace(ctx,workspaceId);await nested.writable(db,ctx,workspaceId);
      if(await editorial.legacyRequest(ctx,workspaceId,input.requestKey,intent)||await editorial.legacyRequest(ctx,workspaceId,input.requestKey,intent==='draft'?'publish':'draft'))p.fail('This original request was migrated; query its preserved receipt instead of submitting it again',409,'legacy_request_exists');
      const locale=data.locale||'zh-CN';
      const source=data.translationOf?await editorial.find(ctx,workspaceId,p.id(data.translationOf.articleId),{locale:locale==='en'?'zh-CN':'en'}):null;
      if(data.translationOf&&!source)p.fail('Translation source not found',409,'source_conflict');
      const existing=await editorial.find(ctx,workspaceId,data.id,{locale});
      const workId=existing?.workId||source?.workId||'editorial-'+p.hash([workspaceId,data.id]).slice(0,48);
      await lock(db,ctx.orgId+':work:'+workId);
      await q(db,'SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 FOR UPDATE',ctx.orgId,workId,locale);
      const current=await editorial.find(ctx,workspaceId,data.id,{locale});
      // Check under the work lock so concurrent creations in different languages cannot merge by accident.
      if(!current&&!source&&await editorial.find(ctx,workspaceId,data.id,{locale:locale==='en'?'zh-CN':'en'}))p.fail('Manuscript identity belongs to another language',409,'identity_conflict');
      if((current?.revision||0)!==input.expectedVersion||(current?.publishedVersion??null)!==input.expectedPublishedVersion)p.fail('Center content or published state changed; preserve local edits and reload',409,'revision_conflict');
      const structuredDraft=Boolean(current&&current.kind!=='news'&&intent==='draft');
      if(current&&(current.sectionId!==data.sectionId||current.locale!==locale||(!structuredDraft&&current.kind!==(data.record?.kind||'news'))))p.fail('Manuscript identity or section changed',409,'identity_conflict');
      const pending=(await q(db,`SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND "destinationId"=$4 AND state IN ('queued','dispatching') LIMIT 1`,ctx.orgId,workId,locale,'site-'+workspace.siteId))[0];
      if(pending)p.fail('Query the current website publication before submitting another revision',409,'publication_pending');
      let translationOf=null;
      if(data.translationOf){
        const ref=data.translationOf;p.integer(ref.revision,'translation source revision',1);
        if(locale===source.locale||workId!==source.workId)p.fail('Translation must retain its source work',409,'source_conflict');
        const sourceData=await editorial.data(ctx,workspaceId,source,ref.revision);
        if(ref.sha256!==legacyFingerprint(sourceData))p.fail('Translation source fingerprint changed',409,'source_conflict');
        translationOf={workId,locale:source.locale,revision:ref.revision};
      }else if(existing){translationOf=(await nested.edition(ctx,workId,locale,existing.revision)).payload.translationOf;}
      if(data.record?.kind==='openSource'){
        await lock(db,ctx.orgId+':resource:'+workspaceId+':'+String(data.record.fields.url||''));
        const duplicates=await q(db,`SELECT e."workId" FROM rssd_editions e JOIN rssd_works w ON w."orgId"=e."orgId" AND w.id=e."workId"
          WHERE e."orgId"=$1 AND w."workspaceId"=$2 AND e."workId"<>$3 AND e.payload->'metadata'->'record'->>'kind'='openSource'
          AND e.payload->'metadata'->'record'->'fields'->>'url'=$4
          AND e.revision=(SELECT max(v.revision) FROM rssd_editions v WHERE v."orgId"=e."orgId" AND v."workId"=e."workId" AND v.locale=e.locale)`,ctx.orgId,workspaceId,workId,data.record.fields.url||'');
        if(duplicates.length)p.fail('This resource link already has a work; update the existing record',409,'duplicate_source');
      }
      const {section}=await nested.workSection(db,ctx,workspaceId,data.sectionId,existing?.workId),destinationId='site-'+workspace.siteId;
      if(intent==='publish'&&!section.policy.targets.some(t=>t.destinationId===destinationId&&t.locale===locale))p.fail('This section has no website destination for the requested language',409,'missing_destination');
      const previousEdition=current?(await nested.edition(ctx,workId,locale,current.revision)).payload:null;
      let structured=null;
      if(structuredDraft){
        const sourceData=await editorial.data(ctx,workspaceId,current,current.revision);
        structured=prepareStructuredDraft({edition:previousEdition,source:sourceData,proposed:data,expected:{kind:current.kind,documentId:current.documentId,articleId:current.articleId,sectionId:current.sectionId,locale}});
      }
      for(const key of ['summary','author','category']){
        const prior=key==='summary'?previousEdition?.summary:previousEdition?.metadata?.[key];
        if(!data[key].trim()&&(!previousEdition||typeof prior==='string'&&prior.trim()))p.fail('Only an existing empty '+key+' can remain empty in a private draft');
      }
      // Legacy editor envelopes contain only some attachments and do not carry alt metadata.
      // Preserve the exact previous edition's attachments; omission is not a deletion instruction.
      const attachments=(previousEdition?.media||[]).map(item=>({...item}));let bodyMarkdown=data.markdown;
      for(const asset of data.assets||[]){const bytes=Buffer.from(asset.data,'base64'),manifest=imageManifest(bytes);const upload=await media.upload(ctx,{workspaceId,name:asset.path,...manifest,data:asset.data});if(!attachments.some(item=>item.id===upload.id))attachments.push({id:upload.id,alt:''});bodyMarkdown=bodyMarkdown.replaceAll(asset.path,'/api/rssd/v1/media/'+upload.id+'/raw');}
      const route=current?.url||(locale==='en'?(source?'/en/news/'+source.articleId+'/':'/en/news/'+data.id+'/'):'/news/'+data.id+'/');
      const metadata={...(previousEdition?.metadata||{}),author:data.author,date:data.date,category:data.category,
        publication:{...(previousEdition?.metadata?.publication||{}),path:route},editorial:{...(previousEdition?.metadata?.editorial||{}),articleId:data.id,...(data.record?{documentId:data.record.documentId}:{})}};
      if(structured)metadata.record={...structured.metadata.record,fields:{...structured.metadata.record.fields,...structured.sections}};
      else if(data.record)metadata.record=record(data.record);
      const packet={requestId:'editorial-'+p.hash([workspaceId,input.requestKey]).slice(0,48),workId,workspaceId,sectionId:data.sectionId,baseRevisions:{[locale]:input.expectedVersion},editions:[{locale,title:data.title,summary:data.summary,bodyMarkdown,sources:previousEdition?.sources||[],media:attachments,translationOf,metadata}]};
      const saved=await nested.submit(ctx,packet,{publish:intent==='publish'}),revision=saved.editions[0].revision;
      const publication=intent==='publish'?(await q(db,'SELECT id FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4 AND "destinationId"=$5',ctx.orgId,workId,locale,revision,destinationId))[0]:null;
      const receipt={id:current?.documentId||data.record?.documentId||workId,articleId:data.id,requestKey:input.requestKey,revision,url:route};
      await x(db,`INSERT INTO rssd_editorial_requests ("orgId","workspaceId","requestKey",intent,"payloadHash","workId",locale,"destinationId","publicationId",receipt)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,ctx.orgId,workspaceId,input.requestKey,intent,fingerprint,workId,locale,destinationId,publication?.id||null,JSON.stringify(receipt));
    });
    return this.receipt(ctx,workspaceId,input.requestKey,{intent});
  }
  async saveArchive(ctx,workspaceId,input){
    p.object(input,'original archive');p.id(input.articleId);p.integer(input.revision,'archive revision',1);
    p.array(input.files,'archive files',1500);if(!input.files.length)p.fail('Original archive is empty');
    const paths=new Set();let total=0;
    for(const f of input.files){
      p.object(f,'archive file');if(typeof f.path!=='string'||f.path.length>1000||f.path.includes('\0')||/^[a-zA-Z]:/.test(f.path)||f.path.startsWith('/')||f.path.includes('\\')||f.path.split('/').some(part=>!part||part==='.'||part==='..')||paths.has(f.path))p.fail('Unsafe original archive path');paths.add(f.path);
      if(typeof f.data!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256||''))p.fail('Invalid original archive file');
      const bytes=Buffer.from(f.data,'base64');total+=bytes.length;
      if(total>48*1024*1024||bytes.toString('base64')!==f.data||digest(bytes)!==f.sha256)p.fail('Original archive checksum mismatch or exceeds 48 MiB');
    }
    const raw=JSON.stringify({articleId:input.articleId,revision:input.revision,files:input.files}),id=digest(raw),bytes=gzipSync(raw);
    await this.store.transaction(async db=>{
      const nested=new RssdStore(db);nested.transaction=fn=>fn(db);const editorial=new RssdEditorial(nested,this.media);
      const row=await editorial.find(ctx,workspaceId,input.articleId);if(!row)p.fail('Manuscript not found',404);
      await lock(db,ctx.orgId+':work:'+row.workId);await nested.writable(db,ctx,workspaceId);
      const current=await editorial.find(ctx,workspaceId,input.articleId);if(current.revision!==input.revision)p.fail('Center edition changed; retain the local original',409,'revision_conflict');
      if(ctx.workerId&&!((await q(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId))[0]))p.fail('Device revoked',401);
      await x(db,`INSERT INTO rssd_editorial_archives ("orgId","workspaceId",id,"workId",locale,revision,payload,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,ctx.orgId,workspaceId,id,row.workId,row.locale,input.revision,bytes,digest(bytes));
    });
    return {archiveId:id,archiveSha256:id,fileCount:input.files.length,centerManaged:true};
  }
  async privateNotes(ctx,workspaceId,id,revision){
    const row=await this.find(ctx,workspaceId,id);if(!row)p.fail('Manuscript not found',404);
    const bound=revision===undefined?row.revision:Math.min(row.revision,page(revision,row.revision,Number.MAX_SAFE_INTEGER));
    const saved=await q(this.store.db,'SELECT id,revision,payload,sha256,"createdAt" FROM rssd_editorial_archives WHERE "orgId"=$1 AND "workspaceId"=$2 AND "workId"=$3 AND locale=$4 AND revision<=$5',ctx.orgId,workspaceId,row.workId,row.locale,bound);
    const legacy=(await q(this.store.db,'SELECT source->\'sourceArchives\' AS archives FROM rssd_legacy_documents WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,row.workId,row.locale))[0];
    const native=(await q(this.store.db,`SELECT revision,payload->'metadata'->'notebook' AS notebook,payload->>'bodyMarkdown' AS "bodyMarkdown"
      FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision<=$4
      AND jsonb_typeof(payload->'metadata'->'notebook')='object'
      AND (payload->'metadata'->'notebook') ?| ARRAY['internalNotes','blockNotes','modelSignatures']
      ORDER BY revision DESC LIMIT 1`,ctx.orgId,row.workId,row.locale,bound))[0];
    const rows=[...saved,...(legacy?.archives||[])].map(archive=>({...archive,kind:'archive'}));
    if(native)rows.push({...native,kind:'native'});
    rows.sort((a,b)=>b.revision-a.revision||(a.kind!==b.kind?(a.kind==='archive'?-1:1):new Date(b.createdAt||b.created)-new Date(a.createdAt||a.created)));
    for(const archive of rows.filter(r=>r.revision<=bound)){
      if(archive.kind==='native')return {articleId:id,revision:archive.revision,privateEditorial:nativePrivateEditorial(archive.notebook,archive.bodyMarkdown),centerManaged:true};
      const bundle=archiveBundle(archive).bundle,notes=(bundle.files||[]).filter(f=>/(^|\/)internal-notes\.json$/.test(f.path));if(!notes.length)continue;
      if(notes.length!==1)p.fail('Original archive contains several author-note files',409,'archive_conflict');
      const bytes=Buffer.from(notes[0].data,'base64');if(digest(bytes)!==notes[0].sha256)p.fail('Author-note checksum mismatch',409,'archive_conflict');
      return {articleId:id,revision:archive.revision,archiveId:archive.id,privateEditorial:JSON.parse(bytes.toString('utf8')),centerManaged:true};
    }
    return {articleId:id,revision:null,privateEditorial:null,centerManaged:true};
  }
  async retry(ctx,workspaceId,key,input){
    const old=await this.receipt(ctx,workspaceId,key);if(old.job.id!==input.jobId)p.fail('Retry must identify the original website job',409,'request_conflict');
    if(old.legacy){if(old.job.status==='success')return old;p.fail('Reconcile the original legacy job before resuming it at the center',409,'legacy_handoff_required');}
    await this.store.transaction(async db=>{
      const workspace=await this.workspace(ctx,workspaceId);await this.store.writable(db,ctx,workspaceId);
      const seed=(await q(db,'SELECT * FROM rssd_publications WHERE "orgId"=$1 AND id=$2',ctx.orgId,input.jobId))[0];if(!seed)p.fail('Original website job not found',404);
      await lock(db,ctx.orgId+':work:'+seed.workId);
      const row=(await q(db,'SELECT * FROM rssd_publications WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,input.jobId))[0];
      if(!row||row.workspaceId!==workspaceId||row.destinationId!=='site-'+workspace.siteId)p.fail('Original website job not found',404);
      if(row.state!=='blocked')return;
      const pending=(await q(db,`SELECT id FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND state IN ('queued','dispatching') LIMIT 1`,ctx.orgId,row.workId,row.locale))[0];
      if(pending)p.fail('A website visibility action is pending; preserve the original publication receipt',409,'publication_pending');
      const visibility=(await q(db,'SELECT visibility FROM rssd_editorial_states WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,row.workId,row.locale))[0];
      if(visibility&&visibility.visibility!=='active')p.fail('Restore or explicitly publish this hidden website edition through a visibility action',409,'edition_hidden');
      const head=(await q(db,'SELECT max(revision) AS revision FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,row.workId,row.locale))[0];
      if(head.revision!==row.revision)p.fail('A newer center edition exists; keep the original failed receipt',409,'stale_revision');
      if(ctx.workerId&&!((await q(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId))[0]))p.fail('Device revoked',401);
      await x(db,`UPDATE rssd_publications SET state='queued',error=NULL,receipt=receipt || '{"manualRetry":true}'::jsonb,"nextAttemptAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2`,ctx.orgId,row.id);
    });return this.receipt(ctx,workspaceId,key);
  }
  async api(ctx,workspaceId,method,path,query={},input){
    const parts=Array.isArray(path)?path:typeof path==='string'?path.split('/'):[];
    if(parts.some(part=>!part||part.includes('/')||part==='.'||part==='..'))p.fail('Invalid editorial path');
    const [first,id,third]=parts;
    let result;
    if(method==='GET'&&parts.length===1&&first==='site'){
      const workspace=await this.workspace(ctx,workspaceId);
      result={protocol:'scholay-content',version:1,siteId:workspace.siteId,spaceId:workspace.id,origin:workspace.origin,capabilities:['language-editions-v1','rssd-center-v1','staged-drafts-v1','bounded-media-v1']};
    }else if(first==='staged-drafts'){
      const drafts=new StagedDrafts(this,inputData);
      if(method==='GET'&&parts.length===1)result=await drafts.list(ctx,workspaceId,query);
      else if(method==='GET'&&parts.length===3&&id==='requests')result=await drafts.receipt(ctx,workspaceId,third);
      else if(method==='GET'&&parts.length===3&&id==='promotions')result=await drafts.promotion(ctx,workspaceId,third,query);
      else if(method==='GET'&&parts.length===2)result=await drafts.detail(ctx,workspaceId,id,query);
      else if(method==='POST'&&parts.length===1)result=await drafts.save(ctx,workspaceId,input);
      else p.fail('Unknown staged draft operation',404,'not_found');
    }else if(method==='GET'&&parts.length===3&&first==='cloud'&&id==='batch'&&third==='read')result=await this.cloudBatch(ctx,workspaceId,query);
    else if(method==='GET'&&parts.length===1&&first==='catalog')result=await this.catalog(ctx,workspaceId,query);
    else if(method==='GET'&&parts.length===1&&first==='index')result=await this.index(ctx,workspaceId,query);
    else if(method==='GET'&&parts.length===2&&['cloud','published'].includes(first))result=await this.detail(ctx,workspaceId,id,{scope:first,locale:query.locale,media:query.media});
    else if(method==='GET'&&parts.length===2&&first==='requests')result=await this.receipt(ctx,workspaceId,id);
    else if(method==='GET'&&parts.length===3&&first==='drafts'&&id==='requests')result=await this.receipt(ctx,workspaceId,third,{intent:'draft'});
    else if(method==='GET'&&parts.length===3&&first==='source-archives'&&id==='private-notes')result=await this.privateNotes(ctx,workspaceId,third,query.revision);
    else if(method==='GET'&&parts.length===2&&first==='source-archives')result=await this.archive(ctx,workspaceId,id);
    else if(method==='POST'&&parts.length===1&&['publish','drafts'].includes(first))result=await this.submit(ctx,workspaceId,input,{intent:first==='publish'?'publish':'draft'});
    else if(method==='POST'&&parts.length===1&&first==='source-archives')result=await this.saveArchive(ctx,workspaceId,input);
    else if(method==='POST'&&parts.length===3&&first==='requests'&&third==='retry')result=await this.retry(ctx,workspaceId,id,input);
    else if(first==='actions'&&this.actions){
      if(method==='POST'&&parts.length===1)result=await this.actions.submit(ctx,workspaceId,input);
      else if(method==='GET'&&parts.length===1)result=await this.actions.list(ctx,workspaceId);
      else if(method==='GET'&&parts.length===2)result=await this.actions.status(ctx,workspaceId,id);
      else if(method==='POST'&&parts.length===3&&third==='retry')result=await this.actions.retry(ctx,workspaceId,id,input);
      else p.fail('Unknown editorial action operation',404,'not_found');
    }else if(first==='actions'){await this.workspace(ctx,workspaceId);p.fail('Website actions are unavailable; the original content is retained',409,'center_action_pending');}
    else if(method==='GET'&&parts.length===1)result=await this.detail(ctx,workspaceId,first,{scope:'status',locale:query.locale});
    else p.fail('Unknown editorial operation',404,'not_found');
    return {...result,centerManaged:true};
  }
}
module.exports={RssdEditorial,archiveBundle,legacyFingerprint,nativePrivateEditorial};
