import type {DeliveredMessage} from '@flue/runtime';
import {SourceAccess,type AccessGuard} from '../access';
import {InferenceBudget} from '../budget';
import type {AssistantEnv} from '../env';
import {bridgeHash} from '../ingress';
import {OriginGuard,scopeKeys} from '../origin-guard';
import {assertRestoredGeneration} from '../retention-runtime';
import {configuredKnowledgeService} from '../knowledge/configured';
import {ConversationRuntime,conversationIdentity,conversationAddress,conversationReplyAnchor,verifiedConversationEvent,type ConversationIdentity,type VerifiedConversationEvent,type TaskContext} from './conversation';
import {NativeConversationRetention} from './conversation-retention';
import {nativeContextDestroyPort,openNativeConversation} from './native-transport';
import {nativeAuthority,nativeGlobalBudgetGuard,nativeMode,nativeScope,joinGuards,nativeOwnerFence,nativeTelegramActivation,nativeCuratorDispatchRequest} from './native-policy';
import type {ConversationProviderHost} from './conversation-provider';
import {createConversationReadCapabilities} from './conversation-connectors';
import {NativeReplyActions} from './conversation-actions';
import type {NativeReplyActuatorRPC} from '../../src/native-reply-contract';
import {approvedSendActivityFence,captureConversationActivity} from '../../src/approved-send-contract';
import {NativeTelegramReplyReview,readNativeReplyReviewContext} from '../native-telegram-review';
import {TelegramBotApi} from '../telegram';
import {telegramLinkGuard,type TelegramLinkFence} from '../telegram-auth';
import {SourceController,sourceTextHash} from '../sources';
import {configuredRetirementGuard} from '../retention-authority';
import type {NativeCaptureInput} from '../../src/native-input-reader';
import {CaptureMaterializer} from '../materialize';
import {telegramText} from '../telegram-format';
import {KnowledgeCurator,isCuratorPrincipal,type CuratorReceipt} from '../knowledge/curator';
import {nativeMediaCapability} from './native-media';
import {NativeOwnerHelp} from './native-owner-help';
import {createNativeCalendarCapability} from './native-calendar';

const owner={kind:'owner'} as const;
type NativeOwnerInput={text:string;message_id:number;message_date:number;thread_id:number|null;payload_hash:string;native_identity_json:string|null;native_activation_key:string|null};
// Only server-defined codes enter durable diagnostics. Provider errors, source
// content, URLs and arbitrary exception messages never become stored gaps.
const captureAdmissionGaps=new Set(['native_event_denied','native_event_source_changed','native_event_origin_changed',
 'native_authority_denied','native_disabled','native_conversation_denied','conversation_authority_changed',
 'conversation_context_withdrawn','conversation_context_unavailable','conversation_exposure_proof','conversation_exposure_changed',
 'conversation_event_conflict','conversation_delivery_denied','conversation_reply_anchor_denied']);
/** Request-local composition root. No active task/session/actor is stored in a
 * module or a mutable shared pointer. Every tool resolves its immutable frame. */
