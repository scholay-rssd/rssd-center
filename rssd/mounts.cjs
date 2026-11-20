'use strict';
// The mount library: what the Center hands a writer for one work besides the section's rules. A mount item
// has a kind, an ID and revisions; a revision is content with a hash and is never changed once stored. The
// Center decides which items one work uses when its demand is claimed, freezes the decision with the claim,
// and hands the claiming device the content of exactly those items. A work's private record keeps each
// item's ID, revision and hash.
//
// The first kind is `persona`: a preset person of the persona library kept outside this repository, stored
// as the library's own writing snapshot. Which persona writes a work is decided by persona-voice.mjs, an
// unchanged copy of contracts/persona-voice.mjs in the rssd repository; see docs/persona-voice.md there.
const {randomUUID}=require('node:crypto');
const p=require('./protocol.cjs');
const {admin}=require('./store.cjs');
const rows=(db,sql,...values)=>db.$queryRawUnsafe(sql,...values);
const one=async(db,sql,...values)=>(await rows(db,sql,...values))[0]||null;
const execute=(db,sql,...values)=>db.$executeRawUnsafe(sql,...values);
const audit=(db,ctx,action,payload)=>execute(db,'INSERT INTO rssd_audit ("orgId",id,actor,action,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',ctx.orgId,randomUUID(),ctx.workerId||ctx.userId||'owner',action,JSON.stringify(payload));
const PERSONA='persona';
// How far back `balanced` looks when it counts which personas a section used.
const USAGE_DAYS=30;
// It is an ES module, so it is loaded once on first use.
let voices;const loadVoices=()=>voices||(voices=import('./persona-voice.mjs'));
// A contract error keeps its own code; anything else is a failure of this service.
const contract=fn=>{try{return fn();}catch(error){if(error instanceof p.ProtocolError)throw error;p.fail(error.message,error.status===400?400:500,error.code||'invalid_persona');}};

class RssdMounts {
 constructor(store){this.store=store;this.db=store.db;}

 /**
  * Add persona revisions. `input.personas` is a list of {snapshot, founderName}: the library's writing
  * snapshot of one preset, and the name of the founder it was tuned from, which signs. A revision that is
  * already stored with the same content is reported as `existing`; the same revision with other content is
  * refused, because a changed persona needs a new revision. Owner only.
  */
 async savePersonas(ctx,input){
  admin(ctx);const {personaEntry,writingPersonaSnapshot}=await loadVoices();
  // One request stays under the default body limit; a larger library is sent in several requests.
  const list=p.array(p.object(input,'personas').personas,'personas',30);
  if(!list.length)p.fail('Name at least one persona',400,'invalid_persona');
  const prepared=list.map(item=>contract(()=>{
   const value=p.object(item,'persona'),snapshot=writingPersonaSnapshot(value.snapshot);
   return {snapshot,entry:personaEntry(snapshot,{founderName:value.founderName})};
  }));
  if(new Set(prepared.map(x=>x.entry.id+'\0'+x.entry.revision)).size!==prepared.length)p.fail('A persona revision is listed twice',400,'invalid_persona');
  return this.store.transaction(async db=>{
   await execute(db,'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',ctx.orgId+':mounts:'+PERSONA);
   const personas=[];
   for(const {snapshot,entry} of prepared){
    const {active:_,...kept}=entry,old=await one(db,'SELECT hash,entry,content FROM rssd_mounts WHERE "orgId"=$1 AND kind=$2 AND id=$3 AND revision=$4',ctx.orgId,PERSONA,entry.id,entry.revision);
    if(old){
     const same=old.hash===entry.snapshotHash || (!old.entry.presetIdOnly && writingPersonaSnapshot(old.content).snapshotHash===entry.snapshotHash);
     if(!same||old.entry.founder?.name!==entry.founder.name)p.fail('Persona '+entry.id+' already has revision '+entry.revision+' with other content; a changed persona needs a new revision',409,'mount_conflict');
     personas.push({id:entry.id,revision:entry.revision,status:'existing'});continue;
    }
    await execute(db,'INSERT INTO rssd_mounts ("orgId",kind,id,revision,version,hash,entry,content) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',
     ctx.orgId,PERSONA,entry.id,entry.revision,Number(/\.v(\d+)$/.exec(entry.revision)[1]),entry.snapshotHash,JSON.stringify({...kept,presetIdOnly:true}),JSON.stringify(snapshot));
    personas.push({id:entry.id,revision:entry.revision,status:'created'});
   }
   // A persona that was retired stays retired when a new revision of it arrives.
   await execute(db,`UPDATE rssd_mounts m SET "retiredAt"=r."retiredAt" FROM (SELECT id,max("retiredAt") AS "retiredAt" FROM rssd_mounts WHERE "orgId"=$1 AND kind=$2 GROUP BY id) r
    WHERE m."orgId"=$1 AND m.kind=$2 AND m.id=r.id AND m."retiredAt" IS NULL AND r."retiredAt" IS NOT NULL`,ctx.orgId,PERSONA);
   await audit(db,ctx,'mounts.personas.save',{personas});
   return {personas};
  });
 }

