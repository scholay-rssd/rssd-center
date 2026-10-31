'use strict';
// Started only after the previous collector has been stopped and its complete
// SQLite ledger handed over. The HTTP service never imports this worker.
const fs=require('node:fs/promises'),{setTimeout:pause}=require('node:timers/promises');
const {configuration}=require('./labels.cjs');
async function main(){
 const config=await configuration();if(config.collectionEnabled!==true)throw Error('Labels collection is not enabled after handoff');
 const tokenInfo=await fs.stat(config.tokenFile);if(tokenInfo.size>8192||tokenInfo.mode&0o077)throw Error('Labels token must be private');
 const token=(await fs.readFile(config.tokenFile,'utf8')).trim();
 const {openLabelsStore}=await import('./legacy-labels/labels-store.mjs'),{createTikHubProvider}=await import('./legacy-labels/labels-provider.mjs'),{createLabelsCollector}=await import('./legacy-labels/labels-collector.mjs');
 const db=openLabelsStore(config.database),collector=createLabelsCollector({db,provider:createTikHubProvider({db,token})});let stopping=false;
 const wake=new AbortController();for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;wake.abort();});
 try{while(!stopping){
  const current=await configuration();if(current.orgId!==config.orgId||current.database!==config.database||current.collectionEnabled!==true)break;
  await collector.runOnce();console.log('Labels collection cycle finished');
  if(!stopping)await pause(60000,null,{signal:wake.signal}).catch(()=>{});
 }}finally{db.close();}
}
main().catch(()=>{console.error('Labels collector stopped; inspect the private configuration and preserved ledger');process.exitCode=1;});
