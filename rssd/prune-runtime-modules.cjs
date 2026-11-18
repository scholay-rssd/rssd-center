'use strict';
// Narrow the image's node_modules to what the running center processes load.
//
// Every dependency lives in the root package.json, so the install stage holds
// the frontend's browser libraries, build tools, test runners and native
// binaries for other platforms beside the server packages (3.5 GB). This keeps
// a conservative closure instead:
//  roots    packages the built backend, orchestrator and rssd scripts require;
//           packages in Next's server traces and .next externals; next itself
//           (pm2 runs `next start`, which also loads next.config.js imports);
//  closure  each kept package's installed dependencies, optionalDependencies
//           and required peers, plus every installed package its runtime files
//           name in a literal require or import (dependencies that resolve only
//           through hoisting). Packages for another os, cpu or libc and the
//           build-only compilers below are dropped.
// Whole package directories are kept, so loading inside a package (Temporal's
// runtime workflow bundling with webpack and swc, Prisma engines, native addons)
// keeps working. Source maps and type declarations, which nothing loads at
// runtime, are removed from the kept packages.
//
//  plan   <app> <prefix>  write <prefix>.keep.json (sorted package directories:
//                         stable across code-only revisions, so the pruned
//                         layer stays cached) and <prefix>.check.json (the
//                         resolutions the closure relies on)
//  apply  <app> <keep>    delete every package directory not kept, then strip
//  verify <app> <check>   every recorded resolution reaches the same copy, and
//                         what the processes load at start loads
const fs=require('node:fs'),path=require('node:path'),{builtinModules}=require('node:module'),{pathToFileURL}=require('node:url');
const BUILTIN=new Set(builtinModules.flatMap(name=>[name,'node:'+name]));
// require/import()/require.resolve calls (comments allowed before the literal),
// Turbopack's external loaders (__turbopack_context__.x/.y), and static imports.
const SPECIFIERS=[/(?:\brequire|__non_webpack_require__|\bimport|\b__turbopack_\w+?(?:\.\w+)?)(?:\.resolve)?\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(["'`])([^"'`\s$]+?)\1/g,/\b(?:import|from)\s*(["'])([^"'\s]+?)\1/g];
const SOURCE=/\.[cm]?js$/;
const APP_ROOTS=['apps/backend/dist','apps/orchestrator/dist','rssd','apps/frontend/.next/server','apps/frontend/next.config.js'];
// rssd/ ships its tests and Jest setup beside the runtime scripts.
const APP_TESTS=/\.(?:test|spec)\.[cm]?js$|(?:^|\/)(?:jest-[\w-]+\.config|ui-environment|ui-style-mock)\.cjs$/;
// Package tests, demos, install scripts, tool configs and development builds never
// run here (NODE_ENV=production): the files stay, their imports are not followed.
// Paths are relative to the package directory.
const NOT_RUNTIME=/^(?:tests?|specs?|demos?|examples?|benchmarks?|fixtures?|scripts)\/|(?:^|\/)(?:__tests__|__mocks__|test-utils)\/|(?:^|\/)(?:[\w-]+\.config|gulpfile|gruntfile|karma\.conf)\.[cm]?js$|\.(?:development|test|spec)\.[cm]?js$/i;
// Compilers that only run in next build: next start serves the compiled .next
// output (Next's own server traces leave @next/swc out) and Sentry's CLI binary
// only uploads source maps during the build.
const BUILD_ONLY=/^@next\/swc-|^@sentry\/cli-/;
const STRIP=/\.(?:[cm]?[jt]sx?|css)\.map$|\.d\.[cm]?ts$/;
const LIBC=process.report.getReport().header.glibcVersionRuntime?'glibc':'musl';
// Temporal's bridge ships its native addon for five platforms and loads releases/<target>/index.node.
const BRIDGE_TARGET=({x64:'x86_64',arm64:'aarch64'}[process.arch]||process.arch)+'-unknown-linux-'+(LIBC==='glibc'?'gnu':'musl');
const OTHER_BRIDGE=new RegExp('(?:^|/)@temporalio/core-bridge/releases/(?!'+BRIDGE_TARGET+'/)[^/]+/');
// What the processes load at start, checked against the pruned modules without the plan.
const STARTUP=['body-parsers','store','publisher','media','migration','editorial','editorial-actions','existing-site-publish'].map(n=>'apps/backend/dist/rssd/'+n+'.cjs')
 .concat(['apps/orchestrator/dist/apps/orchestrator/src/app.module.js','apps/backend/dist/apps/backend/src/app.module.js']);
const WORKFLOWS='apps/orchestrator/dist/apps/orchestrator/src/workflows/index.js';
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const isDir=p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}};
const list=dir=>{try{return fs.readdirSync(dir,{withFileTypes:true});}catch{return [];}};
const posix=p=>p.split(path.sep).join('/');
function allowed(values,actual){
 if(!Array.isArray(values)||!values.length)return true;
 if(values.includes('!'+actual))return false;
 const positive=values.filter(v=>!String(v).startsWith('!'));
 return !positive.length||positive.includes(actual);
}
const supported=pkg=>allowed(pkg.os,process.platform)&&allowed(pkg.cpu,process.arch)&&allowed(pkg.libc,LIBC);
// Source files of an app root (no node_modules anywhere) or of a package (its
// root node_modules holds separate packages; deeper ones belong to it).
function sources(target,packageRoot=false){
 const found=[];
 const walk=(dir,depth)=>{for(const entry of list(dir)){
  const p=path.join(dir,entry.name);
  if(entry.isDirectory()){if(entry.name!=='node_modules'||(packageRoot&&depth>0))walk(p,depth+1);}
  else if(entry.isFile()&&SOURCE.test(entry.name))found.push(p);
 }};
 if(isDir(target))walk(target,0);else if(fs.existsSync(target)&&SOURCE.test(target))found.push(target);
 return found;
}
function specifiers(file){
 let text;try{text=fs.readFileSync(file,'latin1');}catch{return [];}
 const found=new Set();
 for(const pattern of SPECIFIERS)for(const match of text.matchAll(pattern))found.add(match[2]);
 return found;
}
function packageName(spec){
 if(spec==='.'||spec==='..'||spec.startsWith('./')||spec.startsWith('../')||spec.startsWith('/')||spec.startsWith('#'))return null;
 if(/^[a-z][\w+.-]*:/i.test(spec))return null;
 const parts=spec.split('/'),name=spec.startsWith('@')?parts.slice(0,2).join('/'):parts[0];
 // A trailing slash asks for the npm package of a builtin's name (require('punycode/')).
 if(!spec.endsWith('/')&&(BUILTIN.has(name)||BUILTIN.has(spec)))return null;
 if(name==='.'||name==='..'||!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)||(spec.startsWith('@')&&parts.length<2))return null;
 return name;
}
// Node's lookup: <dir>/node_modules/<name> for dir and each of its ancestors.
const cache=new Map();
function resolvePackage(name,fromDir){
 for(let dir=fromDir;;){
  if(path.basename(dir)!=='node_modules'){
   const key=dir+'\0'+name;let hit=cache.get(key);
   if(hit===undefined){const candidate=path.join(dir,'node_modules',name);hit=isDir(candidate)?fs.realpathSync(candidate):null;cache.set(key,hit);}
   if(hit)return hit;
  }
  const parent=path.dirname(dir);if(parent===dir)return null;dir=parent;
 }
}
// The package directory apply visits (a child of a node_modules reached from the top) that holds p.
function packageRoot(p,modules){
 const rel=path.relative(modules,p);
 if(!rel||rel.startsWith('..')||path.isAbsolute(rel))return null;
 const parts=rel.split(path.sep);let root=modules;
 for(let i=0;;){
  const take=parts[i].startsWith('@')?2:1;if(i+take>parts.length)return null;
  root=path.join(root,...parts.slice(i,i+take));i+=take;
  if(parts[i]==='node_modules'&&i+1<parts.length){root=path.join(root,'node_modules');i++;continue;}
  return root;
 }
}
function parentPackage(root,modules){
 let dir=path.dirname(root);if(path.basename(dir).startsWith('@'))dir=path.dirname(dir);
 return dir===modules?null:packageRoot(path.dirname(dir),modules);
}
function packages(modules){
 const found=[];
 for(const entry of list(modules)){
  if(entry.name==='.bin'||!(entry.isDirectory()||entry.isSymbolicLink()))continue;
  const p=path.join(modules,entry.name);
  const roots=entry.name.startsWith('@')&&entry.isDirectory()?list(p).filter(c=>c.isDirectory()||c.isSymbolicLink()).map(c=>path.join(p,c.name)):[p];
  for(const root of roots)found.push(root,...packages(path.join(root,'node_modules')));
 }
 return found;
}
function size(root){
 let total=0;
 const walk=(dir,depth)=>{for(const entry of list(dir)){const p=path.join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='node_modules'||depth>0)walk(p,depth+1);}else if(entry.isFile())total+=fs.lstatSync(p).size;}};
 walk(root,0);return total;
}
function plan(app,prefix){
 cache.clear();app=fs.realpathSync(app);
 const modules=path.join(app,'node_modules'),frontend=path.join(app,'apps/frontend'),label=p=>posix(path.relative(app,p));
 const kept=new Map(),queue=[],checks=new Set(),traced=new Set();
 function keep(dir,why){
  const root=dir&&packageRoot(dir,modules);
  if(!root||kept.has(root)||!isDir(root))return;
  const pkg=readJson(path.join(root,'package.json'));
  if(pkg&&(!supported(pkg)||BUILD_ONLY.test(pkg.name||'')))return;
  const parent=parentPackage(root,modules);if(parent)keep(parent,'contains '+label(root));
  kept.set(root,why);queue.push(root);
 }
 function need(fromDir,name,why,recordFrom){
  const dir=resolvePackage(name,fromDir);if(!dir)return;
  keep(dir,why);
  const root=packageRoot(dir,modules);
  if(root&&kept.has(root)&&resolvePackage(name,recordFrom)===dir)checks.add(label(recordFrom)+'\0'+name+'\0'+label(dir));
 }
 function scan(file,why,recordFrom){
  for(const spec of specifiers(file)){
   const name=packageName(spec);
   if(name)need(path.dirname(file),name,why,recordFrom??path.dirname(file));
   else if(spec.startsWith('./')||spec.startsWith('../'))keep(path.resolve(path.dirname(file),spec),why);
  }
 }
 for(const root of APP_ROOTS)for(const file of sources(path.join(app,root)))if(!APP_TESTS.test(label(file)))scan(file,'app '+label(file));
 need(frontend,'next','pm2 frontend: next start',frontend);
 const traces=dir=>{for(const entry of list(dir)){
  const p=path.join(dir,entry.name);
  if(entry.isDirectory()&&entry.name!=='node_modules')traces(p);
  else if(entry.isFile()&&entry.name.endsWith('.nft.json'))for(const f of readJson(p)?.files||[]){
   let real;try{real=fs.realpathSync(path.resolve(dir,f));}catch{continue;}
   if(packageRoot(real,modules))traced.add(label(real));
   keep(real,'traced by '+label(p));
  }
 }};
 traces(path.join(frontend,'.next'));
 // Turbopack links server externals as .next/node_modules/<name>-<hash>.
 for(const link of packages(path.join(frontend,'.next/node_modules'))){try{keep(fs.realpathSync(link),'next external '+label(link));traced.add(label(link));}catch{}}
 while(queue.length){
  const dir=queue.shift(),pkg=readJson(path.join(dir,'package.json'))||{};
  // Optional peers are left to the literal-require scan below.
  const peers=Object.keys(pkg.peerDependencies||{}).filter(name=>!pkg.peerDependenciesMeta?.[name]?.optional);
  for(const [kind,names] of [['dependency',Object.keys(pkg.dependencies||{})],['optional',Object.keys(pkg.optionalDependencies||{})],['peer',peers]])
   for(const name of names)need(dir,name,kind+' of '+label(dir),dir);
  for(const file of sources(dir,true))if(!NOT_RUNTIME.test(posix(path.relative(dir,file))))scan(file,'required by '+label(file),dir);
 }
 // Files apply removes on purpose, or of a dropped package, are not expected afterwards.
 const files=[...traced].filter(f=>{const root=packageRoot(path.join(app,f),modules);return !STRIP.test(f)&&!OTHER_BRIDGE.test(f)&&(!root||kept.has(root));}).sort();
 fs.writeFileSync(prefix+'.keep.json',JSON.stringify({keep:[...kept.keys()].map(label).sort()},null,1)+'\n');
 fs.writeFileSync(prefix+'.check.json',JSON.stringify({resolve:[...checks].sort().map(c=>c.split('\0')),files})+'\n');
 const all=packages(modules).map(p=>[p,size(p)]),mb=n=>Math.round(n/1048576);
 const keptBytes=all.filter(([p])=>kept.has(p)).reduce((t,[,s])=>t+s,0),total=all.reduce((t,[,s])=>t+s,0);
 const largest=all.filter(([p])=>kept.has(p)).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([p,s])=>mb(s)+'M '+label(p)+' <- '+kept.get(p));
 return {packages:all.length,kept:kept.size,totalMB:mb(total),keptMB:mb(keptBytes),largest};
}
function apply(app,keepFile){
 app=fs.realpathSync(app);
 const modules=path.join(app,'node_modules'),keep=new Set(readJson(keepFile)?.keep||[]);
 if(!keep.size)throw Error('Refusing to prune with an empty keep list');
 let removed=0,stripped=0;
 const visit=dir=>{
  let real=dir;try{real=fs.realpathSync(dir);}catch{}
  // A link out of node_modules (a linked workspace package) is not a package to prune.
  if(fs.lstatSync(dir).isSymbolicLink()&&path.relative(modules,real).startsWith('..'))return;
  if(keep.has(posix(path.relative(app,dir)))||keep.has(posix(path.relative(app,real)))){prune(path.join(dir,'node_modules'));return;}
  fs.rmSync(dir,{recursive:true,force:true});removed++;
 };
 const prune=dir=>{for(const entry of list(dir)){
  if(entry.name==='.bin'||!(entry.isDirectory()||entry.isSymbolicLink()))continue;
  const p=path.join(dir,entry.name);
  if(entry.name.startsWith('@')&&entry.isDirectory()){for(const child of list(p))if(child.isDirectory()||child.isSymbolicLink())visit(path.join(p,child.name));if(!fs.readdirSync(p).length)fs.rmdirSync(p);}
  else visit(p);
 }};
 prune(modules);
 // TypeScript reads its own lib declarations when it compiles.
 const strip=dir=>{for(const entry of list(dir)){
  const p=path.join(dir,entry.name);
  if(entry.isDirectory()){if(!(entry.name==='typescript'&&path.basename(dir)==='node_modules'))strip(p);}
  else if(entry.isFile()&&STRIP.test(entry.name)){fs.rmSync(p);stripped++;}
 }};
 strip(modules);
 for(const dir of packages(modules)){
  const releases=path.join(dir,'releases');
  if(process.platform==='linux'&&readJson(path.join(dir,'package.json'))?.name==='@temporalio/core-bridge'&&isDir(path.join(releases,BRIDGE_TARGET)))
   for(const entry of list(releases))if(entry.name!==BRIDGE_TARGET)fs.rmSync(path.join(releases,entry.name),{recursive:true,force:true});
 }
 return {removedPackages:removed,strippedFiles:stripped,kept:keep.size};
}
function verify(app,checkFile){
 const check=readJson(checkFile);
 if(!check?.resolve?.length)throw Error('Missing resolution checks: '+checkFile);
 cache.clear();app=fs.realpathSync(app);
 const missing=[];
 // The same copy, not merely some copy: a lost nested version must not fall back to the hoisted one.
 for(const [from,name,target] of check.resolve){const dir=resolvePackage(name,path.join(app,from));if(!dir||posix(path.relative(app,dir))!==target)missing.push(from+' -> '+name+' ('+(dir?posix(path.relative(app,dir)):'missing')+', expected '+target+')');}
 for(const file of check.files)if(!fs.existsSync(path.join(app,file)))missing.push('traced '+file);
 if(missing.length)throw Error('Pruned node_modules lost '+missing.length+' resolutions:\n'+missing.slice(0,50).join('\n'));
 return {verifiedResolutions:check.resolve.length,verifiedTracedFiles:check.files.length};
}
async function startup(app){
 for(const file of STARTUP)require(path.join(app,file));
 await import(pathToFileURL(path.join(app,'apps/frontend/next.config.js')).href);
 const {bundleWorkflowCode}=require(require.resolve('@temporalio/worker',{paths:[path.join(app,'apps/orchestrator')]}));
 const quiet={log(){},trace(){},debug(){},info(){},warn(){},error:console.error};
 const bundle=await bundleWorkflowCode({workflowsPath:path.join(app,WORKFLOWS),logger:quiet});
 return {startupModules:STARTUP.length+1,workflowBundleBytes:bundle.code.length};
}
module.exports={packageName,plan,apply,verify,startup};
if(require.main===module){
 const [mode,app,file]=process.argv.slice(2);
 const run={plan:()=>plan(path.resolve(app),path.resolve(file)),apply:()=>apply(path.resolve(app),path.resolve(file)),
  verify:async()=>({...verify(path.resolve(app),path.resolve(file)),...await startup(path.resolve(app))})}[mode];
 if(!run||!app||!file){console.error('Usage: prune-runtime-modules.cjs plan|apply|verify <app> <file>');process.exitCode=2;}
 // The backend's modules open Redis while loading; exit once the checks are done.
 else Promise.resolve().then(run).then(result=>{console.log(JSON.stringify(result,null,1));process.exit(0);},error=>{console.error(error.message);process.exit(1);});
}
