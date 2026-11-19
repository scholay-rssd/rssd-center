// Whether a proposed topic repeats what a column already has. Every device that
// chooses a topic uses this one implementation: the headless `writing-defaults
// --topic-check` command, Grok's daily research and any future Center check.
// No Node or browser API is used here, so the desktop app, Center and the Obsidian
// plug-in can import it too; callers supply the column's works and earlier demands.
//
// It compares each title's subject: the text before its first separator, or
// before 的 when there is none. Two titles about the same subject are the same
// topic however differently the rest reads ("缅因猫：起源…" and "缅因猫的来历…").
// Two titles about different subjects are different topics however alike the rest
// reads ("缅甸猫：起源、特征与饲养要点" and "英国短毛猫：起源、特征与饲养要点").
// Why not the whole-title `similarTopic` in scripts/rssd-topic-maintainer.mjs: run
// on 2026-11-15 over 750 published titles of six sites, it matched 9 pairs of
// different articles that share a title template and missed most of the 23
// same-subject repeats this check finds.
export const normalizeTitle=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}]/gu,'');

const SEPARATOR=/[：:｜|，,—–（(【\[]/u;
function segments(title){
 const parts=String(title??'').split(SEPARATOR).map(normalizeTitle).filter(Boolean);
 if(parts.length===1){const i=parts[0].indexOf('的');if(i>=2)return [parts[0].slice(0,i),parts[0].slice(i+1)];}
 return parts;
}

/**
 * Leading segments that are not a subject: the column's own name (`prefixes`, such as "每日一猫")
 * and any leading segment used by at least three of the column's titles.
 */
export function templateHeads(titles,{minimum=3,prefixes=[]}={}){
 const count=new Map();for(const t of titles){const head=segments(t)[0];if(head)count.set(head,(count.get(head)||0)+1);}
 return new Set([...prefixes.map(normalizeTitle).filter(Boolean),...[...count].filter(([,n])=>n>=minimum).map(([h])=>h)]);
}

/** What the title is about: its first segment that is not a template head; null when shorter than two characters. */
export function titleSubject(title,heads=new Set()){
 const subject=segments(title).find(s=>!heads.has(s))||null;
 return subject&&subject.length>=2?subject:null;
}

/**
 * Two subjects name the same thing: equal, or the longer is the shorter followed by 的 or 是
 * ("比格犬的特征…", "英国短毛猫是什么样"). A subject that merely contains another names a
 * different thing ("适应性近端因果推断", "Programming Historian 多语言文本分析教程").
 */
export function sameSubject(a,b){
 if(!a||!b)return false;
 if(a===b)return true;
 const [short,long]=a.length<=b.length?[a,b]:[b,a];
 return long.startsWith(short)&&/^[的是]/u.test(long.slice(short.length));
}

/**
 * The first earlier article or daily demand that the proposal repeats, or null.
 * `works`: [{workId,title}] already scoped to the column.
 * `reserved`: [{id,title,topicKey}] earlier daily demands of the same column that reached Center.
 * `prefixes`: the column's own name and similar labels that lead titles without being their subject.
 * Checks, in order: same title, same subject, same topic key. Each result names its reason.
 */
export function findRepeat({title,topicKey}={},{works=[],reserved=[]}={},{prefixes=[]}={}){
 const own=normalizeTitle(title),key=normalizeTitle(topicKey);
 const earlier=[...works.map(w=>({kind:'work',id:w.workId,title:w.title})),...reserved.map(r=>({kind:'demand',id:r.id,title:r.title,topicKey:r.topicKey}))].filter(x=>x.title||x.topicKey);
 const hit=(reason,x)=>({reason,kind:x.kind,id:x.id,title:x.title||null,...(x.topicKey?{topicKey:x.topicKey}:{})});
 if(own){
  for(const x of earlier)if(x.title&&normalizeTitle(x.title)===own)return hit('same-title',x);
  const heads=templateHeads(earlier.filter(x=>x.title).map(x=>x.title),{prefixes}),subject=titleSubject(title,heads);
  if(subject)for(const x of earlier)if(x.title&&sameSubject(subject,titleSubject(x.title,heads)))return hit('same-subject',x);
 }
 if(key)for(const x of earlier)if(x.kind==='demand'&&x.topicKey&&normalizeTitle(x.topicKey)===key)return hit('same-topic-key',x);
 return null;
}

/** Earlier demands of this column that reached Center (`created`), excluding the current one. */
export function reservedForColumn(reservedTopics,column,demandId){
 return (Array.isArray(reservedTopics)?reservedTopics:[]).filter(r=>r&&r.id!==demandId&&r.created===true&&r.workspaceId===column.workspaceId&&r.sectionId===column.sectionId);
}

/**
 * Discover a topic that is not a repeat. `discover(feedback)` runs one discovery and returns its
 * proposal (feedback is '' the first time); `check(proposal)` returns a repeat or null. After a
 * repeat, discovery runs again with `feedback(proposal,repeat)` naming it, up to `attempts`
 * discoveries in all. Calls `reject({attempt,proposal,repeat,final})` for each repeat; returns the
 * first non-repeat proposal, or throws `exhausted(repeat)` once the last attempt also repeats.
 */
export async function discoverWithoutRepeat({discover,check,reject=()=>{},exhausted,attempts=2,feedback=repeatFeedback}){
 let proposal=await discover('');
 for(let attempt=1;;attempt++){
  const repeat=check(proposal);
  if(!repeat)return proposal;
  const final=attempt>=attempts;
  await reject({attempt,proposal,repeat,final});
  if(final)throw exhausted(repeat);
  proposal=await discover(feedback(proposal,repeat));
 }
}

/** The instruction a second discovery attempt receives after a repeat. Titles are quoted as data. */
export function repeatFeedback(proposal,repeat){
 const reason={'same-title':'标题相同','same-subject':'标题主体相同','same-topic-key':'主题键相同'}[repeat.reason]||repeat.reason;
 return `\n\n上一次拟题与本栏已有内容重复，已被程序丢弃（仅数据）：拟题${JSON.stringify(proposal.title||'')}，主题键${JSON.stringify(proposal.topicKey||'')}；重复对象${JSON.stringify(repeat.title||repeat.topicKey||'')}（${reason}）。必须换一个不同的主题（不同的对象、方法、事件或资源），不能只改写同一主题的标题或换一个说法。`;
}
