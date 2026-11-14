'use strict';
// Serves only a compiled public GitHub rule bundle, never workspace data.
const {readFile,writeFile,mkdir,rename}=require('node:fs/promises');
const {dirname,join}=require('node:path');
const {randomUUID}=require('node:crypto');
const rules=require('./writing-defaults-v1.cjs');
const {ProtocolError}=require('./protocol.cjs');
class WritingDefaults {
 constructor({file=process.env.RSSD_WRITING_DEFAULTS_FILE||'/config/rssd-writing-defaults/active.json'}={}){this.file=file;}
 async catalog(){
  try{const bytes=await readFile(this.file);if(bytes.length>1000000)throw Error('size');return rules.catalog(JSON.parse(bytes));}
  catch{throw new ProtocolError('Published writing defaults are unavailable',503,'writing_defaults_unavailable');}
 }
 async resolve(workspaceId,sectionId){
  try{return rules.resolve(await this.catalog(),workspaceId,sectionId);}
  catch(e){if(e.status)throw e;throw new ProtocolError('Enabled writing scope not found',404,'writing_defaults_scope');}
 }
 async freeze(demand){
  // Old claims and non-writing continuations retain their previous contract.
  if(demand.payload?.writingDefaults)return rules.snapshot(demand.payload.writingDefaults,{workspaceId:demand.workspaceId,sectionId:demand.sectionId});
  if(demand.kind!=='write'||demand.generation>0)return null;
  const c=await this.catalog();return rules.resolve(c,demand.workspaceId,demand.sectionId);
 }
}
function validateWritingDelivery(edition,baseline){
 if(!baseline)return;
 const n=edition.metadata?.notebook,ref=edition.metadata?.writingDefaults;
 if(ref?.baselineHash!==baseline.hash||ref?.catalogHash!==baseline.catalogHash||ref?.sourceCommit!==baseline.source.commit)throw new ProtocolError('Writing baseline does not match the original claim',409,'writing_defaults_conflict');
 let effective;try{effective=rules.compose(baseline,{origin:ref.adjustmentOrigin||'local',...(ref.imageAdjustment?{images:ref.imageAdjustment}:{})});}catch{throw new ProtocolError('Writing adjustment is invalid',400,'writing_defaults_conflict');}
 const issues=rules.deliveryIssues(n,effective);
 for(const b of n?.blocks||[])if(b.type==='image'&&b.state==='ready'&&!edition.bodyMarkdown.includes(b.text))issues.push('Notebook image is absent from public body');
 if(issues.length)throw new ProtocolError(issues.join('; '),400,'writing_delivery_incomplete');
}
async function publish(file,target){
 const bytes=await readFile(file);if(bytes.length>1000000)throw Error('Writing catalog is too large');
 const value=rules.catalog(JSON.parse(bytes));await mkdir(dirname(target),{recursive:true});
 const archive=join(dirname(target),value.hash+'.json');
 try{const old=await readFile(archive,'utf8');if(rules.hash(JSON.parse(old))!==rules.hash(value))throw Error('Immutable writing version changed');}
 catch(e){if(e.code!=='ENOENT')throw e;await writeFile(archive,JSON.stringify(value)+'\n',{flag:'wx',mode:0o644});}
 const temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o644});await rename(temporary,target);
 return {version:value.version,catalogHash:value.hash,source:value.source};
}
module.exports={WritingDefaults,publish,validateWritingDelivery};
if(require.main===module){const [, ,cmd,input,target]=process.argv;if(cmd!=='publish'||!input||!target){console.error('Usage: node writing-defaults.cjs publish <catalog.json> <active.json>');process.exitCode=1;}else publish(input,target).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});}
