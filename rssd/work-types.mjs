// What kind of work a work is, what each section takes, and which pages a work has on its site. Shared by the
// writing tools, the Center and the website, so it uses no Node or browser API.
//
// A work has one type in every language. The writer chooses between a long article and a short note from
// what the section takes; calendar entries, historical events and resources keep the type their record kind
// fixes. A section that declares nothing takes long articles only and gives them no card page, which is how
// every site works today.
//
// Cards are of two sorts. A long article paged into cards is the same work: its card page is a second view,
// linked both ways with the article page and never shown on the same page. A card version rewritten for a
// platform is a note of its own, linked to the article it was rewritten from.

export const WORK_TYPES=Object.freeze({
 article:Object.freeze({chosen:true,label:Object.freeze({'zh-CN':'长文',en:'Article'})}),
 note:Object.freeze({chosen:true,label:Object.freeze({'zh-CN':'笔记',en:'Note'})}),
 event:Object.freeze({chosen:false,kinds:Object.freeze(['year','history']),label:Object.freeze({'zh-CN':'日程与历史',en:'Event'})}),
 resource:Object.freeze({chosen:false,kinds:Object.freeze(['openSource']),label:Object.freeze({'zh-CN':'资源',en:'Resource'})}),
});
/** The types a writer chooses between; the others follow from the record kind. */
export const CHOSEN_WORK_TYPES=Object.freeze(Object.keys(WORK_TYPES).filter(type=>WORK_TYPES[type].chosen));
/** What a section takes when it declares nothing. */
export const DEFAULT_WORK_TYPES=Object.freeze(['article']);
/** The states of an article edition's card page, in the order the work moves through them. */
export const CARD_STATES=Object.freeze(['waived','absent','pending','stale','present']);
/** The path segment of a long article's card page, under the article's own route. */
export const CARDS_SEGMENT='cards';
/** The most pages one card set may have; the Center stores no more. */
export const MAX_CARD_PAGES=500;
/** How many #tags a writer may give a work, and how long each may be. */
export const MAX_WORK_TAGS=10,MAX_TAG_LENGTH=40;
const ARTICLE_ID=/^[a-z0-9][a-z0-9-]{2,99}$/,SITE_MEDIA=/^\/article-media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/;

const fail=message=>{throw Object.assign(Error(message),{statusCode:400});};

/** A type's name for readers and writers; the English name when the locale has none. */
export function workTypeLabel(type,locale='zh-CN'){
 if(!Object.hasOwn(WORK_TYPES,type))fail('Unknown work type: '+type);
 return WORK_TYPES[type].label[locale]||WORK_TYPES[type].label.en;
}

/**
 * What a section takes: the work types a writer may choose there (the first is the default) and whether its
 * long articles get a card page on the website (`articleCards`). Readers, such as a site or a device syncing
 * the section catalog, leave `strict` off: a type they do not know is dropped, so a newer catalog never stops an
 * older client. Whoever writes the setting, and the build that publishes it, turns `strict` on and gets an error
 * that names the problem.
 */
export function sectionWorkPolicy(section,{strict=false}={}){
 const declared=section?.workTypes,cards=section?.articleCards;
 let workTypes=DEFAULT_WORK_TYPES;
 if(declared!==undefined){
  if(!Array.isArray(declared)||!declared.length){if(strict)fail('workTypes must list at least one work type');}
  else{
   const known=[...new Set(declared.filter(type=>CHOSEN_WORK_TYPES.includes(type)))];
   if(strict&&known.length!==declared.length)fail('workTypes may only list '+CHOSEN_WORK_TYPES.join(' and ')+', each once');
   if(known.length)workTypes=Object.freeze(known);
  }
 }
 if(strict&&cards!==undefined&&typeof cards!=='boolean')fail('articleCards must be true or false');
 if(strict&&cards===true&&!workTypes.includes('article'))fail('articleCards needs a section that takes articles');
 return Object.freeze({workTypes,defaultType:workTypes[0],articleCards:cards===true&&workTypes.includes('article')});
}

/**
 * The type of one work. `kind` is its record kind (news, year, history or openSource); `workType` is what the
 * writer chose, if anything. Without a choice a work takes its section's default. A choice the section does not
 * take is refused, never replaced with another type.
 */
export function workTypeOf({kind='news',workType}={},policy=sectionWorkPolicy()){
 const chosen=workType!==undefined&&workType!==null;
 const fixed=Object.keys(WORK_TYPES).find(type=>WORK_TYPES[type].kinds?.includes(kind));
 if(fixed){if(chosen&&workType!==fixed)fail('A '+kind+' record is always of type '+fixed);return fixed;}
 if(kind!=='news')fail('Unknown record kind: '+kind);
 if(!chosen)return policy.defaultType;
 if(!CHOSEN_WORK_TYPES.includes(workType))fail('Unknown work type: '+workType);
 if(!policy.workTypes.includes(workType))fail('This section does not take '+workTypeLabel(workType,'en').toLowerCase()+'s');
 return workType;
}

/**
 * The link a note keeps to the long article it was rewritten from: that article's ID and the revision the note
 * was written from, so a later revision of the article can be noticed. Only a note carries it. Returns the
 * normalized link, or undefined when there is none.
 */
