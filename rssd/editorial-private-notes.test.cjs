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
