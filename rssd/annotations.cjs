'use strict';
// Annotations of finished works: answers to the versioned questionnaire in annotation-forms.json, given by
// people and by models, kept apart from the works themselves so that annotating never creates a revision.
//
// An annotation names one published revision of one language edition, the form version it answers and who
// answered. Rows are only ever added: a changed answer is a new row, and the newest row of one annotator for one
// revision and form version is the one that counts. Until a person has answered, they are shown nobody else's
// answers for that revision.
const {randomUUID}=require('node:crypto');
const p=require('./protocol.cjs');
const {scope}=require('./store.cjs');
const rows=(db,sql,...values)=>db.$queryRawUnsafe(sql,...values);
const one=async(db,sql,...values)=>(await rows(db,sql,...values))[0]||null;
const PUBLISHED=`('published','legacy_published')`;
// The form and its rules are one ES module shared with the writing tools, loaded once on first use.
let forms;const loadForms=()=>forms||(forms=import('./annotation-forms.mjs'));

class RssdAnnotations {
 /** `editorial` (optional) resolves a site's article ID to its work, for clients that know works by that ID. */
 constructor(store,{editorial}={}){this.store=store;this.db=store.db;this.editorial=editorial;}

 async form(ctx){if(!ctx?.orgId)p.fail('Authentication required',401,'unauthorized');return (await loadForms()).ANNOTATION_FORM;}

 /** Who is answering. A device may also submit a model's answers, named by the model's ID. */
 annotator(ctx,input){
  const submittedBy=ctx.workerId?'device:'+ctx.workerId:ctx.userId?'user:'+ctx.userId:null;
  if(!submittedBy)p.fail('Authentication required',401,'unauthorized');
  if(input?.annotator==null)return {kind:'person',id:submittedBy,submittedBy};
  const value=p.object(input.annotator,'annotator');
  if(value.kind!=='model')p.fail('An annotator is named only for a model',400,'invalid_annotation');
  return {kind:'model',id:p.id(value.id,'annotator.id'),submittedBy};
 }

 /**
  * The revision to annotate and what the form needs to know about it. `input` names the work by `workId`, or by
  * `workspaceId` and `articleId`; `revision` defaults to the newest published one. Only a published revision of an
  * article or a note can be annotated.
  */
 async target(ctx,input){
  const value=p.object(input,'annotation target'),locale=p.locale(value.locale||'zh-CN');
  let workId=value.workId;
  if(!workId){
   if(!this.editorial||!value.workspaceId||!value.articleId)p.fail('Name the work to annotate',400,'invalid_annotation');
   const entry=await this.editorial.find(ctx,p.id(value.workspaceId,'workspaceId'),p.id(value.articleId,'articleId'),{locale});
   if(!entry)p.fail('Work not found',404,'not_found');workId=entry.workId;
  }
  const work=await this.store.work(ctx,p.id(workId,'workId'));
  const newest=await one(this.db,`SELECT max(revision) AS revision FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND state IN ${PUBLISHED}`,ctx.orgId,work.id,locale);
  const revision=value.revision==null?newest?.revision:p.integer(value.revision,'revision',1);
  if(!revision)p.fail('Only a published revision can be annotated',409,'not_published');
  if(value.revision!=null&&!await one(this.db,`SELECT 1 AS found FROM rssd_publications WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4 AND state IN ${PUBLISHED} LIMIT 1`,ctx.orgId,work.id,locale,revision))
   p.fail('Only a published revision can be annotated',409,'not_published');
  const edition=await this.store.edition(ctx,work.id,locale,revision),metadata=edition.payload.metadata||{};
  if(metadata.record)p.fail('Calendar, history and resource records are not annotated',409,'not_annotatable');
  const workType=metadata.workType==='note'?'note':'article';
  // The section's writing family comes from the published writing defaults; without them only the common
  // questions are asked.
  let family;
  try{const catalog=await this.store.writingDefaults?.catalog();family=catalog?.workspaces.find(w=>w.workspaceId===work.workspaceId)?.sections.find(s=>s.id===work.sectionId)?.familyId;}catch{family=undefined;}
  const cards=workType==='article'&&Boolean(await one(this.db,`SELECT 1 AS found FROM rssd_renditions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4 AND payload->>'representation'='raster' LIMIT 1`,ctx.orgId,work.id,locale,revision));
  return {workId:work.id,workspaceId:work.workspaceId,sectionId:work.sectionId,locale,revision,latestPublishedRevision:newest?.revision??revision,editionHash:edition.hash,title:edition.payload.title,
   work:{workType,...(family&&workType==='article'?{family}:{}),...(cards?{cards:true}:{}),...(workType==='note'&&metadata.adaptedFrom?{adapted:true}:{})}};
 }

