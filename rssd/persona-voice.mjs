// Which persona writes a work, and under whose name it is signed. See docs/persona-voice.md.
//
// A persona is a preset person of the persona library kept outside this repository. RSSD takes two things
// from the library as they are: a preset's writing snapshot (how it writes) and the name of the founder the
// preset was tuned from (the byline). A section's frozen policy says how a work gets its persona
// (`policy.voice` in rssd-v1.cjs); an order may name one or ask for none (`demand.voice`). The Center
// decides with `decideVoice` when a demand is claimed and freezes the decision with the claim; every
// device and the Center use this one implementation.
import {createHash} from 'node:crypto';

export const PERSONA_SNAPSHOT_SCHEMA='12monkey.content-persona-snapshot.v1';
export const VOICE_MODES=['fixed','choose','random','balanced'];
export const VOICE_BYLINES=['persona','site'];
/** The most candidates a writer is shown when it chooses the persona itself. */
export const CANDIDATE_LIMIT=5;
const SNAPSHOT_BYTES=20000;

const fail=(message,code='invalid_persona')=>{throw Object.assign(Error(message),{status:400,code});};
const filled=value=>typeof value==='string'&&value.trim().length>0;
const strings=value=>Array.isArray(value)&&value.length>0&&value.every(filled);
const HASH=/^[a-f0-9]{64}$/;
const keys=(value,expected)=>{
 if(value===null||typeof value!=='object'||Array.isArray(value))return false;
 const actual=Object.keys(value).sort(),wanted=[...expected].sort();
 return actual.length===wanted.length&&actual.every((key,index)=>key===wanted[index]);
};
// The library's own canonical form: keys sorted at every level, no whitespace.
const sorted=value=>Array.isArray(value)?value.map(sorted):value===null||typeof value!=='object'?value
 :Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]));
const sha256=value=>createHash('sha256').update(value).digest('hex');

/**
 * A preset's writing snapshot as the persona library compiles it, checked and returned as a plain copy.
 * It is accepted only whole: the library's schema, exactly its fields, and a hash that matches. RSSD never
 * edits a snapshot, so the hash a work records can be checked against the library later. A snapshot carries
 * no demographics, and one that does is refused.
 */
export function personaSnapshot(input){
 let raw;try{raw=JSON.stringify(input);}catch{fail('A persona snapshot must be plain data');}
 if(typeof raw!=='string'||raw.length>SNAPSHOT_BYTES)fail('A persona snapshot is missing or too large');
 const s=JSON.parse(raw),p=s?.preset,b=s?.behavior;
 const shaped=keys(s,['schemaVersion','kind','fictional','preset','publicProfile','behavior','developerInstructions','snapshotHash'])
  &&s.schemaVersion===PERSONA_SNAPSHOT_SCHEMA&&s.kind==='preset-persona'&&s.fictional===true
  &&keys(p,['id','revision','contentHash','personalityHash','founder'])
  &&/^P\d{4,}$/.test(p.id??'')&&new RegExp('^'+String(p.id).toLowerCase()+'\\.v\\d+$').test(p.revision??'')
  &&HASH.test(p.contentHash??'')&&HASH.test(p.personalityHash??'')
  &&keys(p.founder,['id','revision','personalityHash'])&&/^M\d{2,}$/.test(p.founder.id??'')
  &&filled(p.founder.revision)&&HASH.test(p.founder.personalityHash??'')
  &&keys(s.publicProfile,['chineseScreenName','englishScreenName','abbreviation'])&&Object.values(s.publicProfile).every(filled)
  &&keys(b,['tuningIntent','core','strengths','blindSpots','communicationStyle','decisionStyle','collaborationStyle','underPressure'])
  &&filled(b.tuningIntent)&&filled(b.core)&&strings(b.strengths)&&strings(b.blindSpots)
  &&filled(b.communicationStyle)&&filled(b.decisionStyle)&&filled(b.collaborationStyle)&&filled(b.underPressure)
  &&filled(s.developerInstructions)&&HASH.test(s.snapshotHash??'');
 if(!shaped)fail('Not a persona snapshot ('+PERSONA_SNAPSHOT_SCHEMA+')');
 const {snapshotHash,...payload}=s;
 if(sha256(JSON.stringify(sorted(payload)))!==snapshotHash)fail('The persona snapshot does not match its hash','persona_hash_mismatch');
 return s;
}

/**
 * What the Center keeps about one revision of a persona besides the snapshot itself, and what a decision
 * refers to: the preset's ID and revision, the snapshot's hash, and the founder whose name signs.
 * `founderName` comes from the library's founder pack; a preset's own screen names are never a byline.
 * A retired persona (`active:false`) is no longer picked, and stays readable for the works it wrote.
 */
export function personaEntry(snapshot,{founderName,active=true}={}){
 const s=personaSnapshot(snapshot);
 if(!filled(founderName)||founderName!==founderName.trim()||founderName.length>80||/[\x00-\x1f\x7f]/.test(founderName))fail('A persona needs the name of its founder');
 return {id:s.preset.id,revision:s.preset.revision,snapshotHash:s.snapshotHash,
  founder:{id:s.preset.founder.id,name:founderName},active:active!==false,
  summary:{core:s.behavior.core,communicationStyle:s.behavior.communicationStyle,strengths:[...s.behavior.strengths]}};
}

