import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {DeviceAuthorization} from '../apps/frontend/src/components/rssd/device-authorization';
const mockFetch=jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'fixture'})}));
jest.mock('@gitroom/frontend/components/layout/organization.selector',()=>({OrganizationSelector:()=>null}));
const response=(data:unknown,ok=true)=>({ok,json:async()=>data});
beforeEach(()=>{mockFetch.mockReset();mockFetch.mockImplementation(async(path:string)=>{
 if(path.includes('/auth/request?'))return response({requestId:'fixture-request',name:'Fixture Linux',mode:'device',state:'pending',center:'https://example.org',expiresAt:Date.now()+600000});
 if(path.endsWith('/registry'))return response({workspaces:[{id:'one',name:'One workspace'},{id:'two',name:'Two workspace'}]});
 return response({state:'approved'});
});});
afterEach(cleanup);
test('authorization requires explicit workspace selection and never starts production',async()=>{
 render(<DeviceAuthorization requestId="fixture-request" userCode=""/>);
 await screen.findByText('Fixture Linux');const approve=screen.getByRole('button',{name:'授权这台设备'}) as HTMLButtonElement;expect(approve.disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('One workspace'));fireEvent.click(approve);
 await screen.findByRole('status');
 const writes=mockFetch.mock.calls.filter(([,options])=>options?.method==='POST');expect(writes).toHaveLength(1);expect(JSON.parse(writes[0][1].body)).toEqual({approved:true,workspaceIds:['one']});
});
test('denial needs no workspace and expiration never enables approval',async()=>{
 render(<DeviceAuthorization requestId="fixture-request" userCode=""/>);fireEvent.click(await screen.findByRole('button',{name:'拒绝'}));
 await waitFor(()=>expect(mockFetch.mock.calls.some(([,options])=>options?.body===JSON.stringify({approved:false,workspaceIds:[]}))).toBe(true));
 cleanup();mockFetch.mockResolvedValue(response({message:'Authorization expired'},false));
 render(<DeviceAuthorization requestId="expired" userCode=""/>);expect((await screen.findByRole('alert')).textContent).toBe('Authorization expired');expect(screen.queryByRole('button',{name:'授权这台设备'})).toBeNull();
});
