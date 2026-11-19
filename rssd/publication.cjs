'use strict';
const p=require('./rssd-v1.cjs');
const {mediaManifest}=require('./rssd-media.cjs');
const {record,recordFields}=require('./rssd-record.cjs');
// The work types a writer chooses between: CHOSEN_WORK_TYPES in work-types.mjs, which a test keeps equal.
const CHOSEN_WORK_TYPES=['article','note'];
// A card set has at most as many pages as the Center stores for one rendition.
const MAX_CARD_PAGES=500;
// A receiver that understands work types, note links and card sets says so in its status; a sender includes
// them only for such a receiver, because a receiver that drops a field returns a different packet hash.
const WORK_TYPES_CAPABILITY='work-types-v1';
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
  // A work's type, and the work a note was rewritten from, cross only when the work states them.
  if(e.metadata.workType!=null){if(!CHOSEN_WORK_TYPES.includes(e.metadata.workType))p.fail('Unsupported work type');metadata.workType=e.metadata.workType;}
  if(e.metadata.adaptedFrom!=null){
    if(metadata.workType!=='note')p.fail('Only a note can be rewritten from an article');
    const source=p.object(e.metadata.adaptedFrom,'adaptedFrom');
    metadata.adaptedFrom={workId:p.id(source.workId,'adaptedFrom workId'),revision:p.integer(source.revision,'adaptedFrom revision',1)};
  }
  return {locale:e.locale,title:e.title,bodyMarkdown:e.bodyMarkdown,summary:e.summary,sources:e.sources,metadata};
}
// A long article paged into cards: the pages in reading order and an optional small cover, made from the
// revision being published. Each page is site media, which the receiver checks and places like any other.
function cardSet(input,revision,content){
  p.object(input,'card set');
  if(content.metadata.workType==='note')p.fail('Only a long article has a card set');
  if(p.integer(input.revision,'card set revision',1)!==revision)p.fail('A card set must be made from the published revision');
  const pages=p.array(input.pages,'card pages',MAX_CARD_PAGES).map(page=>({...mediaManifest(page),width:p.integer(page.width,'card width',1,8192),height:p.integer(page.height,'card height',1,8192)}));
  if(!pages.length)p.fail('A card set needs pages');
  return {revision,pages,...(input.cover!=null?{cover:mediaManifest(input.cover)}:{})};
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
  if(visible&&input.cards!==undefined)value.cards=cardSet(input.cards,value.revision,content);
  return value;
}
const operation=value=>value.operation||'publish';
const visible=value=>['publish','restore'].includes(operation(value));
const contentKey=value=>p.hash([value.workId,value.locale]);
/** Every media file a packet places on the site: the article's own and its card set's. */
const packetMedia=value=>[...(value.assets||[]),...(value.cards?[...value.cards.pages,...(value.cards.cover?[value.cards.cover]:[])]:[])];
module.exports={publication,publicContent,contentKey,route,operation,visible,packetMedia,CHOSEN_WORK_TYPES,MAX_CARD_PAGES,WORK_TYPES_CAPABILITY};
