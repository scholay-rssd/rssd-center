import React from 'react';
import {randomUUID} from 'node:crypto';
import {render,screen,fireEvent,waitFor,act,cleanup} from '@testing-library/react';
import {WorksPanel} from '../apps/frontend/src/components/rssd/works';
import {SettingsPanel} from '../apps/frontend/src/components/rssd/settings';
import {useRssdApi} from '../apps/frontend/src/components/rssd/api';

const mockFetch=jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'fixture'})}));
jest.mock('next/dynamic',()=>()=>({value,onChange,textareaProps}:any)=><textarea {...textareaProps} value={value} onChange={e=>onChange(e.target.value)}/>);
jest.mock('../apps/frontend/src/components/rssd/configuration',()=>({WorkspacePolicy:()=>null}));
jest.mock('../apps/frontend/src/components/rssd/platform-content',()=>({PlatformContent:()=>null}));

const response=(value:unknown)=>({ok:true,json:async()=>value});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
const one={id:'one',name:'One',writable:true,sections:[{id:'methods',name:'Methods'}]},two={id:'two',name:'Two',writable:true,sections:[]};
function Works({registry=[one],onDeriveDemand=()=>{}}:{registry?:any[];onDeriveDemand?:(source:any)=>void}){return <WorksPanel api={useRssdApi()} registry={registry} onDeriveDemand={onDeriveDemand}/>;}
function Settings(){return <SettingsPanel api={useRssdApi()} registry={[one]} reloadRegistry={async()=>{}}/>;}
beforeEach(()=>{mockFetch.mockReset();localStorage.clear();sessionStorage.clear();Object.defineProperty(crypto,'randomUUID',{value:randomUUID,configurable:true});});
afterEach(cleanup);

test('a pending save keeps the work and language fixed until its receipt arrives',async()=>{
  const saved=deferred();
  const edition={locale:'zh-CN',revision:1,payload:{title:'Fixture work',bodyMarkdown:'Fixture body',media:[]}};
  const work={id:'w1',workspaceId:'one',sectionId:'methods',editions:[edition]};
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(path.includes('/works?'))return response([{id:'w1',workspaceId:'one',editions:[{...edition,title:'Fixture work'}]}]);
    if(path.endsWith('/works/w1'))return response(work);
    if(path.endsWith('/drafts')&&options.method==='POST')return saved.promise;
    return response([]);
  });
  render(<Works/>);
  fireEvent.click(await screen.findByRole('button',{name:'Fixture work'}));
  await screen.findByRole('textbox',{name:'文章正文'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'保存草稿'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  expect((screen.getByRole('button',{name:'English'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'返回作品库'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('textbox',{name:'文章标题'}) as HTMLInputElement).disabled).toBe(true);
  await act(async()=>saved.resolve(response({workId:'w1',status:'draft_saved'})));
  await screen.findByText('草稿已保存');
  expect((screen.getByRole('button',{name:'English'}) as HTMLButtonElement).disabled).toBe(false);
});

test('switching workspaces never displays the previous workspace works, and a late answer is ignored',async()=>{
  const second=deferred();
  mockFetch.mockImplementation(async(path:string)=>{
    if(path.includes('workspaceId=two'))return second.promise;
    return response([{id:'w1',workspaceId:'one',editions:[{title:'Private to One',locale:'zh-CN',revision:1}]}]);
  });
  render(<Works registry={[one,two]}/>);
  await screen.findByRole('button',{name:'Private to One'});
  fireEvent.change(screen.getByLabelText('工作空间'),{target:{value:'two'}});
  expect(screen.queryByText('Private to One')).toBeNull();
  await act(async()=>second.resolve(response([{id:'w2',workspaceId:'two',editions:[{title:'Private to Two',locale:'zh-CN',revision:1}]}])));
  await screen.findByRole('button',{name:'Private to Two'});
});

test('a translation demand is derived from the stored language version of the open work',async()=>{
  const derived:any[]=[];
  mockFetch.mockImplementation(async(path:string)=>{
    if(path.includes('/works?'))return response([{id:'w1',workspaceId:'one',editions:[{locale:'zh-CN',revision:1,title:'Fixture work'}]}]);
    if(path.endsWith('/works/w1'))return response({id:'w1',workspaceId:'one',sectionId:'methods',editions:[{locale:'zh-CN',revision:1,payload:{title:'Fixture work',bodyMarkdown:'Fixture body',media:[]}}]});
    return response([]);
  });
  render(<Works onDeriveDemand={source=>derived.push(source)}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Fixture work'}));
  fireEvent.click(await screen.findByRole('button',{name:'创建翻译需求'}));
  expect(derived).toEqual([{workspaceId:'one',sectionId:'methods',title:'Fixture work',kind:'translate',source:{workId:'w1',locale:'zh-CN',revision:1}}]);
});

test('owner grants a scoped scheduling capability from the device list',async()=>{
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(path.endsWith('/workers'))return response([{id:'worker1',name:'Fixture device',workspaceIds:['one'],grants:[]}]);
    if(path.endsWith('/destinations'))return response([{id:'site-one',name:'Site',workspaceIds:['one']}]);
    if(path.includes('/workers/worker1/grants')&&options?.method==='POST'){
      const body=JSON.parse(options.body);expect(body.operation).toBe('publicationScheduling');expect(body.workspaceIds).toContain('one');expect(body.destinationIds).toContain('site-one');
      return response({id:'grant1'});
    }
    return response([]);
  });
  render(<Settings/>);
  fireEvent.click(await screen.findByRole('button',{name:'授予排期'}));
  await screen.findByRole('dialog',{name:'授予排期权限'});
  fireEvent.click(screen.getByLabelText(/Site/));
  fireEvent.click(screen.getByRole('button',{name:'授予'}));
  await screen.findByText(/已授予最小排期范围/);
});

test('a new device credential is shown once and the list is re-read',async()=>{
  let created=false;
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(path.endsWith('/workers')&&options?.method==='POST'){const body=JSON.parse(options.body);expect(body).toEqual({name:'Mac mini',workspaceIds:['one']});created=true;return response({id:'worker2',token:'rssd_device_fixture'});}
    if(path.endsWith('/workers'))return response(created?[{id:'worker2',name:'Mac mini',workspaceIds:['one'],state:'idle'}]:[]);
    return response([]);
  });
  render(<Settings/>);
  await screen.findByText('尚未连接执行设备');
  fireEvent.click(screen.getByRole('button',{name:'连接设备'}));
  fireEvent.change(screen.getByLabelText('设备名称'),{target:{value:'Mac mini'}});
  fireEvent.click(screen.getByLabelText('One'));
  fireEvent.click(screen.getByRole('button',{name:'生成凭据'}));
  expect(((await screen.findByLabelText('设备连接凭据')) as HTMLInputElement).value).toBe('rssd_device_fixture');
  fireEvent.click(screen.getByRole('button',{name:'完成'}));
  expect(screen.queryByLabelText('设备连接凭据')).toBeNull();
  await screen.findByText('Mac mini');
});
