import {sourceRef} from '../source-proof-contract';
import {SourceAccess,type AccessGuard} from '../access';
import type {AssistantEnv} from '../env';
import {scopeKeys,type OriginGuard,type OriginScope} from '../origin-guard';
import {MediaContext} from '../media';
import {createMediaModelPort} from '../media-model';
import type {ConversationRuntime,TaskContext} from './conversation';
import type {NativeConversationRetention} from './conversation-retention';
import {assertReadExposureCurrent} from '../knowledge/read-exposure';
import {nativeModelSelection} from './conversation-model';

/** Model-chosen perception, reusing the installed image/PDF pipeline. The
 * original binary's parent remains the evidence; OCR is explicitly derived. */
export function nativeMediaCapability(options:{env:AssistantEnv;task:TaskContext;runtime:ConversationRuntime;retention:NativeConversationRetention;origin:OriginGuard;getScope:()=>OriginScope;authorityGuard:()=>AccessGuard;modelGuard:()=>AccessGuard}){
 const {env,task,runtime,retention,origin}=options,scope={...task.knowledge.scope},db=env.DB!,access=new SourceAccess(db,scope,Date.now,'knowledge');
 return {async read(raw:unknown){
  const ref=sourceRef.parse(raw);await runtime.assertTaskCurrent(task);
  if(env.MEDIA_CONTEXT_ENABLED!=='true'||!env.CAPTURE_MEDIA_READER)return {state:'unavailable',reason:'media_context_unconfigured'};
  const selected=nativeModelSelection(env);if(!selected.apiKey)return {state:'unavailable',reason:'media_context_unconfigured'};
  const read=await access.read({kind:'owner'},ref.id,ref.revision);if(!read||read.fence.source.version!==ref.version||read.fence.source.hash!==ref.hash||read.fence.source.origin!=='whatsapp')throw Error('native_media_source_unavailable');
  const fence=await origin.fence(ref.id);if(!fence||(await origin.checkContext(fence)).state!=='current')throw Error('native_media_source_changed');
  let parentRef=ref,parentRead=read,parentFence=fence,captionEvidence:unknown;
  if(fence.sourceKind==='message'){
   const caption=await origin.observe(options.getScope(),fence),attachment=caption.content?.media;
   if(caption.state!=='available'||!attachment||!['image','pdf'].includes(String(caption.content?.kind)))return {state:'pending',reason:'media_attachment_pending'};
   const file=await db.prepare(`SELECT canonical_id FROM assistant_source_origins WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND source_kind='media' AND source_id=? AND chat_id=? AND tombstoned=0`)
    .bind(...scopeKeys(options.getScope()),attachment.id,fence.chatId).first<{canonical_id:string}>();
   if(!file)return {state:'pending',reason:'media_attachment_pending'};
   const fileRead=await access.read({kind:'owner'},file.canonical_id),fileFence=await origin.fence(file.canonical_id);
   if(!fileRead||!fileFence||(await origin.checkContext(fileFence)).state!=='current')throw Error('native_media_source_changed');
   const observed=await origin.observe(options.getScope(),fileFence),body=observed.content;
   if(observed.state!=='available'||fileFence.chatId!==fence.chatId||body?.messageId!==caption.content?.messageId||body?.messageVersion!==caption.content?.messageVersion||body?.media?.id!==attachment.id||body.media.version!==attachment.version||body.media.hash!==attachment.hash)throw Error('native_media_attachment_changed');
   if(typeof caption.content?.text==='string'&&caption.content.text!==read.text)throw Error('native_media_attachment_changed');
   captionEvidence=typeof caption.content?.text==='string'?{state:'available',sourceRef:ref,text:caption.content.text}:{state:'absent'};
   parentRead=fileRead;parentFence=fileFence;parentRef={id:fileRead.fence.source.id,revision:fileRead.fence.source.revision,version:fileRead.fence.source.version,hash:fileRead.fence.source.hash};
  }
  const exposure={sources:parentRef.id===ref.id?[read.fence]:[read.fence,parentRead.fence],origins:parentRef.id===ref.id?[fence]:[fence,parentFence]};
  if(parentFence.sourceKind==='media'&&fence.sourceKind!=='message'){
   const file=await origin.observe(options.getScope(),parentFence),messageId=file.content?.messageId;
   const paired=typeof messageId==='string'?await db.prepare(`SELECT canonical_id FROM assistant_source_origins WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND source_kind='message' AND source_id=? AND chat_id=? AND tombstoned=0`)
    .bind(...scopeKeys(options.getScope()),messageId,parentFence.chatId).first<{canonical_id:string}>():null;
   const pairedRead=paired?await access.read({kind:'owner'},paired.canonical_id):null,pairedFence=paired?await origin.fence(paired.canonical_id):null;
   if(pairedRead&&pairedFence&&(await origin.checkContext(pairedFence)).state==='current'){
    const observed=await origin.observe(options.getScope(),pairedFence),attachment=observed.content?.media;
    if(observed.state!=='available'||observed.content?.messageVersion!==file.content?.messageVersion||attachment?.id!==parentFence.sourceId||attachment?.hash!==file.content?.media?.hash||attachment?.version!==file.content?.media?.version)throw Error('native_media_attachment_changed');
    exposure.sources.push(pairedRead.fence);exposure.origins.push(pairedFence);
    if(typeof observed.content?.text==='string'&&observed.content.text!==pairedRead.text)throw Error('native_media_attachment_changed');
    captionEvidence=typeof observed.content?.text==='string'?{state:'available',sourceRef:{id:pairedRead.fence.source.id,revision:pairedRead.fence.source.revision,version:pairedRead.fence.source.version,hash:pairedRead.fence.source.hash},text:observed.content.text}:{state:'absent'};
   }else captionEvidence={state:'unavailable',reason:'caption_source_unavailable'};
  }
  await retention.expose(task.identity,exposure);
  const model=createMediaModelPort(selected.apiKey,globalThis.fetch.bind(globalThis),selected.provider);
  const media=new MediaContext(db,{...scope,period:new Date().toISOString().slice(0,10)},{origin,reader:env.CAPTURE_MEDIA_READER,secret:env.BRIDGE_SECRET!,model,pdfParser:env.MEDIA_PDF_PARSER,
   accessPurpose:'knowledge',modelProvider:selected.provider,assertAuthority:()=>runtime.assertTaskCurrent(task),authorityGuard:options.authorityGuard,modelGuard:options.modelGuard});
  const output=await media.interpret({kind:'owner'},parentRef.id);
  await runtime.assertTaskCurrent(task);
  if((await origin.checkContext(fence)).state!=='current')throw Error('native_media_source_changed');
  await assertReadExposureCurrent(db,scope,access,origin,exposure,options,'native_media_source_changed');
  if(output.state==='complete')return {state:'available',interpretation:'derived_media_observations',parentSourceRef:parentRef,...(parentRef.id!==ref.id?{requestSourceRef:ref}:{}),caption:captionEvidence,blobHash:output.evidence.blobHash,text:output.evidence.text,pages:output.evidence.pages,coverage:output.coverage,
   evidenceNote:'These are derived visual observations, not a verbatim original message. Do not fabricate an original-text quote; if learning from this file, retain its parent SourceRef and classify interpretation as inferred.'};
  if(output.state==='existing_audio')return {state:'available',interpretation:'source_transcription',sourceRef:ref,text:read.text};
  return output;
 }};
}
