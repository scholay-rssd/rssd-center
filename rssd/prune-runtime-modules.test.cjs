'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {packageName,plan,apply,verify}=require('./prune-runtime-modules.cjs');
const BRIDGE_TARGET=({x64:'x86_64',arm64:'aarch64'}[process.arch]||process.arch)+'-unknown-linux-'+(process.report.getReport().header.glibcVersionRuntime?'gnu':'musl');
function write(root,file,content=''){const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof content==='string'?content:JSON.stringify(content));}
function pkg(root,dir,manifest={},main='module.exports=1;'){write(root,dir+'/package.json',{name:dir.split('node_modules/').pop(),version:'1.0.0',...manifest});write(root,dir+'/index.js',main);}
// A synthetic app: hoisted and nested copies, a scoped package, other platforms,
// build-only compilers, test and demo requires, Next traces and a linked workspace package.
function fixture(t){
 const app=fs.mkdtempSync(path.join(os.tmpdir(),'rssd-prune-'));t.after(()=>fs.rmSync(app,{recursive:true,force:true}));
 const m='node_modules/';
 write(app,'apps/backend/dist/main.js',"require('alpha');require(/* webpackIgnore: true */ 'gamma');require('punycode/');require('node:fs');require('@scope/beta/sub');");
 write(app,'apps/orchestrator/dist/main.js',"import(`delta`).then(()=>{});require('shared');require('@temporalio/core-bridge');");
 write(app,'rssd/tool.cjs',"require('zeta');");
 write(app,'rssd/tool.test.cjs',"require('test-only');");
 write(app,'apps/frontend/next.config.js',"import {wrap} from 'eta';export default wrap({});");
 write(app,'apps/frontend/.next/server/chunks/ssr.js','__turbopack_context__.y("iota");');
 // A route named cache is still traced.
 write(app,'apps/frontend/.next/server/app/cache/page.js.nft.json',{version:1,files:['../../../../../../node_modules/theta/index.js']});
 pkg(app,m+'next',{dependencies:{'@next/env':'1'},optionalDependencies:{'@next/swc-linux-x64-gnu':'1'}});
 pkg(app,m+'@next/env');pkg(app,m+'@next/swc-linux-x64-gnu');
 pkg(app,m+'alpha',{dependencies:{shared:'2'},optionalDependencies:{'other-os':'1'}},"require('shared');require('typescript');");
 write(app,m+'alpha/demos/app.js',"require('demo-only');");
 write(app,m+'alpha/lib/scripts/run.js',"require('lib-scripts');");
 write(app,m+'alpha/index.js.map','{}');write(app,m+'alpha/index.d.ts','export {};');write(app,m+'alpha/data.map','runtime data');
 pkg(app,m+'alpha/node_modules/shared',{version:'2.0.0'});
 pkg(app,m+'shared');
 pkg(app,m+'other-os',{os:['aix']});
 pkg(app,m+'@scope/beta');
 for(const name of ['gamma','punycode','delta','zeta','eta','theta','iota','lib-scripts','test-only','demo-only','unused','typescript'])pkg(app,m+name);
 write(app,m+'typescript/lib/lib.d.ts','declare var fixture: number;');
 pkg(app,m+'@temporalio/core-bridge');write(app,m+'@temporalio/core-bridge/releases/'+BRIDGE_TARGET+'/index.node');write(app,m+'@temporalio/core-bridge/releases/x86_64-pc-windows-msvc/index.node');
 write(app,'libs/linked/index.js');fs.symlinkSync('../libs/linked',path.join(app,m+'linked'));
 return app;
}
test('package names follow how Node reads bare specifiers',()=>{
 for(const [spec,name] of [['fs',null],['node:fs',null],['fs/promises',null],['punycode/','punycode'],['@a/b/c','@a/b'],['lodash/fp','lodash'],['.prisma/client/default','.prisma'],['./x',null],['#internal',null],['https://example.org/x',null],['@scope',null]])
  assert.equal(packageName(spec),name,spec);
});
test('the closure keeps what the built processes load and apply removes the rest',t=>{
 const app=fixture(t),prefix=path.join(app,'runtime-modules');
 plan(app,prefix);
 const keep=new Set(JSON.parse(fs.readFileSync(prefix+'.keep.json','utf8')).keep);
 for(const name of ['next','@next/env','alpha','alpha/node_modules/shared','shared','@scope/beta','gamma','punycode','delta','zeta','eta','theta','iota','lib-scripts','typescript','@temporalio/core-bridge'])assert.ok(keep.has('node_modules/'+name),'kept '+name);
 for(const name of ['@next/swc-linux-x64-gnu','other-os','test-only','demo-only','unused'])assert.ok(!keep.has('node_modules/'+name),'dropped '+name);
 apply(app,prefix+'.keep.json');
 const exists=file=>fs.existsSync(path.join(app,'node_modules',file));
 for(const file of ['unused','demo-only','other-os','@next/swc-linux-x64-gnu','alpha/index.js.map','alpha/index.d.ts'])assert.ok(!exists(file),'removed '+file);
 for(const file of ['alpha/index.js','alpha/data.map','typescript/lib/lib.d.ts','@next/env/index.js'])assert.ok(exists(file),'kept '+file);
 assert.ok(fs.lstatSync(path.join(app,'node_modules/linked')).isSymbolicLink(),'a linked workspace package is left alone');
 assert.equal(exists('@temporalio/core-bridge/releases/x86_64-pc-windows-msvc'),process.platform!=='linux');
 assert.ok(exists('@temporalio/core-bridge/releases/'+BRIDGE_TARGET+'/index.node'));
 assert.equal(verify(app,prefix+'.check.json').verifiedTracedFiles,1);
});
test('verify fails when a nested copy is gone and Node would load the hoisted one',t=>{
 const app=fixture(t),prefix=path.join(app,'runtime-modules');
 plan(app,prefix);apply(app,prefix+'.keep.json');
 fs.rmSync(path.join(app,'node_modules/alpha/node_modules/shared'),{recursive:true});
 assert.throws(()=>verify(app,prefix+'.check.json'),/node_modules\/alpha -> shared \(node_modules\/shared, expected node_modules\/alpha\/node_modules\/shared\)/);
});
