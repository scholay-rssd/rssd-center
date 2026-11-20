'use client';
// The owner's side of persona voices (rssd/MOUNTS.md): the persona library in settings, and in a section's
// rules how a new work gets the persona that writes it and whose name signs it.
import {useCallback,useEffect,useState} from 'react';
type Row=Record<string,any>;
type Api=(path:string,method?:string,data?:unknown)=>Promise<any>;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** How a section gets its persona. `persona` is the earlier byline-only setting, kept only where a section has it. */
export type VoiceMode='none'|'persona'|'fixed'|'choose'|'random'|'balanced';
export const VOICE_MODE_NAMES:Record<VoiceMode,string>={none:'不用人格，署站点名',persona:'只署名（旧设置）',fixed:'固定一位人格',choose:'写作方按题目从范围里挑选',random:'中心随机抽取',balanced:'中心轮换，优先用得最少的'};
export const voiceModeOf=(policy:Row):VoiceMode=>policy?.voice?.mode||(policy?.persona?'persona':'none');

/** The section policy with its voice set as the form describes it. Every other rule of the policy is kept. */
export function withVoice(policy:Row,form:{mode:VoiceMode;persona?:string;range?:'all'|string[];fallback?:string;byline?:'persona'|'site'}):Row{
  const {voice:_v,persona:_p,...rest}=policy;
  if(form.mode==='none')return rest;
  if(form.mode==='persona')return {...rest,...(policy.persona?{persona:policy.persona}:{})};
  const byline=form.byline||'persona';
  if(form.mode==='fixed')return {...rest,voice:{mode:'fixed',persona:form.persona||'',byline}};
  return {...rest,voice:{mode:form.mode,range:form.range||'all',...(form.fallback?{fallback:form.fallback}:{}),byline}};
}

/** What is wrong with a section's voice, or ''. Checked before the rules are saved. */
export function voiceProblem(policy:Row):string{
  const voice=policy?.voice;if(!voice)return '';
  if(voice.mode==='fixed')return voice.persona?'':'选一位固定的人格。';
  if(Array.isArray(voice.range)&&!voice.range.length)return '范围里至少选一位人格，或者改成全部人格。';
  return '';
}

/** The library, in the form the section editor and the library page read: one row per persona. */
export function usePersonaLibrary(api:Api){
  const [personas,setPersonas]=useState<Row[]|null>(null),[error,setError]=useState('');
  const load=useCallback(()=>api('/mounts/personas').then((result:Row)=>{setPersonas(result.personas||[]);setError('');}).catch(e=>{setPersonas([]);setError(message(e));}),[api]);
  useEffect(()=>{void load();},[load]);
  return {personas,error,reload:load};
}

const label=(p:Row)=>p.id+(p.missing?'（库里没有）':p.active===false?'（已停用）':'');

