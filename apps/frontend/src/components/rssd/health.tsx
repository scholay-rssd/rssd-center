'use client';
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
const labels:Record<string,string>={queued:'等待处理',claimed:'正在生产',blocked:'需要处理',completed:'已交稿',cancelled:'已取消',dispatching:'正在发布',published:'已发布',legacy_published:'原系统已发布',superseded:'已被新版替代',healthy:'最近备份已校验',stale:'备份已超时',failed:'最近备份失败',running:'正在备份',not_configured:'尚未配置自动备份',unavailable:'无法读取备份状态',idle:'空闲',running_worker:'工作中',paused:'已暂停'};
export function CenterHealth({api}:{api:(path:string)=>Promise<any>}){
 const [value,setValue]=useState<Row|null>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;const load=()=>api('/health').then(result=>{if(alive){setValue(result);setError('');}}).catch(e=>{if(alive)setError(e.message);});void load();const timer=setInterval(load,30000);return()=>{alive=false;clearInterval(timer);};},[api]);
 return <div className="ca-form ca-wide"><h2>运行状况</h2>{error&&<p role="alert" className="cp-notice ca-error">{error}</p>}{!value?<p>正在读取…</p>:<>
  <p>作品库共有 {value.works} 件作品。自动分发{value.dispatchEnabled?'已开启':'已暂停'}。</p>
  <fieldset><legend>需求与发布</legend>{[['需求',value.demands],['发布',value.publications]].map(([name,rows])=><div key={name as string}><h3>{name as string}</h3>{(rows as Row[]).length?(rows as Row[]).map(row=><p key={row.state}>{labels[row.state]||row.state}：{row.count}</p>):<p>暂无记录</p>}</div>)}</fieldset>
  <fieldset><legend>执行设备</legend>{value.workers.length?value.workers.map((worker:Row)=><p key={worker.id}>{worker.name} · {worker.online?'在线':'未连接'} · {labels[worker.state==='running'?'running_worker':worker.state]||worker.state}{worker.heartbeatAt?' · 最后连接 '+new Date(worker.heartbeatAt).toLocaleString('zh-CN'):''}</p>):<p>尚未连接设备</p>}<p>设备失联后保留原认领，由你恢复或释放。</p></fieldset>
  <fieldset><legend>恢复备份</legend><p>{labels[value.backup.state]||value.backup.state}</p>{value.backup.lastVerifiedAt&&<p>最近成功校验：{new Date(value.backup.lastVerifiedAt).toLocaleString('zh-CN')}</p>}<p>数据库与配置加密留档，文章版本和媒体增量归档。</p></fieldset>
  <p>检查时间：{new Date(value.checkedAt).toLocaleString('zh-CN')}</p>
 </>}</div>;
}
