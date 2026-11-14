'use strict';
require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,writeFile,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path');
const {Test}=require('@nestjs/testing');
const {RssdWritingDefaultsController}=require('../apps/backend/dist/apps/backend/src/rssd/rssd.writing-defaults.controller.js');
const {fixture}=require('./writing-defaults.test.cjs');
test('public HTTP reads return the exact published scope without credentials and cannot write',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'writing-http-')),file=join(directory,'active.json');t.after(()=>rm(directory,{recursive:true,force:true}));
 const prior=process.env.RSSD_WRITING_DEFAULTS_FILE;process.env.RSSD_WRITING_DEFAULTS_FILE=file;t.after(()=>{if(prior===undefined)delete process.env.RSSD_WRITING_DEFAULTS_FILE;else process.env.RSSD_WRITING_DEFAULTS_FILE=prior;});
 const catalog=fixture();await writeFile(file,JSON.stringify(catalog));
 const module=await Test.createTestingModule({controllers:[RssdWritingDefaultsController]}).compile();
 const app=module.createNestApplication();app.useLogger(false);await app.listen(0,'127.0.0.1');t.after(()=>app.close());const base=await app.getUrl()+'/rssd/public/v1/writing-defaults';
 const all=await fetch(base);assert.equal(all.status,200);assert.equal(all.headers.get('cache-control'),'no-store');assert.equal((await all.json()).hash,catalog.hash);
 const section=await fetch(base+'/fixture/section');assert.equal(section.status,200);assert.equal((await section.json()).catalogHash,catalog.hash);
 assert.equal((await fetch(base+'/fixture/retired')).status,404);
 assert.equal((await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
});