/** One section's persona settings, inside the section's fieldset of the rules form. */
export function SectionVoice({section,personas,onChange}:{section:Row;personas:Row[];onChange:(policy:Row)=>void}){
  const policy=section.policy,mode=voiceModeOf(policy),voice=policy.voice||{};
  const byline:'persona'|'site'=voice.byline||'persona',range:'all'|string[]=voice.range||'all';
  const set=(change:Partial<{mode:VoiceMode;persona:string;range:'all'|string[];fallback:string;byline:'persona'|'site'}>)=>onChange(withVoice(policy,{mode,persona:voice.persona,range,fallback:voice.fallback,byline,...change}));
  // Only personas in use are offered; one the section already names stays listed, retired or missing, so the
  // owner sees it and can remove it.
  const active=personas.filter(p=>p.active!==false),offered=new Set(active.map(p=>p.id));
  const named=[...new Set([voice.persona,voice.fallback,...(Array.isArray(range)?range:[])].filter((id:any)=>id&&!offered.has(id)))] as string[];
  const options=[...active,...named.map(id=>personas.find(p=>p.id===id)||{id,missing:true,active:false})];
  const modes=(Object.keys(VOICE_MODE_NAMES) as VoiceMode[]).filter(m=>m!=='persona'||mode==='persona');
  return <div className="ca-stack" role="group" aria-label={section.name+'的人格'}>
    <label>人格<select value={mode} onChange={e=>set({mode:e.target.value as VoiceMode})}>{modes.map(m=><option key={m} value={m}>{VOICE_MODE_NAMES[m]}</option>)}</select></label>
    {mode==='persona'&&<small>这个栏目用的是旧设置：署名 {policy.persona?.name}（{policy.persona?.id}），不影响写法。改成其他方式后旧设置会被替换。</small>}
    {mode==='fixed'&&<label>固定的人格<select value={voice.persona||''} onChange={e=>set({persona:e.target.value})}><option value="">请选择</option>{options.map(p=><option key={p.id} value={p.id}>{label(p)}</option>)}</select></label>}
    {['choose','random','balanced'].includes(mode)&&<>
      <fieldset><legend>范围</legend>
        <label className="ca-check"><input type="radio" name={'range-'+section.id} checked={range==='all'} onChange={()=>set({range:'all'})}/>人格库里全部在用的人格，新加入的自动包括</label>
        <label className="ca-check"><input type="radio" name={'range-'+section.id} checked={Array.isArray(range)} onChange={()=>set({range:Array.isArray(range)?range:[]})}/>只用下面勾选的</label>
        {Array.isArray(range)&&options.map(p=><label className="ca-check" key={p.id}><input type="checkbox" checked={range.includes(p.id)} onChange={e=>set({range:e.target.checked?[...range,p.id]:range.filter(id=>id!==p.id)})}/>{label(p)}</label>)}
      </fieldset>
      <label>兜底人格<select value={voice.fallback||''} onChange={e=>set({fallback:e.target.value})}><option value="">不设：选不出时不用人格</option>{options.map(p=><option key={p.id} value={p.id}>{label(p)}</option>)}</select></label>
      {mode==='choose'&&<small>写作方动笔前从范围里看到最多 5 位候选的简介，按题目选一位并写明理由；没选出时用兜底人格。</small>}
    </>}
    {!['none','persona'].includes(mode)&&<>
      <label>署名<select value={byline} onChange={e=>set({byline:e.target.value as 'persona'|'site'})}><option value="persona">署人格的名字（所属创始人格的英文名）</option><option value="site">署站点名，人格只影响写法</option></select></label>
      {!active.length&&<small className="ca-error">人格库里没有在用的人格。先在“设置 → 人格库”上传人格，否则这个栏目的新作品不会用上人格。</small>}
    </>}
  </div>;
}

/** Up to 30 personas and well under the default body limit per request. */
export function uploadBatches(personas:Row[],{count=30,bytes=80000}:{count?:number;bytes?:number}={}):Row[][]{
  const batches:Row[][]=[];let current:Row[]=[],size=0;
  for(const item of personas){
    const length=JSON.stringify(item).length;
    if(current.length&&(current.length>=count||size+length>bytes)){batches.push(current);current=[];size=0;}
    current.push(item);size+=length;
  }
  if(current.length)batches.push(current);
  return batches;
}

const readText=(file:Blob)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsText(file);});

/** The sections that name a persona, by the persona's ID. */
function usedBy(registry:Row[]){
  const map=new Map<string,string[]>();
  for(const workspace of registry)for(const section of workspace.sections||[]){
    const voice=section.policy?.voice;if(!voice)continue;
    const where=workspace.name+' / '+section.name;
    const ids=voice.mode==='fixed'?[voice.persona]:[...(Array.isArray(voice.range)?voice.range:[]),...(voice.fallback?[voice.fallback]:[])];
    for(const id of new Set(ids))map.set(id,[...(map.get(id)||[]),where]);
  }
  const all=registry.flatMap(w=>(w.sections||[]).filter((s:Row)=>s.policy?.voice&&s.policy.voice.mode!=='fixed'&&(s.policy.voice.range==null||s.policy.voice.range==='all')).map((s:Row)=>w.name+' / '+s.name));
  return {named:map,all};
}

