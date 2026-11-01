import React from 'react';
import {randomUUID} from 'node:crypto';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {Coordination} from '../apps/frontend/src/components/rssd/coordination';
afterEach(cleanup);
test('schedule retries preserve the original request and publication identity after a lost response',async()=>{
 Object.defineProperty(crypto,'randomUUID',{value:randomUUID,configurable:true});
 const writes:any[]=[];
 const api=jest.fn(async(path:string,method?:string,body?:any)=>{
  if(method==='POST'){writes.push({path,body});if(writes.length===1)throw Error('Response lost');return {id:'pub-original'};}
  if(path.startsWith('/coordination/overview'))return {workspaces:[],goals:[],capabilities:{publicationScheduling:true}};
  return {items:[{id:'rssd:pub-original',publicationId:'pub-original',source:'rssd',title:'Original work',workspaceId:'metho',state:'queued',scheduledAt:'2026-11-03T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',hasSchedule:false}],hasNext:false};
 });
 render(<Coordination api={api} workspaceId="metho" view="calendar"/>);
 fireEvent.click(await screen.findByRole('button',{name:'调整排期'}));
 fireEvent.change(screen.getByLabelText('发布时间'),{target:{value:'2026-11-04T10:30'}});
 fireEvent.click(screen.getByRole('button',{name:'保存排期'}));
 await screen.findByText('Response lost');
 fireEvent.click(screen.getByRole('button',{name:'保存排期'}));
 await screen.findByText('原发布排期已保存，未创建新的发布请求。');
 expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);
 expect(writes[0].path).toBe('/publications/pub-original/schedule');
 expect(writes[0].body.expectedUpdatedAt).toBe('2026-11-01T00:00:00.000Z');
 expect(writes[0].body.scheduledAt).toBe(new Date('2026-11-04T10:30').toISOString());
 await waitFor(()=>expect(screen.queryByRole('button',{name:'保存排期'})).toBeNull());
});
