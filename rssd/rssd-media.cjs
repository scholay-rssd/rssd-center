'use strict';
const {createHash}=require('node:crypto');
const p=require('./rssd-v1.cjs');
const MAX_BYTES=20*1024*1024,extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
function mediaManifest(input){
 p.object(input,'media');const sha256=p.text(input.sha256,'media sha256',64),mime=p.text(input.mime,'media MIME',50),bytes=p.integer(input.bytes,'media bytes',1);
 if(!/^[a-f0-9]{64}$/.test(sha256)||!extensions[mime]||bytes>MAX_BYTES)p.fail('Unsupported image or invalid media manifest');
 return {sha256,mime,bytes,path:'/article-media/'+sha256+'.'+extensions[mime]};
}
function imageManifest(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES)p.fail('Image exceeds the 20 MiB limit');
 const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
 if(!mime)p.fail('Only PNG, JPEG and WebP images are accepted');
 return mediaManifest({sha256:createHash('sha256').update(bytes).digest('hex'),mime,bytes:bytes.length});
}
function decodeImage(input){
 if(typeof input?.data!=='string'||input.data.length>Math.ceil(MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))p.fail('Invalid base64 image');
 const bytes=Buffer.from(input.data,'base64');if(bytes.toString('base64')!==input.data)p.fail('Invalid base64 encoding');
 const actual=imageManifest(bytes),expected=mediaManifest(input);
 if(p.hash(actual)!==p.hash(expected))p.fail('Image checksum or type mismatch',409,'media_conflict');return {bytes,manifest:actual};
}
const mediaId=(workspaceId,sha256)=>'media-'+p.hash([p.id(workspaceId),sha256]).slice(0,48);
module.exports={MAX_BYTES,mediaManifest,imageManifest,decodeImage,mediaId};