export class NativeApplicationHost {
 readonly scope;readonly origin:OriginGuard;readonly retention:NativeConversationRetention;readonly runtime:ConversationRuntime;
 private readonly db:D1Database;private readonly configured;
 constructor(private readonly env:AssistantEnv){
  this.scope=nativeScope(env);
  if(!env.DB||!env.CAPTURE_READER||!env.BRIDGE_SECRET||nativeMode(env)==='off')throw Error('native_unconfigured');this.db=env.DB;
  this.configured=[this.db,env.CAPTURE_READER,env.BRIDGE_SECRET,env.OPENAI_API_KEY,env.NATIVE_CONTEXT_ADMIN_SECRET,env.NATIVE_CONVERSATIONS_MODE,env.TELEGRAM_BOT_INSTANCE,env.TELEGRAM_BOT_TOKEN,env.TELEGRAM_WEBHOOK_SECRET,env.WHATSAPP_APPROVED_SEND,env.WHATSAPP_APPROVED_SEND_SECRET];
  this.origin=new OriginGuard(this.db,()=>this.currentScope(),env.CAPTURE_READER,env.BRIDGE_SECRET,2000,'owner_read');
  this.retention=new NativeConversationRetention(this.db!,()=>this.currentScope(),this.origin,nativeContextDestroyPort(env));
  this.runtime=new ConversationRuntime(this.db!,{retention:this.retention,authority:async identity=>(await this.authority(identity)).authority,
   knowledgeClient:identity=>isCuratorPrincipal(identity.principalOrChatId)?'curator':'conversation_agent',
   authorizeEvent:event=>this.authorizeEvent(event),open:openNativeConversation,
   knowledge:task=>configuredKnowledgeService(env,this.currentScope(),task.knowledge.client)});
 }
 currentScope(){
  const e=this.env,now=[e.DB,e.CAPTURE_READER,e.BRIDGE_SECRET,e.OPENAI_API_KEY,e.NATIVE_CONTEXT_ADMIN_SECRET,e.NATIVE_CONVERSATIONS_MODE,e.TELEGRAM_BOT_INSTANCE,e.TELEGRAM_BOT_TOKEN,e.TELEGRAM_WEBHOOK_SECRET,e.WHATSAPP_APPROVED_SEND,e.WHATSAPP_APPROVED_SEND_SECRET];
  if(now.some((v,i)=>v!==this.configured[i])||JSON.stringify(nativeScope(e))!==JSON.stringify(this.scope)||nativeMode(e)==='off')throw Error('native_configuration_changed');
  return this.scope;
 }
 async authority(identity:ConversationIdentity){this.currentScope();await assertRestoredGeneration(this.env);this.currentScope();return nativeAuthority(this.env,identity);}
 async identity(channel:ConversationIdentity['channel'],principalOrChatId:string){
  this.currentScope();const current=await this.retention.currentIdentity(channel,principalOrChatId);if(current){await this.authority(current);return current;}
  const next=conversationIdentity.parse({version:1,...{installationId:this.scope.installationId,generation:this.scope.generation},channel,principalOrChatId,contextEpoch:crypto.randomUUID()});
  await this.authority(next);
  try{await this.retention.register(next);return next;}catch(error){const winner=await this.retention.currentIdentity(channel,principalOrChatId);if(winner){await this.authority(winner);return winner;}throw error;}
 }
 async registered(sessionId:string){
  this.currentScope();const row=await this.db!.prepare(`SELECT identity_json FROM assistant_native_conversations WHERE id=? AND installation_id=? AND generation=? AND tombstoned_at IS NULL`)
   .bind(sessionId,this.scope.installationId,this.scope.generation).first<{identity_json:string}>();
  if(!row)throw Error('native_session_denied');const identity=conversationIdentity.parse(JSON.parse(row.identity_json));
  if(sessionId!==await conversationAddress(identity,identity.channel,identity.principalOrChatId,identity.contextEpoch))throw Error('native_session_denied');
  await this.authority(identity);await this.retention.assertCurrent(identity);return identity;
 }
 private async authorizeEvent(event:VerifiedConversationEvent){
  if(isCuratorPrincipal(event.identity.principalOrChatId)){
   const {authority}=await this.authority(event.identity);await(await this.curator(event.identity)).authorizeEvent(event,authority.ownerId);return;
  }
  const sessionId=await conversationAddress(event.identity,event.identity.channel,event.identity.principalOrChatId,event.identity.contextEpoch);
  const row=await this.db!.prepare(`SELECT request_hash,source_ref_json,telegram_activation_key FROM assistant_native_host_events WHERE installation_id=? AND generation=? AND conversation_id=? AND event_id=? AND event_revision=?`)
   .bind(this.scope.installationId,this.scope.generation,sessionId,event.eventId,event.revision).first<{request_hash:string;source_ref_json:string;telegram_activation_key:string|null}>();
  if(!row||row.request_hash!==await bridgeHash(event)||!event.sourceRef||row.source_ref_json!==JSON.stringify(event.sourceRef))throw Error('native_event_denied');
  if(event.identity.channel==='telegram'){
   const activation=await nativeTelegramActivation(this.env,this.currentScope(),await nativeOwnerFence(this.env,this.currentScope()));
   if(row.telegram_activation_key!==activation.key)throw Error('native_telegram_cut_denied');
  }
  const source=await new SourceAccess(this.db!,this.scope,Date.now,'knowledge').read(owner,event.sourceRef.id,event.sourceRef.revision);
  if(!source||source.fence.source.version!==event.sourceRef.version||source.fence.source.hash!==event.sourceRef.hash||source.text!==event.body)throw Error('native_event_source_changed');
  if(source.fence.source.origin==='whatsapp'){
   const fence=await this.origin.fence(source.fence.source.id);if(!fence||(await this.origin.checkContext(fence)).state!=='current')throw Error('native_event_origin_changed');
  }
  await this.authority(event.identity);
 }
 /** Only canonical provider/owner adapters call this after authentication. A
  * persisted matching hash is not created by native initialData or tool args. */
 private async admit(event:VerifiedConversationEvent,originalSequence:number|null,ownerLink:unknown=null,admissionGuard?:AccessGuard,activationKey:string|null=null){
  const sessionId=await conversationAddress(event.identity,event.identity.channel,event.identity.principalOrChatId,event.identity.contextEpoch),authority=await this.authority(event.identity),guard=admissionGuard?joinGuards(authority.guard,admissionGuard):authority.guard;
  await this.db!.prepare(`INSERT INTO assistant_native_host_events(installation_id,generation,conversation_id,event_id,event_revision,request_hash,source_id,source_ref_json,original_sequence,owner_link_json,created_at,telegram_activation_key)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (${guard.sql}) ON CONFLICT DO NOTHING`)
   .bind(this.scope.installationId,this.scope.generation,sessionId,event.eventId,event.revision,await bridgeHash(event),event.sourceRef!.id,JSON.stringify(event.sourceRef),originalSequence,ownerLink?JSON.stringify(ownerLink):null,Date.now(),activationKey,...guard.values).run();
  return this.runtime.deliverConversation(event);
 }
 /** Capture metadata is already stored by the secret-authenticated bridge.
  * Re-read source/author through its named capability; metadata is no body. */
 async receiveCapture(sequence:number){
  const scope=this.currentScope();await assertRestoredGeneration(this.env);
  const row=await this.db!.prepare(`SELECT * FROM assistant_capture_inbox WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND sequence=?`)
   .bind(...scopeKeys(scope),sequence).first<{sequence:number;chat_id:string;source_id:string;source_kind:'message'|'media'|'derivative'|'conversation';operation:string;metadata_hash:string;application_state:string}>();
  if(!row)throw Error('native_capture_missing');
  const finish=async(state:string,lastGap:string|null=null,taskRef:string|null=null)=>{
   await this.db!.prepare(`INSERT INTO assistant_native_capture_intake(installation_id,generation,source_epoch,source_generation,sequence,metadata_hash,state,task_ref,last_gap,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(installation_id,generation,source_epoch,source_generation,sequence) DO UPDATE SET state=excluded.state,task_ref=COALESCE(excluded.task_ref,assistant_native_capture_intake.task_ref),last_gap=excluded.last_gap,updated_at=excluded.updated_at`)
    .bind(...scopeKeys(scope),sequence,row.metadata_hash,state,taskRef,lastGap,Date.now()).run();return {state,taskRef};
  };
  const cut=this.env.NATIVE_CAPTURE_START_AFTER_SEQUENCE;
  if(typeof cut!=='string'||!/^\d+$/.test(cut)||!Number.isSafeInteger(Number(cut)))throw Error('native_capture_cut_unconfigured');
  if(sequence<=Number(cut))return finish('before_activation');
  const saved=await this.db!.prepare(`SELECT metadata_hash,state,task_ref FROM assistant_native_capture_intake WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND sequence=?`)
   .bind(...scopeKeys(scope),sequence).first<{metadata_hash:string;state:string;task_ref:string|null}>();
  if(saved?.metadata_hash!==undefined&&saved.metadata_hash!==row.metadata_hash)throw Error('native_capture_conflict');
  if(saved&&['admitted','excluded','withdrawn','metadata_only','superseded','before_activation'].includes(saved.state))return {state:saved.state,taskRef:saved.task_ref};
  await finish('pending');
  const materializer=new CaptureMaterializer(this.db!,()=>this.currentScope(),this.env.CAPTURE_READER!,this.env.BRIDGE_SECRET!);
  const materialized=await materializer.process(sequence,row.application_state==='blocked');
  if(row.operation==='withdraw'||row.source_kind==='conversation'){
   await this.sweepRetiredContexts();return finish(row.operation==='withdraw'?'withdrawn':'metadata_only');
  }
  if(materialized.state!=='applied')return finish('unavailable','canonical_pending');
  const reader=this.env.CAPTURE_READER?.readNativeInput;
  if(!reader)return finish('unavailable','native_source_reader_unconfigured');
  let input:NativeCaptureInput;
  try{input=JSON.parse(JSON.stringify(await this.env.CAPTURE_READER!.readNativeInput!({secret:this.env.BRIDGE_SECRET!,sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:row.source_kind,sourceId:row.source_id,chatId:row.chat_id}))) as NativeCaptureInput;}
  catch{return finish('unavailable','source_reader_unavailable');}
  if(input.observation!=='native_capture_input')return finish('unavailable','source_reader_invalid');
  if(input.state!=='available')return finish('unavailable',input.reason??'source_unavailable');
  if(input.sourceEpoch!==scope.sourceEpoch||input.sourceGeneration!==scope.sourceGeneration||input.sourceKind!==row.source_kind||input.sourceId!==row.source_id||input.chatId!==row.chat_id||!Number.isSafeInteger(input.originalSequence)||input.originalSequence<1||typeof input.fromMe!=='boolean'||input.captureState!=='enabled')return finish('unavailable','source_reader_invalid');
  if(!input.authorship||!['external','assistant_action','own_device_unattributed'].includes(input.authorship.kind)||input.fromMe===(input.authorship.kind==='external'))return finish('unavailable','source_authorship_unknown');
  const content=input.snapshot?.content;
  if(!content||content.fromMe!==input.fromMe||content.messageId!==input.originalMessageId||(content.authorId??null)!==input.authorId||input.text!==(typeof content.text==='string'?content.text:null))return finish('unavailable','source_reader_invalid');
  // Source observation hash covers the exact author/direction/body snapshot.
  const canonical=await this.db!.prepare(`SELECT canonical_id,observation_hash FROM assistant_source_origins WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND source_kind=? AND source_id=? AND chat_id=? AND tombstoned=0`)
   .bind(...scopeKeys(scope),row.source_kind,row.source_id,row.chat_id).first<{canonical_id:string;observation_hash:string}>();
  if(!canonical||canonical.observation_hash!==await bridgeHash([input.snapshot.sourceVersion??null,input.snapshot.access,input.snapshot.content]))return finish('unavailable','canonical_snapshot_changed');
  const source=await new SourceAccess(this.db!,scope,Date.now,'knowledge').read(owner,canonical.canonical_id);
  if(!source)return finish('excluded');
  const body=typeof content.text==='string'?content.text:JSON.stringify(content??{});
  if(body!==source.text||await sourceTextHash(body)!==source.fence.source.hash)return finish('unavailable','canonical_text_changed');
  // Images/PDF enter as their exact canonical Source metadata. The agent can
  // choose media_read; no fabricated visual description or eager OCR.
  if(input.textState!=='ready'&&!(row.source_kind==='media'&&['image','pdf'].includes(String(content.kind))))return finish('unavailable','media_text_pending');
  let identity:ConversationIdentity;try{identity=await this.identity('whatsapp',row.chat_id);}catch(error){const code=error instanceof Error?error.message:'native_authority_unavailable';return finish(code==='native_conversation_denied'?'excluded':'unavailable',code);}
  const {authority}=await this.authority(identity),ref={id:source.fence.source.id,revision:source.fence.source.revision,version:source.fence.source.version,hash:source.fence.source.hash};
  // Provider authors, actual group participants, and destination are distinct.
  const author=input.authorship.kind==='external'?{kind:'person' as const,id:input.authorId??(input.conversationKind==='private'?row.chat_id:'unknown-participant:'+input.originalMessageId)}
   :{kind:'system' as const,id:input.authorship.kind==='assistant_action'?'assistant-action:'+input.authorship.action.id:'own-device-unattributed'};
  const status=input.authorship.kind==='assistant_action'?input.authorship.action.status:undefined;
  const actionState=status&&['delivered','read'].includes(status)?'delivered' as const:status&&['accepted','sent'].includes(status)?'accepted' as const:undefined;
  const event=verifiedConversationEvent({identity,eventId:'capture:'+row.source_kind+':'+row.source_id,revision:source.fence.source.revision,kind:input.authorship.kind==='external'?'incoming':'action_result',author,
   occurredAt:typeof content.occurredAt==='number'?content.occurredAt:typeof content.receivedAt==='number'?content.receivedAt:Date.now(),body,sourceRef:ref,...(actionState?{actionState}:{})});
  try{const result=await this.admit(event,input.originalSequence);return finish(result.state,null,result.taskRef);}
  catch(error){
   const code=error instanceof Error&&captureAdmissionGaps.has(error.message)?error.message:'native_admission_unavailable';
   await finish('unavailable',code);throw error;
  }
 }
 private async historicalTelegramIdentity(eventId:string){
  const rows=await this.db.prepare(`SELECT c.identity_json FROM assistant_native_host_events h JOIN assistant_native_conversations c ON c.id=h.conversation_id
   WHERE h.installation_id=? AND h.generation=? AND h.event_id=? ORDER BY h.created_at,h.conversation_id LIMIT 2`)
   .bind(this.scope.installationId,this.scope.generation,eventId).all<{identity_json:string}>();
  if(rows.results.length>1)throw Error('native_owner_replay_conflict');return rows.results[0]?conversationIdentity.parse(JSON.parse(rows.results[0].identity_json)):undefined;
 }
 private async bindTelegramInput(updateId:number,row:NativeOwnerInput,fence:TelegramLinkFence,activation:Awaited<ReturnType<typeof nativeTelegramActivation>>,seed?:ConversationIdentity){
  if(!row.native_identity_json){
   const candidate=seed??await this.historicalTelegramIdentity('telegram:'+this.env.TELEGRAM_BOT_INSTANCE+':'+updateId)
    ??await this.retention.currentIdentity('telegram',fence.userId)
    ??conversationIdentity.parse({version:1,installationId:this.scope.installationId,generation:this.scope.generation,channel:'telegram',principalOrChatId:fence.userId,contextEpoch:crypto.randomUUID()});
   const {guard}=await this.authority(candidate),link=joinGuards(guard,telegramLinkGuard(fence),activation.guard);
   await this.db.prepare(`UPDATE assistant_telegram_updates SET native_identity_json=?,native_activation_key=?
    WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=? AND source_epoch=? AND source_generation=? AND link_revision=? AND user_id=? AND chat_id=? AND payload_hash=?
    AND native_identity_json IS NULL AND message_date>? AND received_at>=? AND outcome='pending' AND state='pending' AND (${link.sql})`)
    .bind(JSON.stringify(candidate),activation.key,this.scope.installationId,this.scope.generation,this.env.TELEGRAM_BOT_INSTANCE!,updateId,this.scope.sourceEpoch,this.scope.sourceGeneration,fence.linkRevision,fence.userId,fence.chatId,row.payload_hash,activation.cutSecond,activation.activatedAt,...link.values).run();
  }
  const saved=await this.db.prepare(`SELECT native_identity_json,native_activation_key FROM assistant_telegram_updates
   WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=? AND source_epoch=? AND source_generation=? AND link_revision=? AND user_id=? AND chat_id=? AND payload_hash=?`)
   .bind(this.scope.installationId,this.scope.generation,this.env.TELEGRAM_BOT_INSTANCE!,updateId,this.scope.sourceEpoch,this.scope.sourceGeneration,fence.linkRevision,fence.userId,fence.chatId,row.payload_hash)
   .first<{native_identity_json:string|null;native_activation_key:string|null}>();
  if(!saved?.native_identity_json||saved.native_activation_key!==activation.key)throw Error('native_owner_input_denied');
  const identity=conversationIdentity.parse(JSON.parse(saved.native_identity_json));
  if(identity.installationId!==this.scope.installationId||identity.generation!==this.scope.generation||identity.channel!=='telegram'||identity.principalOrChatId!==fence.userId)throw Error('native_owner_input_denied');
  await this.authority(identity);
  const current=joinGuards(telegramLinkGuard(fence),activation.guard);
  if(!await this.db.prepare(`SELECT 1 WHERE (${current.sql})`).bind(...current.values).first())throw Error('native_owner_input_denied');
  return identity;
 }
 private async replayTelegramInput(identity:ConversationIdentity,updateId:number,row:NativeOwnerInput,fence:TelegramLinkFence,activation:Awaited<ReturnType<typeof nativeTelegramActivation>>){
  const sessionId=await conversationAddress(identity,'telegram',fence.userId,identity.contextEpoch),eventId='telegram:'+this.env.TELEGRAM_BOT_INSTANCE+':'+updateId;
  const previous=await this.db.prepare(`SELECT c.tombstoned_at,h.request_hash,h.source_ref_json,h.event_revision,h.owner_link_json,h.telegram_activation_key,e.state,e.task_ref,e.receipt_json
   FROM assistant_native_conversations c LEFT JOIN assistant_native_host_events h ON h.conversation_id=c.id AND h.event_id=?
   LEFT JOIN assistant_native_conversation_events e ON e.conversation_id=h.conversation_id AND e.event_id=h.event_id AND e.revision=h.event_revision
   WHERE c.id=? AND c.installation_id=? AND c.generation=? ORDER BY h.event_revision LIMIT 1`)
   .bind(eventId,sessionId,this.scope.installationId,this.scope.generation).first<{tombstoned_at:number|null;request_hash:string|null;source_ref_json:string|null;event_revision:number|null;owner_link_json:string|null;telegram_activation_key:string|null;state:string|null;task_ref:string|null;receipt_json:string|null}>();
  if(!previous)return null;
  if(previous.tombstoned_at!==null||previous.state==='withdrawn'){
   const taskRef=previous.task_ref??'conversation-task-v1-'+await bridgeHash([sessionId,eventId,previous.event_revision??1]);
   return {state:'retired' as const,sessionId,taskRef,...(previous.receipt_json?{receipt:JSON.parse(previous.receipt_json)}:{})};
  }
  if(!previous.request_hash)return null;
  if(!previous.source_ref_json||previous.owner_link_json!==JSON.stringify(fence)||previous.telegram_activation_key!==activation.key)throw Error('native_owner_input_denied');
  const event=verifiedConversationEvent({identity,eventId,revision:previous.event_revision!,kind:'incoming',author:{kind:'owner',id:fence.userId},occurredAt:row.message_date*1000,body:row.text,sourceRef:JSON.parse(previous.source_ref_json),...(row.thread_id?{threadId:String(row.thread_id)}:{})});
  if(await bridgeHash(event)!==previous.request_hash)throw Error('native_owner_replay_conflict');
  // Source/activation guards in the native host are rechecked. A host-only
  // receipt (crash before native dispatch) still pins this exact old identity.
  return this.runtime.deliverConversation(event);
 }
 async receiveTelegram(updateId:number,raw?:unknown){
  const fence=await nativeOwnerFence(this.env,this.currentScope()),activation=await nativeTelegramActivation(this.env,this.currentScope(),fence),link=joinGuards(telegramLinkGuard(fence),activation.guard);
  const row=await this.db!.prepare(`SELECT text,message_id,message_date,thread_id,payload_hash,native_identity_json,native_activation_key FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=? AND source_epoch=? AND source_generation=? AND link_revision=? AND user_id=? AND chat_id=? AND message_date>? AND received_at>=? AND outcome='pending' AND state='pending' AND (${link.sql})`)
   .bind(this.scope.installationId,this.scope.generation,this.env.TELEGRAM_BOT_INSTANCE!,updateId,this.scope.sourceEpoch,this.scope.sourceGeneration,fence.linkRevision,fence.userId,fence.chatId,activation.cutSecond,activation.activatedAt,...link.values).first<NativeOwnerInput>();
  if(!row||typeof row.text!=='string')throw Error('native_owner_input_denied');
  const known=row.native_identity_json?conversationIdentity.parse(JSON.parse(row.native_identity_json)):await this.historicalTelegramIdentity('telegram:'+this.env.TELEGRAM_BOT_INSTANCE+':'+updateId);
  if(known){const identity=await this.bindTelegramInput(updateId,row,fence,activation,known),replay=await this.replayTelegramInput(identity,updateId,row,fence,activation);if(replay)return replay;}
  // Quote correlation is part of the authenticated durable inbox, not the
  // lifetime of this webhook request. Record it BEFORE canonical Source work
  // so a failed report or cron recovery cannot reroute a WhatsApp clarification.
  void raw;const help=await this.help();await help.recordPersistedReply(updateId);
  const operationId='native-telegram-source:'+await bridgeHash([this.scope,this.env.TELEGRAM_BOT_INSTANCE,updateId,row.payload_hash]);
  // Owner input is an attributed report, never an automatic owner policy/note.
  const controller=new SourceController(this.db!,this.scope,owner,Date.now,configuredRetirementGuard(this.env),()=>link);
  const report=await controller.execute({kind:'source.report',operationId,input:{originKey:operationId,text:row.text,authorId:fence.userId,occurredAt:row.message_date*1000,audience:'owner'}}) as {id:string;revision:number;version:number};
  const source=await new SourceAccess(this.db!,this.scope,Date.now,'knowledge').read(owner,report.id,report.revision);
  if(!source||source.text!==row.text||source.fence.source.version!==report.version)throw Error('native_owner_source_changed');
  const ref={id:source.fence.source.id,revision:source.fence.source.revision,version:source.fence.source.version,hash:source.fence.source.hash};
  const resumed=await help.resume(updateId,ref);if(resumed.state==='resumed'||resumed.state==='pending')return resumed.receipt!;
  const identity=await this.bindTelegramInput(updateId,row,fence,activation),replay=await this.replayTelegramInput(identity,updateId,row,fence,activation);if(replay)return replay;
  // The inbox winner was sealed BEFORE registration. A losing caller never
  // falls back to a fresh epoch after another caller purges that winner.
  await this.retention.register(identity);
  const event=verifiedConversationEvent({identity,eventId:'telegram:'+this.env.TELEGRAM_BOT_INSTANCE+':'+updateId,revision:1,kind:'incoming',author:{kind:'owner',id:fence.userId},occurredAt:row.message_date*1000,body:row.text,sourceRef:ref,...(row.thread_id?{threadId:String(row.thread_id)}:{})});
  return this.admit(event,null,fence,activation.guard,activation.key);
 }
 async sweepRetiredContexts(limit=20){
  const keys=[this.scope.installationId,this.scope.generation];
  await this.db!.prepare(`INSERT INTO assistant_native_host_state(installation_id,generation) VALUES(?,?) ON CONFLICT DO NOTHING`).bind(...keys).run();
  const cursor=await this.db!.prepare(`SELECT purge_cursor FROM assistant_native_host_state WHERE installation_id=? AND generation=?`).bind(...keys).first<string>('purge_cursor')??'';
  const rows=await this.db!.prepare(`SELECT id,identity_json,tombstoned_at FROM assistant_native_conversations WHERE installation_id=? AND generation=? AND id>? AND (tombstoned_at IS NULL OR EXISTS(SELECT 1 FROM assistant_native_context_purges p WHERE p.conversation_id=assistant_native_conversations.id AND p.state='tombstoned')) ORDER BY id LIMIT ?`)
   .bind(...keys,cursor,limit).all<{id:string;identity_json:string;tombstoned_at:number|null}>();
  for(const row of rows.results){const identity=conversationIdentity.parse(JSON.parse(row.identity_json));
   if(row.tombstoned_at!==null){await this.retention.purge(identity);continue;}
   try{await this.authority(identity);await this.retention.assertCurrent(identity);}catch(error){if(error instanceof Error&&['native_conversation_denied','native_owner_unlinked','native_authority_denied','conversation_context_withdrawn'].includes(error.message))await this.retention.purge(identity);}
  }
  await this.db!.prepare(`UPDATE assistant_native_host_state SET purge_cursor=? WHERE installation_id=? AND generation=? AND purge_cursor=?`).bind(rows.results.at(-1)?.id??'',...keys,cursor).run();
 }
 async tick(){
  this.currentScope();await assertRestoredGeneration(this.env);
  const cut=this.env.NATIVE_CAPTURE_START_AFTER_SEQUENCE;if(typeof cut!=='string'||!/^\d+$/.test(cut)||!Number.isSafeInteger(Number(cut)))throw Error('native_capture_cut_unconfigured');
  // Persistent per-item gaps and least-recently-attempted ordering keep an
  // unavailable media item from blocking unrelated conversations forever.
  const capture=await this.db!.prepare(`SELECT i.sequence FROM assistant_capture_inbox i LEFT JOIN assistant_native_capture_intake n USING(installation_id,generation,source_epoch,source_generation,sequence)
   WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=? AND i.sequence>?
   AND (n.state IS NULL OR n.state NOT IN ('admitted','excluded','withdrawn','metadata_only','superseded','before_activation'))
   ORDER BY COALESCE(n.updated_at,0),i.sequence LIMIT 10`).bind(...scopeKeys(this.scope),Number(cut)).all<{sequence:number}>();
  const outcomes=[];for(const row of capture.results)try{outcomes.push(await this.receiveCapture(row.sequence));}catch{outcomes.push({state:'unavailable'});}
  const fence=await nativeOwnerFence(this.env,this.currentScope()),activation=await nativeTelegramActivation(this.env,this.currentScope(),fence);
  const ownerUpdates=await this.db!.prepare(`SELECT update_id FROM assistant_telegram_updates u WHERE installation_id=? AND generation=? AND bot_instance=? AND source_epoch=? AND source_generation=? AND link_revision=? AND user_id=? AND chat_id=? AND message_date>? AND received_at>=? AND outcome='pending' AND state='pending'
   AND NOT EXISTS(SELECT 1 FROM assistant_native_help_questions q WHERE q.installation_id=u.installation_id AND q.generation=u.generation AND q.bot_instance=u.bot_instance AND q.owner_update_id=u.update_id AND q.state='resumed')
   AND NOT EXISTS(SELECT 1 FROM assistant_native_host_events e JOIN assistant_native_conversations c ON c.id=e.conversation_id LEFT JOIN assistant_native_conversation_events n ON n.conversation_id=e.conversation_id AND n.event_id=e.event_id AND n.revision=e.event_revision WHERE e.installation_id=u.installation_id AND e.generation=u.generation AND e.event_id='telegram:'||u.bot_instance||':'||u.update_id AND (c.tombstoned_at IS NOT NULL OR n.state IN ('admitted','withdrawn')))
   AND NOT EXISTS(SELECT 1 FROM assistant_native_conversations c WHERE c.installation_id=u.installation_id AND c.generation=u.generation AND c.identity_json=u.native_identity_json AND c.tombstoned_at IS NOT NULL) ORDER BY update_id LIMIT 5`)
   .bind(this.scope.installationId,this.scope.generation,this.env.TELEGRAM_BOT_INSTANCE!,this.scope.sourceEpoch,this.scope.sourceGeneration,fence.linkRevision,fence.userId,fence.chatId,activation.cutSecond,activation.activatedAt).all<{update_id:number}>();
  for(const row of ownerUpdates.results)try{outcomes.push(await this.receiveTelegram(row.update_id));}catch{outcomes.push({state:'unavailable'});}
  await this.sweepRetiredContexts();const curator=await this.dispatchCurator();return {state:'ticked',outcomes,curator};
 }
 async modelHost(sessionId:string,turnId:string):Promise<ConversationProviderHost>{
  const identity=await this.registered(sessionId),period=new Date().toISOString().slice(0,10),scope={installationId:this.scope.installationId,generation:this.scope.generation,period};
  const budget=new InferenceBudget(this.db!,scope);await budget.status(); // no implicit configuration/reset
  nativeGlobalBudgetGuard(this.env);
  const {authority,guard}=await this.authority(identity);
  const sessionGrant:AccessGuard={sql:`EXISTS(SELECT 1 FROM assistant_native_conversation_events WHERE conversation_id=? AND state<>'withdrawn' AND authority_json=? AND sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=?))`,values:[sessionId,JSON.stringify(authority),sessionId]};
  const authorityGuard=()=>joinGuards(guard,this.retention.authorityGuard(sessionId),sessionGrant);
  return {scope,sessionId,contextEpoch:identity.contextEpoch,turnId,budget,globalBudgetGuard:()=>nativeGlobalBudgetGuard(this.env),authorityGuard,
   assertAuthority:async()=>{await this.registered(sessionId);if(JSON.stringify((await this.authority(identity)).authority)!==JSON.stringify(authority))throw Error('native_authority_changed');},
   maxOutputTokens:8192,maxRequestBytes:8*1024*1024,maxResponseBytes:16*1024*1024,timeoutMs:90000};
 }
 async resolve(sessionId:string,delivery:DeliveredMessage){const identity=await this.registered(sessionId);await this.runtime.resolveTask(identity,delivery);return {runtime:this.runtime,frame:(task:TaskContext)=>this.frame(task)};}
 private async actionAuthority(task:TaskContext){await this.runtime.assertTaskCurrent(task);const {authority,guard}=await this.authority(task.identity);if(JSON.stringify(authority)!==JSON.stringify(task.authority))throw Error('native_authority_changed');return guard;}
 actions(){
  const source=this.env.WHATSAPP_APPROVED_SEND as NativeReplyActuatorRPC|undefined,secret=this.env.WHATSAPP_APPROVED_SEND_SECRET;
  if(!source?.executeNative||!secret)throw Error('native_reply_unconfigured');
  return new NativeReplyActions({db:this.db!,scope:this.scope,runtime:this.runtime,retention:this.retention,source,secret,
   autonomousEnabled:()=>this.env.ASSISTANT_NATIVE_AUTONOMOUS_ENABLED==='true'&&nativeMode(this.env)==='autonomous',
   authorityGuard:task=>this.actionAuthority(task),activity:task=>this.activity(task)});
 }
 async activity(task:TaskContext){
  await this.runtime.assertTaskCurrent(task);const anchor=conversationReplyAnchor(task);
  if(!anchor||task.returnChannel.channel!=='whatsapp'||!this.env.CAPTURE_READER?.readConversationActivity)throw Error('native_activity_unavailable');
  const seq=await this.db!.prepare(`SELECT h.original_sequence FROM assistant_native_host_events h JOIN assistant_native_conversation_events e ON e.conversation_id=h.conversation_id AND e.event_id=h.event_id AND e.revision=h.event_revision WHERE e.task_ref=? AND e.conversation_id=? AND e.state<>'withdrawn' AND h.source_ref_json=?`)
   .bind(anchor.taskRef,task.sessionId,JSON.stringify(anchor.sourceRef)).first<number>('original_sequence');
  if(!seq||seq<1)throw Error('native_activity_trigger_unknown');
  const observation=captureConversationActivity.parse(await this.env.CAPTURE_READER.readConversationActivity({secret:this.env.BRIDGE_SECRET!,sourceEpoch:this.scope.sourceEpoch,sourceGeneration:this.scope.sourceGeneration,chatId:task.returnChannel.id}));
  if(observation.state!=='available'||observation.sourceEpoch!==this.scope.sourceEpoch||observation.sourceGeneration!==this.scope.sourceGeneration||observation.chatId!==task.returnChannel.id||observation.latestIncomingOriginalSequence!==seq||observation.lastOwnerOriginalSequence>seq||observation.members.some(m=>!m.captureEnabled))throw Error('native_activity_superseded');
  return approvedSendActivityFence.parse({triggerSequence:seq,watermark:observation.watermark,relationshipRevision:observation.relationshipRevision,relationshipProof:observation.relationshipProof,members:observation.members.map(m=>m.chatId)});
 }
 async review(){
  const actions=this.actions(),key=await bridgeHash(['native-review-credentials-v1',this.env.TELEGRAM_BOT_TOKEN,this.env.TELEGRAM_WEBHOOK_SECRET,this.env.WHATSAPP_APPROVED_SEND_SECRET]);
  const authorityGuard=()=>this.retentionGuard();
  const api=new TelegramBotApi(this.env.TELEGRAM_BOT_TOKEN,this.env.TELEGRAM_BOT_INSTANCE!,globalThis.fetch.bind(globalThis),async()=>{await assertRestoredGeneration(this.env);this.currentScope();},'HTML');
  return new NativeTelegramReplyReview({db:this.db!,scope:this.scope,getScope:()=>this.currentScope(),botInstance:this.env.TELEGRAM_BOT_INSTANCE!,key,api,actions,
   contextReader:task=>readNativeReplyReviewContext(this.db!,this.scope,this.origin,task),authorityGuard});
 }
 private retentionGuard(){this.currentScope();return {sql:`NOT EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1) AND NOT EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='quiescing')`,values:[this.scope.installationId,this.scope.installationId]};}
 async frame(task:TaskContext){
  await this.runtime.assertTaskCurrent(task);
  const reads=createConversationReadCapabilities({env:this.env,task,origin:this.origin,assertCurrent:()=>this.runtime.assertTaskCurrent(task),expose:proof=>this.retention.expose(task.identity,proof),getScope:()=>this.currentScope(),authorityGuard:()=>this.retention.authorityGuard(task.sessionId)});
  const curator=isCuratorPrincipal(task.identity.principalOrChatId)?await this.curatorFrame(task):undefined;
  const media=nativeMediaCapability({env:this.env,task,runtime:this.runtime,retention:this.retention,origin:this.origin,getScope:()=>this.currentScope(),authorityGuard:()=>this.retention.authorityGuard(task.sessionId),modelGuard:()=>nativeGlobalBudgetGuard(this.env)});
  const calendar=createNativeCalendarCapability({db:this.db!,env:this.env,scope:this.scope,getScope:()=>this.currentScope(),task,assertCurrent:()=>this.runtime.assertTaskCurrent(task),authorityGuard:async()=>joinGuards(await this.actionAuthority(task),this.retention.authorityGuard(task.sessionId)),ownerFence:()=>nativeOwnerFence(this.env,this.currentScope()),expose:proof=>this.retention.expose(task.identity,proof)});
  return {reads,media,...(curator?{curator}:{}),effects:{reply:async(input:unknown)=>{
   if(task.returnChannel.channel!=='whatsapp')throw Error('native_reply_channel_denied');
   const actions=this.actions(),result=await actions.propose(task,input);
   if(result.authority?.kind==='human_approval'&&result.intent)return {...result,review:await(await this.review()).dispatch(result.intent.id,'native-intent:'+result.intent.id)};
   if(result.authority?.kind==='autonomous_policy'&&result.intent)return actions.execute(result.intent.id,result.authority);
   return result;
  },respondOwner:(text:string)=>this.respondOwner(task,text),askOwner:async(question:string)=>(await this.help()).ask(task,question),calendarChange:(mutation:unknown)=>calendar.change(mutation)}};
 }
 async help(){
  const credentialKey=await bridgeHash(['native-help-credentials-v1',this.env.TELEGRAM_BOT_INSTANCE,this.env.TELEGRAM_BOT_TOKEN,this.env.TELEGRAM_WEBHOOK_SECRET]);
  const api=new TelegramBotApi(this.env.TELEGRAM_BOT_TOKEN,this.env.TELEGRAM_BOT_INSTANCE!,globalThis.fetch.bind(globalThis),async()=>{await assertRestoredGeneration(this.env);this.currentScope();},'HTML');
  return new NativeOwnerHelp({db:this.db!,scope:this.scope,getScope:()=>this.currentScope(),botInstance:this.env.TELEGRAM_BOT_INSTANCE!,credentialKey,api,
   ownerFence:()=>nativeOwnerFence(this.env,this.currentScope()),assertCurrent:task=>this.runtime.assertTaskCurrent(task),
   authorityGuard:async task=>joinGuards(await this.actionAuthority(task),this.retention.authorityGuard(task.sessionId)),activity:task=>this.activity(task),
   exposeSource:(task,ref)=>this.retention.exposeSource(task.identity,ref),
   resume:async input=>this.admit(verifiedConversationEvent({identity:input.task.identity,eventId:input.eventId,revision:1,kind:'clarification',author:{kind:'owner',id:input.ownerFence.userId},occurredAt:input.occurredAt,body:input.text,sourceRef:input.sourceRef,replyTo:input.anchor}),input.originalSequence,input.ownerFence),
  });
 }
 async curator(identity:ConversationIdentity){
  if(!isCuratorPrincipal(identity.principalOrChatId))throw Error('native_curator_denied');
  const sessionId=await conversationAddress(identity,identity.channel,identity.principalOrChatId,identity.contextEpoch),{guard}=await this.authority(identity);
  return new KnowledgeCurator(this.db!,()=>this.currentScope(),{
   assertCurrent:async()=>{await this.registered(sessionId);},
   authorityGuard:()=>joinGuards(guard,this.retention.authorityGuard(sessionId)),
   verifySource:async read=>{
    if(read.fence.source.origin!=='whatsapp')return {state:'current',guard:{sql:'1',values:[]}};
    const fence=await this.origin.fence(read.id);if(!fence)return {state:'changed'};
    const result=await this.origin.checkContext(fence);return result.state==='current'?{state:'current',guard:this.origin.localContextGuard(fence)}:{state:result.state};
   },
   expose:async(_runId,read)=>this.retention.exposeSource(identity,{id:read.id,revision:read.fence.source.revision,version:read.fence.source.version,hash:read.fence.source.hash}),
  });
 }
 private async curatorFrame(task:TaskContext){
  const latest=task.cohort.at(-1);if(!latest||latest.author.kind!=='system'||!latest.eventId.startsWith('curator-run:'))throw Error('native_curator_denied');
  const curator=await this.curator(task.identity),runId=latest.eventId.slice(12);
  return {curator,runId,finish:async(input:{needsHelp?:boolean})=>{
   await this.runtime.assertTaskCurrent(task);const receipt=await curator.finish(runId,input);
   const notice=await this.curatorSummary(task,curator,receipt);return {...receipt,notice};
  }};
 }
 private async curatorSummary(task:TaskContext,curator:KnowledgeCurator,receipt:CuratorReceipt){
  if(!receipt.shouldNotify)return {state:'not_required'};
  const fence=await nativeOwnerFence(this.env,this.currentScope()),link=telegramLinkGuard(fence);
  const topic=await this.db!.prepare(`SELECT thread_id FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=? AND link_revision=? AND slot='summaries' AND state='ready' AND fence_json=? AND (${link.sql})`)
   .bind(this.scope.installationId,this.scope.generation,this.env.TELEGRAM_BOT_INSTANCE!,fence.linkRevision,JSON.stringify(fence),...link.values).first<number>('thread_id');
  if(!topic)return {state:'unavailable',reason:'summary_topic_unavailable'};
  if(!await curator.claimNotice(receipt.id))return {state:'already_claimed'};
  const c=receipt.counts,pending=c.pending+c.presented+c.unavailable+c.indexing+c.capturePending;
  const heading=receipt.kind==='sample'?'AMOSTRA DA MEMÓRIA':'REVISÃO DA MEMÓRIA',scope=receipt.kind==='sample'?`\n\nSomente a janela (${receipt.window.fromSequence}, ${receipt.window.toSequence}] compõe esta amostra. Este ensaio não ativa a rotina diária.`:'';
  const text=`${receipt.state==='complete'?'✅':'⏳'} <b>${heading} — ${telegramText(receipt.window.day)}</b>\n\n${c.evaluated+c.learned} fontes avaliadas; ${c.learned} fontes com aprendizado confirmado.\n${pending} pendências${receipt.needsHelp?' — preciso da sua ajuda':''}.${scope}`;
  try{
   const api=new TelegramBotApi(this.env.TELEGRAM_BOT_TOKEN,this.env.TELEGRAM_BOT_INSTANCE!,globalThis.fetch.bind(globalThis),async()=>{
    await this.runtime.assertTaskCurrent(task);const now=await nativeOwnerFence(this.env,this.currentScope());if(JSON.stringify(now)!==JSON.stringify(fence))throw Error('native_owner_link_changed');
   },'HTML');
   await api.send(fence.chatId,topic,text,[]);await curator.settleNotice(receipt.id,'accepted');return {state:'accepted'};
  }catch{await curator.settleNotice(receipt.id,'uncertain');return {state:'uncertain'};}
 }
 async dispatchCurator(now=Date.now()){
  const request=nativeCuratorDispatchRequest(this.env);if(request.kind==='disabled')return {state:'disabled' as const};
  const scope=this.currentScope(),fence=await nativeOwnerFence(this.env,scope);
  if(request.kind==='sample'){
   // No identity()/registration before the run CAS. Even a contender which
   // observed no previous run must adopt the winner's immutable native epoch.
   const candidate=await this.retention.currentIdentity('telegram','curator:'+fence.userId)??conversationIdentity.parse({version:1,installationId:scope.installationId,generation:scope.generation,channel:'telegram',principalOrChatId:'curator:'+fence.userId,contextEpoch:crypto.randomUUID()});
   const {guard}=await this.authority(candidate);
   // Admission metadata only: this object cannot release or expose originals.
   const admission=new KnowledgeCurator(this.db,()=>this.currentScope(),{assertCurrent:async()=>{await this.authority(candidate);},authorityGuard:()=>guard,
    verifySource:async()=>{throw Error('native_curator_admission_only');},expose:async()=>{throw Error('native_curator_admission_only');}});
   const run=await admission.beginSample(request.request),bound=await admission.bindSampleIdentity(run.id,candidate);
   const prior=await this.db.prepare(`SELECT c.tombstoned_at,e.state,e.task_ref FROM assistant_native_conversations c
    LEFT JOIN assistant_native_conversation_events e ON e.conversation_id=c.id AND e.event_id=?
    WHERE c.id=? AND c.installation_id=? AND c.generation=? ORDER BY e.sequence LIMIT 1`)
    .bind('curator-run:'+run.id,bound.sessionId,scope.installationId,scope.generation).first<{tombstoned_at:number|null;state:string|null;task_ref:string|null}>();this.currentScope();
   if(prior&&(prior.tombstoned_at!==null||prior.state==='withdrawn'))return {state:'retired' as const,runId:run.id,sessionId:bound.sessionId,...(prior.task_ref?{taskRef:prior.task_ref}:{})};
   await this.authority(bound.identity);await this.retention.register(bound.identity);
   const curator=await this.curator(bound.identity);
   if(prior?.task_ref){
    await this.registered(bound.sessionId);
    await curator.reconcileReady(run.id);
    await curator.finish(run.id); // Accounting only; a claimed notice is not resent.
   }
   return this.runtime.deliverConversation(verifiedConversationEvent(await curator.event(run.id,bound.identity,fence.userId)));
  }
  const identity=await this.identity('telegram','curator:'+fence.userId),curator=await this.curator(identity),run=await curator.beginDue(now);
  if(!run)return {state:'not_due' as const};
  // The curator's system job is not a fact SourceRef, owner request or policy.
  return this.runtime.deliverConversation(verifiedConversationEvent(await curator.event(run.id,identity,fence.userId)));
 }
 async respondOwner(task:TaskContext,text:string){
  if(task.identity.channel!=='telegram'||typeof text!=='string'||!text.trim()||text.length>4096)throw Error('native_owner_response_denied');
  const fence=await nativeOwnerFence(this.env,this.scope);if(task.returnChannel.id!==fence.userId)throw Error('native_owner_response_denied');
  const thread=task.returnChannel.threadId?Number(task.returnChannel.threadId):null;
  if(thread!==null&&(!Number.isSafeInteger(thread)||thread<1))throw Error('native_owner_response_denied');
  const rendered=telegramText(text,Infinity).replace(/\*\*([^\n*]+)\*\*/g,'<b>$1</b>').replace(/(?<!\*)\*([^\n*]+)\*(?!\*)/g,'<i>$1</i>').replace(/`([^\n`]+)`/g,'<code>$1</code>');
  const hash=await bridgeHash([fence,thread,rendered]);
  const prior=await this.db!.prepare(`SELECT request_hash,state,message_id FROM assistant_native_owner_responses WHERE context_ref=?`).bind(task.contextRef).first<{request_hash:string;state:string;message_id:number|null}>();
  if(prior){if(prior.request_hash!==hash)throw Error('native_owner_response_conflict');return {state:prior.state,messageId:prior.message_id};}
  const guard=joinGuards(await this.actionAuthority(task),this.retention.authorityGuard(task.sessionId),telegramLinkGuard(fence));
  const claim=await this.db!.prepare(`INSERT INTO assistant_native_owner_responses(installation_id,generation,context_ref,conversation_id,request_hash,link_json,thread_id,state,created_at)
   SELECT ?,?,?,?,?,?,?,'attempting',? WHERE (${guard.sql}) ON CONFLICT DO NOTHING RETURNING state`)
   .bind(this.scope.installationId,this.scope.generation,task.contextRef,task.sessionId,hash,JSON.stringify(fence),thread,Date.now(),...guard.values).first();
  if(!claim)throw Error('native_owner_response_claim_denied');
  try{
   await this.runtime.assertTaskCurrent(task);const latest=await nativeOwnerFence(this.env,this.scope);if(JSON.stringify(latest)!==JSON.stringify(fence))throw Error('native_owner_link_changed');
   const api=new TelegramBotApi(this.env.TELEGRAM_BOT_TOKEN,this.env.TELEGRAM_BOT_INSTANCE!,globalThis.fetch.bind(globalThis),async()=>{await this.runtime.assertTaskCurrent(task);},'HTML');
   const messageId=await api.send(fence.chatId,thread,rendered,[]);
   await this.db!.prepare(`UPDATE assistant_native_owner_responses SET state='sent',message_id=? WHERE context_ref=? AND state='attempting'`).bind(messageId,task.contextRef).run();
   return {state:'sent',messageId};
  }catch{await this.db!.prepare(`UPDATE assistant_native_owner_responses SET state='uncertain' WHERE context_ref=? AND state='attempting'`).bind(task.contextRef).run();return {state:'uncertain'};}
 }
}
