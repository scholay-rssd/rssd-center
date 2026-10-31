'use strict';
const fs=require('node:fs/promises'),{PrismaClient}=require('@prisma/client');
const {RssdStore}=require('./store.cjs'),{RssdGuestbook}=require('./guestbook.cjs');
async function main(){
 const [operation,orgId,privateFile]=process.argv.slice(2);
 if(!['import','activate'].includes(operation)||!orgId||!privateFile)throw Error('Usage: guestbook-cli.cjs import|activate ORGANIZATION PRIVATE-CONFIG.json');
 const config=JSON.parse(await fs.readFile(privateFile,'utf8')),db=new PrismaClient();
 try{
  if((await db.$queryRawUnsafe('SELECT id FROM "Organization" WHERE id=$1',orgId)).length!==1)throw Error('Organization not found');
  const service=new RssdGuestbook(new RssdStore(db),{secret:process.env.RSSD_ENCRYPTION_KEY||process.env.JWT_SECRET}),ctx={orgId,admin:true,workspaceIds:null,userId:'migration-operator'};
  console.log(JSON.stringify(operation==='import'?await service.importLegacy(ctx,JSON.parse(await fs.readFile(config.archive,'utf8')),config.proxyToken):await service.activate(ctx,config.siteId,config.sourceHash,config)));
 }finally{await db.$disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
