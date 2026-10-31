import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openLabelsStore,configureLabelPlatforms,noteLabelWorker,reserveLabelRequest,completeLabelRequest,uncertainLabelRequest,recoverLabelRequests,validateLabelEndpoint,labelPreflightFailure} from './labels-store.mjs';
import {LABEL_ENDPOINTS,createTikHubProvider} from './labels-provider.mjs';

export function createLabelsCollector({db,endpoints=LABEL_ENDPOINTS,provider,clock=Date.now,timeoutMs=30_000}){
  if(!provider||typeof provider.collect!=='function')throw Error('标签 provider 未配置');
  const whitelist=new Map();
  for(const endpoint of endpoints){validateLabelEndpoint(endpoint);if(whitelist.has(endpoint.id))throw Error('重复标签端点');whitelist.set(endpoint.id,endpoint);}
  configureLabelPlatforms(db,endpoints);
  async function collect(endpointId){
    const endpoint=whitelist.get(endpointId);
    if(!endpoint)throw Error('标签端点不在费用白名单');
    // Official metadata is anonymous/free. A price increase or uncertain quote
    // blocks the paid request before a reservation is made.
    if(provider.validateEndpoint){
      try{await provider.validateEndpoint(endpoint);}catch{labelPreflightFailure(db,endpoint.platformId);return {status:'price_unavailable'};}
    }
    const reservation=reserveLabelRequest(db,endpoint,clock());
    if(!reservation.accepted)return {status:reservation.reason};
    const {request}=reservation;
    const controller=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('标签采集超时'));},timeoutMs);});
    try{
      const result=await Promise.race([provider.collect(endpoint,{requestId:request.id,signal:controller.signal}),timeout]);
      const snapshot=completeLabelRequest(db,request.id,result,{now:clock()});
      return {status:'success',snapshot};
    }catch{
      // The provider may have charged even if transport or decoding failed.
      uncertainLabelRequest(db,request.id,clock());
      return {status:'uncertain',requestId:request.id};
    }finally{clearTimeout(timer);}
  }
  async function runOnce(){
    recoverLabelRequests(db,clock());
    noteLabelWorker(db,{configured:true,now:clock(),message:'云端采集按平台计划更新'});
    const results=[];for(const endpoint of whitelist.values())results.push({platformId:endpoint.platformId,...await collect(endpoint.id)});
    return results;
  }
  return {collect,runOnce};
}
export async function runLabelsWorker({dbPath=process.env.SCHOLAY_LABELS_DB||'/var/lib/scholay-admin/labels.sqlite'}={}){
  const db=openLabelsStore(dbPath);
  try{
    const provider=createTikHubProvider({db});
    return await createLabelsCollector({db,provider}).runOnce();
  }catch{
    noteLabelWorker(db,{configured:false,message:'云端采集配置未完成，已有缓存可继续读取'});
    throw Error('云端标签采集配置或费用白名单不可用');
  }finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const results=await runLabelsWorker();process.stdout.write(JSON.stringify({results})+'\n');}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
