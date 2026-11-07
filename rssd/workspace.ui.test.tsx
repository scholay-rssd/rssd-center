import React from 'react';
import {randomUUID} from 'node:crypto';
import {render,screen,fireEvent,waitFor,act,cleanup} from '@testing-library/react';
import {RssdWorkspace} from '../apps/frontend/src/components/rssd/workspace';

const mockFetch=jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'fixture'})}));
jest.mock('next/dynamic',()=>()=>({value,onChange,textareaProps}:any)=><textarea {...textareaProps} value={value} onChange={e=>onChange(e.target.value)}/>);
jest.mock('../apps/frontend/src/components/rssd/configuration',()=>({WorkspacePolicy:()=>null,DestinationSettings:()=>null}));
jest.mock('../apps/frontend/src/components/rssd/platform-content',()=>({PlatformContent:()=>null}));

const response=(value:unknown)=>({ok:true,json:async()=>value});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>{mockFetch.mockReset();localStorage.clear();sessionStorage.clear();Object.defineProperty(crypto,'randomUUID',{value:randomUUID,configurable:true});});
afterEach(cleanup);

test('a pending save keeps the work, language and workspace fixed until its receipt arrives',async()=>{
  const saved=deferred();
  const edition={locale:'zh-CN',revision:1,payload:{title:'Fixture work',bodyMarkdown:'Fixture body',media:[]}};
  const work={id:'w1',workspaceId:'one',sectionId:'methods',editions:[edition]};
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(path.endsWith('/registry'))return response({workspaces:[{id:'one',name:'One',sections:[]}]});
    if(path.includes('/works?'))return response([{id:'w1',editions:[{...edition,title:'Fixture work'}]}]);
    if(path.endsWith('/works/w1'))return response(work);
    if(path.endsWith('/drafts')&&options.method==='POST')return saved.promise;
    return response([]);
  });
  render(<RssdWorkspace/>);
  fireEvent.click(screen.getByRole('button',{name:'作品库',exact:true}));
  fireEvent.click(await screen.findByRole('button',{name:'Fixture work'}));
  await screen.findByRole('textbox',{name:'文章正文'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'保存草稿'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  expect((screen.getByRole('button',{name:'English'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'返回作品库'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('工作空间') as HTMLSelectElement).disabled).toBe(true);
  await act(async()=>saved.resolve(response({workId:'w1',status:'draft_saved'})));
  await screen.findByText('草稿已保存');
  expect((screen.getByRole('button',{name:'English'}) as HTMLButtonElement).disabled).toBe(false);
});

test('tab changes hide the prior row type immediately and ignore late responses',async()=>{
  const workRequest=deferred();
  mockFetch.mockImplementation(async(path:string)=>{
    if(path.endsWith('/registry'))return response({workspaces:[{id:'one',name:'Fixture workspace',sections:[]}]});
    if(path.includes('/works?'))return workRequest.promise;
    if(path.includes('/demands?'))return response([{id:'d1',title:'Fixture demand',state:'queued'}]);
    if(path.endsWith('/workers'))return response([{id:'worker1',name:'Fixture device',workspaceIds:['one']}]);
    throw Error(path);
  });
  render(<RssdWorkspace/>);
  await screen.findByText('Fixture demand');
  fireEvent.click(screen.getByRole('button',{name:'作品库',exact:true}));
  expect(screen.queryByText('Fixture demand')).toBeNull();
  await waitFor(()=>expect(mockFetch.mock.calls.some(([path])=>path.includes('/works?'))).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'执行设备',exact:true}));
  await screen.findByText('Fixture device');
  await act(async()=>workRequest.resolve(response([{id:'w1',editions:[{title:'Late work',locale:'en',revision:1}]}])));
  expect(screen.queryByText('Late work')).toBeNull();
  expect(screen.getByText('Fixture device')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'作品库',exact:true}));
  await screen.findByRole('button',{name:'Late work'});
});

test('translation demand creation reports skip when the target language already exists',async()=>{
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(path.endsWith('/registry'))return response({workspaces:[{id:'one',name:'One',writable:true,sections:[{id:'methods',name:'Methods'}]}]});
    if(path.includes('/works?'))return response([{id:'w1',editions:[{locale:'zh-CN',revision:1,title:'Fixture work'}]}]);
    if(path.endsWith('/works/w1'))return response({id:'w1',workspaceId:'one',sectionId:'methods',editions:[{locale:'zh-CN',revision:1,payload:{title:'Fixture work',bodyMarkdown:'Fixture body',media:[]}}]});
    if(path.endsWith('/demands')&&options?.method==='POST'){
      const body=JSON.parse(options.body);expect(body.kind).toBe('translate');expect(body.source).toEqual({workId:'w1',locale:'zh-CN',revision:1});
      return response({status:'skipped',reason:'locale_present',workId:'w1'});
    }
    return response([]);
  });
  render(<RssdWorkspace/>);
  fireEvent.click(screen.getByRole('button',{name:'作品库',exact:true}));
  fireEvent.click(await screen.findByRole('button',{name:'Fixture work'}));
  fireEvent.click(await screen.findByRole('button',{name:'创建翻译需求'}));
  fireEvent.click(screen.getByRole('button',{name:'创建'}));
  await screen.findByText('该作品已有目标语言，未重复创建需求');
});

test('owner grants a scoped scheduling capability from the device list',async()=>{
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(path.endsWith('/registry'))return response({workspaces:[{id:'one',name:'One',sections:[]}]});
    if(path.endsWith('/workers'))return response([{id:'worker1',name:'Fixture device',workspaceIds:['one'],grants:[]}]);
    if(path.endsWith('/destinations'))return response([{id:'site-one',name:'Site',workspaceIds:['one']}]);
    if(path.includes('/workers/worker1/grants')&&options?.method==='POST'){
      const body=JSON.parse(options.body);expect(body.operation).toBe('publicationScheduling');expect(body.workspaceIds).toContain('one');expect(body.destinationIds).toContain('site-one');
      return response({id:'grant1'});
    }
    return response([]);
  });
  render(<RssdWorkspace/>);
  fireEvent.click(screen.getByRole('button',{name:'执行设备',exact:true}));
  fireEvent.click(await screen.findByRole('button',{name:'授予排期'}));
  await screen.findByRole('heading',{name:'授予排期权限'});
  fireEvent.click(screen.getByLabelText(/Site/));
  fireEvent.click(screen.getByRole('button',{name:'授予'}));
  await screen.findByText(/已授予最小排期范围/);
});

test('switching workspaces never displays the previous workspace contents while loading',async()=>{
  const second=deferred();
  mockFetch.mockImplementation(async(path:string)=>{
    if(path.endsWith('/registry'))return response({workspaces:[{id:'one',name:'One',sections:[]},{id:'two',name:'Two',sections:[]}]});
    if(path.includes('workspaceId=two'))return second.promise;
    return response([{id:'d1',title:'Private to One',state:'queued'}]);
  });
  render(<RssdWorkspace/>);
  await screen.findByText('Private to One');
  fireEvent.change(screen.getByLabelText('工作空间'),{target:{value:'two'}});
  expect(screen.queryByText('Private to One')).toBeNull();
  await act(async()=>second.resolve(response([{id:'d2',title:'Private to Two',state:'queued'}])));
  await screen.findByText('Private to Two');
});
