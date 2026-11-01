'use strict';
const p=require('./rssd-v1.cjs');
const {mediaManifest}=require('./rssd-media.cjs');
const {record,recordFields}=require('./rssd-record.cjs');
function route(value) {
  if(typeof value!=='string'||!/^\/(?:[A-Za-z0-9_\-\u0080-\uFFFF]+\/)+$/.test(value)||value.length>1000)p.fail('Invalid public article route');
  if(/^\/(?:manage|api|rssd-content|article-media|downloads|assets|fonts)\//.test(value))p.fail('Reserved public route');
  return value;
}
// Only explicitly public metadata crosses the publishing boundary. Prompts,
// notebooks, credentials, raw model output and source archives stay at center.
function publicContent(edition) {
  const e=p.edition(edition),metadata={};
  for(const key of ['author','date','category'])if(e.metadata[key]!=null)metadata[key]=p.text(e.metadata[key],key,500,true);
  if(e.metadata.record){metadata.record=record(e.metadata.record);recordFields(metadata.record,e);}
  return {locale:e.locale,title:e.title,bodyMarkdown:e.bodyMarkdown,summary:e.summary,sources:e.sources,metadata};
}
function publication(input) {
  p.object(input,'publication');if(input.version!==1)p.fail('Unsupported publication version');
  const operation=input.operation||'publish';if(!['publish','withdraw','delete','restore'].includes(operation))p.fail('Unsupported publication operation');
  const visible=operation==='publish'||operation==='restore',content=visible?publicContent(input.content):null;
  const value={version:1,requestId:p.id(input.requestId),siteId:p.id(input.siteId),workspaceId:p.id(input.workspaceId),sectionId:p.id(input.sectionId),
    workId:p.id(input.workId),locale:p.locale(input.locale),revision:p.integer(input.revision,'revision',visible?1:0),
    contentHash:p.text(input.contentHash,'contentHash',64),...(visible?{content}:{}),route:route(input.route)};
  if(visible&&value.locale!==content.locale||!/^[a-f0-9]{64}$/.test(value.contentHash))p.fail('Publication content identity mismatch');
  // Omitted fields preserve the existing v1 publish packet and its hash.
  if(operation!=='publish')Object.assign(value,{operation,operationSequence:p.integer(input.operationSequence,'operationSequence',1),expectedOperationSequence:p.integer(input.expectedOperationSequence,'expectedOperationSequence',0),expectedRevision:p.integer(input.expectedRevision,'expectedRevision',0)});
  else if(input.operationSequence!==undefined)value.operationSequence=p.integer(input.operationSequence,'operationSequence',1);
  if(visible&&input.assets!==undefined){value.assets=p.array(input.assets,'public media',500).map(mediaManifest);if(new Set(value.assets.map(a=>a.sha256)).size!==value.assets.length)p.fail('Duplicate public media');}
  return value;
}
const operation=value=>value.operation||'publish';
const visible=value=>['publish','restore'].includes(operation(value));
const contentKey=value=>p.hash([value.workId,value.locale]);
module.exports={publication,publicContent,contentKey,route,operation,visible};
