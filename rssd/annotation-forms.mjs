// The questionnaire used to annotate finished works, and the rules an answer sheet must satisfy. Shared by the
// Center, which stores answers, and by the tools that show the questions, so it uses no Node or browser API
// beyond reading its own data file.
//
// A form is a list of sections. Each section says which works it applies to (by work type, by the section's
// writing family, by whether the article has a card page, by whether a note was rewritten from an article) and
// holds items of three kinds: `scale` (1 to 5, with words for 1, 3 and 5), `choice` (exactly one option) and
// `check` (yes or no). A section may say where in the writing process its results point (`traces`), and a check
// may say which of its answers is the bad sign (`polarity`). An item may allow a short note, and may be optional. An answer sheet names the form
// version it answers, so a later version never changes what an earlier answer meant.
import {readFileSync} from 'node:fs';
import {CHOSEN_WORK_TYPES} from './work-types.mjs';

export const ANNOTATION_ITEM_TYPES=Object.freeze(['scale','choice','check']);
export const MAX_ANNOTATION_NOTE=500;
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const fail=message=>{throw Object.assign(Error(message),{statusCode:400,code:'invalid_annotation'});};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,what,max=400)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail(what+' must be 1 to '+max+' characters');return value;};

/** Check a form document and return it frozen. `families` are the writing families a section may name. */
export function validateAnnotationForm(document,{families}={}){
 if(!plain(document)||document.schemaVersion!==1)fail('Unsupported annotation form');
 text(document.version,'The form version',40);
 if(!Array.isArray(document.sections)||!document.sections.length)fail('A form has sections');
 const sectionIds=new Set(),itemIds=new Set();
 for(const section of document.sections){
  if(!plain(section)||!ID.test(section.id||'')||sectionIds.has(section.id))fail('Invalid or repeated section: '+section?.id);
  sectionIds.add(section.id);text(section.title,'A section title',80);
  if(section.traces!==undefined)text(section.traces,'The traces of '+section.id,400);
  const applies=section.appliesTo;
  if(!plain(applies)||Object.keys(applies).some(key=>!['workTypes','families','cards','adapted'].includes(key)))fail('Invalid appliesTo in '+section.id);
  if(!Array.isArray(applies.workTypes)||!applies.workTypes.length||applies.workTypes.some(type=>!CHOSEN_WORK_TYPES.includes(type)))fail(section.id+' must name the work types it applies to');
  if(applies.families!==undefined&&(!Array.isArray(applies.families)||!applies.families.length||applies.families.some(id=>typeof id!=='string'||families&&!families.includes(id))))fail(section.id+' names an unknown writing family');
  for(const key of ['cards','adapted'])if(applies[key]!==undefined&&applies[key]!==true)fail(section.id+': '+key+' is true or absent');
  if(!Array.isArray(section.items)||!section.items.length)fail(section.id+' has no items');
  for(const item of section.items){
   if(!plain(item)||!ID.test(item.id||'')||itemIds.has(item.id))fail('Invalid or repeated item: '+item?.id);
   itemIds.add(item.id);text(item.text,'The text of '+item.id);
   if(!ANNOTATION_ITEM_TYPES.includes(item.type))fail(item.id+' has an unknown type');
   if(Object.keys(item).some(key=>!['id','type','text','anchors','options','note','optional','polarity'].includes(key)))fail(item.id+' has an unknown field');
   // Which answer of a check points to machine writing: `tell` when yes does, `good` when no does.
   if(item.polarity!==undefined&&(item.type!=='check'||!['tell','good'].includes(item.polarity)))fail(item.id+': polarity is tell or good, on a check');
   for(const key of ['note','optional'])if(item[key]!==undefined&&typeof item[key]!=='boolean')fail(item.id+': '+key+' is true or false');
   if(item.type==='scale'){
    if(!plain(item.anchors)||Object.keys(item.anchors).sort().join()!=='1,3,5')fail(item.id+' needs words for 1, 3 and 5');
    for(const value of Object.values(item.anchors))text(value,'An anchor of '+item.id,60);
   }else if(item.anchors!==undefined)fail(item.id+': only a scale has anchors');
   if(item.type==='choice'){
    if(!Array.isArray(item.options)||item.options.length<2||item.options.length>10)fail(item.id+' needs 2 to 10 options');
    const seen=new Set();
    for(const option of item.options){if(!plain(option)||!ID.test(option.id||'')||seen.has(option.id))fail(item.id+' has an invalid or repeated option');seen.add(option.id);text(option.label,'An option of '+item.id,80);}
   }else if(item.options!==undefined)fail(item.id+': only a choice has options');
  }
 }
 return deepFreeze(structuredClone(document));
}

