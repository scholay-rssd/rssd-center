'use strict';
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{PrismaClient}=require('@prisma/client');
async function main(){
 await require('./initialize-database.cjs').initializeConfiguredDatabase();
 const db=new PrismaClient();try{
  // Only additive RSSD DDL runs at startup. Postiz's existing schema is preserved.
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('rssd-schema-v1',0))");
   for(const sql of readFileSync(join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await tx.$executeRawUnsafe(sql);
  },{timeout:60000});
 }finally{await db.$disconnect();}
}
main().catch(error=>{console.error('RSSD schema initialization failed:',error.message);process.exitCode=1;});
