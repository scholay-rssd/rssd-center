'use strict';
const p=require('./rssd-v1.cjs');
const {mediaManifest}=require('./rssd-media.cjs');
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
  return {locale:e.locale,title:e.title,bodyMarkdown:e.bodyMarkdown,summary:e.summary,sources:e.sources,metadata};
}
function publication(input) {
  p.object(input,'publication');if(input.version!==1)p.fail('Unsupported publication version');
  const content=publicContent(input.content);
  const value={version:1,requestId:p.id(input.requestId),siteId:p.id(input.siteId),workspaceId:p.id(input.workspaceId),sectionId:p.id(input.sectionId),
    workId:p.id(input.workId),locale:p.locale(input.locale),revision:p.integer(input.revision,'revision',1),
    contentHash:p.text(input.contentHash,'contentHash',64),content,route:route(input.route)};
  if(value.locale!==content.locale||!/^[a-f0-9]{64}$/.test(value.contentHash))p.fail('Publication content identity mismatch');
  if(input.assets!==undefined){value.assets=p.array(input.assets,'public media',500).map(mediaManifest);if(new Set(value.assets.map(a=>a.sha256)).size!==value.assets.length)p.fail('Duplicate public media');}
  return value;
}
const contentKey=value=>p.hash([value.workId,value.locale]);
module.exports={publication,publicContent,contentKey,route};
