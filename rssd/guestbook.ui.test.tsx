import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {GuestbookModeration} from '../apps/frontend/src/components/rssd/guestbook';
afterEach(cleanup);
test('moderation shows private details only in the owner view and posts the exact selected message',async()=>{
 const calls:any[]=[];let status='pending';const api=async(path:string,method?:string,body?:any)=>{
  calls.push([path,method,body]);if(path==='/guestbooks')return [{siteId:'fixture',workspaceId:'research',enabled:true,config:{name:'Fixture',forms:[{id:'message',label:'交流',fields:[]}]}}];
  if(method==='POST'){status=body.status;return {ok:true};}
  return {messages:status==='pending'?[{id:'message-1',name:'Synthetic',kind:'message',message:'A suggestion',contact:'private@example.org',details:{},created:1,status}]:[]};
 };
 render(<GuestbookModeration api={api} workspaceId="research"/>);await screen.findByText('A suggestion');expect(screen.getByText('联系方式：private@example.org')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'公开',exact:true}));await waitFor(()=>expect(screen.queryByText('A suggestion')).toBeNull());
 expect(calls.some(([path,method,body])=>path==='/guestbooks/fixture/messages/message-1/review'&&method==='POST'&&body.status==='approved')).toBe(true);
});
