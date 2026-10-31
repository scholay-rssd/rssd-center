// Fixed official routes/costs, verified 2026-10-05. Only this service's traffic
// labels use these endpoints; no caller-provided URL, seed, price or interval.
import {claimLabelDispatch} from './labels-store.mjs';
const INTERVAL=4*3600_000;
const metric=(label,value)=>{
  if(value==null||value==='')return null;
  if((typeof value!=='number'&&typeof value!=='string')||!/^\d+(?:\.\d+)?$/.test(String(value))||!Number.isFinite(Number(value)))return null;
  return {label,value:String(value),unit:''};
};
const array=(value)=>{if(!Array.isArray(value)||!value.length||value.length>200)throw Error('官方标签列表结构无效');return value;};
const plainTerm=value=>{
  if(typeof value!=='string')throw Error('官方标签名称缺失');
  // Zhihu topic names contain highlight-only markup in its documented search
  // response. Strip that wrapper, never read news/question titles instead.
  return value.replace(/<\/?em>/gi,'');
};
function envelope(body){if(body?.code!==200||!body.data||typeof body.data!=='object')throw Error('标签 provider 响应未成功');return body.data;}
export function decodeTikHubLabels(platformId,body){
  const data=envelope(body);let rows;
  if(platformId==='bilibili'){
    if(data.code!==0)throw Error('哔哩哔哩标签响应未成功');
    rows=array(data.data?.trending?.list).map((row,index)=>({term:row.keyword,kind:'热门搜索词',rank:index+1,metric:metric('搜索热度',row.heat_score),url:null}));
  }else if(platformId==='douyin'){
    if(data.status_code!==0)throw Error('抖音话题响应未成功');
    rows=array(data.item_list).map((row,index)=>({term:row.title,kind:'近7天科技话题',rank:index+1,metric:metric('话题热度',row.hot_score),url:null}));
  }else if(platformId==='kuaishou'){
    if(data.result!==1)throw Error('快手搜索榜响应未成功');
    rows=array(data.hots).map((row,index)=>({term:row.keyword,kind:'热门搜索词',rank:index+1,metric:metric('搜索热度',row.hotValue),url:null}));
  }else if(platformId==='xiaohongshu'){
    if(data.ok!==true||data.success!==true||data.code!==1000)throw Error('小红书搜索词响应未成功');
    rows=array(data.data?.sug_items).filter(row=>row.type==='top_note'&&row.search_type==='notes').map(row=>({term:row.text,kind:'科研相关搜索词',rank:null,metric:null,url:null}));
  }else if(platformId==='weibo'){
    rows=array(data.data).filter(row=>row.is_top===false&&Number.isSafeInteger(row.rank)&&row.rank>0).map(row=>({term:row.keyword,kind:'热门搜索词',rank:row.rank,metric:metric('热度',row.heat),url:null}));
  }else if(platformId==='toutiao'){
    if(data.BaseResp?.StatusCode!==0)throw Error('头条关键词响应未成功');
    // Live output repeats index=100/growth=50 across all rows. These fields
    // must never be exposed as observed traffic or reconstructed as metrics.
    rows=array(data.hot_words).map((row,index)=>({term:row.keyword,kind:'热门关键词',rank:index+1,metric:null,url:null}));
  }else if(platformId==='zhihu'){
    rows=array(data.data).filter(row=>row.type==='search_result'&&row.object?.type==='topic').map(row=>({term:plainTerm(row.object.name),kind:'科研相关话题',rank:null,metric:null,url:/^\d{1,30}$/.test(String(row.object.id))?'https://www.zhihu.com/topic/'+row.object.id:null}));
  }else throw Error('未知官方标签平台');
  // Keep the provider's original list order; remove exact duplicate terms
  // within one type rather than inventing traffic/ranks for suggestion lists.
  const seen=new Set();rows=rows.filter(row=>{const key=JSON.stringify([row.kind,row.term]);if(seen.has(key))return false;seen.add(key);return true;}).slice(0,100);
  if(!rows.length)throw Error('官方标签列表为空');
  return {period:platformId==='douyin'?'近7天':null,rows};
}
const endpoint=(id,platformId,path,maxCostMicros,boardLabel,query={})=>Object.freeze({id,platformId,path,maxCostMicros,boardLabel,query:Object.freeze(query),intervalMs:INTERVAL,decode:body=>decodeTikHubLabels(platformId,body)});
export const LABEL_ENDPOINTS=Object.freeze([
  endpoint('bilibili-search','bilibili','/api/v1/bilibili/web/fetch_hot_search',1000,'热门搜索词',{limit:50}),
  endpoint('douyin-science-topics','douyin','/api/v1/douyin/creator/fetch_creator_hot_topic_billboard',1000,'科技话题 · 近7天',{billboard_tag:336,order_key:1,time_filter:2}),
  endpoint('kuaishou-search','kuaishou','/api/v1/kuaishou/web/fetch_kuaishou_hot_list_v2',1000,'热门搜索词',{board_type:6}),
  endpoint('xiaohongshu-research-suggest','xiaohongshu','/api/v1/xiaohongshu/web_v3/fetch_search_suggest',10000,'科研相关搜索词',{keyword:'科研'}),
  endpoint('weibo-hot-search','weibo','/api/v1/weibo/web_v2/fetch_hot_search_summary',1500,'热门搜索词'),
  endpoint('toutiao-keywords','toutiao','/api/v1/douyin/index/fetch_hot_words',1000,'热门关键词',{app_name:'toutiao'}),
  endpoint('zhihu-research-topics','zhihu','/api/v1/zhihu/web/fetch_topic_search_v3',1000,'科研相关话题',{keyword:'科研',offset:0,limit:25}),
]);