 /** Retire a persona, or with `retired:false` bring it back. A retired persona is not picked for new works; the works it wrote keep it. Owner only. */
 async retirePersona(ctx,id,input={}){
  admin(ctx);p.id(id,'persona id');const retired=input.retired!==false;
  if(input.retired!==undefined&&typeof input.retired!=='boolean')p.fail('retired must be a boolean',400,'invalid_request');
  const changed=await execute(this.db,`UPDATE rssd_mounts SET "retiredAt"=${retired?'COALESCE("retiredAt",CURRENT_TIMESTAMP)':'NULL'} WHERE "orgId"=$1 AND kind=$2 AND id=$3`,ctx.orgId,PERSONA,id);
  if(!changed)p.fail('Persona not found',404,'not_found');
  await audit(this.db,ctx,'mounts.personas.'+(retired?'retire':'restore'),{id});
  return {id,retired};
 }

 /**
  * Every revision the Center keeps, as the entries `decideVoice` reads. Only the newest revision of a
  * persona that is not retired is active; older revisions stay so a work that has a source can keep the
  * revision that wrote it.
  */
 async library(db,orgId){
  const all=await rows(db,'SELECT id,version,entry,"retiredAt",CASE WHEN NOT (entry ? \'presetIdOnly\') THEN content END AS legacy FROM rssd_mounts WHERE "orgId"=$1 AND kind=$2 ORDER BY id,version',orgId,PERSONA);
  const newest=new Map(all.map(row=>[row.id,row.version]));
  const {writingPersonaSnapshot,personaEntry}=await loadVoices();
  return all.map(row=>{
   const active=!row.retiredAt && row.version===newest.get(row.id);
   if(!row.legacy)return {...row.entry,active};
   const snapshot=writingPersonaSnapshot(row.legacy);
   return {...personaEntry(snapshot,{founderName:row.entry.founder.name,active}),originalHash:row.entry.snapshotHash};
  });
 }

 /** The personas of the library for the owner: one row per persona, its newest revision, who signs and whether it is in use. No content. */
 async personas(ctx){
  admin(ctx);const all=await this.library(this.db,ctx.orgId),byId=new Map();
  for(const entry of all){const row=byId.get(entry.id)||{id:entry.id,revisions:[]};row.revisions.push(entry.revision);Object.assign(row,{revision:entry.revision,snapshotHash:entry.snapshotHash,founder:entry.founder,summary:entry.summary,active:entry.active});byId.set(entry.id,row);}
  return {personas:[...byId.values()]};
 }

 /** An order may only name a persona that can be picked now. */
 async requirePersona(db,orgId,id){
  if(!(await this.library(db,orgId)).some(entry=>entry.active&&entry.id===id))p.fail('The order names a persona the library does not have or has retired',409,'unknown_persona');
 }

