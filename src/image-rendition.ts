import type {Env} from './env';
import {AppError,LIMITS,readBounded,sha256} from './core';
import {jpegStructure} from './jpeg';
export const IMAGE_RENDITION_VERSION='image-readable-v1' as const;
export const IMAGE_CAPTURE_BYTES=20971520;
export const IMAGE_RENDITION_PARAMETERS=Object.freeze({width:2048,height:2048,fit:'scale-down' as const,quality:85});
export interface ImageRendition {version:typeof IMAGE_RENDITION_VERSION;originalHash:string;originalMime:string;originalSize:number;hash:string;mime:'image/jpeg';size:number;parameters:typeof IMAGE_RENDITION_PARAMETERS}
export function needsImageRendition(bytes:Uint8Array,mime:string){
 if(['image/heic','image/heif'].includes(mime)||bytes.length>LIMITS.mediaBytes)return true;
 const jpeg=mime==='image/jpeg'?jpegStructure(bytes):null;
 if(jpeg)return jpeg.width>4096||jpeg.height>4096||jpeg.width*jpeg.height>12000000;
 if(mime==='image/png'&&bytes.length>=24){const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),w=d.getUint32(16),h=d.getUint32(20);return w>4096||h>4096||w*h>12000000;}
 return false;
}
export async function createImageRendition(env:Env,bytes:Uint8Array,mime:string):Promise<{bytes:Uint8Array;metadata:ImageRendition}|null>{
 if(!needsImageRendition(bytes,mime))return null;
 if(!env.IMAGES)throw new AppError('image_normalization_unconfigured',503);
 let timer:ReturnType<typeof setTimeout>|undefined;
 const work=(async()=>{
  let result:ImageTransformationResult;
  try{result=await env.IMAGES!.input(new Response(bytes).body!).transform({width:2048,height:2048,fit:'scale-down'}).output({format:'image/jpeg',quality:85});}
  catch{throw new AppError('image_normalization_failed',502);}
  const rendered=await readBounded(result.image(),LIMITS.mediaBytes),dimensions=jpegStructure(rendered);
  if(result.contentType()!=='image/jpeg'||!dimensions||dimensions.width>2048||dimensions.height>2048)throw new AppError('image_normalization_invalid',502);
  return {bytes:rendered,metadata:{version:IMAGE_RENDITION_VERSION,originalHash:await sha256(bytes),originalMime:mime,originalSize:bytes.length,hash:await sha256(rendered),mime:'image/jpeg' as const,size:rendered.length,parameters:IMAGE_RENDITION_PARAMETERS}};
 })();
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('image_normalization_timeout',504)),30000);})]);}
 finally{clearTimeout(timer);}
}
export function parseImageRendition(text:string):ImageRendition{
 const r=JSON.parse(text) as ImageRendition;
 if(!r||r.version!==IMAGE_RENDITION_VERSION||r.mime!=='image/jpeg'||!Number.isSafeInteger(r.size)||r.size<1||r.size>LIMITS.mediaBytes||!Number.isSafeInteger(r.originalSize)||r.originalSize<1||r.originalSize>IMAGE_CAPTURE_BYTES||!/^image\/(heic|heif|jpeg|png|webp)$/.test(r.originalMime)||!/^([a-f0-9]{64})$/.test(r.originalHash)||!/^([a-f0-9]{64})$/.test(r.hash)||JSON.stringify(r.parameters)!==JSON.stringify(IMAGE_RENDITION_PARAMETERS))throw new AppError('image_rendition_invalid',409);
 return r;
}
