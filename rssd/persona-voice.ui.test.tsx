import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup,within} from '@testing-library/react';
import {WorkspacePolicy} from '../apps/frontend/src/components/rssd/configuration';
import {PersonaLibrary,uploadBatches,withVoice} from '../apps/frontend/src/components/rssd/persona-voice';
afterEach(cleanup);
// The rules form copies the workspace with structuredClone, which this jsdom lacks; the data here is plain JSON.
if(typeof structuredClone!=='function')(globalThis as any).structuredClone=(value:unknown)=>JSON.parse(JSON.stringify(value));

// Made-up personas as GET /mounts/personas lists them.
const persona=(n:number,active=true)=>({id:'P000'+n,revision:'p000'+n+'.v1',revisions:['p000'+n+'.v1'],founder:{id:'M0'+n,name:'Founder'+n},summary:{core:'Core '+n,communicationStyle:'Plain',strengths:['Checks']},active});
const library=[persona(1),persona(2),persona(3,false)];
const workspace=(policy:Record<string,unknown>={})=>({id:'research',name:'Research',revision:4,sections:[{id:'methods',name:'Methods',policy:{version:2,instructions:'Rules',brand:{},targets:[],...policy}}]});
function center(personas=library){
 const calls:any[]=[];
 const api=async(path:string,method='GET',body?:any)=>{
  calls.push([path,method,body]);
  if(path==='/destinations')return [];
  if(path==='/mounts/personas'&&method==='GET')return {personas};
  if(path==='/mounts/personas'&&method==='POST')return {personas:body.personas.map((p:any)=>({id:p.snapshot.preset.id,revision:p.snapshot.preset.revision,status:p.snapshot.preset.id==='P0001'?'existing':'created'}))};
  if(path.endsWith('/retire'))return {id:path.split('/')[3],retired:body.retired};
  if(path==='/workspaces')return {};
  throw Error('unexpected '+path);
 };
 return {api,calls,saved:()=>calls.filter(([path,method])=>path==='/workspaces'&&method==='POST').map(([,,body])=>body)};
}
const saveRules=()=>fireEvent.click(screen.getByRole('button',{name:'保存栏目规则'}));
const voiceGroup=()=>within(screen.getByRole('group',{name:'Methods的人格'}));

test('a section can be given a fixed persona that signs, and saving sends exactly that voice',async()=>{
 const f=center();render(<WorkspacePolicy workspace={workspace()} api={f.api} onSaved={async()=>{}}/>);
 const group=voiceGroup();
 expect((group.getByLabelText('人格') as HTMLSelectElement).value).toBe('none');
 expect(group.queryByRole('option',{name:'只署名（旧设置）'})).toBeNull();
 fireEvent.change(group.getByLabelText('人格'),{target:{value:'fixed'}});
 await waitFor(()=>expect(group.getByRole('option',{name:'P0002 · Founder2'})).toBeTruthy());
 saveRules();
 await screen.findByText(/选一位固定的人格/);expect(f.saved()).toHaveLength(0);
 fireEvent.change(group.getByLabelText('固定的人格'),{target:{value:'P0002'}});
 saveRules();
 await screen.findByText(/栏目规则已保存/);
 const [body]=f.saved();
 expect(body.baseRevision).toBe(4);
 expect(body.workspace.sections[0].policy).toEqual({version:3,instructions:'Rules',brand:{},targets:[],voice:{mode:'fixed',persona:'P0002',byline:'persona'}});
});

test('a range, a fallback and the site byline; choosing none removes the voice',async()=>{
 const f=center();render(<WorkspacePolicy workspace={workspace({voice:{mode:'random',range:'all',byline:'persona'}})} api={f.api} onSaved={async()=>{}}/>);
 const group=voiceGroup();
 fireEvent.change(group.getByLabelText('人格'),{target:{value:'choose'}});
 fireEvent.click(group.getByLabelText('只用下面勾选的'));
 saveRules();await screen.findByText(/至少选一位人格/);
 await waitFor(()=>expect(group.getByLabelText('P0001 · Founder1')).toBeTruthy());
 fireEvent.click(group.getByLabelText('P0001 · Founder1'));fireEvent.click(group.getByLabelText('P0002 · Founder2'));
 fireEvent.change(group.getByLabelText('兜底人格'),{target:{value:'P0002'}});
 fireEvent.change(group.getByLabelText('署名'),{target:{value:'site'}});
 saveRules();await screen.findByText(/栏目规则已保存/);
 expect(f.saved()[0].workspace.sections[0].policy.voice).toEqual({mode:'choose',range:['P0001','P0002'],fallback:'P0002',byline:'site'});
 fireEvent.change(group.getByLabelText('人格'),{target:{value:'none'}});
 saveRules();await waitFor(()=>expect(f.saved()).toHaveLength(2));
 expect('voice' in f.saved()[1].workspace.sections[0].policy).toBe(false);
});