 /** The newest row of one annotator for one revision and form version, or null. */
 mine(ctx,target,annotator,formVersion){
  return one(this.db,`SELECT id,"formVersion",answers,"createdAt" FROM rssd_annotations WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4 AND "formVersion"=$5 AND "annotatorKind"=$6 AND "annotatorId"=$7
   ORDER BY "createdAt" DESC,id DESC LIMIT 1`,ctx.orgId,target.workId,target.locale,target.revision,formVersion,annotator.kind,annotator.id);
 }

 /** What to show an annotator for one work: the revision, the sections that apply, and their own answers if any. */
 async describe(ctx,input){
  const {ANNOTATION_FORM,annotationSectionsFor}=await loadForms(),target=await this.target(ctx,input),annotator=this.annotator(ctx,input);
  return {formVersion:ANNOTATION_FORM.version,target,sections:annotationSectionsFor(ANNOTATION_FORM,target.work),mine:await this.mine(ctx,target,annotator,ANNOTATION_FORM.version)};
 }

 /** Add one answer sheet. The form version must be the current one, so answers are never checked against a form they were not given for. */
 async submit(ctx,input){
  const {ANNOTATION_FORM,validateAnnotationAnswers}=await loadForms(),value=p.object(input,'annotation');
  if(value.formVersion!==ANNOTATION_FORM.version)p.fail('The annotation form changed; reload it and answer again',409,'form_changed');
  const target=await this.target(ctx,value),annotator=this.annotator(ctx,value);
  if(value.editionHash!==undefined&&value.editionHash!==target.editionHash)p.fail('The edition changed; reload it and answer again',409,'source_conflict');
  let answers;try{answers=validateAnnotationAnswers(ANNOTATION_FORM,target.work,value.answers);}catch(error){p.fail(error.message,400,'invalid_annotation');}
  await this.store.writable(this.db,ctx,target.workspaceId);
  const id=randomUUID();
  const row=await one(this.db,`INSERT INTO rssd_annotations ("orgId",id,"workspaceId","sectionId","workId",locale,revision,"editionHash","formVersion","annotatorKind","annotatorId","submittedBy",target,answers)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb) RETURNING id,"workId",locale,revision,"formVersion","annotatorKind","annotatorId",answers,"createdAt"`,
   ctx.orgId,id,target.workspaceId,target.sectionId,target.workId,target.locale,target.revision,target.editionHash,ANNOTATION_FORM.version,annotator.kind,annotator.id,annotator.submittedBy,JSON.stringify(target.work),JSON.stringify(answers));
  await this.db.$executeRawUnsafe('INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,randomUUID(),ctx.workerId||ctx.userId||'owner','annotation.submit',JSON.stringify({id,workId:target.workId,locale:target.locale,revision:target.revision,annotator:annotator.kind+':'+annotator.id}));
  return row;
 }

 /**
  * Annotations that count: the newest row per annotator, revision and form version. The owner sees every
  * annotator's; a device sees what it submitted itself, plus, for a revision it has answered as a person, the
  * others' answers for that revision.
  */
 async list(ctx,{workspaceId,workId,locale,limit=100,offset=0}={}){
  if(!ctx?.orgId)p.fail('Authentication required',401,'unauthorized');
  if(workspaceId)scope(ctx,p.id(workspaceId,'workspaceId'));if(workId)p.id(workId,'workId');if(locale)p.locale(locale);
  limit=p.integer(Number(limit),'limit',1,200);offset=p.integer(Number(offset),'offset',0,1000000);
  const self=ctx.workerId?'device:'+ctx.workerId:'user:'+ctx.userId;
  return rows(this.db,`WITH current AS (SELECT DISTINCT ON ("workId",locale,revision,"formVersion","annotatorKind","annotatorId") * FROM rssd_annotations
    WHERE "orgId"=$1 AND ($2::text IS NULL OR "workspaceId"=$2) AND ($3::jsonb IS NULL OR "workspaceId" IN (SELECT jsonb_array_elements_text($3::jsonb)))
     AND ($4::text IS NULL OR "workId"=$4) AND ($5::text IS NULL OR locale=$5)
    ORDER BY "workId",locale,revision,"formVersion","annotatorKind","annotatorId","createdAt" DESC,id DESC)
   SELECT id,"workspaceId","sectionId","workId",locale,revision,"editionHash","formVersion","annotatorKind","annotatorId",target,answers,"createdAt" FROM current c
   WHERE $6::boolean OR c."submittedBy"=$7 OR EXISTS (SELECT 1 FROM rssd_annotations m WHERE m."orgId"=c."orgId" AND m."workId"=c."workId" AND m.locale=c.locale AND m.revision=c.revision
     AND m."formVersion"=c."formVersion" AND m."annotatorKind"='person' AND m."annotatorId"=$7)
   ORDER BY "createdAt" DESC,id DESC LIMIT $8 OFFSET $9`,ctx.orgId,workspaceId||null,ctx.workspaceIds===null?null:JSON.stringify(ctx.workspaceIds),workId||null,locale||null,Boolean(ctx.admin),self,limit,offset);
 }
}
module.exports={RssdAnnotations};
