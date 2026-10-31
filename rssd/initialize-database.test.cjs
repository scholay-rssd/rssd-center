'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {Client}=require('pg'),{randomUUID}=require('node:crypto');
const {initializeDatabase}=require('./initialize-database.cjs');
test('offline initialization requires an empty database and leaves existing content unchanged',async()=>{
 const config=process.env.RSSD_TEST_DATABASE_URL_FILE?JSON.parse(fs.readFileSync(process.env.RSSD_TEST_DATABASE_URL_FILE,'utf8')):{connectionString:process.env.RSSD_TEST_DATABASE_URL};
 const database=config.database||new URL(config.connectionString).pathname.slice(1);if(!/^rssd_.*test/.test(database))throw Error('Dedicated test database required');
 const client=new Client(config),schema='rssd_init_'+randomUUID().replaceAll('-','');await client.connect();
 try{
  await client.query('CREATE SCHEMA '+schema);await client.query('SET search_path TO '+schema);
  await assert.rejects(initializeDatabase(client),/first installation/);
  assert.deepEqual(await initializeDatabase(client,{allow:true}),{initialized:true});
  const tables=await client.query("SELECT count(*) FROM pg_tables WHERE schemaname=current_schema()");assert(Number(tables.rows[0].count)>80);
  assert.deepEqual(await initializeDatabase(client,{allow:true,schema:()=>{throw Error('Existing tables must not be rebuilt');}}),{initialized:false});
  await client.query('SET search_path TO public');await client.query('DROP SCHEMA '+schema+' CASCADE');await client.query('CREATE SCHEMA '+schema);await client.query('SET search_path TO '+schema);
  await client.query('CREATE TABLE preserved(value text)');await client.query("INSERT INTO preserved VALUES ('untouched')");
  await assert.rejects(initializeDatabase(client,{allow:true}),/non-empty/);assert.equal((await client.query('SELECT value FROM preserved')).rows[0].value,'untouched');
 }finally{await client.query('SET search_path TO public');await client.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await client.end();}
});
