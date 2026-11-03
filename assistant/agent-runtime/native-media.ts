import {inferenceBudgetMode} from '../budget';
import {sourceRef} from '../source-proof-contract';
import {SourceAccess,type AccessGuard} from '../access';
import type {AssistantEnv} from '../env';
import {scopeKeys,type OriginGuard,type OriginScope} from '../origin-guard';
import {MediaContext} from '../media';
import {createMediaModelPort} from '../media-model';
import type {ConversationRuntime,TaskContext} from './conversation';
import type {NativeConversationRetention} from './conversation-retention';
import {assertReadExposureCurrent} from '../knowledge/read-exposure';
import {nativeModelSelection} from '../.flue/providers/model-selection';

/** Model-chosen perception, reusing the installed image/PDF pipeline. The
 * original binary's parent remains the evidence; OCR is explicitly derived. */
export function nativeMediaCapability(options:{env:AssistantEnv;task:TaskContext;runtime:ConversationRuntime;retention:NativeConversationRetention;origin:OriginGuard;getScope:()=>OriginScope;authorityGuard:()=>AccessGuard;modelGuard:()=>AccessGuard;onReadResult?:(ref:unknown,result:unknown)=>Promise<void>}){
 const {env,task,runtime,retention,origin}=options,scope={...task.knowledge.scope},db=env.DB!,access=new SourceAccess(db,scope,Date.now,'knowledge');
 return {async read(raw:unknown){
  const ref=sourceRef.parse(raw);await runtime.assertTaskCurrent(task);
  const failed=async<T extends {state:string;reason:string}>(result:T)=>{await options.onReadResult?.(ref,result);await runtime.assertTaskCurrent(task);return result;};
  const read=await access.read({kind:'owner'},ref.id,ref.revision);if(!read||read.fence.source.version!==ref.version||read.fence.source.hash!==ref.hash||read.fence.source.origin!=='whatsapp')throw Error('native_media_source_unavailable');
  const fence=await origin.fence(ref.id);if(!fence||(await origin.checkContext(fence)).state!=='current')throw Error('native_media_source_changed');
  const observed=await origin.observe(options.getScope(),fence);
  if(observed.state!=='available')return failed({state:'unavailable',reason:'caption_snapshot_unavailable',diagnostic:observed.reason??observed.state});
  if(observed.content?.kind==='audio'||(fence.sourceKind==='derivative'&&observed.content?.kind==='transcript')){
   let transcriptRead=read,transcriptFence=fence;
   if(observed.content.kind==='audio'){
    const media=observed.content.media;
    if(!media)return failed({state:'pending',reason:'audio_transcription_pending'});
    const candidate=await db.prepare(`SELECT o.canonical_id FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
     JOIN assistant_origin_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation AND v.canonical_id=s.id AND v.version=s.current_version
     WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=? AND o.source_kind='derivative' AND o.tombstoned=0 AND s.status='active'
      AND json_extract(v.dependencies_json,'$.kind')='transcript' AND json_extract(v.dependencies_json,'$.media.id')=? AND json_extract(v.dependencies_json,'$.media.version')=? AND json_extract(v.dependencies_json,'$.media.hash')=?
      AND json_extract(v.dependencies_json,'$.messageId')=? AND json_extract(v.dependencies_json,'$.messageVersion')=? ORDER BY o.watermark DESC,o.canonical_id LIMIT 1`)
     .bind(...scopeKeys(options.getScope()),fence.chatId,media.id,media.version,media.hash,observed.content.messageId!,observed.content.messageVersion!).first<{canonical_id:string}>();
    if(!candidate)return failed({state:'pending',reason:'audio_transcription_pending'});
    const linked=await access.read({kind:'owner'},candidate.canonical_id),linkedFence=await origin.fence(candidate.canonical_id);
    if(!linked||!linkedFence||(await origin.checkContext(linkedFence)).state!=='current')throw Error('native_media_source_changed');
    const transcript=await origin.observe(options.getScope(),linkedFence),body=transcript.content;
    if(transcript.state!=='available'||body?.kind!=='transcript'||body.text!==linked.text||body.messageId!==observed.content.messageId||body.messageVersion!==observed.content.messageVersion||body.media?.id!==media.id||body.media.version!==media.version||body.media.hash!==media.hash)throw Error('native_media_attachment_changed');
    transcriptRead=linked;transcriptFence=linkedFence;
   }else if(observed.content.text!==read.text)throw Error('native_media_source_changed');
   if(transcriptRead.text===null)return failed({state:'pending',reason:'audio_transcription_pending'});
   const transcriptRef={id:transcriptRead.id,revision:transcriptRead.fence.source.revision,version:transcriptRead.fence.source.version,hash:transcriptRead.fence.source.hash};
   const exposure=transcriptRef.id===ref.id?{sources:[read.fence],origins:[fence]}:{sources:[read.fence,transcriptRead.fence],origins:[fence,transcriptFence]};
   await retention.expose(task.identity,exposure);await runtime.assertTaskCurrent(task);
   for(const selected of exposure.origins)if((await origin.checkContext(selected)).state!=='current')throw Error('native_media_source_changed');
   const output={state:'available' as const,interpretation:'source_transcription',parentSourceRef:transcriptRef,requestSourceRef:ref,text:transcriptRead.text,coveredSourceRefs:exposure.sources.map(f=>({id:f.source.id,revision:f.source.revision,version:f.source.version,hash:f.source.hash}))};
   await options.onReadResult?.(ref,output);
   await assertReadExposureCurrent(db,scope,access,origin,exposure,options,'native_media_source_changed');return output;
  }
  if(env.MEDIA_CONTEXT_ENABLED!=='true'||!env.CAPTURE_MEDIA_READER)return failed({state:'unavailable',reason:'media_context_unconfigured'});
  const selected=nativeModelSelection(env);if(!selected.apiKey)return failed({state:'unavailable',reason:'media_context_unconfigured'});
  let parentRef=ref,parentRead=read,parentFence=fence,captionEvidence:unknown;
  if(fence.sourceKind==='message'){
   const caption=observed,attachment=caption.content?.media;
   // OriginGuard normalizes diagnostics; never label a failed read as an
   // attachment that simply has not arrived, or expose the Source body here.
   if(caption.state!=='available')return failed({state:'unavailable',reason:'caption_snapshot_unavailable',diagnostic:caption.reason??caption.state});
   if(!['image','pdf'].includes(String(caption.content?.kind)))return failed({state:'unavailable',reason:'media_message_kind_unsupported'});
   if(!attachment)return failed({state:'pending',reason:'media_attachment_pending'});
   const file=await db.prepare(`SELECT canonical_id FROM assistant_source_origins WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND source_kind='media' AND source_id=? AND chat_id=? AND tombstoned=0`)
    .bind(...scopeKeys(options.getScope()),attachment.id,fence.chatId).first<{canonical_id:string}>();
   if(!file)return failed({state:'pending',reason:'media_file_projection_pending'});
   const fileRead=await access.read({kind:'owner'},file.canonical_id),fileFence=await origin.fence(file.canonical_id);
   if(!fileRead||!fileFence||(await origin.checkContext(fileFence)).state!=='current')throw Error('native_media_source_changed');
   const fileObservation=await origin.observe(options.getScope(),fileFence),body=fileObservation.content;
   if(fileObservation.state!=='available'||fileFence.chatId!==fence.chatId||body?.messageId!==caption.content?.messageId||body?.messageVersion!==caption.content?.messageVersion||body?.media?.id!==attachment.id||body.media.version!==attachment.version||body.media.hash!==attachment.hash)throw Error('native_media_attachment_changed');
   if(typeof caption.content?.text==='string'&&caption.content.text!==read.text)throw Error('native_media_attachment_changed');
   captionEvidence=typeof caption.content?.text==='string'?{state:'available',sourceRef:ref,text:caption.content.text}:{state:'absent'};
   parentRead=fileRead;parentFence=fileFence;parentRef={id:fileRead.fence.source.id,revision:fileRead.fence.source.revision,version:fileRead.fence.source.version,hash:fileRead.fence.source.hash};
  }
  const exposure={sources:parentRef.id===ref.id?[read.fence]:[read.fence,parentRead.fence],origins:parentRef.id===ref.id?[fence]:[fence,parentFence]};
  if(parentFence.sourceKind==='media'&&fence.sourceKind!=='message'){
   const file=observed,messageId=file.content?.messageId;
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
   accessPurpose:'knowledge',budgetMode:inferenceBudgetMode(env.INFERENCE_BUDGET_MODE),modelProvider:selected.provider,assertAuthority:()=>runtime.assertTaskAuthority(task),authorityGuard:options.authorityGuard,modelGuard:options.modelGuard});
  const output=await media.interpret({kind:'owner'},parentRef.id);
  await runtime.assertTaskCurrent(task);
  if((await origin.checkContext(fence)).state!=='current')throw Error('native_media_source_changed');
  const result=output.state==='complete'?{state:'available',interpretation:'derived_media_observations',parentSourceRef:parentRef,...(parentRef.id!==ref.id?{requestSourceRef:ref}:{}),caption:captionEvidence,blobHash:output.evidence.blobHash,text:output.evidence.text,pages:output.evidence.pages,coverage:output.coverage,
   coveredSourceRefs:exposure.sources.map(f=>({id:f.source.id,revision:f.source.revision,version:f.source.version,hash:f.source.hash})),evidenceNote:'These are derived visual observations, not a verbatim original message. Do not fabricate an original-text quote; if learning from this file, retain its parent SourceRef and classify interpretation as inferred.'}
   :output.state==='existing_audio'?{state:'available',interpretation:'source_transcription',sourceRef:ref,text:read.text}:output;
  await options.onReadResult?.(ref,result);
  await assertReadExposureCurrent(db,scope,access,origin,exposure,options,'native_media_source_changed');return result;
 }};
}
