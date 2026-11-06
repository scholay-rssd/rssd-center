'use strict';
const {mkdir,readFile,open,rename,rm}=require('node:fs/promises');
const {join,resolve}=require('node:path');
const {randomUUID}=require('node:crypto');
const p=require('./protocol.cjs'),m=require('./rssd-media.cjs');
const referencedCenterMediaIds=p.referencedMediaIds;
class RssdMedia {
 constructor(store,{directory,origin}={}){this.store=store;this.directory=resolve(directory||'/config/rssd/media');this.origin=origin?new URL(origin).origin:'';}
 path(orgId,manifest){return join(this.directory,p.hash(orgId),manifest.path.split('/').at(-1));}
 view(row){const path='/api/rssd/v1/media/'+row.id+'/raw';return {id:row.id,workspaceId:row.workspaceId,manifest:row.manifest,name:row.name,url:this.origin+path};}
 async row(ctx,id){p.id(id);const row=(await this.store.db.$queryRawUnsafe('SELECT * FROM rssd_media WHERE "orgId"=$1 AND id=$2',ctx.orgId,id))[0];if(!row)p.fail('Media not found',404,'not_found');await this.store.workspace(this.store.db,ctx,row.workspaceId);return row;}
 async status(ctx,id){return this.view(await this.row(ctx,id));}
 async bytes(ctx,id){const row=await this.row(ctx,id),bytes=await readFile(this.path(ctx.orgId,row.manifest));if(p.hash(m.imageManifest(bytes))!==p.hash(row.manifest))p.fail('Stored media checksum mismatch',409,'media_conflict');return {bytes,row};}
 async upload(ctx,input){
  const workspaceId=p.id(input.workspaceId);await this.store.workspace(this.store.db,ctx,workspaceId);
  const {bytes,manifest}=m.decodeImage(input),id=m.mediaId(workspaceId,manifest.sha256),name=p.text(input.name||id,'media name',300);
  const file=this.path(ctx.orgId,manifest),directory=join(this.directory,p.hash(ctx.orgId));await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID(),handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{await rename(temporary,file);}finally{await rm(temporary,{force:true});}
  return this.store.transaction(async db=>{
   if(ctx.workerId){const worker=await db.$queryRawUnsafe('SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL',ctx.orgId,ctx.workerId);if(!worker.length)p.fail('Device revoked',401);}
   const [row]=await db.$queryRawUnsafe(`INSERT INTO rssd_media ("orgId",id,"workspaceId",name,manifest) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT ("orgId",id) DO UPDATE SET id=EXCLUDED.id RETURNING *`,ctx.orgId,id,workspaceId,name,JSON.stringify(manifest));
   if(row.workspaceId!==workspaceId||p.hash(row.manifest)!==p.hash(manifest))p.fail('Media identity conflict',409,'media_conflict');return this.view(row);
  });
 }
 async publication(orgId,workspaceId,edition){
  const ctx={orgId,admin:true,workspaceIds:null},assets=[],uploads=[];let bodyMarkdown=edition.bodyMarkdown;
  const ids=[...new Set([...(edition.media||[]).map(item=>item.id),...referencedCenterMediaIds(bodyMarkdown)])];
  for(const id of ids){
   const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const reference=new RegExp('(?:https?:\\/\\/[^/\\s)]+)?/api/rssd/v1/media/'+escaped+'/raw','g');
   if(!reference.test(bodyMarkdown))continue;reference.lastIndex=0;
   const row=await this.row(ctx,id);if(row.workspaceId!==workspaceId)p.fail('Publication media belongs to a different workspace',403);
   if(!assets.some(a=>a.sha256===row.manifest.sha256)){assets.push(row.manifest);uploads.push({manifest:row.manifest,id:row.id});}
   bodyMarkdown=bodyMarkdown.replace(reference,row.manifest.path);
  }
  if(/\/api\/rssd\/v1\/media\//.test(bodyMarkdown))p.fail('Article references media missing from its edition manifest',400,'missing_media');
  return {edition:{...edition,bodyMarkdown},assets,uploads};
 }
}
module.exports={RssdMedia,referencedCenterMediaIds};