 /**
  * The voice decision of one demand as it is claimed, or null when neither the section, the order nor a
  * source says anything about voices, so that such a claim stays exactly as it was. `policy` is the
  * section's policy being frozen with this claim.
  */
 async decide(db,orgId,demand,policy){
  const voice=policy?.voice||null,order=demand.payload.voice??null;
  // A translation or an update comes from one edition; a note rewritten from an article from the article.
  const from=demand.kind!=='write'?demand.payload.source:demand.payload.adaptedFrom;
  let source;
  if(from){
   const edition=from.locale
    ?await one(db,`SELECT payload->'metadata' AS metadata FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND locale=$3 AND revision=$4`,orgId,from.workId,from.locale,from.revision)
    :await one(db,`SELECT payload->'metadata' AS metadata FROM rssd_editions WHERE "orgId"=$1 AND "workId"=$2 AND revision=$3 ORDER BY locale DESC LIMIT 1`,orgId,from.workId,from.revision);
   const kept=edition?.metadata?.voice;
   source=kept?.id&&kept.revision?{id:kept.id,revision:kept.revision,snapshotHash:kept.snapshotHash,signed:Boolean(edition.metadata.persona?.id)}:null;
  }
  if(!source&&!voice&&!order)return null;
  const {decideVoice}=await loadVoices(),library=await this.library(db,orgId);
  let usage={};
  if(voice?.mode==='balanced'&&source===undefined&&!order){
   const used=await rows(db,`SELECT payload->'voiceDecision'->'persona'->>'id' AS id,count(*)::int AS count FROM rssd_demands WHERE "orgId"=$1 AND "workspaceId"=$2 AND "sectionId"=$3 AND id<>$4
     AND state IN ('claimed','blocked','completed') AND payload->'voiceDecision'->>'state'='chosen' AND "updatedAt">CURRENT_TIMESTAMP-make_interval(days=>$5) GROUP BY 1`,orgId,demand.workspaceId,demand.sectionId,demand.id,USAGE_DAYS);
   usage=Object.fromEntries(used.map(row=>[row.id,row.count]));
  }
  const decision=decideVoice({voice,order,source,library,demandId:demand.id,usage});
  // A writer running the old code may copy its source edition's original hash into a derived note.
  if(decision.method==='kept' && source.snapshotHash && source.snapshotHash!==decision.persona.snapshotHash &&
     library.some(entry=>entry.id===source.id && entry.revision===source.revision && entry.originalHash===source.snapshotHash))
   decision.sourceSnapshotHash=source.snapshotHash;
  return decision;
 }

 /** The stored snapshot a decision refers to, or null. */
 async snapshot(db,orgId,persona){
  const row=await one(db,'SELECT hash,content FROM rssd_mounts WHERE "orgId"=$1 AND kind=$2 AND id=$3 AND revision=$4',orgId,PERSONA,persona.id,persona.revision);
  if(!row)return null;
  if(row.hash===persona.snapshotHash)return row.content;
  const {writingPersonaSnapshot}=await loadVoices(),writing=writingPersonaSnapshot(row.content);
  return writing.snapshotHash===persona.snapshotHash?writing:null;
 }

 /**
  * A claimed demand as its own device receives it: with the content of the mounts its frozen decisions
  * name, under `mounts`. The content is not kept on the demand, so nobody who lists demands reads it.
  */
 async attach(db,orgId,row){
  const decision=row?.payload?.voiceDecision;
  if(decision?.state!=='chosen')return row;
  const voice=await this.snapshot(db,orgId,decision.persona);
  return voice?{...row,mounts:{voice}}:row;
 }

