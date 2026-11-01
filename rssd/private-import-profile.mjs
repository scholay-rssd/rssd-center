// Explicit grant-bound archive description. It never accepts patterns or globs.
const SHA=/^[a-f0-9]{64}$/;
const rootName=value=>typeof value==='string'&&value.length>0&&value.length<=255&&!value.includes('/')&&!value.includes('\\')&&!/[\x00-\x1f\x7f]/.test(value)&&!['.','..'].includes(value);
const size=value=>Number.isSafeInteger(value)&&value>=0&&value<=16*1024*1024;
export function validateSourceProfile(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='inventoryPath,metadataExceptions,unlistedMetadata,version'||value.version!==1||!rootName(value.inventoryPath)||value.inventoryPath==='MANIFEST.json')throw Error('Invalid source profile');
 const names=new Set(['MANIFEST.json',value.inventoryPath]);
 for(const [kind,keys] of [['metadataExceptions',['actualBytes','actualSha256','expectedBytes','expectedSha256','path']],['unlistedMetadata',['bytes','path','sha256']]]){
  const list=value[kind];if(!Array.isArray(list)||list.length>16)throw Error('Invalid source profile');
  for(const item of list){
   if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!==keys.join(',')||!rootName(item.path)||names.has(item.path))throw Error('Invalid source profile');names.add(item.path);
   if(kind==='metadataExceptions'){
    if(!size(item.expectedBytes)||!size(item.actualBytes)||!SHA.test(item.expectedSha256)||!SHA.test(item.actualSha256)||(item.expectedBytes===item.actualBytes&&item.expectedSha256===item.actualSha256))throw Error('Invalid source profile');
   }else if(!size(item.bytes)||!SHA.test(item.sha256))throw Error('Invalid source profile');
  }
 }
 return JSON.parse(JSON.stringify(value));
}
