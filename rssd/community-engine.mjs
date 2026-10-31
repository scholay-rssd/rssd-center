// Adapted from RSSD core c2f9cee (MIT); original license: legacy-labels/LICENSE.
import Database from './legacy-labels/sqlite.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {mkdirSync,chmodSync,readFileSync,writeFileSync,renameSync,statSync,existsSync} from 'node:fs';
import {mkdir,writeFile,rename,unlink,chmod} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';

export const communityOrigins=Object.freeze({
  'scholay-today':'https://today.scholay.com',legis:'https://legis.wiki',
  metho:'https://metho.scholay.com',enter:'https://enter.scholay.com',
  xsiching:'https://xsiching.com',study:'https://study.scholay.com'
});
const forum='https://enterscholar.com';
const decodeAttribute=s=>s.replace(/&amp;/g,'&').replace(/&#(?:0*38|x0*26);/gi,'&');
export function sourceFromPost(post){
  // Match the importer's explicit provenance footer, not arbitrary article links.
  for(const content of [post.raw,post.cooked]){
    if(typeof content!=='string')continue;
    const footers=[...content.matchAll(/<small\b[^>]*>([\s\S]*?)<\/small>/gi)];
    for(const [,footer] of footers.reverse()){
      if(!/这是一个从|original (?:entry|topic)|companion discussion/i.test(footer))continue;
      const urls=[...footer.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(x=>decodeAttribute(x[1]));
      if(urls.length===1)return urls[0];
    }
  }
  return null;
}
export function normalizedSource(value){
  try{
    const u=new URL(value),decoded=decodeURIComponent(u.pathname);
    if(u.username||u.password||u.search||u.hash||u.protocol!=='https:'||!Object.values(communityOrigins).includes(u.origin))return null;
    if(!/^\/(?:news|calendar|history|open-source)\/.+\/$/.test(u.pathname)||decoded.includes('\\')||decoded.includes('\0')||/%2f/i.test(u.pathname)||decoded.split('/').some(x=>x==='.'||x==='..'))return null;
    return {url:u.href,origin:u.origin,route:u.pathname};
  }catch{return null;}
}
export function validSignature(raw,signature,secret){
  if(!/^sha256=[a-f0-9]{64}$/i.test(signature||''))return false;
  return timingSafeEqual(Buffer.from(signature.slice(7),'hex'),createHmac('sha256',secret).update(raw).digest());
}
function readConfig(path){
  const c=JSON.parse(readFileSync(path,'utf8'));
  if(!['pilot','all','off'].includes(c.mode)||!Array.isArray(c.sites)||!Array.isArray(c.authors))throw Error('Invalid community link configuration');
  for(const s of c.sites)if(communityOrigins[s.id]!==s.origin||!s.webRoot||!isAbsolute(s.webRoot))throw Error('Invalid community site');
  if(c.mode==='pilot'&&(!Array.isArray(c.sources)||c.sources.some(s=>!normalizedSource(s))))throw Error('Invalid pilot sources');
  return c;
}
async function publicFirstPost(id){
  const response=await fetch(forum+'/t/'+id+'.json',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{'user-agent':'Scholay-ArticleLinks/1.0','accept':'application/json'}});
  if(!response.ok)throw Error('Forum lookup '+response.status);
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512*1024)throw Error('Forum payload too large');chunks.push(chunk);}
  const topic=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(topic.id!==id)throw Error('Wrong forum topic');
  return topic.post_stream?.posts?.find(p=>p.post_number===1);
}
export function createCommunityLinks({root,secret,configPath=join(root,'config.json'),flushDelayMs=1000,lookupPost=publicFirstPost,sourceExists=(source,site)=>existsSync(join(site.webRoot,decodeURIComponent(source.route),'index.html'))}){
  if(typeof secret!=='string'||secret.length<32)throw Error('Community webhook secret is required');
  mkdirSync(root,{recursive:true,mode:0o750});
  const publicRoot=join(root,'public'),asset=join(publicRoot,'discussion-links.v1.js'),script=readFileSync(new URL('./community-public/discussion-links.v1.js',import.meta.url));
  mkdirSync(publicRoot,{recursive:true,mode:0o755});chmodSync(publicRoot,0o755);
  if(!existsSync(asset)||!readFileSync(asset).equals(script)){
    writeFileSync(asset+'.next',script,{mode:0o644});chmodSync(asset+'.next',0o644);renameSync(asset+'.next',asset);
  }
  const dbPath=join(root,'links.sqlite'),db=new Database(dbPath);chmodSync(dbPath,0o600);
  db.pragma('journal_mode = WAL');db.pragma('busy_timeout = 1000');
  db.exec(`CREATE TABLE IF NOT EXISTS links(source_url TEXT PRIMARY KEY,site_id TEXT NOT NULL,route TEXT NOT NULL,topic_id INTEGER UNIQUE NOT NULL,topic_url TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,type TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS links_by_site ON links(site_id,active);`);
  let config,configStamp='',timer,closed=false,events=0,flushing=Promise.resolve();const dirty=new Set();
  const configuration=()=>{const s=statSync(configPath),stamp=s.mtimeMs+':'+s.size;if(stamp!==configStamp){config=readConfig(configPath);configStamp=stamp;}return config;};
  configuration();
  const flush=()=>{
    if(timer){clearTimeout(timer);timer=null;}
    const sites=[...dirty];dirty.clear();
    flushing=flushing.then(async()=>{
      for(const id of sites){
        const rows=db.prepare('SELECT route,topic_url FROM links WHERE site_id=? AND active=1 ORDER BY route').all(id);
        const directory=join(root,'public',id),target=join(directory,'links.json'),temporary=target+'.next';
        try{
          await mkdir(directory,{recursive:true,mode:0o755});
          await chmod(join(root,'public'),0o755);await chmod(directory,0o755);
          await writeFile(temporary,JSON.stringify({version:1,links:Object.fromEntries(rows.map(r=>[r.route,r.topic_url]))})+'\n',{mode:0o644});
          await chmod(temporary,0o644); // Service UMask=0077 must not hide public metadata.
          await rename(temporary,target);
        }catch(e){
          dirty.add(id);await unlink(temporary).catch(()=>{});
          console.error(JSON.stringify({event:'community_links_flush',status:'failed',site:id,code:e.code||e.name}));
        }
      }
      if(dirty.size&&!timer&&!closed){timer=setTimeout(flush,30000);timer.unref();}
    }).catch(error=>{console.error(JSON.stringify({event:'community_links_flush',status:'failed',code:error.code||error.name}));});
    return flushing;
  };
  const schedule=id=>{dirty.add(id);if(!timer&&!closed){timer=setTimeout(flush,flushDelayMs);timer.unref();}};
  // Recover a database commit whose static-file replacement was interrupted.
  for(const {site_id} of db.prepare('SELECT DISTINCT site_id FROM links').all())dirty.add(site_id);
  if(dirty.size){timer=setTimeout(flush,flushDelayMs);timer.unref();}
  function receive({raw,signature,eventId,eventType,instance}){
    const started=performance.now(),cpu=process.cpuUsage();
    if(!Buffer.isBuffer(raw)||raw.length>512*1024||!validSignature(raw,signature,secret))return {statusCode:401,body:{error:'Invalid webhook signature'}};
    if(instance&&instance.replace(/\/$/,'')!==forum)return {statusCode:403,body:{error:'Wrong forum instance'}};
    const type=String(eventType||'');
    if(type==='ping')return {statusCode:200,body:{ok:true,status:'pong'}};
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(String(eventId||'')))return {statusCode:400,body:{error:'Invalid event id'}};
    if(db.prepare('SELECT 1 FROM events WHERE id=?').get(eventId))return {statusCode:200,body:{ok:true,status:'duplicate'}};
    let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return {statusCode:400,body:{error:'Invalid JSON'}};}
    const c=configuration(),post=payload.post,topic=payload.topic;let result='ignored';
    if(c.mode!=='off'&&['topic_created','topic_edited','topic_destroyed','topic_recovered'].includes(type)&&topic&&Number.isSafeInteger(topic.id)&&topic.id>0&&topic.archetype==='regular'&&c.authors.includes(topic.created_by?.username)){
      const saved=db.prepare('SELECT * FROM links WHERE topic_id=?').get(topic.id);
      if(saved)return {topic:{id:topic.id,username:topic.created_by.username,source:saved.source_url},eventType:type};
      if(c.mode==='all'||c.topicIds?.includes(topic.id))return {topic:{id:topic.id,username:topic.created_by.username},eventType:type};
    }
    const eligible=c.mode!=='off'&&['post_created','post_edited','post_updated','post_destroyed','post_recovered'].includes(type)&&post&&post.post_number===1&&Number.isSafeInteger(post.topic_id)&&post.topic_id>0&&c.authors.includes(post.username)&&post.archetype!=='private_message'&&post.topic_archetype!=='private_message'&&topic?.archetype!=='private_message';
    db.transaction(()=>{
      if(eligible){
        const existing=db.prepare('SELECT * FROM links WHERE topic_id=?').get(post.topic_id);
        if(type==='post_destroyed'){
          if(existing?.active){db.prepare('UPDATE links SET active=0,updated=? WHERE topic_id=?').run(Date.now(),post.topic_id);schedule(existing.site_id);result='removed';}
        }else{
          const source=normalizedSource(sourceFromPost(post)),site=source&&c.sites.find(s=>s.origin===source.origin);
          const inPilot=c.mode==='all'||c.sources.includes(source?.url);
          if(source&&site&&inPilot&&sourceExists(source,site)){
            const occupied=db.prepare('SELECT * FROM links WHERE source_url=?').get(source.url);
            if((occupied?.active&&occupied.topic_id!==post.topic_id)||(existing&&existing.source_url!==source.url))result='conflict';
            else{
              const topicUrl=forum+'/t/-/'+post.topic_id;
              if(occupied?.active&&occupied.topic_url===topicUrl)result='unchanged';
              else{
                db.prepare('INSERT INTO links VALUES(?,?,?,?,?,1,?) ON CONFLICT(source_url) DO UPDATE SET site_id=excluded.site_id,route=excluded.route,topic_id=excluded.topic_id,topic_url=excluded.topic_url,active=1,updated=excluded.updated').run(source.url,site.id,source.route,post.topic_id,topicUrl,Date.now());
                schedule(site.id);result='linked';
              }
            }
          }
        }
      }
      db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(eventId,type,result,Date.now());
      if(++events%100===0){
        db.prepare('DELETE FROM events WHERE created<?').run(Date.now()-30*86400_000);
        db.exec('DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT 5000)');
      }
    })();
    const usage=process.cpuUsage(cpu);
    console.info(JSON.stringify({event:'community_links',type,result,durationMs:+(performance.now()-started).toFixed(2),cpuMs:+((usage.user+usage.system)/1000).toFixed(2)}));
    return {statusCode:200,body:{ok:true,status:result}};
  }
  let lookups=0;
  async function accept(event){
    const result=receive(event);if(!result.topic)return result;
    const t=result.topic;let post;
    if(t.source)post={topic_id:t.id,post_number:1,username:t.username,cooked:'<small>original topic <a href="'+t.source+'">source</a></small>'};
    else{
      if(lookups>=2)return {statusCode:503,body:{error:'Lookup busy; retry delivery'}};
      lookups++;
      try{post=await lookupPost(t.id);if(post?.topic_id!==t.id||post?.username!==t.username)throw Error('Wrong first post');}
      catch(error){console.error(JSON.stringify({event:'community_links_lookup',status:'failed',topicId:t.id,reason:error.message}));return {statusCode:503,body:{error:'Forum unavailable; retry delivery'}};}
      finally{lookups--;}
    }
    const source=normalizedSource(sourceFromPost(post)),site=source&&configuration().sites.find(s=>s.origin===source.origin);
    if(source&&site&&result.eventType!=='topic_destroyed'&&!sourceExists(source,site))return {statusCode:503,body:{error:'Published source is not available; retry delivery'}};
    const raw=Buffer.from(JSON.stringify({post})),type=result.eventType==='topic_destroyed'?'post_destroyed':result.eventType==='topic_recovered'?'post_recovered':'post_edited';
    return receive({...event,raw,signature:'sha256='+createHmac('sha256',secret).update(raw).digest('hex'),eventType:type});
  }
  return {receive,accept,flush,db,async close(){closed=true;await flush();db.close();}};
}