/** Settings → persona library: what the Center keeps, uploading the file `rssd center personas-export` writes, retiring. */
export function PersonaLibrary({api,registry}:{api:Api;registry:Row[]}){
  const {personas,error:loadError,reload}=usePersonaLibrary(api);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const {named,all}=usedBy(registry);
  const upload=async(file:File)=>{
    setBusy(true);setError('');setNotice('');
    try{
      let parsed:Row;try{parsed=JSON.parse(await readText(file));}catch{throw Error('这个文件不是 JSON。请选择 rssd center personas-export 生成的文件。');}
      if(parsed?.schemaVersion!=='rssd.persona-upload.v1'||!Array.isArray(parsed.personas)||!parsed.personas.length)throw Error('这个文件不是人格库的上传文件。请用 rssd center personas-export 生成。');
      const results:Row[]=[];
      for(const batch of uploadBatches(parsed.personas))results.push(...(await api('/mounts/personas','POST',{personas:batch})).personas);
      const created=results.filter(r=>r.status==='created').length;
      setNotice('已上传 '+results.length+' 个人格版本：新增 '+created+' 个，'+(results.length-created)+' 个已存在未改动。');
      await reload();
    }catch(e){setError(message(e));await reload();}
    finally{setBusy(false);}
  };
  const retire=async(row:Row,retired:boolean)=>{
    setBusy(true);setError('');setNotice('');
    try{await api('/mounts/personas/'+encodeURIComponent(row.id)+'/retire','POST',{retired});setNotice(row.id+(retired?' 已停用，新作品不再选它；已写完的作品不受影响。':' 已恢复。'));await reload();}
    catch(e){setError(message(e));}finally{setBusy(false);}
  };
  return <section aria-label="人格库">
    <div className="cp-section-heading"><div><h2>人格库</h2><p>写作时可以套用的人格。栏目在“工作空间 → 栏目规则”里选择怎么用。人格的内容只存在中心，写作设备每篇只拿到认领时定下的那一位。</p></div>
      <label className="cp-primary ca-inline">{busy?'正在上传…':'上传人格文件'}<input aria-label="上传人格文件" type="file" accept="application/json,.json" hidden disabled={busy} onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void upload(file);}}/></label></div>
    <p className="ca-note">上传文件用 <code>rssd center personas-export --library &lt;人格库目录&gt; --out &lt;文件&gt;</code> 生成。已存的版本不会被改写；人格有修改时要在人格库里升一个版本再上传。</p>
    {(error||loadError)&&<p role="alert" className="cp-notice ca-error">{error||loadError}</p>}
    {notice&&<p role="status" className="cp-notice">{notice}</p>}
    <div className="cp-table-wrap">
      <table className="cp-demands-table">
        <thead><tr><th>人格</th><th>署名</th><th>当前版本</th><th>使用的栏目</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{(personas||[]).map(row=><tr key={row.id}>
          <td><strong>{row.id}</strong><small>{row.summary?.core}</small></td>
          <td>{row.founder?.name}</td>
          <td>{row.revision}{row.revisions?.length>1&&<small>共 {row.revisions.length} 个版本</small>}</td>
          <td>{[...(named.get(row.id)||[]),...(row.active?all:[])].join('、')||'—'}</td>
          <td><span className="cp-state">{row.active?'在用':'已停用'}</span></td>
          <td><button className="cp-text-button" disabled={busy} onClick={()=>void retire(row,row.active)}>{row.active?'停用':'恢复'}</button></td>
        </tr>)}</tbody>
      </table>
      {personas&&!personas.length&&!loadError&&<div className="cp-empty"><h3>人格库是空的</h3><p>上传 personas-export 生成的文件后，人格会出现在这里。</p></div>}
      {!personas&&<div className="cp-empty"><h3>正在读取…</h3></div>}
    </div>
  </section>;
}
