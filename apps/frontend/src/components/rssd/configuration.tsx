'use client';
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
type Api=(path:string,method?:string,data?:unknown)=>Promise<any>;

export function WorkspacePolicy({workspace,api,onSaved}:{workspace:Row;api:Api;onSaved:()=>Promise<void>}){
  const [draft,setDraft]=useState<Row>(structuredClone(workspace)),[destinations,setDestinations]=useState<Row[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setDraft(structuredClone(workspace));},[workspace]);
  useEffect(()=>{api('/destinations').then(setDestinations).catch(e=>setError(e.message));},[api]);
  const update=(index:number,key:string,value:unknown)=>setDraft(old=>({...old,sections:old.sections.map((s:Row,i:number)=>i===index?{...s,policy:{...s.policy,[key]:value}}:s)}));
  return <form className="ca-form ca-wide" onSubmit={event=>{event.preventDefault();setBusy(true);setError('');setNotice('');
    const next={...draft,sections:draft.sections.map((s:Row)=>({...s,policy:{...s.policy,version:s.policy.version+1}}))};
    api('/workspaces','POST',{workspace:next,baseRevision:workspace.revision}).then(async()=>{await onSaved();setNotice('栏目规则已保存，已认领的任务继续使用认领时的规则。');}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
    <h2>{workspace.name} · 栏目规则</h2><p>只选择本栏目需要发布的渠道。中文和英文分别配置。</p>
    {draft.sections.map((section:Row,index:number)=><fieldset key={section.id}><legend>{section.name}</legend>
      <label>写作要求<textarea rows={5} value={section.policy.instructions||''} onChange={e=>update(index,'instructions',e.target.value)}/></label>
      <label>品牌署名<input value={section.policy.brand?.name||''} onChange={e=>update(index,'brand',{...section.policy.brand,name:e.target.value})}/></label>
      <label>品牌网址<input type="url" value={section.policy.brand?.url||''} onChange={e=>update(index,'brand',{...section.policy.brand,url:e.target.value})}/></label>
      {destinations.filter(d=>d.workspaceIds.includes(workspace.id)).map(d=><div key={d.id}><strong>{d.name}{!d.enabled?'（已停用）':''}</strong>{['zh-CN','en'].map(locale=>{
        const checked=section.policy.targets.some((t:Row)=>t.destinationId===d.id&&t.locale===locale);
        return <label className="ca-check" key={locale}><input type="checkbox" checked={checked} onChange={e=>update(index,'targets',e.target.checked?[...section.policy.targets,{destinationId:d.id,locale}]:section.policy.targets.filter((t:Row)=>!(t.destinationId===d.id&&t.locale===locale)))}/>{locale==='en'?'英文':'中文'}</label>;
      })}</div>)}
    </fieldset>)}
    <fieldset><legend>添加栏目</legend><label>栏目名称<input name="newSectionName"/></label><label>栏目标识<input name="newSectionId" pattern="[a-zA-Z0-9][a-zA-Z0-9._:-]*"/></label>
      <button type="button" onClick={event=>{const form=event.currentTarget.form!,values=new FormData(form),id=String(values.get('newSectionId')||'').trim(),name=String(values.get('newSectionName')||'').trim();
        if(!id||!name||draft.sections.some((s:Row)=>s.id===id)){setError('填写新的栏目名称和唯一标识。');return;}
        setDraft(old=>({...old,sections:[...old.sections,{id,name,policy:{version:0,instructions:'',brand:{},targets:[]}}]}));
        (form.elements.namedItem('newSectionId') as HTMLInputElement).value='';(form.elements.namedItem('newSectionName') as HTMLInputElement).value='';}}>加入栏目</button>
    </fieldset>
    {error&&<p role="alert" className="cp-notice ca-error">{error}</p>}{notice&&<p role="status">{notice}</p>}<button className="cp-primary" disabled={busy}>保存栏目规则</button>
  </form>;
}
