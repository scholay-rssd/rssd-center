import React from 'react';
import {randomUUID} from 'node:crypto';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {RssdCenter} from '../apps/frontend/src/components/rssd/live-center';

const mockFetch=jest.fn(),mockPush=jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'fixture'})}));
jest.mock('next/navigation',()=>({useRouter:()=>({push:mockPush})}));
jest.mock('next/dynamic',()=>()=>()=>null);
jest.mock('../apps/frontend/src/components/rssd/configuration',()=>({WorkspacePolicy:()=>null,DestinationSettings:()=>null}));
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
beforeEach(()=>{mockFetch.mockReset();mockPush.mockReset();localStorage.clear();sessionStorage.clear();Object.defineProperty(crypto,'randomUUID',{value:randomUUID,configurable:true});});
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
  // The management screens are not loaded until they are opened.
  expect(mockFetch.mock.calls.some(([path])=>String(path).endsWith('/registry'))).toBe(false);
});

test('an existing management link opens that screen inside the new page',async()=>{
  mockFetch.mockImplementation(async(path:string)=>path==='/rssd/v1/workers'?response([{id:'w1',name:'Fixture device',workspaceIds:['one'],state:'idle'}]):center(path));
  render(<RssdCenter initialTab="workers" initialWorkspace="one"/>);
  await screen.findByText('Fixture device');
  expect(screen.getByRole('button',{name:'作品与管理'}).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button',{name:'执行设备'}).getAttribute('aria-current')).toBe('page');
  // What the view already shows is not repeated among the embedded screens.
  for(const name of ['总览','统一日历','发布记录'])expect(screen.queryByRole('button',{name})).toBeNull();
  expect(screen.getAllByRole('heading',{name:'工作中心'})).toHaveLength(1);
});

test('goals are reached from the overview, and no assistant is offered in the browser',async()=>{
  mockFetch.mockImplementation(async(path:string)=>center(path));
  render(<RssdCenter/>);
  expect(screen.queryByRole('button',{name:/中心助手/})).toBeNull();
  expect(screen.queryByRole('button',{name:/向助手下指令/})).toBeNull();
  fireEvent.click(await screen.findByRole('button',{name:/维护生产目标/}));
  await waitFor(()=>expect(mockPush).toHaveBeenCalledWith('/rssd?tab=goals'));
});

test('a schedule is changed in the calendar drawer once across a lost response, and the old calendar link opens it',async()=>{
  const writes:any[]=[];
  mockFetch.mockImplementation(async(path:string,options:any)=>{
    if(options?.method==='POST'){writes.push({path,body:JSON.parse(options.body)});return writes.length===1?response({message:'Response lost'},false):response({id:'p1'});}
    return center(path);
  });
  render(<RssdCenter initialTab="calendar"/>);
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
