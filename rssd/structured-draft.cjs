'use strict';
// Strictly map a Markdown edit onto an existing structured record. This helper
// does not save, publish, authorize, or reconcile a staged branch. The caller
// must acquire its normal work lock and verify the exact edition/source base.
const {recordFields}=require('./rssd-record.cjs');
const {hash,fail:protocolFail}=require('./protocol.cjs');

const SECTION_KEYS={year:['summary','body'],history:['factSummary','historicalSignificance'],openSource:['summary','value']};
const SECTION_LABELS={year:[['摘要'],['正文']],history:[['事实摘要'],['学术意义','历史意义']],openSource:[['项目简介'],['学术价值','使用价值']]};
const immutableProperties=['summary','author','date','category'];
// Invalid draft input can be fixed by another local edit; only an actual
// identity/baseline conflict is a 409 requiring explicit reconciliation.
const fail=(message,code='structured_conflict')=>protocolFail(message,code==='structured_conflict'?409:400,code);
const isObject=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const localeOf=v=>v||'zh-CN';

// recordFields' parser toggles on any triple marker. Reject ambiguous fence
// syntax rather than silently parsing a fake structured heading inside code.
function checkFences(markdown){
 let fence=null,parserFenced=false;
 for(const line of markdown.replace(/\r\n?/g,'\n').split('\n')){
  const naive=/^\s{0,3}(```|~~~)/.test(line);
  const open=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if(!fence){
   if(open){if(open[1][0]==='`'&&open[2].includes('`'))fail('Ambiguous code fence; retain an unambiguous Markdown fence','structured_markdown');fence={char:open[1][0],length:open[1].length};}
  }else{
   const close=new RegExp('^ {0,3}'+(fence.char==='`'?'`':'~')+'{'+fence.length+',}[ \\t]*$');
   if(close.test(line))fence=null;
  }
  if(naive)parserFenced=!parserFenced;
  if(Boolean(fence)!==parserFenced)fail('Code fence cannot be parsed safely; local edits were kept','structured_markdown');
 }
 if(fence||parserFenced)fail('Close the code fence before saving','structured_markdown');
}

function sectionLabels(markdown,kind){
 const groups=SECTION_LABELS[kind],found=groups.map(()=>[]);let fenced=false;
 for(const line of markdown.replace(/\r\n?/g,'\n').split('\n')){
  if(/^\s{0,3}(```|~~~)/.test(line))fenced=!fenced;
  if(fenced)continue;
  const heading=/^## ([^\n]+)$/.exec(line);if(!heading)continue;
  for(let i=0;i<groups.length;i++)if(groups[i].includes(heading[1].trim()))found[i].push(heading[1].trim());
 }
 if(found.some(items=>items.length!==1))fail('Retain each structured section heading exactly once','structured_markdown');
 return found.map(items=>items[0]);
}

/**
 * source: trusted editor projection of the locked current edition/branch.
 * edition: trusted full original edition, including raw metadata.record.
 * proposed: untrusted edited envelope; expected: trusted identity from the row.
 * Generic summary/date/category/author are kept unchanged until explicit
 * bidirectional mappings exist. Title and the two named prose sections may be
 * edited. Raw record fields, including unknown/private fields, are never taken
 * from the client or rewritten by recordFields' allowlist.
 */
function prepareStructuredDraft({edition,source,proposed,expected}={}){
 if(!isObject(edition)||!isObject(edition.metadata)||!isObject(edition.metadata.record)||!isObject(edition.metadata.record.fields)||!isObject(source)||!isObject(source.record)||!isObject(proposed)||!isObject(expected))fail('The structured record baseline is unavailable');
 const original=edition.metadata.record,kind=original.kind;
 if(!SECTION_KEYS[kind]||source.record.kind!==kind||expected.kind!==kind||source.record.documentId!==expected.documentId||source.id!==expected.articleId||proposed.id!==expected.articleId||expected.articleId!=='record-'+expected.documentId||source.sectionId!==expected.sectionId||proposed.sectionId!==expected.sectionId||localeOf(source.locale)!==expected.locale||localeOf(proposed.locale)!==expected.locale)fail('The structured record identity changed');
 if(proposed.record!==undefined&&hash(proposed.record)!==hash(source.record))fail('Structured source fields cannot be edited through this projection','structured_fields_read_only');
 for(const key of immutableProperties)if(typeof source[key]!=='string'||typeof proposed[key]!=='string'||source[key]!==proposed[key])fail('The '+key+' property does not have a safe structured mapping; restore it before saving','structured_property_unmapped');
 if(typeof proposed.title!=='string'||!proposed.title.trim()||typeof proposed.markdown!=='string'||typeof source.markdown!=='string')fail('A title and structured Markdown are required','structured_markdown');
 const markdown=proposed.markdown.replace(/\r\n?/g,'\n'),first=/^# ([^\n]+)(?:\n|$)/.exec(markdown);
 if(!first||proposed.title!==proposed.title.trim()||first[1]!==proposed.title)fail('The first Markdown heading must match the title property exactly','structured_title_mismatch');
 checkFences(source.markdown);
 checkFences(markdown);
 // Different site types use different legal aliases for the last section.
 // Keep the original alias so a draft accepted by Center remains compatible
 // with the source site's structured receiver after eventual reconciliation.
 if(hash(sectionLabels(source.markdown,kind))!==hash(sectionLabels(markdown,kind)))fail('Keep the original structured section headings','structured_markdown');
 const parsed=recordFields(original,{title:proposed.title,bodyMarkdown:proposed.markdown});
 const sections=Object.fromEntries(SECTION_KEYS[kind].map(key=>[key,parsed[key]]));
 // Clone the entire metadata object, including unknown nested source fields.
 // The caller may update only its separately validated, mapped projections.
 return {kind,title:proposed.title,summary:source.summary,bodyMarkdown:proposed.markdown,sections,metadata:structuredClone(edition.metadata)};
}
module.exports={prepareStructuredDraft};
