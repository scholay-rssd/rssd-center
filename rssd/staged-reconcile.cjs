'use strict';
// Used only inside the locked migration activation transaction. It promotes a
// branch whose exact source/base has survived final import, retaining all branch
// revisions and media. It creates private drafts, never publications.
const p=require('./protocol.cjs');
const {RssdStore}=require('./store.cjs');
const {RssdEditorial}=require('./editorial.cjs');
const {prepareStructuredDraft}=require('./structured-draft.cjs');
const q=(db,sql,...v)=>db.$queryRawUnsafe(sql,...v),x=(db,sql,...v)=>db.$executeRawUnsafe(sql,...v);
async function promoteStaged({db,ctx,workspaceId,media,limit=8}){
 const drafts=await q(db,`WITH heads AS (SELECT DISTINCT ON ("workId",locale) * FROM rssd_staged_drafts WHERE "orgId"=$1 AND "workspaceId"=$2 ORDER BY "workId",locale,"overlayRevision" DESC)
  SELECT h.* FROM heads h WHERE NOT EXISTS (SELECT 1 FROM rssd_staged_draft_promotions t WHERE t."orgId"=h."orgId" AND t."workspaceId"=h."workspaceId" AND t."workId"=h."workId" AND t.locale=h.locale AND t."overlayRevision"=h."overlayRevision") ORDER BY h."workId",h.locale LIMIT $3`,ctx.orgId,workspaceId,limit);
 if(!drafts.length)return [];
 const store=new RssdStore(db);store.transaction=fn=>fn(db);
 const editor=new RssdEditorial(store,media),entries=await editor.entries(ctx,workspaceId),promotions=[];
 for(const draft of drafts){
  const candidates=entries.filter(e=>e.workId===draft.workId&&e.locale===draft.locale&&!e.deletedAt);
  const row=candidates.length===1?candidates[0]:null;
  if(!row||row.articleId!==draft.articleId||row.revision!==draft.baseRevision||(row.publishedVersion??null)!==draft.basePublishedVersion)p.fail('The final source conflicts with a private staged draft',409,'staged_reconcile_conflict');
  const base=await store.edition(ctx,draft.workId,draft.locale,draft.baseRevision);
  const source=await q(db,'SELECT "sourceHash" FROM rssd_legacy_documents WHERE "orgId"=$1 AND "siteId"=$2 AND "workId"=$3 AND locale=$4 AND "deletedAt" IS NULL',ctx.orgId,(await editor.workspace(ctx,workspaceId)).siteId,draft.workId,draft.locale);
  if(base.hash!==draft.baseHash||source.length!==1||source[0].sourceHash!==draft.baseSourceHash)p.fail('The final source conflicts with a private staged draft',409,'staged_reconcile_conflict');
  let bodyMarkdown=draft.data.markdown;
  const referenced=new Set(bodyMarkdown.match(/\/article-media\/[A-Za-z0-9._-]+/g)||[]);
  const saved=[...(base.payload.media||[])],ids=new Set(saved.map(a=>a.id));
  for(const ref of draft.data.assets||[]){
   if(!referenced.has(ref.path))continue; // Older branch-only media remain in the retained overlay history.
   const item=await media.row(ctx,ref.id);
   if(item.workspaceId!==workspaceId||item.manifest.path!==ref.path)p.fail('Staged media cannot be reconciled',409,'media_conflict');
   if(!ids.has(ref.id)){await media.bytes(ctx,ref.id);saved.push({id:ref.id,alt:''});ids.add(ref.id);}
   bodyMarkdown=bodyMarkdown.replaceAll(ref.path,'/api/rssd/v1/media/'+ref.id+'/raw');
   referenced.delete(ref.path);
  }
  if(referenced.size||/\/article-media\/[A-Za-z0-9._-]+/.test(bodyMarkdown))p.fail('Staged draft image is missing',409,'media_conflict');
  let metadata={...(base.payload.metadata||{}),author:draft.data.author,date:draft.data.date,category:draft.data.category};
  if(row.kind!=='news'){
   const sourceData=await editor.data(ctx,workspaceId,row,draft.baseRevision,entries,{referencedOnly:true});
   const proposed={...draft.data};delete proposed.record;
   const prepared=prepareStructuredDraft({edition:base.payload,source:sourceData,proposed,expected:{kind:row.kind,documentId:row.documentId,articleId:row.articleId,sectionId:row.sectionId,locale:row.locale}});
   metadata={...metadata,record:{...prepared.metadata.record,fields:{...prepared.metadata.record.fields,...prepared.sections}}};
  }
  const edition={...base.payload,title:draft.data.title,summary:draft.data.summary,bodyMarkdown,metadata,media:saved};
  const requestId='staged-promote-'+p.hash([workspaceId,draft.workId,draft.locale,draft.overlayRevision,draft.baseHash]).slice(0,48);
  const result=await store.submit(ctx,{requestId,workId:draft.workId,workspaceId,sectionId:row.sectionId,baseRevisions:{[draft.locale]:draft.baseRevision},editions:[edition]},{publish:false});
  if(result.status!=='draft_saved'||result.publicationIds.length||result.editions.length!==1)p.fail('Staged promotion receipt is invalid',409,'reconcile_invalid');
  const canonicalRevision=result.editions[0].revision;
  const canonicalHash=result.editions[0].hash;
  await x(db,`INSERT INTO rssd_staged_draft_promotions ("orgId","workspaceId","workId",locale,"articleId","overlayRevision","baseRevision","baseHash","canonicalRevision","canonicalHash","requestId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,ctx.orgId,workspaceId,draft.workId,draft.locale,draft.articleId,draft.overlayRevision,draft.baseRevision,draft.baseHash,canonicalRevision,canonicalHash,requestId);
  promotions.push({articleId:draft.articleId,workId:draft.workId,locale:draft.locale,overlayRevision:draft.overlayRevision,baseRevision:draft.baseRevision,baseHash:draft.baseHash,canonicalRevision,canonicalHash,requestId});
 }
 return promotions;
}
module.exports={promoteStaged};
