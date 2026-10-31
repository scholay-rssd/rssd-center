'use client';
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
type Api=(path:string,method?:string,data?:unknown)=>Promise<any>;

export function WorkspacePolicy({workspace,api,onSaved}:{workspace:Row;api:Api;onSaved:()=>Promise<void>}){
  const [draft,setDraft]=useState<Row>(structuredClone(workspace)),[destinations,setDestinations]=useState<Row[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setDraft(structuredClone(workspace));},[workspace]);
  useEffect(()=>{api('/destinations').then(setDestinations).catch(e=>setError(e.message));},[api]);
  const update=(index:number,key:string,value:unknown)=>setDraft(old=>({...old,sections:old.sections.map((s:Row,i:number)=>i===index?{...s,policy:{...s.policy,[key]:value}}:s)}));
  return <form className="rssd-form" onSubmit={event=>{event.preventDefault();setBusy(true);setError('');setNotice('');
    const next={...draft,sections:draft.sections.map((s:Row)=>({...s,policy:{...s.policy,version:s.policy.version+1}}))};
    api('/workspaces','POST',{workspace:next,baseRevision:workspace.revision}).then(async()=>{await onSaved();setNotice('栏目规则已保存，已认领的任务继续使用认领时的规则。');}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
    <h2>{workspace.name} · 栏目规则</h2><p>只选择本栏目需要发布的渠道。中文和英文分别配置。</p>
    {draft.sections.map((section:Row,index:number)=><fieldset key={section.id}><legend>{section.name}</legend>
      <label>写作要求<textarea rows={5} value={section.policy.instructions||''} onChange={e=>update(index,'instructions',e.target.value)}/></label>
      <label>品牌署名<input value={section.policy.brand?.name||''} onChange={e=>update(index,'brand',{...section.policy.brand,name:e.target.value})}/></label>
      <label>品牌网址<input type="url" value={section.policy.brand?.url||''} onChange={e=>update(index,'brand',{...section.policy.brand,url:e.target.value})}/></label>
      {destinations.filter(d=>d.workspaceIds.includes(workspace.id)).map(d=><div key={d.id}><strong>{d.name}{!d.enabled?'（已停用）':''}</strong>{['zh-CN','en'].map(locale=>{
        const checked=section.policy.targets.some((t:Row)=>t.destinationId===d.id&&t.locale===locale);
        return <label className="rssd-checkbox" key={locale}><input type="checkbox" checked={checked} onChange={e=>update(index,'targets',e.target.checked?[...section.policy.targets,{destinationId:d.id,locale}]:section.policy.targets.filter((t:Row)=>!(t.destinationId===d.id&&t.locale===locale)))}/>{locale==='en'?'英文':'中文'}</label>;
      })}</div>)}
    </fieldset>)}
    <fieldset><legend>添加栏目</legend><label>栏目名称<input name="newSectionName"/></label><label>栏目标识<input name="newSectionId" pattern="[a-zA-Z0-9][a-zA-Z0-9._:-]*"/></label>
      <button type="button" onClick={event=>{const form=event.currentTarget.form!,values=new FormData(form),id=String(values.get('newSectionId')||'').trim(),name=String(values.get('newSectionName')||'').trim();
        if(!id||!name||draft.sections.some((s:Row)=>s.id===id)){setError('填写新的栏目名称和唯一标识。');return;}
        setDraft(old=>({...old,sections:[...old.sections,{id,name,policy:{version:0,instructions:'',brand:{},targets:[]}}]}));
        (form.elements.namedItem('newSectionId') as HTMLInputElement).value='';(form.elements.namedItem('newSectionName') as HTMLInputElement).value='';}}>加入栏目</button>
    </fieldset>
    {error&&<p role="alert" className="rssd-error">{error}</p>}{notice&&<p role="status">{notice}</p>}<button className="rssd-primary" disabled={busy}>保存栏目规则</button>
  </form>;
}

export function DestinationSettings({workspaces,api}:{workspaces:Row[];api:Api}){
  const [rows,setRows]=useState<Row[]>([]),[selected,setSelected]=useState<Row|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const refresh=()=>api('/destinations').then(setRows);
  useEffect(()=>{refresh().catch(e=>setError(e.message));},[api]);
  return <div><div className="rssd-toolbar"><p>站点接收的内容范围由栏目规则决定。</p><button onClick={()=>{setSelected({id:'',workspaceIds:[],config:{}});setNotice('');}}>连接自家站点</button></div>
    {error&&<p role="alert" className="rssd-error">{error}</p>}{notice&&<p role="status" className="rssd-message">{notice}</p>}
    {selected&&<form className="rssd-form" key={selected.id||'new'} autoComplete="off" onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);setBusy(true);setError('');
      api('/destinations','POST',{id:v.get('id'),name:v.get('name'),kind:'site',workspaceIds:v.getAll('workspaces'),config:{origin:v.get('origin'),siteId:v.get('siteId')},token:v.get('token')||undefined,enabled:v.get('enabled')==='on'})
        .then(async()=>{await refresh();setSelected(null);setNotice('站点连接已保存。请在工作空间的栏目规则中选择发布语言与目的地。');}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
      <h2>{selected.id?'编辑站点连接':'连接自家站点'}</h2><label>连接名称<input name="name" required defaultValue={selected.name}/></label>
      <label>连接标识<input name="id" required readOnly={Boolean(selected.id)} defaultValue={selected.id}/></label>
      <label>站点网址<input type="url" name="origin" required readOnly={Boolean(selected.id)} defaultValue={selected.config.origin}/></label>
      <label>站点标识<input name="siteId" required readOnly={Boolean(selected.id)} defaultValue={selected.config.siteId}/></label>
      <label>站点接收凭据<input type="password" name="token" required={!selected.hasCredential} placeholder={selected.hasCredential?'留空保留已有凭据':''} autoComplete="new-password"/></label>
      <fieldset><legend>允许发布的工作空间</legend>{workspaces.map(w=><label className="rssd-checkbox" key={w.id}><input type="checkbox" name="workspaces" value={w.id} defaultChecked={selected.workspaceIds.includes(w.id)}/>{w.name}</label>)}</fieldset>
      <label className="rssd-checkbox"><input type="checkbox" name="enabled" defaultChecked={selected.enabled}/>启用此站点的内容发布</label>
      <div className="rssd-form-actions"><button type="button" onClick={()=>setSelected(null)}>取消</button><button className="rssd-primary" disabled={busy}>保存连接</button></div>
    </form>}
    <div className="rssd-list">{rows.map(row=><article className="rssd-row" key={row.id}><div><h2>{row.name}</h2><p>{row.config.origin}</p></div><span>{row.enabled?'已启用':'已停用'}</span><button onClick={()=>setSelected(row)}>编辑</button></article>)}</div>
    <p className="rssd-footer">现有社交平台账号继续在渠道页面管理；RSSD 需求管线的外部平台连接器仍在接入。</p>
  </div>;
}
