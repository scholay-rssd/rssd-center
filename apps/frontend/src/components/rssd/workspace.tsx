'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import './workspace.css';
import {WorkspacePolicy,DestinationSettings} from './configuration';

const Editor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });
const names: Record<string,string> = {queued:'待领取',claimed:'进行中',blocked:'待处理',completed:'已交稿',cancelled:'已取消',idle:'空闲',running:'工作中',paused:'已暂停',revoked:'已撤销',accepted:'已接收',submitted:'已提交',verified:'已发布',failed:'失败',unknown:'待核实',draft_saved:'已存草稿'};
type Row = Record<string, any>;
type Tab = 'demands'|'works'|'publications'|'workers'|'settings'|'destinations';
class ApiError extends Error { constructor(message:string,public status:number,public code?:string){super(message);} }
const label = (state:string) => ({published:'已发布',dispatching:'正在分发',superseded:'已被新版替代'}[state] || names[state] || state);
const when = (value?:string) => value ? new Date(value).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '尚未连接';

export function RssdWorkspace() {
  const fetch = useFetch(), user=useUser();
  const [tab,setTab]=useState<Tab>('demands'),[registry,setRegistry]=useState<Row[]>([]),[space,setSpace]=useState('');
  const [rows,setRows]=useState<Row[]>([]),[search,setSearch]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[creating,setCreating]=useState(false);
  const [selected,setSelected]=useState<Row|null>(null),[language,setLanguage]=useState('zh-CN'),[title,setTitle]=useState(''),[body,setBody]=useState('');
  const [token,setToken]=useState(''),[pending,setPending]=useState<Row|null>(null);
  const [attachments,setAttachments]=useState<Row[]>([]);
  const requestGeneration=useRef(0);
  const active=registry.find(w=>w.id===space);
  const storageKey='rssd:pending:'+user?.orgId;
  const api=useCallback(async(path:string,method='GET',data?:unknown)=>{
    const response=await fetch('/rssd/v1'+path,{method,...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json().catch(()=>({message:'中心返回了无法读取的响应'}));
    if(!response.ok)throw new ApiError(result.message || '操作失败',response.status,result.code);
    return result;
  },[fetch]);
  const loadRegistry=useCallback(async()=>{
    const result=await api('/registry');setRegistry(result.workspaces);
    setSpace(current=>result.workspaces.some((w:Row)=>w.id===current)?current:result.workspaces[0]?.id||'');
  },[api]);
  const refresh=useCallback(async()=>{
    const generation=++requestGeneration.current;setLoading(true);
    try{
      const query=new URLSearchParams();if(space)query.set('workspaceId',space);if(search)query.set('search',search);
      const result=['settings','destinations'].includes(tab)?[]:await api('/'+tab+(tab==='workers'?'':'?'+query));
      if(generation===requestGeneration.current)setRows(result);
    }catch(err){if(generation===requestGeneration.current)setError((err as Error).message);}
    finally{if(generation===requestGeneration.current)setLoading(false);}
  },[api,tab,space,search]);
  useEffect(()=>{loadRegistry().catch(err=>setError(err.message));},[loadRegistry]);
  useEffect(()=>{const timeout=setTimeout(refresh,180);return()=>clearTimeout(timeout);},[refresh]);
  useEffect(()=>{try{const saved=sessionStorage.getItem(storageKey);setPending(saved?JSON.parse(saved):null);}catch{}},[storageKey]);
  const action=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(err){setError((err as Error).message);}finally{setBusy(false);}};
  const openWork=async(id:string)=>{
    const work=await api('/works/'+encodeURIComponent(id));setSelected(work);setCreating(false);
    const edition=work.editions.find((e:Row)=>e.locale===language)||work.editions[0];
    setLanguage(edition?.locale||'zh-CN');setTitle(edition?.payload.title||'');setBody(edition?.payload.bodyMarkdown||'');setAttachments(edition?.payload.media||[]);
  };
  const chooseLanguage=(locale:string)=>{
    const current=selected?.editions.find((e:Row)=>e.locale===language);
    if((title!==(current?.payload.title||'')||body!==(current?.payload.bodyMarkdown||''))&&!window.confirm('当前语言有未保存的修改，确定切换吗？'))return;
    const edition=selected?.editions.find((e:Row)=>e.locale===locale);setLanguage(locale);setTitle(edition?.payload.title||'');setBody(edition?.payload.bodyMarkdown||'');setAttachments(edition?.payload.media||[]);
  };
  const rememberPending=(value:Row|null)=>{setPending(value);if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);};
  const accepted=async(result:Row)=>{rememberPending(null);setNotice(result.status==='draft_saved'?'草稿已保存':'作品已接收，发布结果可在“发布记录”查看');await openWork(result.workId);await refresh();};
  const sendEdition=async(publish:boolean)=>{
    if(!selected)return;
    const previous=selected.editions.find((e:Row)=>e.locale===language);
    const packet={requestId:crypto.randomUUID(),workId:selected.id,workspaceId:selected.workspaceId,sectionId:selected.sectionId,
      baseRevisions:{[language]:previous?.revision||0},editions:[{...(previous?.payload||{}),locale:language,title,bodyMarkdown:body,media:attachments}]};
    const request={path:publish?'/submissions':'/drafts',packet};rememberPending(request);
    try{await accepted(await api(request.path,'POST',packet));}
    catch(err){if(err instanceof ApiError&&err.status<500)rememberPending(null);throw err;}
  };
  const recover=async()=>{
    if(!pending)return;
    try{await accepted(await api('/submissions/'+encodeURIComponent(pending.packet.requestId)));}
    catch(err){if(err instanceof ApiError&&err.status===404)await accepted(await api(pending.path,'POST',pending.packet));else throw err;}
  };
  const create=async(form:HTMLFormElement)=>{
    const values=new FormData(form);
    if(tab==='demands'){
      await api('/demands','POST',{workspaceId:space,sectionId:values.get('section'),kind:'write',title:values.get('title'),brief:values.get('brief'),requiredLocales:values.get('languages')==='both'?['zh-CN','en']:[values.get('languages')]});
      setNotice('需求已加入清单');
    }else if(tab==='workers'){
      const worker=await api('/workers','POST',{name:values.get('name'),workspaceIds:values.getAll('spaces')});setToken(worker.token);
    }else if(tab==='settings'){
      const id=values.get('id') as string;
      await api('/workspaces','POST',{baseRevision:0,workspace:{id,name:values.get('name'),siteId:values.get('siteId')||null,sections:[{id:values.get('sectionId'),name:values.get('sectionName'),policy:{version:1,instructions:values.get('instructions')||'',targets:[]}}]}});
      await loadRegistry();setSpace(id);setNotice('工作空间已建立，可配置栏目与发布渠道后投入生产');
    }
    setCreating(false);await refresh();
  };
  const newWork=(form:HTMLFormElement)=>{
    const values=new FormData(form);setSelected({id:crypto.randomUUID(),workspaceId:space,sectionId:values.get('section'),editions:[]});
    setLanguage(values.get('language') as string);setTitle('');setBody('');setAttachments([]);setCreating(false);
  };
  const upload=async(file:File)=>{
    if(!selected)return;if(file.size>20*1024*1024)throw Error('配图不能超过 20 MiB');
    const bytes=await file.arrayBuffer(),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file);});
    const result=await api('/media','POST',{workspaceId:selected.workspaceId,sha256,mime:file.type,bytes:file.size,data,name:file.name});
    setAttachments(old=>[...old.filter(m=>m.id!==result.id),{id:result.id,alt:file.name}]);setBody(old=>old+'\n\n!['+file.name.replace(/[\[\]\\\n\r]/g,' ')+']('+result.url+')\n');setNotice('配图已保存到中心，保存文章后会保留引用');
  };
  return <section className="rssd-workspace">
    <header className="rssd-header"><div><div className="rssd-overline">RSSD / 内容生产</div><h1>工作中心</h1></div>
      <div className="rssd-header-actions"><label className="rssd-sr-only" htmlFor="rssd-space">工作空间</label><select id="rssd-space" value={space} onChange={e=>{setSpace(e.target.value);setSelected(null);}}><option value="">全部工作空间</option>{registry.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select><button onClick={()=>void refresh()} disabled={loading}>刷新</button></div></header>
    <nav className="rssd-tabs" aria-label="中心功能">{([['demands','需求池'],['works','作品库'],['publications','发布记录'],['workers','执行设备'],['destinations','发布渠道'],['settings','工作空间']] as [Tab,string][]).map(([id,name])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>{setTab(id);setCreating(false);setSelected(null);setError('');setSearch('');}}>{name}</button>)}</nav>
    {error&&<div role="alert" className="rssd-message rssd-error">{error}</div>}
    {notice&&<div role="status" className="rssd-message">{notice}</div>}
    {pending&&<div role="status" className="rssd-message">上次提交的结果尚未确认，原稿与请求已保留。<button disabled={busy} onClick={()=>void action(recover)}>查询并恢复原提交</button></div>}
    {tab!=='destinations'&&<div className="rssd-toolbar"><label className="rssd-search"><span>查找</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={tab==='works'?'作品标题或语言':'需求标题'} disabled={!['demands','works'].includes(tab)}/></label>
      {tab!=='publications'&&<button className="rssd-primary" disabled={busy||Boolean(pending)||(!space&&['demands','works'].includes(tab))} onClick={()=>{setCreating(true);setSelected(null);setToken('');}}>{tab==='demands'?'新建需求':tab==='works'?'新建作品':tab==='workers'?'连接设备':'新建工作空间'}</button>}</div>}
    {tab==='destinations'&&<DestinationSettings workspaces={registry} api={api}/>}
    {tab==='settings'&&active&&!creating&&<WorkspacePolicy key={active.id} workspace={active} api={api} onSaved={loadRegistry}/>}
    {creating&&<form className="rssd-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;if(tab==='works')newWork(form);else void action(()=>create(form));}}>
      <h2>{tab==='demands'?'把需要完成的内容放进需求池':tab==='works'?'创建一件作品':tab==='workers'?'为执行设备生成连接凭据':'建立工作空间'}</h2>
      {['demands','works'].includes(tab)&&<label>栏目<select name="section" required>{active?.sections.map((s:Row)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      {tab==='demands'&&<><label>选题<input name="title" required maxLength={500}/></label><label>写作要求<textarea name="brief" rows={5}/></label><label>需要的语言<select name="languages"><option value="both">中文与英文</option><option value="zh-CN">仅中文</option><option value="en">仅英文</option></select></label></>}
      {tab==='works'&&<label>首先编辑的语言<select name="language"><option value="zh-CN">中文</option><option value="en">English</option></select></label>}
      {tab==='workers'&&<><label>设备名称<input name="name" required placeholder="例如：Mac mini"/></label><fieldset><legend>允许处理的工作空间</legend>{registry.map(w=><label className="rssd-checkbox" key={w.id}><input type="checkbox" name="spaces" value={w.id} defaultChecked={w.id===space}/>{w.name}</label>)}</fieldset></>}
      {tab==='settings'&&<><label>名称<input name="name" required/></label><label>稳定标识<input name="id" required pattern="[a-zA-Z0-9][a-zA-Z0-9._:-]*"/></label><label>对应站点标识<input name="siteId"/></label><label>首个栏目名称<input name="sectionName" required/></label><label>首个栏目标识<input name="sectionId" required/></label><label>写作要求<textarea name="instructions" rows={5}/></label></>}
      <div className="rssd-form-actions"><button type="button" onClick={()=>setCreating(false)}>取消</button><button className="rssd-primary" disabled={busy}>创建</button></div>
    </form>}
    {token&&<div className="rssd-message"><strong>连接凭据只显示这一次</strong><p>复制到对应设备的 RSSD 中心设置中。</p><input aria-label="设备连接凭据" readOnly type="password" value={token}/><button onClick={()=>void navigator.clipboard.writeText(token).then(()=>setNotice('连接凭据已复制')).catch(()=>setError('复制失败，请选择后复制'))}>复制凭据</button><button onClick={()=>setToken('')}>关闭</button></div>}
    {!creating&&selected&&tab==='works'?<div className="rssd-editor"><div className="rssd-editor-toolbar"><button onClick={()=>setSelected(null)}>返回作品库</button><div><button aria-pressed={language==='zh-CN'} onClick={()=>chooseLanguage('zh-CN')}>中文</button><button aria-pressed={language==='en'} onClick={()=>chooseLanguage('en')}>English</button></div><span>版本 {selected.editions.find((e:Row)=>e.locale===language)?.revision||0}</span><button disabled={busy||Boolean(pending)||!title.trim()||!body.trim()} onClick={()=>void action(()=>sendEdition(false))}>保存草稿</button><button className="rssd-primary" disabled={busy||Boolean(pending)||!title.trim()||!body.trim()} onClick={()=>void action(()=>sendEdition(true))}>提交发布</button></div>
      <input className="rssd-title-input" aria-label="文章标题" placeholder="文章标题" value={title} onChange={e=>setTitle(e.target.value)} disabled={busy||Boolean(pending)}/>
      <label>插入配图<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy||Boolean(pending)} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void action(()=>upload(file));}}/></label>
      <Editor value={body} onChange={value=>setBody(value||'')} height={560} previewOptions={{skipHtml:true}} textareaProps={{'aria-label':'文章正文',disabled:busy||Boolean(pending)}}/>
    </div>:!creating&&tab!=='destinations'&&<div className="rssd-list" aria-busy={loading}>
      {tab==='settings'?registry.map(w=><article className="rssd-row" key={w.id}><div><h2>{w.name}</h2><p>{w.sections.map((s:Row)=>s.name).join(' · ')}</p></div><span>{w.siteId||'尚未关联站点'}</span></article>):rows.length?rows.map(row=><article className="rssd-row" key={row.id}>
        <div className="rssd-row-main"><h2>{tab==='works'?<button className="rssd-work-link" onClick={()=>void action(()=>openWork(row.id))}>{row.editions[0]?.title||'未命名作品'}</button>:row.title||row.name||row.workId}</h2><p>{tab==='demands'?active?.sections.find((s:Row)=>s.id===row.sectionId)?.name||row.sectionId:tab==='works'?row.editions.map((e:Row)=>`${e.locale} · v${e.revision}`).join(' / '):tab==='workers'?row.details?.message||row.workspaceIds.join(' · '):`${row.locale} · v${row.revision} → ${row.destinationId}`}</p>{row.error&&<p className="rssd-error">{row.error}</p>}</div>
        {row.state&&<span className={'rssd-state rssd-state-'+row.state}>{label(row.state)}</span>}<time>{when(row.heartbeatAt||row.updatedAt||row.createdAt)}</time>
        {tab==='demands'&&['claimed','blocked'].includes(row.state)&&<button disabled={busy} onClick={()=>void action(async()=>{await api('/demands/'+row.id,'PATCH',{action:'release'});await refresh();})}>释放认领</button>}
        {tab==='workers'&&!row.revokedAt&&<button disabled={busy} onClick={()=>void action(async()=>{await api('/workers/'+row.id+'/revoke','POST',{});await refresh();})}>撤销连接</button>}
        {tab==='publications'&&row.state==='blocked'&&<button disabled={busy} onClick={()=>void action(async()=>{await api('/publications/'+row.id+'/retry','POST',{});await refresh();})}>恢复原发布</button>}
        {tab==='publications'&&row.state==='published'&&row.receipt?.url&&/^https?:\/\//.test(row.receipt.url)&&<a href={row.receipt.url} target="_blank" rel="noreferrer">查看成品</a>}
      </article>):<div className="rssd-empty"><h2>{loading?'正在读取…':tab==='demands'?'需求池里还没有任务':tab==='works'?'还没有作品':tab==='workers'?'尚未连接执行设备':'暂无发布记录'}</h2><p>{tab==='demands'?'添加选题后，在 PC 或无头版开启工作模式。':tab==='works'?'作品可以从生产设备提交，也可以在这里创建。':tab==='workers'?'连接凭据按工作空间授权，智能体账号留在设备上。':'提交作品后，各个目的地的结果会分别记录在这里。'}</p></div>}
    </div>}
    <footer className="rssd-footer"><a href="https://github.com/scholay-rssd/rssd-center" target="_blank" rel="noreferrer">RSSD 中心源码 · AGPL-3.0</a><span>基于 Postiz</span></footer>
  </section>;
}
