import React from 'react';
import {render,screen,cleanup} from '@testing-library/react';
import {SWRConfig} from 'swr';
import {RssdHome} from '../apps/frontend/src/components/rssd/home';
import {GROUPS,pick} from '../apps/frontend/src/components/rssd/downloads';
const asset=(name:string,size=2*1024*1024)=>({name,size,browser_download_url:'https://github.com/scholay-rssd/fixture/releases/download/x/'+name});
const plugin=[{tag_name:'0.2.9',html_url:'https://github.com/scholay-rssd/rssd-obsidian/releases/tag/0.2.9',prerelease:false,draft:false,published_at:'2026-11-20T04:31:36Z',
 assets:['main.js','manifest.json','release.json','rssd-starter-vault-0.2.9.zip'].map(name=>asset(name))}];
const app=[
 {tag_name:'v0.17.0',html_url:'draft',prerelease:false,draft:true,published_at:'2026-11-21T00:00:00Z',assets:[asset('rssd-0.17.0-windows-x64-setup.exe')]},
 {tag_name:'v0.16.15-rc.1',html_url:'notes-only',prerelease:true,draft:false,published_at:'2026-11-20T00:00:00Z',assets:[asset('SHA256SUMS.txt')]},
 {tag_name:'v0.16.14-rc.1',html_url:'https://github.com/scholay-rssd/rssd/releases/tag/v0.16.14-rc.1',prerelease:true,draft:false,published_at:'2026-11-19T09:56:48Z',
  assets:['rssd-0.16.14-macos-arm64-development.zip','rssd-0.16.14-macos-x64-development.zip','rssd-0.16.14-windows-x64-setup.exe','rssd-headless-0.16.14-darwin-arm64.tar.gz','rssd-headless-0.16.14-darwin-x64.tar.gz','rssd-headless-0.16.14-linux-x64.tar.gz','SHA256SUMS.txt'].map(name=>asset(name))},
];
const group=(id:string)=>GROUPS.find(g=>g.id===id)!;
const show=()=>render(<SWRConfig value={{provider:()=>new Map()}}><RssdHome initialMode="light"/></SWRConfig>);
afterEach(()=>{cleanup();delete (global as any).fetch;});

test('each download group takes the newest published release that has its files, and keeps desktop and CLI files apart',()=>{
 expect(pick(plugin as any,group('obsidian'))!.links.map(l=>l.label)).toEqual(['入门 vault','main.js','manifest.json']);
 const desktop=pick(app as any,group('desktop'))!,cli=pick(app as any,group('cli'))!;
 expect(desktop.version).toBe('0.16.14-rc.1');expect(desktop.prerelease).toBe(true);
 expect(desktop.links.map(l=>l.url.split('/').pop())).toEqual(['rssd-0.16.14-macos-arm64-development.zip','rssd-0.16.14-macos-x64-development.zip','rssd-0.16.14-windows-x64-setup.exe','SHA256SUMS.txt']);
 expect(cli.links.map(l=>l.url.split('/').pop())).toEqual(['rssd-headless-0.16.14-darwin-arm64.tar.gz','rssd-headless-0.16.14-darwin-x64.tar.gz','rssd-headless-0.16.14-linux-x64.tar.gz','SHA256SUMS.txt']);
 expect(pick([] as any,group('cli'))).toBeNull();
});

test('the home page links every download to GitHub and offers sign-in only, never registration',async()=>{
 const urls:string[]=[];
 (global as any).fetch=jest.fn(async(url:string)=>{urls.push(url);return {ok:true,json:async()=>url.includes('rssd-obsidian')?plugin:app};});
 show();
 const vault=await screen.findByRole('link',{name:/入门 vault/});
 expect(vault.getAttribute('href')).toMatch(/^https:\/\/github\.com\/.+rssd-starter-vault-0\.2\.9\.zip$/);
 await screen.findByRole('link',{name:/Windows/});
 for(const link of screen.getAllByRole('link'))expect(link.getAttribute('href')).toMatch(/^(https:\/\/github\.com\/|\/|#)/);
 expect(urls.every(url=>url.startsWith('https://api.github.com/repos/scholay-rssd/'))).toBe(true);
 expect(screen.getAllByText('预发布')).toHaveLength(2);
 expect(screen.getAllByRole('link',{name:/登录/}).every(link=>link.getAttribute('href')==='/auth/login')).toBe(true);
 expect(screen.queryByText(/注册账号|Sign Up/)).toBeNull();
 expect(document.body.textContent).not.toMatch(/Postiz/);
});

test('when GitHub cannot be read the page still points to the releases',async()=>{
 (global as any).fetch=jest.fn(async()=>({ok:false,status:403,json:async()=>({})}));
 show();
 const links=await screen.findAllByRole('link',{name:'前往 GitHub Releases'});
 expect(links.map(link=>link.getAttribute('href'))).toEqual(['https://github.com/scholay-rssd/rssd-obsidian/releases','https://github.com/scholay-rssd/rssd/releases','https://github.com/scholay-rssd/rssd/releases']);
});
