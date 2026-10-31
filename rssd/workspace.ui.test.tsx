import React from 'react';
import {render,screen,fireEvent,waitFor,act,cleanup} from '@testing-library/react';
import {RssdWorkspace} from '../apps/frontend/src/components/rssd/workspace';

const mockFetch=jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'fixture'})}));
jest.mock('next/dynamic',()=>()=>()=>null);
jest.mock('../apps/frontend/src/components/rssd/configuration',()=>({WorkspacePolicy:()=>null,DestinationSettings:()=>null}));
jest.mock('../apps/frontend/src/components/rssd/platform-content',()=>({PlatformContent:()=>null}));

const response=(value:unknown)=>({ok:true,json:async()=>value});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>{mockFetch.mockReset();localStorage.clear();sessionStorage.clear();});
afterEach(cleanup);

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