/**
 * The sections, in order, that apply to one work. `work` is {workType, family, cards, adapted}: its type, the
 * writing family of its section (for an article), whether it has a card page, and whether it is a note rewritten
 * from an article.
 */
export function annotationSectionsFor(form,work){
 if(!CHOSEN_WORK_TYPES.includes(work?.workType))fail('A work to annotate is an article or a note');
 return form.sections.filter(section=>{
  const applies=section.appliesTo;
  return applies.workTypes.includes(work.workType)&&(!applies.families||applies.families.includes(work.family))&&(!applies.cards||work.cards===true)&&(!applies.adapted||work.adapted===true);
 });
}
export const annotationItemsFor=(form,work)=>annotationSectionsFor(form,work).flatMap(section=>section.items);

/**
 * Check an answer sheet for one work against the form and return it normalized: {itemId: {value, note?}}.
 * A scale answers 1 to 5, a choice one of its option IDs, a check true or false. Every item that applies and is
 * not optional must be answered; an item that does not apply to this work must not be. A note is allowed only
 * where the item allows one.
 */
export function validateAnnotationAnswers(form,work,answers){
 if(!plain(answers))fail('Answers are an object keyed by item');
 const items=annotationItemsFor(form,work),byId=new Map(items.map(item=>[item.id,item])),out={};
 for(const id of Object.keys(answers))if(!byId.has(id))fail('This work has no item '+id);
 for(const item of items){
  const answer=answers[item.id];
  if(answer===undefined||answer===null){if(item.optional)continue;fail('Missing answer: '+item.id);}
  if(!plain(answer)||Object.keys(answer).some(key=>!['value','note'].includes(key)))fail('Invalid answer: '+item.id);
  const value=answer.value;
  if(item.type==='scale'&&!(Number.isSafeInteger(value)&&value>=1&&value<=5))fail(item.id+' is answered 1 to 5');
  if(item.type==='check'&&typeof value!=='boolean')fail(item.id+' is answered yes or no');
  if(item.type==='choice'&&!item.options.some(option=>option.id===value))fail(item.id+' is answered with one of its options');
  out[item.id]={value};
  if(answer.note!==undefined&&answer.note!==null&&answer.note!==''){
   if(!item.note)fail(item.id+' takes no note');
   if(typeof answer.note!=='string'||answer.note.length>MAX_ANNOTATION_NOTE)fail('The note of '+item.id+' is at most '+MAX_ANNOTATION_NOTE+' characters');
   out[item.id].note=answer.note;
  }
 }
 return out;
}

function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}

const FAMILIES=Object.freeze([...new Set(Object.values(JSON.parse(readFileSync(new URL('./writing-column-families.json',import.meta.url),'utf8'))))].sort());
/** The writing families a form may name: the values of writing-column-families.json. */
export const ANNOTATION_FAMILIES=FAMILIES;
/** The current form. */
export const ANNOTATION_FORM=validateAnnotationForm(JSON.parse(readFileSync(new URL('./annotation-forms.json',import.meta.url),'utf8')),{families:FAMILIES});

/**
 * One number per section from one answer sheet, for comparing works and runs: the mean of the section's scale
 * answers (1 to 5, 5 the human end) and the share of its `tell` and `good` checks that point to machine writing.
 * A section with no such answers is left out.
 */
export function annotationProfile(form,work,answers){
 const out={};
 for(const section of annotationSectionsFor(form,work)){
  const scales=[],signs=[];
  for(const item of section.items){
   const value=answers?.[item.id]?.value;
   if(item.type==='scale'&&Number.isSafeInteger(value))scales.push(value);
   if(item.type==='check'&&item.polarity&&typeof value==='boolean')signs.push(item.polarity==='tell'?value:!value);
  }
  if(scales.length||signs.length)out[section.id]={...(scales.length?{scale:scales.reduce((a,b)=>a+b,0)/scales.length}:{}),...(signs.length?{tells:signs.filter(Boolean).length,checks:signs.length}:{})};
 }
 return out;
}
