import type {Env} from './env';
import {AppError,sha256} from './core';
import {readCaptureSnapshot} from './assistant-source-reader';
import {sourceRef} from '../assistant/source-proof-contract';
import type {ApprovedSendScope} from './approved-send-contract';
export type OwnerToolProvenance={origins:{sourceKind:'message'|'media'|'derivative';sourceId:string;chatId:string;sourceVersion:number|null;observationHash:string}[];canonicalRefs:{id:string;revision:number;version:number;hash:string}[]};
export const emptyOwnerToolProvenance=():OwnerToolProvenance=>({origins:[],canonicalRefs:[]});
/** Server-generated MCP results only. Never accepts model-supplied provenance. */
export async function ownerToolProvenance(env:Env,scope:ApprovedSendScope,tool:string,result:unknown):Promise<OwnerToolProvenance>{
 const provenance=emptyOwnerToolProvenance(),r=result as {isError?:boolean;content?:{type:string;text?:string}[]};
 if(r.isError)return provenance;
 const values=(r.content??[]).filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text!);}catch{return null;}}).filter(Boolean);
 const fail=()=>{throw new AppError('owner_tool_provenance_unavailable',409);};
 async function origin(kind:'message'|'media'|'derivative',id:string,chatId:string,version:number|null,text?:string,truncated=false){
  if(typeof id!=='string'||typeof chatId!=='string'||version!==null&&(!Number.isSafeInteger(version)||version<1))fail();
  const snapshot=await readCaptureSnapshot(env,{secret:env.ASSISTANT_READER_SECRET,sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:kind,sourceId:id,chatId});
  if(snapshot.state!=='available'||snapshot.sourceVersion!==version||!snapshot.access||!snapshot.content)fail();
  if(text!==undefined&&(typeof snapshot.content!.text!=='string'||(truncated?!snapshot.content!.text.startsWith(text):snapshot.content!.text!==text)))fail();
  const observationHash=await sha256(JSON.stringify([snapshot.sourceVersion??null,snapshot.access,snapshot.content]));
  provenance.origins.push({sourceKind:kind,sourceId:id,chatId,sourceVersion:version,observationHash});
 }
 async function media(id:string){
  const m=await env.DB.prepare('SELECT chat_id,version,message_id FROM media WHERE id=? AND epoch=? AND generation=? AND deleted_at IS NULL').bind(id,scope.sourceEpoch,scope.sourceGeneration).first<{chat_id:string;version:number;message_id:string|null}>();
  if(!m)fail();
  // Uploaded/generated files have no capture-origin; their metadata contains no
  // captured message text and is linked by the current authenticated command.
  if(m!.message_id)await origin('media',id,m!.chat_id,m!.version);
 }
 if(tool==='consultar_mensagens'||tool==='exportar_conversa'){
  if(values.length!==1||!Array.isArray(values[0].items))fail();
  for(const item of values[0].items){
   if(typeof item.text==='string')await origin('message',item.id,item.chatId,item.version,item.text,item.textTruncated===true);
   if(typeof item.transcription?.text==='string'){
    const derivative=await env.DB.prepare(`SELECT d.id,d.media_version FROM media_derivatives d JOIN media m ON m.id=d.media_id AND m.version=d.media_version AND m.epoch=d.epoch AND m.generation=d.generation WHERE m.id=? AND m.message_id=? AND m.message_version=? AND d.kind='transcript' AND d.state='ready' AND d.epoch=? AND d.generation=?`).bind(item.mediaId,item.id,item.version,scope.sourceEpoch,scope.sourceGeneration).first<{id:string;media_version:number}>();
    if(!derivative)fail();await origin('derivative',derivative!.id,item.chatId,null,item.transcription.text,item.transcription.truncated===true);
   }
  }
 }
 if(tool==='transcrever_audio'){
  const v=values[0];if(!v||typeof v.id!=='string'||typeof v.text!=='string')fail();
  const d=await env.DB.prepare(`SELECT m.chat_id,d.media_version FROM media_derivatives d JOIN media m ON m.id=d.media_id AND m.version=d.media_version AND m.epoch=d.epoch AND m.generation=d.generation WHERE d.id=? AND d.epoch=? AND d.generation=? AND d.state='ready'`).bind(v.id,scope.sourceEpoch,scope.sourceGeneration).first<{chat_id:string;media_version:number}>();
  if(!d)fail();await origin('derivative',v.id,d!.chat_id,null,v.text);
 }
 if(tool==='consultar_midia'||tool==='obter_midia'){
  const v=values[0],m=v?.metadata??v;if(!m||typeof m.id!=='string')fail();await media(m.id);
 }
 if(tool.startsWith('assistente_')){
  const seen=new Set<string>();
  function refs(value:unknown){
   if(!value||typeof value!=='object')return;
   const row=value as Record<string,unknown>,parsed=sourceRef.safeParse({id:row.id,revision:row.revision,version:row.version,hash:row.hash});
   if(parsed.success){const key=JSON.stringify(parsed.data);if(!seen.has(key)){seen.add(key);provenance.canonicalRefs.push(parsed.data);}}
   for(const entry of Object.values(row))refs(entry);
  }
  for(const v of values)refs(v);
 }
 return provenance;
}
