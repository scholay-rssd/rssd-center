'use client';
import {useCallback,useEffect,useState} from 'react';
import {useFetch} from '@gitroom/helpers/utils/custom.fetch';
import {OrganizationSelector} from '@gitroom/frontend/components/layout/organization.selector';
import {useUser} from '@gitroom/frontend/components/layout/user.context';
import './workspace.css';
type Row=Record<string,any>;
export function DeviceAuthorization({requestId,userCode}:{requestId:string;userCode:string}){
 const fetch=useFetch(),user=useUser();
 const [code,setCode]=useState(userCode),[request,setRequest]=useState<Row|null>(null),[spaces,setSpaces]=useState<Row[]>([]),[selected,setSelected]=useState<string[]>([]);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(''),[callback,setCallback]=useState('');
 const api=useCallback(async(path:string,body?:unknown)=>{const response=await fetch('/rssd/v1'+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.message||'授权失败');return data;},[fetch]);
 const load=useCallback(async(id:string,code:string)=>{
  setBusy(true);setError('');setRequest(null);setSelected([]);
  try{const [req,registry]=await Promise.all([api('/auth/request?'+new URLSearchParams(id?{requestId:id}:{userCode:code})),api('/registry')]);setRequest(req);setSpaces(registry.workspaces);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 },[api]);
 useEffect(()=>{if(requestId||userCode)void load(requestId,userCode);},[requestId,userCode,user?.orgId,load]);
 async function decide(approved:boolean){
  if(!request)return;setBusy(true);setError('');
  try{const result=await api('/auth/requests/'+request.requestId+'/decision',{approved,workspaceIds:selected});setDone(approved?'设备授权已确认。客户端将完成连接，工作模式仍由你手动开启。':'已拒绝本次设备授权。');if(result.callback){setCallback(result.callback);window.location.href=result.callback;}}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <main className="rssd-workspace rssd-device-authorization"><header className="rssd-header"><div><span className="rssd-overline">RSSD / 设备</span><h1>授权设备</h1></div></header>
  <p className="rssd-authorization-intro">确认这是你刚刚在客户端发起的连接请求，再选择允许访问的工作空间。</p>
  <OrganizationSelector asOpenSelect/>
  {error&&<p className="rssd-message rssd-error" role="alert">{error}</p>}
  {done?<section className="rssd-form"><p className="rssd-message" role="status">{done}</p>{callback&&<a href={callback}>返回 RSSD 客户端</a>}</section>:<>
   {!requestId&&<form className="rssd-form rssd-device-code" onSubmit={event=>{event.preventDefault();void load('',code);}}><label>设备码<input value={code} onChange={event=>setCode(event.target.value)} maxLength={20} autoComplete="off"/></label><button disabled={busy||!code.trim()}>查找请求</button></form>}
   {busy&&!request&&<p className="rssd-message" role="status">正在读取授权请求…</p>}
   {request&&<section className="rssd-form rssd-device-card"><h2>{request.name}</h2><p>{request.center} · {request.mode==='desktop'?'桌面客户端':'Linux 无头客户端'}</p><p>有效期至 {new Date(request.expiresAt).toLocaleString()}</p>
    <fieldset disabled={busy||request.state!=='pending'}><legend>允许访问的工作空间</legend><div className="rssd-device-scopes">{spaces.map(space=><label className="rssd-checkbox" key={space.id}><input type="checkbox" checked={selected.includes(space.id)} onChange={event=>setSelected(old=>event.target.checked?[...old,space.id]:old.filter(id=>id!==space.id))}/>{space.name}</label>)}</div></fieldset>
    {request.state==='pending'?<div className="rssd-form-actions"><button disabled={busy} onClick={()=>void decide(false)}>拒绝</button><button className="rssd-primary" disabled={busy||!selected.length} onClick={()=>void decide(true)}>授权这台设备</button></div>:<p className="rssd-message">这条请求已经处理，请返回客户端查看结果或重新发起。</p>}
   </section>}
  </>}
 </main>;
}
