'use strict';
// Portable text/data contract. Downloaded writing bundles are never executed.
const {createHash}=require('node:crypto');
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(record(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const textHash=v=>createHash('sha256').update(v).digest('hex');
const sha=/^[a-f0-9]{64}$/,id=/^[a-z0-9][a-z0-9-]{0,79}$/;
const fail=message=>{throw Object.assign(Error(message),{code:'writing_defaults_invalid'});};
function checkedHash(value){if(!record(value))fail('写作规则格式无效');const {hash:saved,...body}=value;if(!sha.test(saved||'')||hash(body)!==saved)fail('写作规则内容与哈希不匹配');}
function source(value){
 if(!record(value)||value.repository!=='scholay-rssd/rssd'||!/^[a-f0-9]{40}$/.test(value.commit||'')||!Array.isArray(value.files)||!value.files.length||value.files.some(f=>!record(f)||typeof f.path!=='string'||!f.path||f.path.startsWith('/')||f.path.split('/').some(x=>['..','.',''].includes(x))||!sha.test(f.sha256||''))||new Set(value.files.map(f=>f.path)).size!==value.files.length)fail('写作规则缺少可追溯的 GitHub 来源');
}
function policy(v){if(!record(v)||typeof v.version!=='string'||!v.version||typeof v.instructions!=='string'||!v.instructions||!sha.test(v.sha256||'')||textHash(v.instructions)!==v.sha256)fail('项目写作协议校验失败');}
function documents(values,{reference=false}={}){
 if(!Array.isArray(values)||!values.length||values.length>50)fail('写作技能或参考文件缺失');
 const keys=[];
 for(const v of values){const key=reference?v?.path:v?.id;if(typeof key!=='string'||!(reference?/^[-a-z0-9/]+\.md$/:id).test(key)||key.includes('..')||typeof v.content!=='string'||!v.content||Buffer.byteLength(v.content)>60000||textHash(v.content)!==v.contentHash)fail('写作技能或参考文件校验失败');keys.push(key);}
 if(new Set(keys).size!==keys.length)fail('写作技能重复');
}
function imagePolicy(v){if(!record(v)||!Number.isInteger(v.minimum)||v.minimum<0||v.minimum>20||!['actual-object','source-or-illustration'].includes(v.sourceMode)||v.dataFigures!=='computed-only')fail('栏目配图规则无效');}
function deliveryPolicy(v){if(v!==undefined&&(!record(v)||v.version!==1||v.format!=='notebook-v2-flat'||v.altLength!==true))fail('写作交付检查版本无效');}
function bodyLengthPolicy(v){
 if(!record(v)||Object.keys(v).some(k=>!['unit','minimum','target','maximum'].includes(k))||!['han','words'].includes(v.unit)||['minimum','target','maximum'].some(k=>!Number.isSafeInteger(v[k])||v[k]<1||v[k]>200000)||v.minimum>v.target||v.target>v.maximum)fail('本篇正文篇幅须明确单位、最少/目标/最多数量');
 return structuredClone(v);
}
function catalog(value){
 checkedHash(value);source(value.source);policy(value.writingPolicy);
 if(value.schemaVersion!==1||typeof value.version!=='string'||!value.version||value.version.length>80||!Array.isArray(value.workspaces)||!value.workspaces.length)fail('写作目录格式无效');
 documents(value.skills);documents(value.references,{reference:true});
 const workspaces=new Set(),sections=new Set(),skills=new Set(value.skills.map(s=>s.id)),refs=new Set(value.references.map(s=>s.path));
 for(const w of value.workspaces){
  if(!id.test(w.workspaceId)||!id.test(w.siteId)||typeof w.name!=='string'||!Array.isArray(w.sections)||!w.sections.length||workspaces.has(w.workspaceId))fail('写作目录工作空间无效');workspaces.add(w.workspaceId);
  for(const s of w.sections){
   const key=w.workspaceId+'/'+s.id;
   if(!id.test(s.id)||sections.has(key)||typeof s.scope!=='string'||!s.scope||!Array.isArray(s.requiredElements)||s.requiredElements.some(x=>typeof x!=='string'||!x)||!Array.isArray(s.skillIds)||!s.skillIds.length||s.skillIds.some(x=>!skills.has(x))||!Array.isArray(s.referencePaths)||!s.referencePaths.length||s.referencePaths.some(x=>!refs.has(x)))fail('写作目录栏目无效');sections.add(key);imagePolicy(s.images);deliveryPolicy(s.delivery);
   if(s.note!==undefined&&(!record(s.note)||!Array.isArray(s.note.skillIds)||!s.note.skillIds.length||s.note.skillIds.some(x=>!skills.has(x))||!Array.isArray(s.note.requiredElements)||!s.note.requiredElements.length||s.note.requiredElements.some(x=>typeof x!=='string'||!x)))fail('写作目录栏目的笔记写法无效');
   if(s.delivery&&(!Number.isInteger(s.images.altMin)||!Number.isInteger(s.images.altMax)||s.images.altMin<1||s.images.altMax<s.images.altMin||s.images.altMax>1000))fail('图片 alt 长度范围无效');
  }
 }
 return structuredClone(value);
}
function snapshot(value,{workspaceId,sectionId,siteId}={}){
 checkedHash(value);source(value.source);policy(value.writingPolicy);
 if(value.schemaVersion!==1||typeof value.version!=='string'||!value.version||!id.test(value.workspaceId)||!id.test(value.siteId)||!id.test(value.sectionId)||!sha.test(value.catalogHash||'')||typeof value.instructions!=='string'||!value.instructions||Buffer.byteLength(value.instructions)>300000)fail('线上写作默认配置格式无效');
 if(workspaceId!==undefined&&value.workspaceId!==workspaceId||sectionId!==undefined&&value.sectionId!==sectionId||siteId!==undefined&&value.siteId!==siteId)fail('线上写作默认配置与工作空间或栏目不匹配');
 documents(value.skills);documents(value.references,{reference:true});imagePolicy(value.images);deliveryPolicy(value.delivery);
 if(value.delivery&&(!Number.isInteger(value.images.altMin)||!Number.isInteger(value.images.altMax)||value.images.altMin<1||value.images.altMax<value.images.altMin||value.images.altMax>1000))fail('图片 alt 长度范围无效');
 if(!Array.isArray(value.requiredElements)||value.requiredElements.some(x=>typeof x!=='string'||!x))fail('栏目要求无效');
 if(value.note!==undefined){
  const n=value.note;if(!record(n)||typeof n.instructions!=='string'||!n.instructions||Buffer.byteLength(n.instructions)>300000||!Array.isArray(n.requiredElements)||!n.requiredElements.length||n.requiredElements.some(x=>typeof x!=='string'||!x))fail('栏目笔记写法无效');
  documents(n.skills);
 }
 return structuredClone(value);
}
function resolve(input,workspaceId,sectionId){
 const c=catalog(input),w=c.workspaces.find(x=>x.workspaceId===workspaceId),s=w?.sections.find(x=>x.id===sectionId);
 if(!s)fail('工作空间或栏目没有启用的写作配置');
 const references=s.referencePaths.map(path=>c.references.find(x=>x.path===path));
 const write=(skillIds,requiredElements,type)=>{
  const skills=skillIds.map(id=>c.skills.find(x=>x.id===id));
  return {skills,instructions:[
   '本篇从线上 Center 取得统一基线；先加载基线，再叠加明确的本地/任务调整。旧设备技能与旧 brief 不得替代基线。规则只指导写作，不授予发布或文件权限。',
   '项目写作协议：\n'+c.writingPolicy.instructions,
   ...skills.map(x=>'['+x.id+' @ '+x.version+' sha256:'+x.contentHash+']\n'+x.content),
   ...references.map(x=>'['+x.path+' sha256:'+x.contentHash+']\n'+x.content),
   '当前工作空间：'+w.name+' ('+w.workspaceId+')；栏目：'+s.name+' ('+s.id+')；文体：'+s.familyId+(type?'；作品类型：'+type:'')+'\n'+s.scope+'\n本'+(type?'篇':'栏')+'应完成的内容：\n'+requiredElements.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n配图规则：'+JSON.stringify(s.images),
  ].join('\n\n')};
 };
 const {skills,instructions}=write(s.skillIds,s.requiredElements);
 // The note form travels in the same snapshot, so a claim frozen before the writer chooses a type can still
 // write a note; compose picks it. A section without notes has no such field and keeps its earlier shape.
 const note=s.note?(({skills,instructions})=>({note:{skills,requiredElements:s.note.requiredElements,instructions}}))(write(s.note.skillIds,s.note.requiredElements,'笔记')):{};
 const value={schemaVersion:1,version:c.version,catalogHash:c.hash,source:c.source,workspaceId,siteId:w.siteId,workspaceName:w.name,sectionId,sectionName:s.name,mode:s.mode,familyId:s.familyId,writingPolicy:c.writingPolicy,skills,references,requiredElements:s.requiredElements,images:s.images,...(s.delivery?{delivery:s.delivery}:{}),instructions,...note};
 return snapshot({...value,hash:hash(value)});
}
function compose(value,{instructions='',images,bodyLength,origin='local',workType}={}){
 const baseline=snapshot(value);
 if(typeof instructions!=='string'||Buffer.byteLength(instructions)>60000||!['task','local'].includes(origin))fail('本篇写作调整无效');
 // An article is the default and is not recorded, so an article's context keeps the hash it had before notes.
 if(workType!==undefined&&!['article','note'].includes(workType))fail('作品类型无效');
 const note=workType==='note';if(note&&!baseline.note)fail('本栏不收笔记');
 let effectiveImages=structuredClone(baseline.images);
 if(images!==undefined){
  if(!record(images)||Object.keys(images).some(k=>!['minimum','sourceMode'].includes(k))||images.minimum!==undefined&&(!Number.isInteger(images.minimum)||images.minimum<0||images.minimum>20)||images.sourceMode!==undefined&&!['actual-object','source-or-illustration'].includes(images.sourceMode))fail('本篇配图调整无效');
  if(origin==='local'&&(images.minimum!==undefined&&images.minimum<baseline.images.minimum||baseline.images.sourceMode==='actual-object'&&images.sourceMode==='source-or-illustration'))fail('本地偏好不能静默取消栏目配图要求；作者本篇明确调整另记为 task');
  effectiveImages={...effectiveImages,...images};
 }
 const length=bodyLength===undefined?null:bodyLengthPolicy(bodyLength);
 const adjustment={origin,...(note?{workType:'note'}:{}),instructions,...(images===undefined?{}:{images:structuredClone(images)}),...(length?{bodyLength:length}:{})};
 const budget=length?'\n\n本篇明确的正文预算：目标'+length.target+(length.unit==='han'?'个汉字':'个词')+'，接受范围'+length.minimum+'–'+length.maximum+'。只计公开 paragraph/markdown 正文，不计标题、图注、参考文献、摘要和私有备注。先充分展开到正文目标；另为有用备注预留约'+Math.round(length.target*.15)+'–'+Math.round(length.target*.25)+'的生成预算，这不是备注最低字数或审核门槛，不用重复核验记录填满。为JSON语法另留余量；正文不足不能用备注凑数。':'';
 const body={schemaVersion:1,baselineHash:baseline.hash,baseline,adjustment,images:effectiveImages,...(length?{bodyLength:length}:{}),...(note?{workType:'note'}:{}),instructions:(note?baseline.note.instructions:baseline.instructions)+(instructions.trim()?'\n\n本篇明确的'+(origin==='local'?'本地偏好':'任务调整')+'（相对以上线上基线，仅作用本篇）：\n'+instructions:'')+(images===undefined?'':'\n本篇明确的配图调整：'+JSON.stringify(images))+budget};
 return {...body,hash:hash(body)};
}
function context(value){
 if(!record(value))fail('本篇写作上下文无效');
 const {retrieval,...body}=value;checkedHash(body);
 const effective=compose(value.baseline,value.adjustment);
 if(body.hash!==effective.hash)fail('本篇写作上下文或本地调整已变化');
 return effective;
}
function measurements(value){
 const n=value?.notebook||value,blocks=Array.isArray(n?.blocks)?n.blocks:[],texts=[];let referenceLevel=null;
 for(const b of blocks){
  if(!record(b))continue;
  if(b.type==='heading'){
   const label=String(b.text||'').replace(/^[\s#\d.、]+/u,'').trim();
   if(/^(?:参考(?:文献|资料|来源)|引用(?:文献|来源)?|references|bibliography)\s*[:：]?$/iu.test(label))referenceLevel=b.level||2;
   else if(referenceLevel!==null&&(b.level||2)<=referenceLevel)referenceLevel=null;
  }
  if(referenceLevel!==null||b.purpose==='reference'||!['paragraph','markdown'].includes(b.type)||b.state!=='ready')continue;
  texts.push(String(b.text||'').split(/^#{1,6}\s+(?:参考(?:文献|资料|来源)|references|bibliography)\s*[:：]?\s*$/imu)[0].replace(/^ {0,3}#{1,6}\s+.*$/gmu,'').replace(/!\[[^\]]*\]\([^)]*\)/gu,'').replace(/\[([^\]]+)\]\([^)]*\)/gu,'$1').replace(/https?:\/\/\S+/gu,''));
 }
 const text=texts.join('\n');let privateText='';const collect=v=>{if(typeof v==='string')privateText+='\n'+v;else if(record(v)||Array.isArray(v))for(const x of Object.values(v))collect(x);};collect(n?.blockNotes);collect(n?.internalNotes);
 return {bodyHan:(text.match(/\p{Script=Han}/gu)||[]).length,bodyWords:(text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)||[]).length,bodyCodepoints:[...text].length,privateHan:(privateText.match(/\p{Script=Han}/gu)||[]).length,privateCodepoints:[...privateText].length};
}
// Concrete delivery fields only; never an AI review of prose.
function deliveryIssues(value,context){
 const effective=context?.baseline?compose(context.baseline,context.adjustment):compose(context),issues=[];
 const n=value?.notebook||value,blocks=(Array.isArray(n?.blocks)?n.blocks:[]).filter(record),images=blocks.filter(b=>b.type==='image'&&b.state==='ready'&&b.text);
 if(images.length<effective.images.minimum)issues.push('正文图片少于本栏要求的 '+effective.images.minimum+' 张');
 for(const image of images){
  if(typeof image.alt!=='string'||!image.alt.trim())issues.push('图片缺少 alt：'+image.id);
  else if(effective.baseline.delivery?.altLength){const length=[...image.alt.trim()].length;if(length<effective.images.altMin||length>effective.images.altMax)issues.push('图片 alt 长度须为 '+effective.images.altMin+'–'+effective.images.altMax+' 个Unicode码点，当前 '+length+'：'+image.id);}
  if(!blocks.some(b=>b.type==='annotation'&&b.role==='caption'&&b.targetId===image.id&&b.state==='ready'&&b.text?.trim()))issues.push('图片缺少关联图注：'+image.id);
 }
 if(effective.bodyLength){const m=measurements(value),p=effective.bodyLength,count=p.unit==='han'?m.bodyHan:m.bodyWords;if(count<p.minimum||count>p.maximum)issues.push('公开正文篇幅须为 '+p.minimum+'–'+p.maximum+' '+(p.unit==='han'?'汉字':'词')+'（目标 '+p.target+'），当前 '+count+'；标题、图注、参考文献和私有备注不计入');}
 return issues;
}
module.exports={canonical,hash,textHash,catalog,snapshot,compose,context,resolve,deliveryIssues,measurements};