 /**
  * The writer's answer where the section lets it choose: `personaId` with a one-sentence `reason` picks one
  * of the candidates; without `personaId` the writer declines and the section's fallback applies. Either
  * way the decision is settled once and frozen. Asking again returns the settled decision and its snapshot,
  * so a device that lost the reply can read it back; naming another persona then is refused.
  */
 async chooseVoice(ctx,input){
  if(!ctx.workerId)p.fail('Device authentication required',403);
  const value=p.object(input,'voice choice'),demandId=p.id(value.demandId,'demandId'),claimToken=p.id(value.claimToken,'claimToken');
  const personaId=value.personaId==null?null:p.id(value.personaId,'personaId');
  const {settleVoice,lapseVoice}=await loadVoices();
  return this.store.transaction(async db=>{
   const demand=await one(db,'SELECT * FROM rssd_demands WHERE "orgId"=$1 AND id=$2 FOR UPDATE',ctx.orgId,demandId);
   if(!demand||!['claimed','blocked'].includes(demand.state)||demand.workerId!==ctx.workerId||demand.claimToken!==claimToken)p.fail('Claim no longer belongs to this device',409,'claim_revoked');
   const current=demand.payload.voiceDecision;
   if(!current)p.fail('This work is not waiting for a persona to be chosen',409,'voice_not_pending');
   let decision=current;
   if(current.state==='pending'){
    decision=contract(()=>personaId?settleVoice(current,personaId,value.reason):lapseVoice(current));
    await execute(db,'UPDATE rssd_demands SET payload=$3::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "orgId"=$1 AND id=$2',ctx.orgId,demandId,JSON.stringify({...demand.payload,voiceDecision:decision}));
    await audit(db,ctx,'demand.voice',{id:demandId,method:decision.method||null,persona:decision.persona?.id||null});
   }else if(personaId&&decision.persona?.id!==personaId)p.fail('The persona of this work is already decided',409,'voice_not_pending');
   const voice=decision.state==='chosen'?await this.snapshot(db,ctx.orgId,decision.persona):null;
   return {demandId,voiceDecision:decision,...(voice?{mounts:{voice}}:{})};
  });
 }

 /**
  * What a submission under a claim must carry for the claim's frozen decision, checked for each edition of
  * a new work. A decision the writer never settled lapses here. Returns the decision that applies.
  */
 async checkSubmission(decision,editions,{presetRecord=false}={}){
  const {lapseVoice}=await loadVoices(),settled=lapseVoice(decision),chosen=settled.state==='chosen'?settled.persona:null;
  for(const edition of editions){
   const metadata=edition.metadata||{},wrote=metadata.voice,where='the '+edition.locale+' edition ';
   if(!chosen){
    if(wrote||metadata.persona)p.fail('This work has no persona; '+where+'names one',409,'voice_conflict');
    continue;
   }
   const sourceHash=!presetRecord && settled.method==='kept' && settled.sourceSnapshotHash && wrote?.snapshotHash===settled.sourceSnapshotHash;
   if(wrote?.id!==chosen.id||wrote?.revision!==chosen.revision||(!sourceHash && wrote?.snapshotHash!==chosen.snapshotHash))
    p.fail('This work is written by persona '+chosen.id+' at '+chosen.revision+'; '+where+'records another',409,'voice_conflict');
   if(settled.byline==='persona'){
    const signingId=metadata.persona?.id;
    const matches=signingId===chosen.id || (!presetRecord && signingId===chosen.founder.id);
    if(metadata.author!==chosen.founder.name || !matches || Object.keys(metadata.persona).length!==1)
     p.fail('This work is signed by '+chosen.founder.name+'; '+where+'carries another signing identity',409,'byline_conflict');
   }else if(metadata.persona)p.fail('This work is signed by the site; '+where+'names a persona as its byline',409,'byline_conflict');
   if(Object.keys(wrote).length!==3)p.fail('A writing record contains only the preset ID, revision and snapshot hash',409,'voice_conflict');
  }
  return settled;
 }
}
module.exports={RssdMounts,USAGE_DAYS};
