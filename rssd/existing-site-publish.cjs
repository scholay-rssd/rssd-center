'use strict';
const {randomUUID}=require('node:crypto');
const p=require('./protocol.cjs');
const {scope}=require('./store.cjs');
const encoded=value=>JSON.stringify(value);
const q=(db,sql,...args)=>db.$queryRawUnsafe(sql,...args);
const x=(db,sql,...args)=>db.$executeRawUnsafe(sql,...args);
const one=async(...args)=>(await q(...args))[0]||null;
const lock=(db,key)=>x(db,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',key);
const RECEIPT_FIELDS=Object.freeze(['requestId','status','workId','workspaceId','locale','revision','hash','destinationId','destinationKind','publicationId','publicationState','articleId']);
const INPUT_FIELDS=Object.freeze(['requestId','workId','locale','revision','hash','destinationId','articleId']);
function editionHash(value){
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))p.fail('Invalid hash',400,'invalid_request');
 return value;
}
function documentId(workId,locale){
 const h=p.hash([workId,locale]).slice(0,32);
 return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}
function resolveArticleId(workId,locale,payload){
 const metadata=payload?.metadata||{};
 const kind=metadata.record?.kind||'news';
 if(kind!=='news')return 'record-'+(metadata.editorial?.documentId||documentId(workId,locale));
 return metadata.editorial?.articleId||('center-'+p.hash([workId,locale]).slice(0,48));
}
function publicReceipt(row,publication){
 const value={
  requestId:row.requestId,status:row.status,workId:row.workId,workspaceId:row.workspaceId,
  locale:row.locale,revision:row.revision,hash:row.editionHash,destinationId:row.destinationId,
  destinationKind:'site',publicationId:row.publicationId,publicationState:publication?.state||null,
  articleId:row.articleId,
 };
 return Object.fromEntries(RECEIPT_FIELDS.map(k=>[k,value[k]]));
}
class RssdExistingSitePublish {
 constructor(store){this.store=store;this.db=store.db;}
 async receipt(ctx,requestId){
  p.id(requestId,'requestId');
  const row=await one(this.db,'SELECT * FROM rssd_existing_site_publishes WHERE "orgId"=$1 AND "requestId"=$2',ctx.orgId,requestId);
  if(!row)p.fail('Publication request not found',404,'not_found');
  scope(ctx,row.workspaceId);
  const publication=await one(this.db,'SELECT id,state FROM rssd_publications WHERE "orgId"=$1 AND id=$2',ctx.orgId,row.publicationId);
  return publicReceipt({...row,status:row.result?.status||'existing'},publication);
 }
 async publish(ctx,input={}){
  p.object(input,'existing English site publication');
  for(const key of Object.keys(input))if(!INPUT_FIELDS.includes(key))p.fail('Unknown field',400,'invalid_request');
  const requestId=p.id(input.requestId,'requestId'),workId=p.id(input.workId,'workId');
  if(input.locale!=='en')p.fail('Existing-site publish is English only',409,'english_only');
  const locale=p.locale(input.locale),revision=p.integer(input.revision,'revision',1);
  const hash=editionHash(input.hash),destinationId=p.id(input.destinationId,'destinationId');
  const articleId=input.articleId===undefined?undefined:p.id(input.articleId,'articleId');
  const fingerprint=p.hash({workId,locale,revision,hash,destinationId,articleId:articleId||null});
  return this.store.transaction(async db=>{
   await lock(db,ctx.orgId+':existing-site-publish:'+requestId);
   if(ctx.workerId&&!await one(db,'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId))p.fail('Device revoked',401,'unauthorized');
   const previous=await one(db,'SELECT * FROM rssd_existing_site_publishes WHERE "orgId"=$1 AND "requestId"=$2',ctx.orgId,requestId);
   if(previous){
    if(previous.payloadHash!==fingerprint)p.fail('Request identity was reused with different content',409,'request_conflict');
    scope(ctx,previous.workspaceId);
    const publication=await one(db,'SELECT id,state FROM rssd_publications WHERE "orgId"=$1 AND id=$2',ctx.orgId,previous.publicationId);
    return publicReceipt({...previous,status:previous.result?.status||'existing'},publication);
   }
   await lock(db,ctx.orgId+':work:'+workId);
   const work=await one(db,'SELECT * FROM rssd_works WHERE "orgId"=$1 AND id=$2',ctx.orgId,workId);
   if(!work)p.fail('Work not found',404,'not_found');
   scope(ctx,work.workspaceId);
   await this.store.writable(db,ctx,work.workspaceId);
   const openStoreOnly=await one(db,`SELECT id FROM rssd_demands WHERE "orgId"=$1 AND kind='translate' AND state IN ('queued','claimed','blocked')
     AND payload->>'storeOnly'='true' AND payload->'source'->>'workId'=$2 LIMIT 1`,ctx.orgId,workId);
   if(openStoreOnly)p.fail('An open store-only translate forbids other writes to this work',409,'store_only_conflict');
   const {row:workspace}=await this.store.workspace(db,ctx,work.workspaceId,work.sectionId);
   const siteId=workspace.payload.siteId;
   if(!siteId)p.fail('Workspace has no website destination',409,'missing_destination');
   const canonical='site-'+siteId;
   if(destinationId!==canonical)p.fail('Only the workspace website destination can be published',409,'unsupported_destination');
   const destination=await one(db,'SELECT id,kind,enabled,"workspaceIds",config FROM rssd_destinations WHERE "orgId"=$1 AND id=$2',ctx.orgId,destinationId);
   if(!destination||destination.kind!=='site'||!destination.enabled||!destination.workspaceIds.includes(work.workspaceId)||destination.config.siteId!==siteId)
    p.fail('Website destination is not configured for this workspace',409,'missing_destination');
   const action=await one(db,`SELECT id FROM rssd_editorial_actions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND state IN ('queued','dispatching') LIMIT 1`,ctx.orgId,workId,locale);
   if(action)p.fail('A website visibility action is in progress; retain the local result until its receipt settles',409,'publication_pending');
   const visibility=await one(db,'SELECT visibility FROM rssd_editorial_states WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3',ctx.orgId,workId,locale);
   if(visibility?.visibility==='deleted')p.fail('This edition was deleted; restore it explicitly before editing',409,'edition_deleted');
   if(visibility?.visibility==='withdrawn')p.fail('This website edition is withdrawn; explicitly publish or restore it through a visibility action',409,'edition_withdrawn');
   const edition=await one(db,'SELECT locale,revision,payload,hash FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4',ctx.orgId,workId,locale,revision);
   if(!edition)p.fail('Edition revision not found',404,'not_found');
   if(edition.hash!==hash)p.fail('Edition fingerprint does not match the requested revision',409,'source_conflict');
   const resolved=resolveArticleId(workId,locale,edition.payload);
   if(articleId!==undefined&&articleId!==resolved)p.fail('English manuscript identity does not match this revision',409,'identity_conflict');
   const existingPublication=await one(db,'SELECT id,state FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4 AND "destinationId"=$5',ctx.orgId,workId,locale,revision,destinationId);
   let publicationId,status;
   if(existingPublication){
    publicationId=existingPublication.id;status='existing';
   }else{
    publicationId=randomUUID();status='created';
    const inserted=await one(db,`INSERT INTO rssd_publications ("orgId",id,"workId","workspaceId",locale,revision,"destinationId",payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT ("orgId","workId",locale,revision,"destinationId") DO NOTHING RETURNING id`,
     ctx.orgId,publicationId,workId,work.workspaceId,locale,revision,destinationId,encoded({edition:edition.payload,sectionId:work.sectionId,policyVersion:0,hash,intent:'existingEnglishSitePublish'}));
    if(!inserted){
     const raced=await one(db,'SELECT id,state FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4 AND "destinationId"=$5',ctx.orgId,workId,locale,revision,destinationId);
     publicationId=raced.id;status='existing';
    }
   }
   const publication=await one(db,'SELECT id,state FROM rssd_publications WHERE "orgId"=$1 AND id=$2',ctx.orgId,publicationId);
   const result=publicReceipt({requestId,status,workId,workspaceId:work.workspaceId,locale,revision,editionHash:hash,destinationId,publicationId,articleId:resolved},publication);
   await x(db,`INSERT INTO rssd_existing_site_publishes ("orgId","requestId","workspaceId","workId",locale,revision,"destinationId","editionHash","articleId","publicationId","payloadHash",result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,ctx.orgId,requestId,work.workspaceId,workId,locale,revision,destinationId,hash,resolved,publicationId,fingerprint,encoded(result));
   await x(db,'INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,randomUUID(),ctx.workerId||ctx.userId||'center','publication.existingEnglishSite',encoded({requestId,workId,locale,revision,destinationId,publicationId,status}));
   return result;
  });
 }
}
const EXISTING_ENGLISH_SITE_PUBLISH_VERSION=1;
const EXISTING_ENGLISH_SITE_PUBLISH_GUARANTEES=Object.freeze(['canonicalSiteOnly','englishOnly','existingRevision','hashBind','localeIdentity','noEditionRewrite','zeroExternalTasks','idempotentReceipt','openWorkFence']);
function existingEnglishSitePublishContract(){return {version:EXISTING_ENGLISH_SITE_PUBLISH_VERSION,guarantees:[...EXISTING_ENGLISH_SITE_PUBLISH_GUARANTEES]};}
function supportsExistingEnglishSitePublish(overview){
 const row=overview?.contracts?.existingEnglishSitePublish;
 if(!row||typeof row!=='object'||Array.isArray(row)||!Number.isInteger(row.version)||row.version<EXISTING_ENGLISH_SITE_PUBLISH_VERSION||!Array.isArray(row.guarantees))return false;
 return EXISTING_ENGLISH_SITE_PUBLISH_GUARANTEES.every(token=>row.guarantees.includes(token));
}
module.exports={RssdExistingSitePublish,RECEIPT_FIELDS,INPUT_FIELDS,resolveArticleId,EXISTING_ENGLISH_SITE_PUBLISH_VERSION,EXISTING_ENGLISH_SITE_PUBLISH_GUARANTEES,existingEnglishSitePublishContract,supportsExistingEnglishSitePublish};
