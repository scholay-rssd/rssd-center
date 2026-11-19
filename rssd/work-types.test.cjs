'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RssdPublisher,CredentialCipher}=require('./publisher.cjs');
const {publication,contentKey}=require('./publication.cjs');
const {inputData}=require('./editorial.cjs');
const p=require('./protocol.cjs');

const secret='fixture-secret-not-real-0123456789abcdef',orgId='org-1',destinationId='site-pets';
const manifest=c=>({sha256:c.repeat(64),mime:'image/png',bytes:10,path:'/article-media/'+c.repeat(64)+'.png'});
const media={a:manifest('a'),b:manifest('b'),c:manifest('c')};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

// A fake site receiver: it normalizes packets with the shared contract and answers like the real one.
function receiver(capabilities){
  const stored=new Map(),packets=new Map(),calls=[];
  const fetchImpl=async(url,{method='GET',body}={})=>{
    const path=new URL(url).pathname;calls.push(method+' '+path);
    if(path.endsWith('/status'))return json({accepting:true,capabilities});
    const mediaMatch=/\/media\/([a-f0-9]{64})$/.exec(path);
    if(mediaMatch){if(method==='POST'){const {data,...m}=JSON.parse(body);stored.set(mediaMatch[1],m);}return stored.has(mediaMatch[1])?json(stored.get(mediaMatch[1])):json({},404);}
    if(path.endsWith('/submissions')&&method==='POST'){const value=publication(JSON.parse(body));packets.set(value.requestId,value);return json(receipt(value));}
    const submission=/\/submissions\/([^/]+)$/.exec(path);
    if(submission)return packets.has(submission[1])?json(receipt(packets.get(submission[1]))):json({},404);
    const content=/\/rssd-content\/([a-f0-9]+)\.json$/.exec(path);
    if(content)return json([...packets.values()].find(x=>contentKey(x)===content[1]));
    return json({},404);
  };
  const receipt=value=>({requestId:value.requestId,siteId:value.siteId,workId:value.workId,locale:value.locale,revision:value.revision,contentHash:value.contentHash,packetHash:p.hash(value),state:'success'});
  return {fetchImpl,stored,packets,calls};
}

function fixture({capabilities=['work-types-v1'],rendition=true,metadata={workType:'article'}}={}){
  const cipher=new CredentialCipher(secret),queries=[],finished=[];
  const destination={id:destinationId,orgId,kind:'site',enabled:true,workspaceIds:['pets'],config:{origin:'https://pet.example/',siteId:'pets',sealedToken:cipher.seal('site-token',orgId+':'+destinationId)}};
  const db={
    $queryRawUnsafe:async(sql,...values)=>{queries.push({sql,values});
      if(/FROM rssd_destinations/.test(sql))return [destination];
      if(/FROM rssd_renditions/.test(sql))return rendition?[{payload:{representation:'raster',width:1080,height:1440,coverMediaId:'media-c',pages:[{mediaId:'media-a'},{mediaId:'media-b'}]}}]:[];
      return [];},
    $executeRawUnsafe:async(sql,...values)=>{finished.push(values);return 1;},
  };
  const store={db,async row(ctx,id){return {id,workspaceId:'pets',manifest:media[id.slice(6)]};}};
  const mediaStore={publication:async(org,workspace,edition)=>({edition,assets:[],uploads:[]}),row:store.row,bytes:async(ctx,id)=>({bytes:Buffer.from('png '+id)})};
  const site=receiver(capabilities);
  const publisher=new RssdPublisher({db},{secret,fetchImpl:site.fetchImpl,media:mediaStore});
  const row={orgId,id:'publication-1',leaseToken:'lease',workId:'maine-coon',workspaceId:'pets',locale:'zh-CN',revision:2,destinationId,createdAt:new Date('2026-11-19T08:00:00Z'),receipt:{},
    payload:{sectionId:'daily-cat',hash:'d'.repeat(64),edition:{locale:'zh-CN',title:'缅因猫',bodyMarkdown:'正文。',summary:'',sources:[],media:[],metadata:{date:'2026-11-19',...metadata}}}};
  return {publisher,row,site,queries,finished};
}
const state=f=>f.finished.at(-1)[3];