test('a persona the section names but the library no longer offers stays visible, and an empty library is said plainly',async()=>{
 const f=center([persona(1)]);render(<WorkspacePolicy workspace={workspace({voice:{mode:'balanced',range:['P0001','P0009'],byline:'persona'}})} api={f.api} onSaved={async()=>{}}/>);
 const group=voiceGroup();
 await waitFor(()=>expect(group.getByLabelText('P0009 · 库里没有（已停用）')).toBeTruthy());
 expect((group.getByLabelText('P0009 · 库里没有（已停用）') as HTMLInputElement).checked).toBe(true);
 cleanup();
 const empty=center([]);render(<WorkspacePolicy workspace={workspace({voice:{mode:'fixed',persona:'P0001',byline:'site'}})} api={empty.api} onSaved={async()=>{}}/>);
 await screen.findByText(/人格库里没有在用的人格/);
});

test('the earlier byline-only setting is kept as it is until the owner picks another way',async()=>{
 const f=center();render(<WorkspacePolicy workspace={workspace({persona:{id:'M01',name:'Kiya'}})} api={f.api} onSaved={async()=>{}}/>);
 const group=voiceGroup();
 expect((group.getByLabelText('人格') as HTMLSelectElement).value).toBe('persona');
 expect((screen.getByLabelText('署名人格名字') as HTMLInputElement).value).toBe('Kiya');
 saveRules();await screen.findByText(/栏目规则已保存/);
 expect(f.saved()[0].workspace.sections[0].policy.persona).toEqual({id:'M01',name:'Kiya'});
 fireEvent.change(group.getByLabelText('人格'),{target:{value:'fixed'}});
 expect(screen.queryByLabelText('署名人格名字')).toBeNull();
 fireEvent.change(group.getByLabelText('固定的人格'),{target:{value:'P0001'}});
 saveRules();await waitFor(()=>expect(f.saved()).toHaveLength(2));
 const policy=f.saved()[1].workspace.sections[0].policy;
 expect('persona' in policy).toBe(false);expect(policy.voice).toEqual({mode:'fixed',persona:'P0001',byline:'persona'});
});

test('withVoice keeps every other rule and never leaves both settings',()=>{
 const base={version:1,instructions:'x',brand:{name:'b'},targets:[{destinationId:'d',locale:'en'}],persona:{id:'M01',name:'K'}};
 expect(withVoice(base,{mode:'none'})).toEqual({version:1,instructions:'x',brand:{name:'b'},targets:[{destinationId:'d',locale:'en'}]});
 expect(withVoice(base,{mode:'persona'})).toEqual(base);
 expect(withVoice(base,{mode:'random',range:'all',fallback:'',byline:'site'}).voice).toEqual({mode:'random',range:'all',byline:'site'});
 expect('persona' in withVoice(base,{mode:'fixed',persona:'P0001'})).toBe(false);
});

test('the library lists personas, uploads an export file in batches, and retires one',async()=>{
 const f=center();
 const registry=[{id:'research',name:'Research',sections:[{id:'methods',name:'Methods',policy:{voice:{mode:'fixed',persona:'P0002',byline:'persona'}}},{id:'notes',name:'Notes',policy:{voice:{mode:'choose',range:'all',byline:'site'}}}]}];
 render(<PersonaLibrary api={f.api} registry={registry}/>);
 const row=(id:string)=>within(screen.getByText(id).closest('tr') as HTMLElement);
 await screen.findByText('P0002');
 expect(row('P0002').getByText('Research / Methods、Research / Notes')).toBeTruthy();
 expect(row('P0001').getByText('Research / Notes')).toBeTruthy();
 expect(row('P0003').getByText('已停用')).toBeTruthy();expect(row('P0003').getByText('—')).toBeTruthy();
 const snapshot=(n:number)=>({preset:{id:'P00'+String(n).padStart(2,'0'),revision:'p00'+String(n).padStart(2,'0')+'.v1'},pad:'x'.repeat(1800)});
 const file=new File([JSON.stringify({schemaVersion:'rssd.persona-upload.v1',personas:Array.from({length:45},(_,i)=>({snapshot:snapshot(i+1),founderName:'F'}))})],'personas.json',{type:'application/json'});
 fireEvent.change(screen.getByLabelText('上传人格文件'),{target:{files:[file]}});
 await screen.findByText('已上传 45 个人格版本：新增 44 个，1 个已存在未改动。');
 const posts=f.calls.filter(([path,method])=>path==='/mounts/personas'&&method==='POST');
 expect(posts.map(([,,body])=>body.personas.length)).toEqual([30,15]);
 fireEvent.change(screen.getByLabelText('上传人格文件'),{target:{files:[new File(['{"personas":[]}'],'other.json')]}});
 await screen.findByText(/不是人格库的上传文件/);
 fireEvent.click(row('P0002').getByRole('button',{name:'停用'}));
 await screen.findByText(/P0002 已停用/);
 expect(f.calls.some(([path,method,body])=>path==='/mounts/personas/P0002/retire'&&method==='POST'&&body.retired===true)).toBe(true);
 fireEvent.click(row('P0003').getByRole('button',{name:'恢复'}));
 await waitFor(()=>expect(f.calls.some(([path,,body])=>path==='/mounts/personas/P0003/retire'&&body?.retired===false)).toBe(true));
});

test('upload batches stay under the count and the size of one request',()=>{
 const item=(n:number)=>({n,pad:'x'.repeat(n)});
 expect(uploadBatches(Array.from({length:61},()=>item(10))).map(b=>b.length)).toEqual([30,30,1]);
 expect(uploadBatches([item(50000),item(50000),item(10)]).map(b=>b.length)).toEqual([1,2]);
 expect(uploadBatches([])).toEqual([]);
});
