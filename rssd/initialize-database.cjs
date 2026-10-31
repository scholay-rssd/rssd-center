'use strict';
const {readFileSync}=require('node:fs'),{join}=require('node:path');
async function initializeDatabase(client,{allow=false,schema=()=>readFileSync(join(__dirname,'postiz-schema.sql'),'utf8')}={}){
 await client.query('BEGIN');
 try{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rssd-empty-database-v1',0))");
  const {rows}=await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()");
  if(rows.some(row=>row.tablename==='Organization')){await client.query('COMMIT');return {initialized:false};}
  if(rows.length)throw Error('Refusing to initialize a non-empty database without the Postiz organization table');
  if(!allow)throw Error('Empty database: set RSSD_INITIALIZE_EMPTY_DATABASE=1 for first installation');
  await client.query(schema());
  await client.query('COMMIT');return {initialized:true};
 }catch(error){await client.query('ROLLBACK');throw error;}
}
async function initializeConfiguredDatabase(){
 const {Client}=require('pg'),client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
 try{return await initializeDatabase(client,{allow:process.env.RSSD_INITIALIZE_EMPTY_DATABASE==='1'});}finally{await client.end();}
}
module.exports={initializeDatabase,initializeConfiguredDatabase};
if(require.main===module)initializeConfiguredDatabase().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error('Database initialization failed:',error.message);process.exitCode=1;});
