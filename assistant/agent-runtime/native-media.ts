import {sourceRef} from '../source-proof-contract';
import {SourceAccess,type AccessGuard} from '../access';
import type {AssistantEnv} from '../env';
import type {OriginGuard,OriginScope} from '../origin-guard';
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
  await retention.expose(task.identity,{sources:[read.fence],origins:[fence]});
  const model=createMediaModelPort(selected.apiKey,globalThis.fetch.bind(globalThis),selected.provider);
  const media=new MediaContext(db,{...scope,period:new Date().toISOString().slice(0,10)},{origin,reader:env.CAPTURE_MEDIA_READER,secret:env.BRIDGE_SECRET!,model,pdfParser:env.MEDIA_PDF_PARSER,
   accessPurpose:'knowledge',modelProvider:selected.provider,assertAuthority:()=>runtime.assertTaskCurrent(task),authorityGuard:options.authorityGuard,modelGuard:options.modelGuard});
  const output=await media.interpret({kind:'owner'},ref.id);
  await runtime.assertTaskCurrent(task);
  if((await origin.checkContext(fence)).state!=='current')throw Error('native_media_source_changed');
  await assertReadExposureCurrent(db,scope,access,origin,{sources:[read.fence],origins:[fence]},options,'native_media_source_changed');
  if(output.state==='complete')return {state:'available',interpretation:'derived_media_observations',parentSourceRef:ref,blobHash:output.evidence.blobHash,text:output.evidence.text,pages:output.evidence.pages,coverage:output.coverage,
   evidenceNote:'These are derived visual observations, not a verbatim original message. Do not fabricate an original-text quote; if learning from this file, retain its parent SourceRef and classify interpretation as inferred.'};
  if(output.state==='existing_audio')return {state:'available',interpretation:'source_transcription',sourceRef:ref,text:read.text};
  return output;
 }};
}
