'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RssdPublisher,CredentialCipher}=require('./publisher.cjs');
const {publication,publicContent,contentKey}=require('./publication.cjs');
const {inputData}=require('./editorial.cjs');
const p=require('./protocol.cjs');

const secret='fixture-secret-not-real-0123456789abcdef',orgId='org-1',destinationId='site-pets';
const manifest=c=>({sha256:c.repeat(64),mime:'image/png',bytes:10,path:'/article-media/'+c.repeat(64)+'.png'});
const media={a:manifest('a'),b:manifest('b'),c:manifest('c'),d:manifest('d')};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
// Two raster card sets for the same revision; the second is saved later.
const renditions={
  'rendition-1':{representation:'raster',width:1080,height:1440,coverMediaId:'media-c',pages:[{mediaId:'media-a'},{mediaId:'media-b'}]},
  'rendition-2':{representation:'raster',width:1080,height:1440,pages:[{mediaId:'media-d'}]},
};

// A fake site receiver: it normalizes packets with the shared contract and answers like the real one. `status`
// is the capability list its status reports, or how a receiver without that endpoint answers: an old receiver's
// credential check runs first and answers 401 for any route it does not know.
function receiver(status){
  const stored=new Map(),packets=new Map(),calls=[];
  const fetchImpl=async(url,{method='GET',body}={})=>{
    const path=new URL(url).pathname;calls.push(method+' '+path);
    if(path.endsWith('/status'))return status==='no-status'?json({},404):status==='old-receiver'?json({code:'unauthorized'},401):status==='status-down'?json({},503):json({accepting:true,capabilities:status});
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

function fixture({status=['work-types-v1'],newest='rendition-1',metadata={workType:'article'}}={}){
  const cipher=new CredentialCipher(secret),queries=[],writes=[],state={newest};
  const destination={id:destinationId,orgId,kind:'site',enabled:true,workspaceIds:['pets'],config:{origin:'https://pet.example/',siteId:'pets',sealedToken:cipher.seal('site-token',orgId+':'+destinationId)}};
  const db={
    $queryRawUnsafe:async(sql,...values)=>{queries.push({sql,values});
      if(/FROM rssd_destinations/.test(sql))return [destination];
      if(/FROM rssd_renditions/.test(sql)&&/ id=\$3/.test(sql))return renditions[values[2]]?[{payload:renditions[values[2]]}]:[];
      if(/FROM rssd_renditions/.test(sql))return state.newest?[{id:state.newest}]:[];
      return [];},
    $executeRawUnsafe:async(sql,...values)=>{writes.push({sql,values});return 1;},
  };
  const store={db,async row(ctx,id){return {id,workspaceId:'pets',manifest:media[id.slice(6)]};}};
  const mediaStore={publication:async(org,workspace,edition)=>({edition,assets:[],uploads:[]}),row:store.row,bytes:async(ctx,id)=>({bytes:Buffer.from('png '+id)})};
  const site=receiver(status);
  const publisher=new RssdPublisher({db},{secret,fetchImpl:site.fetchImpl,media:mediaStore});
  const row={orgId,id:'publication-1',leaseToken:'lease',workId:'maine-coon',workspaceId:'pets',locale:'zh-CN',revision:2,destinationId,createdAt:new Date('2026-11-19T08:00:00Z'),receipt:{},
    payload:{sectionId:'daily-cat',hash:'d'.repeat(64),edition:{locale:'zh-CN',title:'缅因猫',bodyMarkdown:'正文。',summary:'',sources:[],media:[],metadata:{date:'2026-11-19',...metadata}}}};
  return {publisher,row,site,queries,writes,state};
}
const finishes=f=>f.writes.filter(w=>/SET state=/.test(w.sql));
const outcome=f=>finishes(f).at(-1).values[3];
const frozen=f=>f.writes.filter(w=>/SET payload=payload/.test(w.sql)).map(w=>JSON.parse(w.values[3]));

test('an article reaches a capable site with its type and the newest card set for its revision',async()=>{
  const f=fixture();await f.publisher.dispatch(f.row);
  assert.equal(outcome(f),'published');
  const packet=f.site.packets.get('publication-1');
  assert.equal(packet.content.metadata.workType,'article');
  assert.deepEqual(packet.cards,{revision:2,pages:[{...media.a,width:1080,height:1440},{...media.b,width:1080,height:1440}],cover:media.c});
  assert.deepEqual([...f.site.stored.keys()].sort(),[media.a.sha256,media.b.sha256,media.c.sha256]);
  // The choice is a raster set for this revision, ai-image before ai-code before algorithm, then the newest; it is
  // kept with the publication before anything is sent.
  const lookup=f.queries.find(q=>/FROM rssd_renditions/.test(q.sql)&&!/ id=\$3/.test(q.sql));
  assert.match(lookup.sql,/summary->>'representation'='raster'[^]*ORDER BY CASE summary->>'variant' WHEN 'ai-image' THEN 0 WHEN 'ai-code' THEN 1 WHEN 'algorithm' THEN 2 ELSE 3 END,"createdAt" DESC/);
  assert.deepEqual(lookup.values,[orgId,'pets','maine-coon','zh-CN',2]);
  assert.deepEqual(frozen(f),[{sitePacket:{workTypes:true,cardSetId:'rendition-1'}}]);
  assert.deepEqual(f.row.payload.sitePacket,{workTypes:true,cardSetId:'rendition-1'});
});

test('a retry sends the card set chosen first, even after a newer one is saved',async()=>{
  const f=fixture();await f.publisher.dispatch(f.row);
  f.state.newest='rendition-2';
  // The second attempt finds the submission on the receiver and must rebuild exactly the packet it holds.
  await f.publisher.dispatch(f.row);
  assert.equal(outcome(f),'published');
  assert.equal(frozen(f).length,1);
  assert.deepEqual(f.site.packets.get('publication-1').cards.pages.map(page=>page.sha256),[media.a.sha256,media.b.sha256]);
});

test('a note reaches a capable site with its source link and tags, and no card set',async()=>{
  const f=fixture({metadata:{workType:'note',adaptedFrom:{workId:'maine-coon-article',revision:3},tags:['缅因猫','长毛猫']}});await f.publisher.dispatch(f.row);
  assert.equal(outcome(f),'published');
  const packet=f.site.packets.get('publication-1');
  assert.deepEqual(packet.content.metadata,{date:'2026-11-19',workType:'note',adaptedFrom:{workId:'maine-coon-article',revision:3},tags:['缅因猫','长毛猫']});
  assert.equal(packet.cards,undefined);
  assert.ok(!f.queries.some(q=>/FROM rssd_renditions/.test(q.sql)));
});

test('a receiver that does not advertise work types gets the packet it always had',async()=>{
  // An empty list, no list, a receiver from before the status endpoint (404), and one whose credential check
  // answers first for routes it does not know (401).
  for(const status of [[],null,'no-status','old-receiver']){
    const f=fixture({status,metadata:{workType:'note',adaptedFrom:{workId:'maine-coon-article',revision:3},tags:['缅因猫']}});await f.publisher.dispatch(f.row);
    assert.equal(outcome(f),'published',String(status));
    const packet=f.site.packets.get('publication-1');
    assert.deepEqual(packet.content.metadata,{date:'2026-11-19'});
    assert.equal(packet.cards,undefined);
    assert.ok(!f.queries.some(q=>/FROM rssd_renditions/.test(q.sql)));
    assert.deepEqual(frozen(f),[{sitePacket:{workTypes:false,cardSetId:null}}]);
  }
});

test('a status check that fails for another reason is retried, not guessed',async()=>{
  const f=fixture({status:'status-down'});
  await assert.rejects(f.publisher.dispatch(f.row),{status:503});
  assert.equal(f.site.packets.size,0);
  assert.equal(f.writes.length,0);
});

test('a submission an earlier Center already sent is finished with the packet it sent',async()=>{
  const f=fixture();
  // That Center sent no work type and no card set, and kept no decision with the publication.
  const content=publicContent(f.row.payload.edition);delete content.metadata.workType;
  const sent=publication({version:1,requestId:'publication-1',siteId:'pets',workspaceId:'pets',sectionId:'daily-cat',workId:'maine-coon',locale:'zh-CN',revision:2,contentHash:'d'.repeat(64),content,route:'/news/'+p.hash('maine-coon').slice(0,32)+'/'});
  f.site.packets.set('publication-1',sent);
  await f.publisher.dispatch(f.row);
  assert.equal(outcome(f),'published');
  assert.deepEqual(frozen(f),[{sitePacket:{workTypes:false,cardSetId:null}}]);
  assert.ok(!f.site.calls.some(call=>call.endsWith('/status')));
});

test('an article without a card set for its revision is published without one',async()=>{
  const f=fixture({newest:null});await f.publisher.dispatch(f.row);
  assert.equal(outcome(f),'published');
  assert.equal(f.site.packets.get('publication-1').cards,undefined);
  assert.equal(f.site.stored.size,0);
  assert.deepEqual(frozen(f),[{sitePacket:{workTypes:true,cardSetId:null}}]);
});

test('the editorial intake checks a stated work type and note link',()=>{
  const data={id:'maine-coon-signs',title:'缅因猫的 5 个特征',summary:'一眼认出',markdown:'正文',author:'A',category:'每日一猫',date:'2026-11-19',sectionId:'daily-cat'};
  assert.equal(inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon',revision:2}}}).workType,'note');
  assert.equal(inputData({data:{...data,workType:null,adaptedFrom:null}}).workType,null);
  assert.throws(()=>inputData({data:{...data,workType:'event'}}),/Invalid work type/);
  assert.throws(()=>inputData({data:{...data,workType:'article',adaptedFrom:{articleId:'maine-coon',revision:2}}}),/Only a note/);
  assert.throws(()=>inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon-signs',revision:2}}}),/Invalid source article/);
  assert.throws(()=>inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon'}}}),/adaptedFrom revision/);
  assert.throws(()=>inputData({data:{...data,workType:'note',adaptedFrom:{articleId:'maine-coon',revision:2,workId:'x'}}}),/names an article and the revision/);
  // Tags are kept as the packet carries them: trimmed, without the leading #, each once; [] clears them.
  assert.deepEqual(inputData({data:{...data,tags:['#缅因猫',' 长毛猫 ','缅因猫','',' # ']}}).tags,['缅因猫','长毛猫']);
  assert.deepEqual(inputData({data:{...data,tags:[]}}).tags,[]);
  assert.throws(()=>inputData({data:{...data,tags:Array.from({length:11},(_,i)=>'tag'+i)}}),/at most 10 tags/);
  assert.throws(()=>inputData({data:{...data,tags:['猫'.repeat(41)]}}),/at most 10 tags of up to 40/);
  assert.throws(()=>inputData({data:{...data,tags:'缅因猫'}}),/Invalid tags/);
  const documentId='123e4567-e89b-42d3-a456-426614174000';
  assert.throws(()=>inputData({data:{...data,id:'record-'+documentId,markdown:'# 日程\n\n## 摘要\n\n一句话。\n\n## 正文\n\n正文。',workType:'article',record:{kind:'year',documentId,fields:{}}}}),/structured record keeps/);
});

// Card updates: a card set saved after its revision went live reaches the website through a `cards` action.
const {RssdEditorialActions,cardsPacket}=require('./editorial-actions.cjs');
const cardEdition={locale:'zh-CN',title:'缅因猫',bodyMarkdown:'正文。',summary:'',sources:[],media:[],metadata:{date:'2026-11-19',workType:'article'}};
const livePacket=extra=>publication({version:1,requestId:'publication-1',siteId:'pets',workspaceId:'pets',sectionId:'daily-cat',workId:'maine-coon',locale:'zh-CN',revision:2,
  contentHash:p.hash(cardEdition),content:publicContent(cardEdition),route:'/news/maine-coon/',...extra});

function cardsFixture({status=['work-types-v1','card-updates-v1'],live=livePacket(),newest='rendition-1',pending=false,existing=false,edition=cardEdition,headState='success',enabled=true,bilingual=false}={}){
  const cipher=new CredentialCipher(secret),writes=[],stored=new Map();
  const destination={id:destinationId,orgId,kind:'site',enabled,workspaceIds:['pets'],config:{origin:'https://pet.example',siteId:'pets',sealedToken:cipher.seal('site-token',orgId+':'+destinationId)}};
  const site={head:{siteId:'pets',workId:'maine-coon',locale:'zh-CN',revision:2,route:'/news/maine-coon/',operation:'publish',operationSequence:1,contentHash:p.hash(cardEdition),state:headState},live,receipts:new Map()};
  const receipt=value=>({requestId:value.requestId,siteId:value.siteId,workId:value.workId,locale:value.locale,revision:value.revision,contentHash:value.contentHash,packetHash:p.hash(value),operation:value.operation||'publish',operationSequence:value.operationSequence,state:'success',release:'release-2'});
  const fetchImpl=async(url,{method='GET',body}={})=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/status'))return json({accepting:true,capabilities:status});
    if(path.includes('/heads/'))return json(site.head);
    if(path.startsWith('/rssd-content/'))return json(site.live);
    const mediaMatch=/\/media\/([a-f0-9]{64})$/.exec(path);
    if(mediaMatch){if(method==='POST'){const {data,...m}=JSON.parse(body);stored.set(mediaMatch[1],m);}return stored.has(mediaMatch[1])?json(stored.get(mediaMatch[1])):json({},404);}
    if(path.endsWith('/submissions')&&method==='POST'){
      // The receiver's rule for a card update: the live head, the next sequence, nothing changed but the card set.
      const value=publication(JSON.parse(body)),head=site.head;
      if(value.operation!=='cards'||value.expectedOperationSequence!==head.operationSequence||value.operationSequence!==head.operationSequence+1||value.revision!==head.revision||value.contentHash!==head.contentHash
        ||p.hash([value.content,value.assets||[]])!==p.hash([site.live.content,site.live.assets||[]]))return json({message:'refused'},409);
      site.head={...head,operation:'cards',operationSequence:value.operationSequence};site.live=value;site.receipts.set(value.requestId,receipt(value));
      return json(receipt(value));
    }
    const submission=/\/submissions\/([^/]+)$/.exec(path);
    if(submission)return site.receipts.has(submission[1])?json(site.receipts.get(submission[1])):json({},404);
    return json({},404);
  };
  let inserted=null;
  const db={
    $queryRawUnsafe:async(sql,...values)=>{
      if(/FROM rssd_destinations/.test(sql))return [destination];
      if(/FROM rssd_renditions/.test(sql)&&/ id=\$3/.test(sql))return renditions[values[2]]?[{payload:renditions[values[2]]}]:[];
      if(/FROM rssd_renditions/.test(sql))return newest?[{id:newest}]:[];
      if(/UNION ALL SELECT id FROM rssd_editorial_actions/.test(sql))return pending?[{id:'publication-9'}]:[];
      if(/INSERT INTO rssd_editorial_actions/.test(sql)){if(existing)return [];inserted={requestKey:values[3],payload:JSON.parse(values[8])};return [{id:values[1]}];}
      if(bilingual&&/FROM rssd_editorial_actions WHERE "orgId"=\$1 AND "workspaceId"=\$2 AND "requestKey"=\$3/.test(sql))return [{id:'action-cards-1',state:'queued',action:'cards',locale:'zh-CN',payload:inserted.payload,receipt:{}}];
      if(/FROM rssd_editorial_actions WHERE "orgId"=\$1 AND id=\$2 FOR UPDATE/.test(sql))return [{leaseToken:'lease'}];
      if(/FROM rssd_works/.test(sql))return [{id:'maine-coon',workspaceId:'pets',sectionId:'daily-cat'}];
      if(/FROM rssd_editions/.test(sql))return [{locale:'zh-CN',revision:2,payload:edition,hash:p.hash(edition)}];
      return [];},
    $executeRawUnsafe:async(sql,...values)=>{writes.push({sql,values});return 1;},
  };
  const store={db,transaction:fn=>fn(db),async edition(){return {payload:cardEdition,hash:p.hash(cardEdition)};}};
  const mediaStore={row:async(ctx,id)=>({id,workspaceId:'pets',manifest:media[id.slice(6)]}),bytes:async(ctx,id)=>({bytes:Buffer.from('png '+id)})};
  // A later draft (revision 3) exists; revision 2 is live.
  const entry={workId:'maine-coon',locale:'zh-CN',articleId:'maine-coon',revision:3,publishedVersion:2,sectionId:'daily-cat',url:'/news/maine-coon/',visibility:null,visibilityGeneration:0,deletedAt:null};
  class Editorial{constructor(nested,mediaStore){this.store=nested;this.media=mediaStore;}async workspace(){return {id:'pets',siteId:'pets'};}async entries(){return [entry];}async find(ctx,workspaceId,id,options){if(bilingual&&options?.locale!==entry.locale)throw new p.ProtocolError('Several editions claim this manuscript identity',409,'identity_conflict');return entry;}}
  const publisher=new RssdPublisher(store,{secret,fetchImpl,media:mediaStore});
  const actions=new RssdEditorialActions(store,mediaStore,publisher,new Editorial(store,mediaStore));
  const row=()=>({orgId,id:'action-cards-1',workspaceId:'pets',requestKey:inserted.requestKey,workId:'maine-coon',locale:'zh-CN',destinationId,action:'cards',payload:{...inserted.payload},receipt:{},packet:null,leaseToken:'lease',attempts:1,createdAt:new Date()});
  return {actions,site,stored,writes,row,entry,get inserted(){return inserted;}};
}
const actionState=f=>f.writes.filter(w=>/UPDATE rssd_editorial_actions SET state=/.test(w.sql)).at(-1)?.values;

test('a card update is the live packet with a new card set and the next sequence',()=>{
  const live=livePacket({operation:'cards',operationSequence:3,expectedOperationSequence:2,expectedRevision:2,cards:{revision:2,pages:[{...media.d,width:1080,height:1440}]}});
  const cards={revision:2,pages:[{...media.a,width:1080,height:1440}],cover:media.c};
  const packet=cardsPacket(live,{revision:2,operationSequence:3},cards,'action-cards-2');
  assert.deepEqual([packet.requestId,packet.operation,packet.operationSequence,packet.expectedOperationSequence,packet.expectedRevision],['action-cards-2','cards',4,3,2]);
  assert.deepEqual(packet.cards,cards);
  assert.equal(p.hash([packet.content,packet.assets||[]]),p.hash([live.content,live.assets||[]]));
  assert.equal(packet.contentHash,live.contentHash);
});

test('a card set saved for the live revision is queued once and reaches the website without a new revision',async()=>{
  const f=cardsFixture();
  assert.equal(await f.actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'}),'cards-rendition-1');
  assert.deepEqual([f.inserted.payload.publicRevision,f.inserted.payload.renditionId,f.inserted.payload.revision],[2,'rendition-1',3]);
  // Another draft saved before the update runs does not stop it: only the live revision matters.
  f.entry.revision=4;
  const result=await f.actions.dispatch(f.row());
  assert.equal(result.state,'published');
  assert.equal(f.site.live.operation,'cards');
  assert.deepEqual(f.site.live.cards,{revision:2,pages:[{...media.a,width:1080,height:1440},{...media.b,width:1080,height:1440}],cover:media.c});
  assert.deepEqual([...f.stored.keys()].sort(),[media.a.sha256,media.b.sha256,media.c.sha256]);
  // The publication's receipt records the receiver's new operation sequence, which later actions are fenced on.
  const upsert=f.writes.find(w=>/INSERT INTO rssd_publications/.test(w.sql));
  assert.equal(upsert.values[5],2);
  assert.equal(JSON.parse(upsert.values[8]).operationSequence,2);
});

test('a card update for a bilingual work resolves the locale of the queued action',async()=>{
  const f=cardsFixture({bilingual:true});await f.actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'});
  assert.equal((await f.actions.dispatch(f.row())).state,'published');
  assert.equal(f.site.live.locale,'zh-CN');assert.equal(f.site.live.operation,'cards');
});

test('a bilingual card action status resolves its own locale',async()=>{
  const f=cardsFixture({bilingual:true});await f.actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'});
  const status=await f.actions.status({orgId,admin:true,workspaceIds:null},'pets','cards-rendition-1');
  assert.equal(status.status,'queued');assert.equal(status.publishedVersion,2);
});

test('no card update for a note, a site that is not set up, or an edition published before card sets were sent',async()=>{
  const queue=f=>f.actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'});
  assert.equal(await queue(cardsFixture({edition:{...cardEdition,metadata:{date:'2026-11-19',workType:'note'}}})),null);
  assert.equal(await queue(cardsFixture({enabled:false})),null);
  // A head the receiver only knows from its migration baseline has no packet to send back: dropped, not retried.
  const legacy=cardsFixture({headState:'legacy'});await queue(legacy);
  assert.equal((await legacy.actions.dispatch(legacy.row())).state,'superseded');
  assert.match(actionState(legacy)[4],/published before card sets were sent/);
});

test('a card update waits for a quiet edition, is queued once per card set, and skips a set just sent',async()=>{
  assert.equal(await cardsFixture({pending:true}).actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'}),null);
  assert.equal(await cardsFixture({existing:true}).actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'}),null);
  assert.equal(await cardsFixture({newest:null}).actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'}),null);
  assert.equal(await cardsFixture().actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN',except:'rendition-1'}),null);
});

test('a card update is dropped for a receiver without card updates, or when the set is already live',async()=>{
  const old=cardsFixture({status:['work-types-v1']});await old.actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'});
  assert.equal((await old.actions.dispatch(old.row())).state,'superseded');
  assert.match(actionState(old)[4],/did not confirm it takes card updates/);
  assert.equal(old.site.live.operation,undefined);
  const cards={revision:2,pages:[{...media.a,width:1080,height:1440},{...media.b,width:1080,height:1440}],cover:media.c};
  const same=cardsFixture({live:livePacket({cards})});await same.actions.queueCards(orgId,{workspaceId:'pets',workId:'maine-coon',locale:'zh-CN'});
  assert.equal((await same.actions.dispatch(same.row())).state,'superseded');
  assert.match(actionState(same)[4],/already on the website/);
});

test('the publisher runs its follow-up after a verified publication, and a failing follow-up changes nothing',async()=>{
  const calls=[];
  const f=fixture();f.publisher.afterPublish=async row=>{calls.push(row.id);throw Error('queue unavailable');};
  const logged=console.error;console.error=()=>{};try{await f.publisher.dispatch(f.row);}finally{console.error=logged;}
  assert.equal(outcome(f),'published');
  assert.deepEqual(calls,['publication-1']);
});

test('a Center transaction timeout leaves a website action or publication queued for retry, not blocked',async()=>{
  const {classifyDestinationError}=require('./publisher.cjs');
  const timeout=()=>new p.ProtocolError('Publication transaction timed out before it could commit; retry the original request',503,'transaction_timeout');
  const outcome=async error=>{
    let finished;
    const actions=Object.assign(Object.create(RssdEditorialActions.prototype),{running:false,
      claim:async()=>({id:'action-1'}),dispatch:async()=>{throw error;},finish:async(row,result)=>(finished=result)});
    await actions.tick();
    return finished;
  };
  const retried=await outcome(timeout());
  assert.equal(retried.state,'queued');assert.match(retried.error,/queried before retry/);
  assert.equal((await outcome(new p.ProtocolError('Website action destination is disabled or changed',409,'missing_destination'))).state,'blocked');
  assert.equal((await outcome(Object.assign(Error('Receiver returned HTTP 403'),{status:403}))).state,'blocked');
  assert.equal((await outcome(Object.assign(Error('fetch failed'),{code:'ECONNREFUSED'}))).state,'queued');
  const classified=classifyDestinationError(timeout());
  assert.equal(classified.blocked,false);assert.equal(classified.code,'transaction_timeout');
  assert.equal(classifyDestinationError(new p.ProtocolError('Bad packet',400,'invalid_request')).blocked,true);
});
