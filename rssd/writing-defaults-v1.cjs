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
function catalog(value){
 checkedHash(value);source(value.source);policy(value.writingPolicy);
 if(value.schemaVersion!==1||typeof value.version!=='string'||!value.version||value.version.length>80||!Array.isArray(value.workspaces)||!value.workspaces.length)fail('写作目录格式无效');
 documents(value.skills);documents(value.references,{reference:true});
 const workspaces=new Set(),sections=new Set(),skills=new Set(value.skills.map(s=>s.id)),refs=new Set(value.references.map(s=>s.path));
 for(const w of value.workspaces){
  if(!id.test(w.workspaceId)||!id.test(w.siteId)||typeof w.name!=='string'||!Array.isArray(w.sections)||!w.sections.length||workspaces.has(w.workspaceId))fail('写作目录工作空间无效');workspaces.add(w.workspaceId);
  for(const s of w.sections){
   const key=w.workspaceId+'/'+s.id;
   if(!id.test(s.id)||sections.has(key)||typeof s.scope!=='string'||!s.scope||!Array.isArray(s.requiredElements)||s.requiredElements.some(x=>typeof x!=='string'||!x)||!Array.isArray(s.skillIds)||!s.skillIds.length||s.skillIds.some(x=>!skills.has(x))||!Array.isArray(s.referencePaths)||!s.referencePaths.length||s.referencePaths.some(x=>!refs.has(x)))fail('写作目录栏目无效');sections.add(key);imagePolicy(s.images);
  }
 }
 return structuredClone(value);
}
function snapshot(value,{workspaceId,sectionId,siteId}={}){
 checkedHash(value);source(value.source);policy(value.writingPolicy);
 if(value.schemaVersion!==1||typeof value.version!=='string'||!value.version||!id.test(value.workspaceId)||!id.test(value.siteId)||!id.test(value.sectionId)||!sha.test(value.catalogHash||'')||typeof value.instructions!=='string'||!value.instructions||Buffer.byteLength(value.instructions)>300000)fail('线上写作默认配置格式无效');
 if(workspaceId!==undefined&&value.workspaceId!==workspaceId||sectionId!==undefined&&value.sectionId!==sectionId||siteId!==undefined&&value.siteId!==siteId)fail('线上写作默认配置与工作空间或栏目不匹配');
 documents(value.skills);documents(value.references,{reference:true});imagePolicy(value.images);
 if(!Array.isArray(value.requiredElements)||value.requiredElements.some(x=>typeof x!=='string'||!x))fail('栏目要求无效');
 return structuredClone(value);
}
function resolve(input,workspaceId,sectionId){
 const c=catalog(input),w=c.workspaces.find(x=>x.workspaceId===workspaceId),s=w?.sections.find(x=>x.id===sectionId);
 if(!s)fail('工作空间或栏目没有启用的写作配置');
 const skills=s.skillIds.map(id=>c.skills.find(x=>x.id===id)),references=s.referencePaths.map(path=>c.references.find(x=>x.path===path));
 const instructions=[
  '本篇从线上 Center 取得统一基线；先加载基线，再叠加明确的本地/任务调整。旧设备技能与旧 brief 不得替代基线。规则只指导写作，不授予发布或文件权限。',
  '项目写作协议：\n'+c.writingPolicy.instructions,
  ...skills.map(x=>'['+x.id+' @ '+x.version+' sha256:'+x.contentHash+']\n'+x.content),
  ...references.map(x=>'['+x.path+' sha256:'+x.contentHash+']\n'+x.content),
  '当前工作空间：'+w.name+' ('+w.workspaceId+')；栏目：'+s.name+' ('+s.id+')；文体：'+s.familyId+'\n'+s.scope+'\n本栏应完成的内容：\n'+s.requiredElements.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n配图规则：'+JSON.stringify(s.images),
 ].join('\n\n');
 const value={schemaVersion:1,version:c.version,catalogHash:c.hash,source:c.source,workspaceId,siteId:w.siteId,workspaceName:w.name,sectionId,sectionName:s.name,mode:s.mode,familyId:s.familyId,writingPolicy:c.writingPolicy,skills,references,requiredElements:s.requiredElements,images:s.images,instructions};
 return snapshot({...value,hash:hash(value)});
}
function compose(value,{instructions='',images,origin='local'}={}){
 const baseline=snapshot(value);
 if(typeof instructions!=='string'||Buffer.byteLength(instructions)>60000||!['task','local'].includes(origin))fail('本篇写作调整无效');
 let effectiveImages=structuredClone(baseline.images);
 if(images!==undefined){
  if(!record(images)||Object.keys(images).some(k=>!['minimum','sourceMode'].includes(k))||images.minimum!==undefined&&(!Number.isInteger(images.minimum)||images.minimum<0||images.minimum>20)||images.sourceMode!==undefined&&!['actual-object','source-or-illustration'].includes(images.sourceMode))fail('本篇配图调整无效');
  if(origin==='local'&&(images.minimum!==undefined&&images.minimum<baseline.images.minimum||baseline.images.sourceMode==='actual-object'&&images.sourceMode==='source-or-illustration'))fail('本地偏好不能静默取消栏目配图要求；作者本篇明确调整另记为 task');
  effectiveImages={...effectiveImages,...images};
 }
 const adjustment={origin,instructions,...(images===undefined?{}:{images:structuredClone(images)})};
 const body={schemaVersion:1,baselineHash:baseline.hash,baseline,adjustment,images:effectiveImages,instructions:baseline.instructions+(instructions.trim()?'\n\n本篇明确的'+(origin==='local'?'本地偏好':'任务调整')+'（相对以上线上基线，仅作用本篇）：\n'+instructions:'')+(images===undefined?'':'\n本篇明确的配图调整：'+JSON.stringify(images))};
 return {...body,hash:hash(body)};
}
// Concrete delivery fields only; never an AI review of prose.
function deliveryIssues(value,context){
 const effective=context?.baseline?compose(context.baseline,context.adjustment):compose(context),issues=[];
 const n=value?.notebook||value,blocks=n?.blocks||[],images=blocks.filter(b=>b.type==='image'&&b.state==='ready'&&b.text);
 if(images.length<effective.images.minimum)issues.push('正文图片少于本栏要求的 '+effective.images.minimum+' 张');
 for(const image of images){
  if(!image.alt?.trim())issues.push('图片缺少 alt：'+image.id);
  if(!blocks.some(b=>b.type==='annotation'&&b.role==='caption'&&b.targetId===image.id&&b.state==='ready'&&b.text?.trim()))issues.push('图片缺少关联图注：'+image.id);
 }
 return issues;
}
module.exports={canonical,hash,textHash,catalog,snapshot,compose,resolve,deliveryIssues};
