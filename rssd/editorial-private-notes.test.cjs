'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');const{nativePrivateEditorial}=require('./editorial.cjs');
test('native private projection exposes only supported note fields and anchors, independently of the notebook body',()=>{
 const notebook={internalNotes:{writing:'Private'},blockNotes:{p:{notes:{images:'Image decision'}}},blocks:[{id:'p',type:'paragraph',text:'Public paragraph'}],modelSignatures:[],mounts:{secret:'not returned'},unrelated:'not returned'};
 const notes=nativePrivateEditorial(notebook,'exact edition body');assert.deepEqual(Object.keys(notes),['version','bodySha','internalNotes','blockNotes','modelSignatures']);assert.equal(notes.bodySha,createHash('sha256').update('exact edition body').digest('hex'));assert.deepEqual(notes.blockNotes.p.anchor,{type:'paragraph',text:'Public paragraph'});notes.internalNotes.writing='Changed';assert.equal(notebook.internalNotes.writing,'Private');assert.equal(nativePrivateEditorial({blocks:[]},'Body'),null);
});
test('malformed native note fields and oversized private projections are rejected',()=>{
 assert.throws(()=>nativePrivateEditorial({internalNotes:{publicBody:'Invalid key'}},'Body'),{code:'private_notes_invalid'});
 assert.throws(()=>nativePrivateEditorial({modelSignatures:[{runId:'incomplete'}]},'Body'),{code:'private_notes_invalid'});
 assert.throws(()=>nativePrivateEditorial({blockNotes:{p:{notes:{writing:17}}}},'Body'),{code:'private_notes_invalid'});
});
const {privateAppend,appendPrivateRecord}=require('./editorial.cjs');
const drawn={runId:'codex-image-01a1ee10',agentId:'codex',agentName:'Codex',modelId:'gpt-image',modelName:'gpt-image',action:'image',status:'completed',startedAt:'2026-11-18T10:00:00.000Z'};
test('a draft adds drawing runs and an images note to the existing private record without replacing it',()=>{
 const prior={internalNotes:{writing:'Kept',images:'Earlier note'},blockNotes:{p:{notes:{images:'Row note'}}},modelSignatures:[{...drawn,runId:'write-1',action:'write',agentName:'Cursor'}]};
 const addition=privateAppend({modelSignatures:[drawn,drawn],internalNotes:{images:'题图：Codex · gpt-image'}});
 const notebook=appendPrivateRecord({blocks:[]},prior,addition);
 assert.deepEqual(notebook.modelSignatures.map(r=>r.runId),['write-1','codex-image-01a1ee10']);
 assert.equal(notebook.internalNotes.writing,'Kept');assert.equal(notebook.internalNotes.images,'Earlier note\n\n题图：Codex · gpt-image');
 assert.deepEqual(notebook.blockNotes,prior.blockNotes);
 // Saving the same addition again changes nothing.
 assert.deepEqual(appendPrivateRecord(notebook,nativePrivateEditorial(notebook,'Body'),addition).internalNotes,notebook.internalNotes);
 // The projection that Obsidian's Details reads carries the run with its model.
 assert.equal(nativePrivateEditorial(notebook,'Body').modelSignatures[1].modelName,'gpt-image');
});
test('a private addition cannot carry unknown fields, running runs or public text',()=>{
 assert.throws(()=>privateAppend({blocks:[]}));
 assert.throws(()=>privateAppend({modelSignatures:[{...drawn,status:'running'}]}));
 assert.throws(()=>privateAppend({modelSignatures:[{...drawn,caption:'public'}]}));
 assert.throws(()=>privateAppend({internalNotes:{publicBody:'x'}}));
});
