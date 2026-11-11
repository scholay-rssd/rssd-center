'use client';
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
export function GuestbookModeration({api,workspaceId}:{api:(path:string,method?:string,data?:unknown)=>Promise<any>;workspaceId:string}){
 const [books,setBooks]=useState<Row[]>([]),[site,setSite]=useState(''),[status,setStatus]=useState('pending'),[rows,setRows]=useState<Row[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[tick,setTick]=useState(0);
 const visible=books.filter(b=>!workspaceId||b.workspaceId===workspaceId),book=visible.find(b=>b.siteId===site);
 useEffect(()=>{let live=true;api('/guestbooks').then(value=>{if(live)setBooks(value);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api]);
 useEffect(()=>{setSite(current=>visible.some(b=>b.siteId===current)?current:visible[0]?.siteId||'');},[books,workspaceId]);
 useEffect(()=>{let live=true;setRows([]);setError('');if(site&&book)api('/guestbooks/'+encodeURIComponent(site)+'/messages?status='+status).then(result=>{if(live)setRows(result.messages);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,site,status,tick,book]);
 const review=async(id:string,next:string)=>{setBusy(true);setError('');try{await api('/guestbooks/'+encodeURIComponent(site)+'/messages/'+encodeURIComponent(id)+'/review','POST',{status:next});setTick(n=>n+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="ca-form ca-wide"><h2>留言审核</h2><p>审核通过后公开昵称和留言正文，联系方式与补充信息仅在此处显示。</p>
 {error&&<p role="alert" className="cp-notice ca-error">{error}</p>}
 {!visible.length?<p>此工作空间尚未接入留言板。</p>:<><label>站点<select value={site} disabled={busy} onChange={e=>setSite(e.target.value)}>{visible.map(b=><option key={b.siteId} value={b.siteId}>{b.config.name}</option>)}</select></label>
 <label>审核状态<select value={status} disabled={busy} onChange={e=>setStatus(e.target.value)}><option value="pending">待审核</option><option value="approved">已公开</option><option value="rejected">不公开</option></select></label>
 {book&&!book.enabled&&<p>该留言板正在迁移，完成旧系统交接后才能审核。</p>}
 {!rows.length&&<p>暂无此状态的留言。</p>}
 {rows.map(r=><article key={r.id}><h3>{r.name} · {book?.config.forms.find((f:Row)=>f.id===r.kind)?.label||r.kind}</h3><time>{new Date(r.created).toLocaleString('zh-CN')}</time><p style={{whiteSpace:'pre-wrap'}}>{r.message}</p>
 <details><summary>私有联系与补充信息</summary><p>联系方式：{r.contact||'未填写'}</p>{Object.entries(r.details||{}).map(([key,value])=><p key={key}>{book?.config.forms.find((f:Row)=>f.id===r.kind)?.fields.find((f:Row)=>f.key===key)?.label||key}：{String(value)}</p>)}</details>
 <div className="ca-actions">{[['approved','公开'],['rejected','不公开'],['pending','恢复待审']].filter(([value])=>value!==r.status).map(([value,label])=><button key={value} disabled={busy||!book?.enabled} onClick={()=>void review(r.id,value)}>{label}</button>)}</div></article>)}</>}
 </section>;
}