async function boundedJson(response,maxBytes=2*1024*1024){
  if(!response.ok)throw Error('标签 provider 返回失败状态');
  const reader=response.body?.getReader();if(!reader)throw Error('标签 provider 响应不可读');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('标签 provider 响应超过上限');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createTikHubProvider({db,token=process.env.SCHOLAY_TIKHUB_KEY,fetcher=fetch}={}){
  if(!db||typeof db.prepare!=='function')throw Error('标签 provider 必须绑定预算账本');
  if(typeof token!=='string'||!token.trim())throw Error('云端标签凭据未配置');
  const quotes=new Map();
  const allowedEndpoint=endpoint=>{
    const allowed=LABEL_ENDPOINTS.find(item=>item.id===endpoint.id);
    if(!allowed||allowed!==endpoint||typeof allowed.decode!=='function'||!/^\/api\/v1\/[a-zA-Z0-9/_-]+$/.test(allowed.path||''))throw Error('官方标签端点不在白名单');
    return allowed;
  };
  async function validateEndpoint(endpoint){
    const allowed=allowedEndpoint(endpoint);
    const url=new URL('/api/v1/tikhub/user/get_endpoint_info','https://api.tikhub.io');url.searchParams.set('endpoint',allowed.path);
    // Never attach the paid credential to this anonymous price request.
    const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000)});
    const body=await boundedJson(response,64*1024),cost=body?.data?.endpoint_cost;
    const micros=Math.round(Number(cost)*1_000_000);
    if(body?.code!==200||body.data?.endpoint_uri!==allowed.path||(typeof cost!=='number'&&typeof cost!=='string')||!Number.isFinite(Number(cost))||Number(cost)>allowed.maxCostMicros/1_000_000||!Number.isSafeInteger(micros)||micros<1||micros>allowed.maxCostMicros)throw Error('官方标签费用已变化或未确认');
    quotes.set(allowed.id,Date.now());
  }
  return {validateEndpoint,async collect(endpoint,{signal,requestId}){
    const allowed=allowedEndpoint(endpoint);
    // Direct internal calls must satisfy the same gate as the collector. A
    // quote authorizes just one paid request; retries need a fresh price check.
    if(!quotes.has(allowed.id)||Date.now()-quotes.get(allowed.id)>30_000)await validateEndpoint(allowed);
    quotes.delete(allowed.id);
    // An internal caller cannot bypass or reuse the durable budget reservation.
    claimLabelDispatch(db,requestId,allowed);
    const url=new URL(allowed.path,'https://api.tikhub.io');
    for(const [key,value] of Object.entries(allowed.query||{}))url.searchParams.set(key,String(value));
    const response=await fetcher(url,{method:'GET',headers:{Authorization:'Bearer '+token.trim()},redirect:'error',signal});
    return allowed.decode(await boundedJson(response));
  }};
}
