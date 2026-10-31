'use client';
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
export function CenterLabels({api}:{api:(path:string,method?:string,data?:unknown)=>Promise<any>}){
 const [feed,setFeed]=useState<Row|null>(null),[platform,setPlatform]=useState(''),[search,setSearch]=useState(''),[error,setError]=useState(''),[tick,setTick]=useState(0),[notice,setNotice]=useState('');
 useEffect(()=>{let live=true;setError('');api('/labels').then(value=>{if(live){setFeed(value);setPlatform(current=>current||value.platforms[0]?.id||'');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,tick]);
 const selected=feed?.platforms.find((p:Row)=>p.id===platform),snapshot=feed?.latest.find((p:Row)=>p.platformId===platform);
 return <section className="rssd-form"><h2>流量标签</h2><p>读取云端已有缓存。刷新与切换平台不会启动采集。</p>{error&&<p role="alert">{error}</p>}
 {feed&&<><div className="rssd-header-actions"><label>平台<select value={platform} onChange={e=>setPlatform(e.target.value)}>{feed.platforms.map((p:Row)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button onClick={()=>setTick(n=>n+1)}>刷新缓存</button></div>
 <label>查找标签<input value={search} onChange={e=>setSearch(e.target.value)}/></label><p>{selected?.message}{snapshot?.observedAt?' · '+new Date(snapshot.observedAt).toLocaleString('zh-CN'):''}</p>
 <div className="rssd-list">{snapshot?.rows.filter((r:Row)=>r.term.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((r:Row)=><article className="rssd-row" key={r.id}><div><h3>{r.term}</h3><p>{r.kind}{r.metric?' · '+r.metric.label+' '+r.metric.value:''}</p></div><button onClick={()=>void navigator.clipboard.writeText(r.term).then(()=>setNotice('已复制：'+r.term)).catch(()=>setNotice('复制失败，请手动选择标签文字'))}>复制</button></article>)}</div>
 {!snapshot&&<p>此平台尚无可用缓存。</p>}</>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
