'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {prepareStructuredDraft}=require('./structured-draft.cjs');
const documentId='123e4567-e89b-42d3-a456-426614174000',id='record-'+documentId;
const layout={
 year:{kind:'year',fields:{id:'year:1',category:'Events',tags:['a'],start:'2026-01-01',end:null,recurrence:{frequency:'yearly',monthDay:'01-01'},dateBasis:'verified',sourceName:'source',sourceUrl:'https://example.org',provenance:'original',reviewedAt:null,bodyTruncated:false,unknown:{private:['keep']}}},
 history:{kind:'history',fields:{id:'history:1',dateKey:'01-01',year:1901,domain:'research',eventType:'event',importance:'A',sources:[{label:'original',url:'https://example.org'}],preciseToDay:true,unknown:{private:['keep']}}},
 openSource:{kind:'openSource',fields:{date:'2026-01-01',category:'tools',url:'https://example.org/a',relatedUrl:'https://example.org/b',status:'active',unknown:{private:['keep']}}},
};
const labels={year:['摘要','正文'],history:['事实摘要','历史意义'],openSource:['项目简介','使用价值']};
function fixture(kind){
 const [a,b]=labels[kind],markdown=`# Original\n\n## ${a}\n\nFirst section\n\n## ${b}\n\nSecond section\n`;
 const raw=structuredClone(layout[kind]);
 const edition={title:'Original',summary:'Existing summary',bodyMarkdown:markdown,metadata:{record:raw,nested:{private:['preserve']},author:'A',date:'2026-01-01',category:'C'}};
 const source={id,title:'Original',summary:'Existing summary',author:'A',date:'2026-01-01',category:'C',sectionId:'records',markdown,record:{kind,documentId,fields:{...structuredClone(raw.fields),derived:'trusted projection'}}};
 const proposed=structuredClone(source),expected={kind,documentId,articleId:id,locale:'zh-CN',sectionId:'records'};
 return {edition,source,proposed,expected};
}
for(const kind of Object.keys(layout))test(kind+' retains all raw fields while mapping the named prose and title',()=>{
 const x=fixture(kind),before=structuredClone(x.edition.metadata);x.proposed.title='Revised';x.proposed.markdown=x.proposed.markdown.replace('# Original','# Revised').replace('First section','Updated first').replace('Second section','Updated second');
 const result=prepareStructuredDraft(x);assert.equal(result.title,'Revised');assert.equal(result.summary,'Existing summary');assert.deepEqual(Object.values(result.sections),['Updated first','Updated second']);assert.deepEqual(result.metadata,before);
 result.metadata.record.fields.unknown.private.push('new');assert.deepEqual(x.edition.metadata,before,'returned metadata is detached');
});
test('both structured heading variants and CRLF retain the intended sections',()=>{
 for(const [kind,first,second] of [['history','事实摘要','学术意义'],['openSource','项目简介','学术价值']]){
  const x=fixture(kind);x.proposed.markdown=`# Original\r\n\r\n## ${first}\r\n\r\nOne\r\n\r\n## ${second}\r\n\r\nTwo\r\n`;
  x.source.markdown=x.proposed.markdown;
  assert.deepEqual(Object.values(prepareStructuredDraft(x).sections),['One','Two']);
 }
});
test('mismatched H1, duplicate/missing/out-of-order headings and leading prose cannot silently map',()=>{
 const x=fixture('year');x.proposed.title='Another';assert.throws(()=>prepareStructuredDraft(x),{code:'structured_title_mismatch'});
 x.proposed=structuredClone(x.source);x.proposed.title=' Original ';assert.throws(()=>prepareStructuredDraft(x),{code:'structured_title_mismatch'});
 x.proposed=structuredClone(x.source);x.proposed.markdown=x.proposed.markdown.replace('## 正文','## 摘要\n\nDuplicate\n\n## 正文');assert.throws(()=>prepareStructuredDraft(x));
 x.proposed=structuredClone(x.source);x.proposed.markdown=x.proposed.markdown.replace('## 正文','## Other');assert.throws(()=>prepareStructuredDraft(x));
 x.proposed=structuredClone(x.source);x.proposed.markdown='# Original\n\n## 正文\n\nB\n\n## 摘要\n\nA\n';assert.throws(()=>prepareStructuredDraft(x));
 x.proposed=structuredClone(x.source);x.proposed.markdown=x.proposed.markdown.replace('## 摘要','Unexpected introduction\n\n## 摘要');assert.throws(()=>prepareStructuredDraft(x));
});
test('a valid alternate site heading cannot silently replace the source site heading',()=>{
 const x=fixture('history');x.proposed.markdown=x.source.markdown.replace('## 历史意义','## 学术意义');assert.throws(()=>prepareStructuredDraft(x),{code:'structured_markdown'});
 const y=fixture('openSource');y.proposed.markdown=y.source.markdown.replace('## 使用价值','## 学术价值');assert.throws(()=>prepareStructuredDraft(y),{code:'structured_markdown'});
});
test('valid code fences are preserved and ambiguous or unclosed fences are refused',()=>{
 const x=fixture('year');x.proposed.markdown=x.proposed.markdown.replace('Second section','```js\n## 摘要\n```\n\nSecond section');assert.match(prepareStructuredDraft(x).sections.body,/## 摘要/);
 x.proposed.markdown=x.source.markdown.replace('First section','````\n```\n## 摘要\n````');assert.throws(()=>prepareStructuredDraft(x),{code:'structured_markdown'});
 x.proposed.markdown=x.source.markdown.replace('Second section','```js\nUnclosed');assert.throws(()=>prepareStructuredDraft(x),{code:'structured_markdown'});
});
test('projection changes, forged structured fields and mismatched identity are rejected',()=>{
 for(const key of ['summary','category','date','author']){const x=fixture('year');x.proposed[key]='changed';assert.throws(()=>prepareStructuredDraft(x),{code:'structured_property_unmapped',status:400});}
 const x=fixture('history');x.proposed.record.fields.sources=[];assert.throws(()=>prepareStructuredDraft(x),{code:'structured_fields_read_only',status:400});
 x.proposed=structuredClone(x.source);x.proposed.id='record-another';assert.throws(()=>prepareStructuredDraft(x),{code:'structured_conflict',status:409});
 x.proposed=structuredClone(x.source);x.proposed.locale='en';assert.throws(()=>prepareStructuredDraft(x),{code:'structured_conflict'});
 x.proposed=structuredClone(x.source);delete x.proposed.record;assert.equal(prepareStructuredDraft(x).kind,'history','the client need not transmit raw private fields');
});
