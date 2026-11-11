'use client';
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
export function PlatformContent({api,workspaceId,value,onChange,attachments,disabled}:{api:(path:string)=>Promise<any>;workspaceId:string;value:Row;onChange:(value:Row)=>void;attachments:Row[];disabled:boolean}){
 const [destinations,setDestinations]=useState<Row[]>([]),[error,setError]=useState('');
 useEffect(()=>{let alive=true;api('/destinations').then(rows=>{if(alive)setDestinations(rows.filter((d:Row)=>d.kind==='postiz'&&d.workspaceIds.includes(workspaceId)));}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[api,workspaceId]);
 if(!destinations.length&&!error)return null;
 return <details className="ca-form ca-wide"><summary>社交平台正文与配图</summary>{error&&<p role="alert" className="cp-notice ca-error">{error}</p>}<p>各平台使用这里准备的正文与附件；是否发布由栏目规则决定。</p>{destinations.map(d=>{
  const content=value[d.id],update=(patch:Row)=>onChange({...value,[d.id]:{text:'',mediaIds:[],settings:{},...content,...patch}});
  return <fieldset key={d.id} disabled={disabled}><legend>{d.name}{!d.enabled?'（渠道已停用）':''}</legend>{!content?<button type="button" onClick={()=>update({})}>准备此平台的内容</button>:<><label>发布正文<textarea rows={5} value={content.text||''} onChange={e=>update({text:e.target.value})}/></label><p>发布配图</p>{attachments.length?attachments.map(asset=><label className="ca-check" key={asset.id}><input type="checkbox" checked={(content.mediaIds||[]).includes(asset.id)} onChange={e=>update({mediaIds:e.target.checked?[...(content.mediaIds||[]),asset.id]:(content.mediaIds||[]).filter((id:string)=>id!==asset.id)})}/>{asset.alt||'配图'}</label>):<p>请先在正文编辑器中上传配图。</p>}<button type="button" onClick={()=>{const next={...value};delete next[d.id];onChange(next);}}>移除此平台的备稿</button></>}</fieldset>;
 })}</details>;
}
