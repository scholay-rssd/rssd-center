'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {publicContent}=require('./publication.cjs');

test('the vendored publication boundary accepts fully English structured records',()=>{
 for(const [kind,headings] of [['year',['Summary','Body']],['history',['Fact Summary','Historical Significance']],['openSource',['Project Overview','Research Value']]]){
  const edition={locale:'en',title:'Synthetic record',bodyMarkdown:'# Synthetic record\n\n## '+headings[0]+'\n\nFirst section.\n\n## '+headings[1]+'\n\nSecond section.',metadata:{record:{kind,fields:{}}}};
  assert.equal(publicContent(edition).bodyMarkdown,edition.bodyMarkdown);
 }
});

test('English support keeps required section order and the Chinese heading contract',()=>{
 const edition={locale:'en',title:'Synthetic record',bodyMarkdown:'## Body\n\nSecond.\n\n## Summary\n\nFirst.',metadata:{record:{kind:'year',fields:{}}}};
 assert.throws(()=>publicContent(edition),/out of order/);
 assert.throws(()=>publicContent({...edition,locale:'zh-CN'}),/retain one heading/);
});
