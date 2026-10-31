'use strict';
const p=require('./rssd-v1.cjs');
const keys={
 year:['id','category','tags','start','end','recurrence','dateBasis','sourceName','sourceUrl','provenance','reviewedAt','bodyTruncated'],
 history:['id','dateKey','year','domain','eventType','importance','sources','preciseToDay'],
 openSource:['date','category','url','relatedUrl','status']
};
const sections={year:[['summary',['摘要']],['body',['正文']]],history:[['factSummary',['事实摘要']],['historicalSignificance',['学术意义','历史意义']]],openSource:[['summary',['项目简介']],['value',['学术价值','使用价值']]]};
function record(value){
 p.object(value,'structured record');if(!keys[value.kind])p.fail('Unknown structured record kind');
 const original=p.object(value.fields,'record fields'),fields={};
 for(const key of keys[value.kind])if(Object.hasOwn(original,key))fields[key]=original[key];
 return {kind:value.kind,fields:p.json(fields,'record fields')};
}
function recordFields(value,content){
 const {kind,fields}=record(value),markdown=content.bodyMarkdown.replace(/\r\n?/g,'\n');
 const headings=[];let fenced=false;let offset=0;
 for(const line of markdown.split('\n')){
  if(/^\s{0,3}(```|~~~)/.test(line))fenced=!fenced;
  if(!fenced){const match=/^## ([^\n]+)$/.exec(line);if(match)headings.push({label:match[1].trim(),start:offset,end:offset+line.length+1});}
  offset+=line.length+1;
 }
 const required=sections[kind].map(([key,labels])=>{const found=headings.filter(h=>labels.includes(h.label));if(found.length!==1)p.fail('Structured content must retain one heading: '+labels.join(' / '));return {key,...found[0]};});
 if(required.some((h,i)=>i>0&&h.start<=required[i-1].start))p.fail('Structured content headings are out of order');
 const leading=markdown.slice(0,required[0].start).replace(/^# [^\n]+\n?/,'').trim();if(leading)p.fail('Put structured prose inside its named sections');
 const result={...fields,title:content.title};for(let i=0;i<required.length;i++)result[required[i].key]=markdown.slice(required[i].end,required[i+1]?.start??markdown.length).trim();
 return result;
}
module.exports={record,recordFields};
