import React from 'react';
import {randomUUID} from 'node:crypto';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {RssdCenter} from '../apps/frontend/src/components/rssd/live-center';

const mockFetch=jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'fixture'})}));
jest.mock('next/dynamic',()=>()=>()=>null);
jest.mock('../apps/frontend/src/components/rssd/configuration',()=>({WorkspacePolicy:()=>null}));
jest.mock('../apps/frontend/src/components/rssd/platform-content',()=>({PlatformContent:()=>null}));

const response=(value:unknown,ok=true)=>({ok,status:ok?200:500,json:async()=>value});
const workspace={id:'one',name:'One',writable:true,sections:[{id:'methods',name:'Methods'}]};
const demand={id:'d1',workspaceId:'one',sectionId:'methods',title:'Fixture demand',kind:'write',state:'queued',priority:0,generation:3,payload:{requiredLocales:['zh-CN'],brief:'Fixture brief',dueAt:'2026-11-20T15:59:59.000Z'}};
const queued={id:'rssd:p1',source:'rssd',publicationId:'p1',workId:'w1',workspaceId:'one',title:'Fixture publication',destination:'Fixture site',destinationId:'site',locale:'zh-CN',state:'queued',scheduledAt:new Date().toISOString(),updatedAt:'2026-11-01T00:00:00.000Z',hasSchedule:true};
const center=(path:string)=>{
  if(path.startsWith('/rssd/v1/coordination/overview'))return response({workspaces:[workspace],goals:[],counts:[{workspaceId:'one',state:'queued',count:1}],works:[],capabilities:{publicationScheduling:true}});
  if(path.startsWith('/rssd/v1/coordination/channels'))return response({destinations:[],channels:[]});
  if(path.startsWith('/rssd/v1/coordination/calendar'))return response({items:[queued],hasNext:false});
  if(path.startsWith('/rssd/v1/demands?'))return response([demand]);
  if(path.endsWith('/registry'))return response({workspaces:[workspace]});
  return response([]);
};
beforeEach(()=>{mockFetch.mockReset();localStorage.clear();sessionStorage.clear();Object.defineProperty(crypto,'randomUUID',{value:randomUUID,configurable:true});});
afterEach(cleanup);

test('the work-centre view shows Center data and saves a task edit once across a lost response',async()=>{
  const edits:any[]=[];
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(options?.method==='PATCH'){edits.push({path,body:JSON.parse(options.body)});return edits.length===1?response({message:'Response lost'},false):response({});}
    return center(path);
  });
  render(<RssdCenter/>);
  expect(screen.getByRole('heading',{name:'工作中心'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/需求池/}));
  fireEvent.click(await screen.findByRole('button',{name:'Fixture demand'}));
  // A browser has no local worker, so the task can be edited but not started here.
  expect(screen.queryByRole('button',{name:'本机认领并执行'})).toBeNull();
  fireEvent.change(screen.getByLabelText('优先级'),{target:{value:'优先'}});
  fireEvent.click(screen.getByRole('button',{name:'保存到中心'}));
  await screen.findByText(/Response lost/);
  fireEvent.click(screen.getByRole('button',{name:'保存到中心'}));
  await screen.findByText('需求已保存到中心。');
  expect(edits).toHaveLength(2);expect(edits[0]).toEqual(edits[1]);
  expect(edits[0].path).toBe('/rssd/v1/demands/d1/definition');
  expect(edits[0].body.baseGeneration).toBe(3);expect(edits[0].body.changes.priority).toBe(10);
  expect(edits[0].body.changes.dueAt).toBe(demand.payload.dueAt);
  // The works library and settings are not loaded until they are opened.
  expect(mockFetch.mock.calls.some(([path])=>/\/works\?|\/workers$/.test(String(path)))).toBe(false);
});

