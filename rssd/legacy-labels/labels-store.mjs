import Database from './sqlite.mjs';
import {mkdirSync,chmodSync,lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export const LABEL_MONTH_LIMIT_MICROS=5_000_000;
export const LABEL_SNAPSHOT_MAX_BYTES=24*1024;
export const LABEL_PLATFORMS=Object.freeze([
  {id:'bilibili',name:'哔哩哔哩',mark:'哔'},
  {id:'douyin',name:'抖音',mark:'抖'},
  {id:'kuaishou',name:'快手',mark:'快'},
  {id:'xiaohongshu',name:'小红书',mark:'红'},
  {id:'weibo',name:'微博',mark:'微'},
  {id:'toutiao',name:'今日头条',mark:'头'},
  {id:'zhihu',name:'知乎',mark:'知'},
]);
export const labelMonth=now=>new Date(now+8*3600_000).toISOString().slice(0,7);
const iso=now=>new Date(now).toISOString();
const text=(value,max,required=false)=>{
  if(typeof value!=='string'||value.length>max||/[\u0000-\u001f]/.test(value))throw Error('标签公共字段格式无效');
  const result=value.trim();if(required&&!result)throw Error('标签公共字段不能为空');return result;
};
const safeUrl=value=>{
  if(value==null||value==='')return null;
  const url=new URL(text(value,2000,true));
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hostname==='localhost'||/^\d+(?:\.\d+){3}$/.test(url.hostname)||url.hostname.includes(':'))throw Error('标签来源链接无效');
  return url.href;
};
function platform(id){if(!LABEL_PLATFORMS.some(item=>item.id===id))throw Error('未知标签平台');return id;}
export function validateLabelEndpoint(endpoint){
  if(!endpoint||typeof endpoint!=='object')throw Error('标签端点不在白名单');
  platform(endpoint.platformId);
  if(!/^[a-z0-9][a-z0-9._-]{1,99}$/.test(endpoint.id||'')||!Number.isSafeInteger(endpoint.maxCostMicros)||endpoint.maxCostMicros<1||endpoint.maxCostMicros>LABEL_MONTH_LIMIT_MICROS||!Number.isSafeInteger(endpoint.intervalMs)||endpoint.intervalMs<60_000||endpoint.intervalMs>31*86400_000)throw Error('标签端点费用或周期未获确认');
  return {id:endpoint.id,platformId:endpoint.platformId,maxCostMicros:endpoint.maxCostMicros,intervalMs:endpoint.intervalMs,boardLabel:text(endpoint.boardLabel||'平台标签',100,true)};
}
export function openLabelsStore(path){
  if(path!==':memory:'){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    try{if(lstatSync(path).isSymbolicLink())throw Error('标签缓存不能使用符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const db=new Database(path);
  if(path!==':memory:')chmodSync(path,0o600);
  db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS label_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS label_platforms(id TEXT PRIMARY KEY,endpoint_id TEXT,board_label TEXT,next_due INTEGER,last_attempt INTEGER,status TEXT NOT NULL DEFAULT 'pending',message TEXT NOT NULL DEFAULT '云端尚未采集');
    CREATE TABLE IF NOT EXISTS label_budget_months(month TEXT PRIMARY KEY,limit_micros INTEGER NOT NULL CHECK(limit_micros=5000000),spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),CHECK(spent_micros+reserved_micros<=limit_micros));
    CREATE TABLE IF NOT EXISTS label_requests(id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,month TEXT NOT NULL REFERENCES label_budget_months(month),platform_id TEXT NOT NULL REFERENCES label_platforms(id),endpoint_id TEXT NOT NULL,max_cost_micros INTEGER NOT NULL CHECK(max_cost_micros>0),charged_micros INTEGER,state TEXT NOT NULL CHECK(state IN ('reserved','succeeded','uncertain')),created INTEGER NOT NULL,finished INTEGER,dispatched INTEGER);
    CREATE TABLE IF NOT EXISTS label_prior_spend(id TEXT PRIMARY KEY,month TEXT NOT NULL REFERENCES label_budget_months(month),cost_micros INTEGER NOT NULL CHECK(cost_micros>0),note TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS label_snapshots(id TEXT PRIMARY KEY REFERENCES label_requests(id),platform_id TEXT NOT NULL,observed INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS label_snapshot_platform_time ON label_snapshots(platform_id,observed DESC,id DESC);
    CREATE INDEX IF NOT EXISTS label_snapshot_time ON label_snapshots(observed DESC,id DESC);
  `);
  if(!db.prepare('PRAGMA table_info(label_requests)').all().some(column=>column.name==='dispatched'))db.exec('ALTER TABLE label_requests ADD COLUMN dispatched INTEGER');
  for(const item of LABEL_PLATFORMS)db.prepare('INSERT OR IGNORE INTO label_platforms(id) VALUES(?)').run(item.id);
  return db;
}
export function labelBudget(db,now=Date.now()){
  const month=labelMonth(now),row=db.prepare('SELECT * FROM label_budget_months WHERE month=?').get(month);
  const spentMicros=row?.spent_micros||0,reservedMicros=row?.reserved_micros||0,remainingMicros=LABEL_MONTH_LIMIT_MICROS-spentMicros-reservedMicros;
  return {month,currency:'USD',limitMicros:LABEL_MONTH_LIMIT_MICROS,spentMicros,reservedMicros,remainingMicros,blocked:remainingMicros===0};
}
// Explicit one-time import for earlier, verified label diagnostics. This is
// server maintenance only, never reachable from the read-only HTTP API.
export function seedLabelSpend(db,{id,month,costMicros,note='此前标签接口验证费用'}){
  if(!/^[a-zA-Z0-9_-]{6,100}$/.test(id||'')||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||'')||!Number.isSafeInteger(costMicros)||costMicros<1||costMicros>LABEL_MONTH_LIMIT_MICROS)throw Error('历史标签费用记录无效');
  const safeNote=text(note,240,true);
  return db.transaction(()=>{
    const old=db.prepare('SELECT * FROM label_prior_spend WHERE id=?').get(id);
    if(old){if(old.month!==month||old.cost_micros!==costMicros)throw Error('历史标签费用编号已绑定另一条账目');return {imported:false};}
    db.prepare('INSERT OR IGNORE INTO label_budget_months(month,limit_micros) VALUES(?,?)').run(month,LABEL_MONTH_LIMIT_MICROS);
    const budget=db.prepare('SELECT * FROM label_budget_months WHERE month=?').get(month);
    if(budget.spent_micros+budget.reserved_micros+costMicros>LABEL_MONTH_LIMIT_MICROS)throw Error('历史费用超过本月剩余额度');
    db.prepare('INSERT INTO label_prior_spend VALUES(?,?,?,?)').run(id,month,costMicros,safeNote);
    db.prepare('UPDATE label_budget_months SET spent_micros=spent_micros+? WHERE month=?').run(costMicros,month);
    return {imported:true};
  })();
}
export function noteLabelWorker(db,{configured,now=Date.now(),message=''}={}){
  db.prepare("INSERT INTO label_meta VALUES('worker',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({configured:configured===true,lastWorkerAt:iso(now),message:text(message,240)}));
}
export function configureLabelPlatforms(db,endpoints){
  const seen=new Set();
  for(const input of endpoints){
    const endpoint=validateLabelEndpoint(input);
    if(seen.has(endpoint.platformId))throw Error('同平台只能配置一个完整标签采集端点');seen.add(endpoint.platformId);
    db.prepare('UPDATE label_platforms SET endpoint_id=?,board_label=? WHERE id=?').run(endpoint.id,endpoint.boardLabel,endpoint.platformId);
  }
}
export function labelPreflightFailure(db,platformId){
  platform(platformId);
  db.prepare("UPDATE label_platforms SET status='error',message='官方费用或连接校验未通过，未发起付费采集' WHERE id=?").run(platformId);
}
export function claimLabelDispatch(db,id,input,now=Date.now()){
  const endpoint=validateLabelEndpoint(input);
  return db.transaction(()=>{
    const request=db.prepare("SELECT * FROM label_requests WHERE id=? AND state='reserved' AND dispatched IS NULL").get(id);
    if(!request||request.endpoint_id!==endpoint.id||request.platform_id!==endpoint.platformId||request.max_cost_micros!==endpoint.maxCostMicros)throw Error('付费采集缺少有效费用预留，或该请求已经发出');
    db.prepare('UPDATE label_requests SET dispatched=? WHERE id=?').run(now,id);
  })();
}
// Reserving happens before networking, inside one cross-process SQLite lock.
// An incomplete/ambiguous request keeps its reservation even after a restart.
export function reserveLabelRequest(db,input,now=Date.now()){
  const endpoint=validateLabelEndpoint(input),month=labelMonth(now);
  return db.transaction(()=>{
    db.prepare('INSERT OR IGNORE INTO label_budget_months(month,limit_micros) VALUES(?,?)').run(month,LABEL_MONTH_LIMIT_MICROS);
    const dedupeKey=`${endpoint.platformId}:${endpoint.id}:${Math.floor(now/endpoint.intervalMs)}`;
    const old=db.prepare('SELECT * FROM label_requests WHERE dedupe_key=?').get(dedupeKey);
    if(old)return {accepted:false,reason:'already_requested',request:old};
    const state=db.prepare('SELECT * FROM label_platforms WHERE id=?').get(endpoint.platformId);
    if(state.next_due>now)return {accepted:false,reason:'not_due'};
    const budget=labelBudget(db,now);
    if(budget.remainingMicros<endpoint.maxCostMicros){
      db.prepare("UPDATE label_platforms SET status='budget_exhausted',message='月预算不足，保留云端缓存' WHERE id=?").run(endpoint.platformId);
      return {accepted:false,reason:'budget_exhausted'};
    }
    const id='label-'+randomUUID();
    db.prepare("INSERT INTO label_requests(id,dedupe_key,month,platform_id,endpoint_id,max_cost_micros,state,created) VALUES(?,?,?,?,?,?,'reserved',?)").run(id,dedupeKey,month,endpoint.platformId,endpoint.id,endpoint.maxCostMicros,now);
    db.prepare('UPDATE label_budget_months SET reserved_micros=reserved_micros+? WHERE month=?').run(endpoint.maxCostMicros,month);
    const nextSlot=(Math.floor(now/endpoint.intervalMs)+1)*endpoint.intervalMs;
    db.prepare("UPDATE label_platforms SET endpoint_id=?,board_label=?,last_attempt=?,next_due=?,status='collecting',message='云端正在采集' WHERE id=?").run(endpoint.id,endpoint.boardLabel,now,nextSlot,endpoint.platformId);
    return {accepted:true,request:db.prepare('SELECT * FROM label_requests WHERE id=?').get(id)};
  })();
}
function safeSnapshot(request,result,now){
  if(!result||!Array.isArray(result.rows)||!result.rows.length||result.rows.length>100)throw Error('标签响应为空或超过上限');
  const rows=result.rows.map(row=>{
    const term=text(row.term,240,true),kind=text(row.kind,80,true);
    if(row.rank!=null&&(!Number.isSafeInteger(row.rank)||row.rank<1||row.rank>10000))throw Error('标签排名无效');
    const metric=row.metric==null?null:{label:text(row.metric.label,60,true),value:text(row.metric.value,60,true),unit:text(row.metric.unit||'',24)};
    return {id:createHash('sha256').update(JSON.stringify([request.platform_id,kind,term])).digest('hex').slice(0,24),term,kind,rank:row.rank??null,metric,url:safeUrl(row.url)};
  });
  if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('标签响应包含重复条目');
  const value={id:request.id,platformId:request.platform_id,provider:'tikhub',endpointId:request.endpoint_id,observedAt:iso(now),period:result.period==null?null:text(result.period,100),rows};
  if(Buffer.byteLength(JSON.stringify(value))>LABEL_SNAPSHOT_MAX_BYTES)throw Error('标签快照超过公共响应上限');
  return value;
}
export function completeLabelRequest(db,id,result,{now=Date.now(),chargedMicros}={}){
  return db.transaction(()=>{
    const request=db.prepare('SELECT * FROM label_requests WHERE id=?').get(id);
    if(!request)throw Error('标签采集请求不存在');
    if(request.state==='succeeded')return JSON.parse(db.prepare('SELECT payload FROM label_snapshots WHERE id=?').get(id).payload);
    // Billing is conservative by default: count the whole confirmed upper bound.
    const cost=chargedMicros??request.max_cost_micros;
    if(!Number.isSafeInteger(cost)||cost<0||cost>request.max_cost_micros)throw Error('费用不在已预留上限内');
    const snapshot=safeSnapshot(request,result,now);
    db.prepare('INSERT INTO label_snapshots VALUES(?,?,?,?)').run(id,request.platform_id,now,JSON.stringify(snapshot));
    db.prepare("UPDATE label_requests SET state='succeeded',charged_micros=?,finished=? WHERE id=?").run(cost,now,id);
    db.prepare('UPDATE label_budget_months SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+? WHERE month=?').run(request.max_cost_micros,cost,request.month);
    db.prepare("UPDATE label_platforms SET status='ready',message='云端标签已更新' WHERE id=?").run(request.platform_id);
    return snapshot;
  })();
}
export function uncertainLabelRequest(db,id,now=Date.now()){
  return db.transaction(()=>{
    const request=db.prepare("SELECT * FROM label_requests WHERE id=? AND state='reserved'").get(id);
    if(!request)return;
    db.prepare("UPDATE label_requests SET state='uncertain',finished=? WHERE id=?").run(now,id);
    db.prepare("UPDATE label_platforms SET status='error',message='采集未确认，保留旧缓存与费用预留' WHERE id=?").run(request.platform_id);
  })();
}
export function recoverLabelRequests(db,now=Date.now(),timeoutMs=120_000){
  for(const request of db.prepare("SELECT id FROM label_requests WHERE state='reserved' AND created<=?").all(now-timeoutMs))uncertainLabelRequest(db,request.id,now);
}
export function labelsFeed(db,now=Date.now()){
  const budget=labelBudget(db,now),worker=JSON.parse(db.prepare("SELECT value FROM label_meta WHERE key='worker'").get()?.value||'null');
  const latest=[];
  const platforms=LABEL_PLATFORMS.map(item=>{
    const row=db.prepare('SELECT * FROM label_platforms WHERE id=?').get(item.id);
    const saved=db.prepare('SELECT payload FROM label_snapshots WHERE platform_id=? ORDER BY observed DESC,id DESC LIMIT 1').get(item.id);
    const snapshot=saved?JSON.parse(saved.payload):null;if(snapshot)latest.push(snapshot);
    const stale=row.status==='ready'&&row.next_due!=null&&row.next_due<=now;
    const interrupted=row.status==='collecting'&&row.last_attempt<now-120_000;
    return {...item,boardLabel:row.board_label||'平台标签',status:interrupted?'error':stale?'stale':row.status,message:interrupted?'上次采集未确认，保留缓存与费用预留':stale?'云端等待下次更新':row.message,lastObservedAt:snapshot?.observedAt||null,nextDueAt:row.next_due==null?null:iso(row.next_due)};
  });
  const history=db.prepare('SELECT payload FROM label_snapshots ORDER BY observed DESC,id DESC LIMIT 60').all().map(row=>JSON.parse(row.payload));
  return {schemaVersion:1,source:'scholay-cloud-labels',generatedAt:iso(now),budget,collection:{configured:worker?.configured===true,lastWorkerAt:worker?.lastWorkerAt||null,message:worker?.message||'云端采集服务尚未启动'},platforms,latest,history};
}
