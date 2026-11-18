'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RssdRenditions,manifest}=require('./renditions.cjs');
const input={workId:'work',locale:'zh-CN',revision:1,sourceHash:'a'.repeat(64),method:'image',title:'Title',cover:'media-one',pages:['media-one','media-two']};
function fixture() {
 const rows=new Map(), ctx={orgId:'org',workspaceIds:['space']};
 const db={
 async $queryRawUnsafe(sql,...v){
  if(sql.startsWith('SELECT e.hash'))return v[0]==='org'&&v[1]==='space'&&v[2]==='work'&&v[3]==='zh-CN'&&v[4]===1?[{hash:'a'.repeat(64),sectionId:'section'}]:[];
  if(sql.startsWith('SELECT id,payload'))return [...rows.values()].filter(r=>r.orgId===v[0]&&r.workspaceId===v[1]&&r.id===v[2]);
  if(sql.startsWith('SELECT r.id'))return [...rows.values()].filter(r=>r.orgId===v[0]&&r.workspaceId===v[1]&&r.id>v[2]).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,v[3]).map(({payload,...r})=>r);
  return [];
 },
 async $executeRawUnsafe(sql,...v){rows.set(v[1],{orgId:v[0],id:v[1],workspaceId:v[2],workId:v[3],locale:v[4],revision:v[5],bytes:BigInt(v[11]),payload:JSON.parse(v[12])});}
 };
 const store={db,async workspace(db,c,w){if(!c.workspaceIds.includes(w))throw Error('denied')},transaction:fn=>fn(db)};
 const media={async row(c,id){return {workspaceId:id==='foreign'?'elsewhere':'space',manifest:{mime:id==='png'?'image/png':'image/webp',bytes:100}}}};
 return {cards:new RssdRenditions(store,media),rows,ctx};
}
test('immutable sets deduplicate retries and retain exact page order',async()=>{const {cards,ctx,rows}=fixture();const first=await cards.save(ctx,'space',input);assert.deepEqual(await cards.save(ctx,'space',input),first);assert.equal(rows.size,1);assert.deepEqual((await cards.detail(ctx,'space',first.id)).pages,input.pages);const next=await cards.save(ctx,'space',{...input,pages:[...input.pages].reverse()});assert.notEqual(first.id,next.id);assert.equal(rows.size,2)});
test('source revision and cross-workspace references are rejected',async()=>{const {cards,ctx,rows}=fixture();for(const change of [{revision:2},{sourceHash:'b'.repeat(64)},{locale:'en'},{pages:['foreign'],cover:'foreign'},{pages:['png'],cover:'png'}])await assert.rejects(cards.save(ctx,'space',{...input,...change}));await assert.rejects(cards.save(ctx,'elsewhere',input));assert.equal(rows.size,0)});
test('gallery lists have bounded cursors and omit page payloads',async()=>{const {cards,ctx}=fixture();await cards.save(ctx,'space',input);await cards.save(ctx,'space',{...input,title:'Another'});const a=await cards.list(ctx,'space',{limit:'1'});assert.equal(a.items.length,1);assert.ok(a.next);assert.equal(a.items[0].payload,undefined);assert.doesNotThrow(()=>JSON.stringify(a));const b=await cards.list(ctx,'space',{limit:'1',after:a.next});assert.equal(b.items.length,1);assert.equal(b.next,null);assert.notEqual(a.items[0].id,b.items[0].id);await assert.rejects(cards.list(ctx,'space',{limit:101}))});
test('manifest rejects empty, oversized and invalid method sets',()=>{for(const change of [{pages:[]},{pages:Array(1000).fill('media-one')},{method:'unknown'}])assert.throws(()=>manifest({...input,...change}));assert.equal(manifest({...input,method:'algorithm'}).method,'algorithm');assert.equal(manifest({...input,method:'intelligent'}).method,'intelligent')});