test('earlier links open their screen in the one interface',async()=>{
  mockFetch.mockImplementation(async(path:string)=>path==='/rssd/v1/workers'?response([{id:'w1',name:'Fixture device',workspaceIds:['one'],state:'idle'}]):center(path));
  render(<RssdCenter initialTab="workers" initialWorkspace="one"/>);
  await screen.findByText('Fixture device');
  expect(screen.getByRole('button',{name:'设置'}).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button',{name:'执行设备'}).getAttribute('aria-pressed')).toBe('true');
  // One set of tabs, one title, and nothing that leads to another interface.
  expect(screen.getAllByRole('navigation')).toHaveLength(1);
  expect(screen.getAllByRole('heading',{name:'工作中心'})).toHaveLength(1);
  for(const name of ['作品与管理','中心助手','统一日历','发布记录'])expect(screen.queryByRole('button',{name:new RegExp(name)})).toBeNull();
  expect(document.querySelector('a[href="/launches"],a[href="/media"],a[href="/analytics"],a[href="/settings"]')).toBeNull();
  cleanup();
  render(<RssdCenter initialTab="works"/>);
  expect(screen.getByRole('button',{name:'作品库'}).getAttribute('aria-current')).toBe('page');
});

test('a goal is saved from the overview once across a lost response',async()=>{
  const writes:any[]=[];
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(options?.method==='POST'){writes.push({path,body:JSON.parse(options.body)});return writes.length===1?response({message:'Response lost'},false):response({});}
    return center(path);
  });
  render(<RssdCenter/>);
  fireEvent.click(await screen.findByRole('button',{name:/维护生产目标/}));
  await screen.findByRole('dialog',{name:'生产目标'});
  fireEvent.click(screen.getByRole('button',{name:'新增生产目标'}));
  fireEvent.change(screen.getByLabelText('栏目标识'),{target:{value:'methods'}});
  fireEvent.change(screen.getByLabelText('选题方向'),{target:{value:'Weekly methods'}});
  fireEvent.change(screen.getByLabelText('交稿目标'),{target:{value:'3'}});
  fireEvent.click(screen.getByRole('button',{name:'保存目标'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Response lost');
  fireEvent.click(screen.getByRole('button',{name:'保存目标'}));
  await screen.findByText(/目标已保存/);
  expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);
  expect(writes[0].path).toBe('/rssd/v1/goals');
  expect(writes[0].body.id).toBe('goal:one:methods');expect(writes[0].body.goal.target).toBe(3);expect(writes[0].body.goal.enabled).toBe(false);
});

test('a task is added to the pool from the task list',async()=>{
  const writes:any[]=[];
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(options?.method==='POST'){writes.push({path,body:JSON.parse(options.body)});return response({status:'created'});}
    return center(path);
  });
  render(<RssdCenter initialView="demands"/>);
  fireEvent.click(await screen.findByRole('button',{name:/新建需求/}));
  await screen.findByRole('dialog',{name:'新建需求'});
  fireEvent.change(screen.getByLabelText('选题'),{target:{value:'A new topic'}});
  fireEvent.click(screen.getByRole('button',{name:'加入需求池'}));
  await screen.findByText('需求已加入需求池');
  expect(writes).toEqual([{path:'/rssd/v1/demands',body:{workspaceId:'one',sectionId:'methods',kind:'write',title:'A new topic',brief:'',requiredLocales:['zh-CN','en']}}]);
});

test('a schedule is changed in the calendar drawer once across a lost response, and the old calendar link opens it',async()=>{
  const writes:any[]=[];
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(options?.method==='POST'){writes.push({path,body:JSON.parse(options.body)});return writes.length===1?response({message:'Response lost'},false):response({id:'p1'});}
    return center(path);
  });
  render(<RssdCenter initialTab="publications"/>);
  expect(screen.getByRole('button',{name:/发布日历/}).getAttribute('aria-current')).toBe('page');
  fireEvent.click(await screen.findByRole('button',{name:/Fixture publication/}));
  fireEvent.change(screen.getByLabelText('日期'),{target:{value:'2026-12-01'}});
  fireEvent.change(screen.getByLabelText('时间'),{target:{value:'10:30'}});
  fireEvent.click(screen.getByRole('button',{name:'保存排期'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Response lost');
  fireEvent.click(screen.getByRole('button',{name:'保存排期'}));
  await screen.findByText('排期已保存到中心，原发布身份不变。');
  expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);
  expect(writes[0].path).toBe('/rssd/v1/publications/p1/schedule');
  expect(writes[0].body.expectedUpdatedAt).toBe(queued.updatedAt);
  expect(writes[0].body.scheduledAt).toBe(new Date('2026-12-01T10:30').toISOString());
});
