'use strict';
// Local operator command. The authenticated database connection never enters a browser or a public artifact.
const {PrismaClient}=require('@prisma/client');
const {RssdStore}=require('./store.cjs'),{RssdMedia}=require('./media.cjs'),{RssdMigration}=require('./migration.cjs');
async function main(){
 const [operation,orgId,directory,evidenceFile]=process.argv.slice(2);if(!['import','inspect','reconcile','activate'].includes(operation)||!orgId||!directory)throw Error('Usage: migration-cli.cjs import ORGANIZATION PRIVATE-MIGRATION-DIRECTORY | inspect ORGANIZATION SITE | reconcile|activate ORGANIZATION SITE PRIVATE-EVIDENCE.json');
 const db=new PrismaClient();
 try{
  const org=await db.$queryRawUnsafe('SELECT id FROM "Organization" WHERE id=$1',orgId);if(org.length!==1)throw Error('Organization not found');
  const store=new RssdStore(db),media=new RssdMedia(store,{directory:process.env.RSSD_MEDIA_DIRECTORY});
  const migration=new RssdMigration(store,media),ctx={orgId,admin:true,workspaceIds:null,userId:'migration-operator'};
  const report=operation==='import'?await migration.import(ctx,directory):operation==='inspect'?await migration.inspect(ctx,directory):await migration[operation](ctx,directory,JSON.parse(await require('node:fs/promises').readFile(evidenceFile,'utf8')));
  console.log(JSON.stringify(report));
 }finally{await db.$disconnect();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