export function validateAdaptedFrom(value,{type,articleId}={}){
 if(value===undefined||value===null)return undefined;
 if(type!=='note')fail('Only a note can be rewritten from an article');
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['articleId','revision'].includes(key)))fail('adaptedFrom names an article and the revision it was written from');
 if(!ARTICLE_ID.test(value.articleId||''))fail('adaptedFrom needs the article ID');
 if(!Number.isSafeInteger(value.revision)||value.revision<1)fail('adaptedFrom needs the revision the note was written from');
 if(articleId!==undefined&&value.articleId===articleId)fail('A note cannot be rewritten from itself');
 return {articleId:value.articleId,revision:value.revision};
}

/**
 * Both directions of the links between notes and the articles they were rewritten from, for the works published
 * on one site. Each work is {articleId, type, revision?, adaptedFrom?}. `notesOf` maps an article to its notes,
 * each marked `outdated` when the article has a newer revision than the one the note was written from. A link to
 * something that is not a published article is listed in `missing`, never guessed.
 */
export function adaptationIndex(works){
 const byId=new Map(works.map(work=>[work.articleId,work])),notesOf=new Map(),missing=[];
 for(const note of works){
  if(!note.adaptedFrom)continue;
  const article=byId.get(note.adaptedFrom.articleId);
  if(!article||article.type!=='article'){missing.push({articleId:note.articleId,adaptedFrom:note.adaptedFrom.articleId});continue;}
  if(!notesOf.has(article.articleId))notesOf.set(article.articleId,[]);
  notesOf.get(article.articleId).push({articleId:note.articleId,outdated:Number.isSafeInteger(article.revision)&&article.revision>note.adaptedFrom.revision});
 }
 return {notesOf,missing};
}

/**
 * The #tags a writer gives a work, in order: each a short phrase without the leading #, each once. The site shows
 * them after the tags bound to the work in its organization file. Returns the tags, or undefined when there are none.
 */
export function validateWorkTags(value){
 if(value===undefined||value===null)return undefined;
 if(!Array.isArray(value)||value.length>MAX_WORK_TAGS)fail('A work has at most '+MAX_WORK_TAGS+' tags');
 for(const tag of value)if(typeof tag!=='string'||!tag||tag!==tag.trim()||tag.length>MAX_TAG_LENGTH||tag.startsWith('#')||/[\x00-\x1f]/.test(tag))fail('A tag is a phrase of up to '+MAX_TAG_LENGTH+' characters, without spaces around it or a leading #');
 if(new Set(value).size!==value.length)fail('Each tag is given once');
 return value.length?[...value]:undefined;
}

/**
 * A card set as a site publishes it with an article edition: its pages in reading order, each a picture in the
 * site's own media store, an optional small cover, and the edition revision it was made from. Only a long
 * article has one; a note's pictures are its content. Returns the normalized set, or undefined when there is
 * none.
 */
export function validateCardSet(value,{type}={}){
 if(value===undefined||value===null)return undefined;
 if(type!=='article')fail('Only a long article has a card set');
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['revision','pages','cover'].includes(key)))fail('A card set has pages, and may name its revision and cover');
 if(value.revision!==undefined&&(!Number.isSafeInteger(value.revision)||value.revision<1))fail('A card set revision is a whole number from 1');
 if(!Array.isArray(value.pages)||!value.pages.length||value.pages.length>MAX_CARD_PAGES)fail('A card set has 1 to '+MAX_CARD_PAGES+' pages');
 const picture=(item,what)=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||!SITE_MEDIA.test(item.src||''))fail(what+' must be a picture in the site media store');
  const sized=item.width!==undefined||item.height!==undefined;
  if(sized&&!(Number.isSafeInteger(item.width)&&item.width>0&&Number.isSafeInteger(item.height)&&item.height>0))fail(what+' needs a whole width and height');
  return {src:item.src,...(sized?{width:item.width,height:item.height}:{})};
 };
 return {...(value.revision!==undefined?{revision:value.revision}:{}),pages:value.pages.map((page,index)=>picture(page,'Card '+(index+1))),...(value.cover!==undefined?{cover:picture(value.cover,'The cover')}:{})};
}

/**
 * Where an article edition's card page stands. `revision` is the edition's current revision; `sets` are the card
 * sets the Center lists for that edition, each with the revision it was made from; `pending` says a card job is
 * queued. A note, and an article in a section without card pages, is `waived`: its pictures are its content.
 */
export function articleCardState({type,policy=sectionWorkPolicy(),revision,sets=[],pending=false}){
 if(type!=='article'||!policy.articleCards)return 'waived';
 if(sets.some(set=>set.revision===revision))return 'present';
 if(pending)return 'pending';
 return sets.length?'stale':'absent';
}

/**
 * The pages a work has on its site, in the order a reader meets them. A long article gets its card page only
 * while a card set for its current revision is there: cards made from an earlier revision may say what the
 * article no longer says. A note is one page. Other types keep their article page.
 */
export function workPages({type,cardState='waived'}){
 if(type==='note')return ['note'];
 return type==='article'&&cardState==='present'?['article','cards']:['article'];
}

/** The card page's route for an article edition's route: /news/<id>/ becomes /news/<id>/cards/. */
export function cardsRoute(route){
 if(typeof route!=='string'||!/^\/(?!\/)[^?#\\]*\/$/.test(route)||route.includes('..'))fail('A card page needs the article route');
 return route+CARDS_SEGMENT+'/';
}