test('an article reaches a capable site with its type and the card set made from the published revision',async()=>{
  const f=fixture();await f.publisher.dispatch(f.row);
  assert.equal(state(f),'published');
  const packet=f.site.packets.get('publication-1');
  assert.equal(packet.content.metadata.workType,'article');
  assert.deepEqual(packet.cards,{revision:2,pages:[{...media.a,width:1080,height:1440},{...media.b,width:1080,height:1440}],cover:media.c});
  assert.deepEqual([...f.site.stored.keys()].sort(),[media.a.sha256,media.b.sha256,media.c.sha256]);
  // The card set is the newest raster one for this revision saved before the publication was requested.
  const lookup=f.queries.find(q=>/FROM rssd_renditions/.test(q.sql));
  assert.match(lookup.sql,/representation'='raster'/);
  assert.deepEqual(lookup.values,[orgId,'pets','maine-coon','zh-CN',2,f.row.createdAt]);
});

test('a note reaches a capable site with its source link and no card set',async()=>{
  const f=fixture({metadata:{workType:'note',adaptedFrom:{workId:'maine-coon-article',revision:3}}});await f.publisher.dispatch(f.row);
  assert.equal(state(f),'published');
  const packet=f.site.packets.get('publication-1');
  assert.deepEqual(packet.content.metadata,{date:'2026-11-19',workType:'note',adaptedFrom:{workId:'maine-coon-article',revision:3}});
  assert.equal(packet.cards,undefined);
  assert.ok(!f.queries.some(q=>/FROM rssd_renditions/.test(q.sql)));
});

test('a receiver that does not advertise work types gets the packet it always had',async()=>{
  for(const capabilities of [[],null]){
    const f=fixture({capabilities,metadata:{workType:'note',adaptedFrom:{workId:'maine-coon-article',revision:3}}});await f.publisher.dispatch(f.row);
    assert.equal(state(f),'published');
    const packet=f.site.packets.get('publication-1');
    assert.deepEqual(packet.content.metadata,{date:'2026-11-19'});
    assert.equal(packet.cards,undefined);
    assert.ok(!f.queries.some(q=>/FROM rssd_renditions/.test(q.sql)));
  }
});

test('an article without a card set for its revision is published without one',async()=>{
  const f=fixture({rendition:false});await f.publisher.dispatch(f.row);
  assert.equal(state(f),'published');
  assert.equal(f.site.packets.get('publication-1').cards,undefined);
  assert.equal(f.site.stored.size,0);
});

test('the editorial intake checks a stated work type and note link',()=>{
  const data={id:'maine-coon-signs',title:'缅因猫的 5 个特征',summary:'一眼认出',markdown:'正文',author:'A',category:'每日一猫',date:'2026-11-19',sectionId:'daily-cat'};
  assert.equal(inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon',revision:2}}}).workType,'note');
  assert.equal(inputData({data:{...data,workType:null,adaptedFrom:null}}).workType,null);
  assert.throws(()=>inputData({data:{...data,workType:'event'}}),/Invalid work type/);
  assert.throws(()=>inputData({data:{...data,workType:'article',adaptedFrom:{articleId:'maine-coon',revision:2}}}),/Only a note/);
  assert.throws(()=>inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon-signs',revision:2}}}),/Invalid source article/);
  assert.throws(()=>inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon'}}}),/adaptedFrom revision/);
  const documentId='123e4567-e89b-42d3-a456-426614174000';
  assert.throws(()=>inputData({data:{...data,id:'record-'+documentId,markdown:'# 日程\n\n## 摘要\n\n一句话。\n\n## 正文\n\n正文。',workType:'article',record:{kind:'year',documentId,fields:{}}}}),/structured record keeps/);
});