const reference=entry=>({id:entry.id,revision:entry.revision,snapshotHash:entry.snapshotHash,founder:{...entry.founder}});
const candidate=entry=>({...reference(entry),summary:{...entry.summary,strengths:[...entry.summary.strengths]}});
// A fixed order of the entries for one demand: the same demand always gets the same order, and adding a
// persona to the library moves the others as little as possible.
const drawn=(entries,demandId)=>[...entries].sort((a,b)=>{
 const x=sha256(demandId+'\0'+a.id),y=sha256(demandId+'\0'+b.id);return x<y?-1:x>y?1:a.id<b.id?-1:1;});
const current=library=>(Array.isArray(library)?library:[]).filter(entry=>entry?.active!==false);

/** The personas a section's voice may pick from: the active ones, all of them or those its range lists. */
export function voiceRange(voice,library){
 const active=current(library);
 if(!voice)return [];
 if(voice.mode==='fixed')return active.filter(entry=>entry.id===voice.persona);
 return voice.range==='all'||voice.range==null?active:active.filter(entry=>voice.range.includes(entry.id));
}

/**
 * Decide the persona of one work when its demand is claimed. The result is frozen with the claim.
 *
 *   voice     the section's frozen `policy.voice`, or null
 *   order     the demand's `voice`: 'none', {persona:id}, or null
 *   source    for a translation, an update or a note rewritten from an article: the voice the source edition
 *             recorded and whether a persona signed it ({id,revision,signed}), or null when it had no
 *             voice. Leave undefined for a new work.
 *   library   persona entries (`personaEntry`), every revision the Center keeps
 *   demandId  seeds the draws, so a retried claim of one demand decides the same
 *   usage     {personaId: works} of this section lately, for `balanced`
 *
 * Returns {state:'none'}, or {state:'chosen', method, persona, byline}, or, when the writer is to choose,
 * {state:'pending', candidates, byline, fallback}. `method` is kept | named | fixed | random | balanced |
 * only | fallback (and `chosen` once `settleVoice` has taken the writer's choice). `byline` is 'persona' or
 * 'site'; a kept voice signs as its source did.
 *
 * Order of precedence: a work that has a source keeps the source's voice; then what the order says; then
 * the section's mode; and when that yields no usable persona, the section's fallback, else none.
 */
export function decideVoice({voice=null,order=null,source,library=[],demandId='',usage={}}={}){
 const none={state:'none'},all=Array.isArray(library)?library:[],active=current(all);
 const chosen=(method,entry,byline)=>({state:'chosen',method,persona:reference(entry),byline});
 if(source!==undefined){
  if(!source)return none;
  const kept=all.find(entry=>entry.id===source.id&&entry.revision===source.revision);
  return kept?chosen('kept',kept,source.signed===true?'persona':'site'):none;
 }
 const byline=VOICE_BYLINES.includes(voice?.byline)?voice.byline:'persona';
 const fallback=()=>{const entry=voice?.fallback?active.find(e=>e.id===voice.fallback):null;return entry?chosen('fallback',entry,byline):none;};
 if(order==='none')return none;
 if(order?.persona){const named=active.find(entry=>entry.id===order.persona);return named?chosen('named',named,byline):fallback();}
 if(!voice)return none;
 const range=voiceRange(voice,all);
 if(!range.length)return fallback();
 if(voice.mode==='fixed')return chosen('fixed',range[0],byline);
 if(range.length===1)return chosen('only',range[0],byline);
 const order_=drawn(range,String(demandId));
 if(voice.mode==='random')return chosen('random',order_[0],byline);
 if(voice.mode==='balanced'){
  const used=entry=>Number.isSafeInteger(usage?.[entry.id])&&usage[entry.id]>0?usage[entry.id]:0;
  const least=Math.min(...order_.map(used));
  return chosen('balanced',order_.find(entry=>used(entry)===least),byline);
 }
 const kept=fallback();
 return {state:'pending',candidates:order_.slice(0,CANDIDATE_LIMIT).map(candidate),byline,fallback:kept.state==='chosen'?kept.persona:null};
}

/**
 * Take the writer's choice among the candidates of a pending decision. `reason` is one sentence on why this
 * persona suits the topic; it is kept with the decision in the work's private record. A persona outside the
 * candidates is refused.
 */
export function settleVoice(pending,personaId,reason){
 if(pending?.state!=='pending')fail('This work is not waiting for a persona to be chosen','voice_not_pending');
 const picked=pending.candidates.find(entry=>entry.id===personaId);
 if(!picked)fail('That persona is not among the candidates of this work','voice_not_offered');
 const why=typeof reason==='string'?reason.trim().replace(/\s+/g,' '):'';
 if(!why||why.length>500)fail('Say in one sentence why this persona suits the topic','voice_reason_required');
 return {state:'chosen',method:'chosen',persona:reference(picked),byline:pending.byline,reason:why};
}

/** A pending decision the writer never settled: the section's fallback, else no persona. */
export function lapseVoice(pending){
 if(pending?.state!=='pending')return pending;
 return pending.fallback?{state:'chosen',method:'fallback',persona:{...pending.fallback,founder:{...pending.fallback.founder}},byline:pending.byline}:{state:'none'};
}
