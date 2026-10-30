import type { AgentHandleDispatchRequest, AgentInstanceHandle, DeliveredMessage, DispatchReceipt } from '@flue/runtime';
import { z } from 'zod';
import { bridgeHash } from '../ingress';
import { sourceRef } from '../source-proof-contract';
import type { KnowledgeContext } from '../knowledge/contracts';
import type { KnowledgeService } from '../knowledge/service';
import type { NativeConversationRetention } from './conversation-retention';

const label=z.string().min(1).max(256), integer=z.number().int().nonnegative().safe();
export const conversationIdentity=z.object({version:z.literal(1),installationId:label,generation:label,
 channel:z.enum(['whatsapp','telegram']),principalOrChatId:label,contextEpoch:label}).strict();
export type ConversationIdentity=Readonly<z.infer<typeof conversationIdentity>>;
export type ConversationScope=Pick<ConversationIdentity,'installationId'|'generation'>;
const replyToSchema=z.object({taskRef:label,sourceRef}).strict();
export const nativeTaskWorkRef=z.object({kind:z.enum(['mission','follow_up']),bindingId:label,occurrenceId:label,id:label,version:integer.positive(),dueAt:integer}).strict();
const eventSchema=z.object({identity:conversationIdentity,eventId:label,revision:integer.positive(),
 kind:z.enum(['incoming','owner_manual','correction','withdrawal','action_result','approval','discard','clarification','mission_due','fup_due']),
 author:z.object({kind:z.enum(['owner','person','system']),id:label}).strict(),occurredAt:integer,
 body:z.string(),sourceRef:sourceRef.optional(),attachmentKind:z.enum(['image','pdf']).optional(),threadId:label.optional(),
 actionState:z.enum(['proposed','discarded','approved','attempted','accepted','delivered']).optional(),
 replyTo:replyToSchema.optional(),workRef:nativeTaskWorkRef.optional()}).strict()
 .refine(e=>!e.replyTo||(e.kind==='clarification'&&e.identity.channel==='whatsapp'&&e.author.kind==='owner'),{message:'conversation_reply_anchor_denied'})
 .refine(e=>['mission_due','fup_due'].includes(e.kind)?!!e.workRef&&!!e.sourceRef&&e.identity.channel==='telegram'&&e.author.kind==='system'&&e.author.id==='native-task-host'&&e.workRef.kind===(e.kind==='mission_due'?'mission':'follow_up'):!e.workRef,{message:'native_task_event_denied'});
type DeepReadonly<T>=T extends object?{readonly [K in keyof T]:DeepReadonly<T[K]>}:T;
declare const verified:unique symbol;
export type HostConversationEvent=z.infer<typeof eventSchema>;
export type VerifiedConversationEvent=DeepReadonly<HostConversationEvent>&{readonly [verified]:true};
function immutable<T>(value:T):DeepReadonly<T>{
 if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}
 return value as DeepReadonly<T>;
}
/** Host adapter only: call AFTER authenticating the provider/owner and resolving
 * canonical chat and author. Parsing alone never authenticates an event. The
 * runtime also requires the host's authorizeEvent callback before admission. */
export function verifiedConversationEvent(input:HostConversationEvent):VerifiedConversationEvent{
 return immutable(eventSchema.parse(input)) as VerifiedConversationEvent;
}
export async function conversationAddress(scope:ConversationScope,channel:ConversationIdentity['channel'],principalOrChatId:string,contextEpoch:string){
 const identity=conversationIdentity.parse({version:1,installationId:scope.installationId,generation:scope.generation,channel,principalOrChatId,contextEpoch});
 return 'conversation-v1-'+await bridgeHash([identity.version,identity.installationId,identity.generation,identity.channel,identity.principalOrChatId,identity.contextEpoch]);
}
const address=(identity:ConversationIdentity)=>conversationAddress(identity,identity.channel,identity.principalOrChatId,identity.contextEpoch);
const authoritySchema=z.object({ownerId:label,sourceEpoch:label,sourceGeneration:label,policyRevision:integer,
 grantRef:label,mode:z.enum(['shadow','approval','autonomous'])}).strict();
export type ConversationAuthority=Readonly<z.infer<typeof authoritySchema>>;
type EventRow={sequence:number;conversation_id:string;event_id:string;revision:number;task_ref:string;request_hash:string;
 event_json:string|null;authority_json:string;state:string;receipt_json:string|null};
export type TaskContext=DeepReadonly<{
 contextRef:string;identity:ConversationIdentity;sessionId:string;ownerId:string;taskRef:string;
 cohort:{taskRef:string;eventId:string;revision:number;sequence:number;kind:HostConversationEvent['kind'];occurredAt:number;author:HostConversationEvent['author'];threadId?:string;sourceRef?:z.infer<typeof sourceRef>;workRef?:z.infer<typeof nativeTaskWorkRef>}[];
 /** WhatsApp canonical chat, or Telegram owner principal resolved to its own
  * authenticated transport by the action host. A topic never identifies a DO. */
 watermark:number;returnChannel:{channel:ConversationIdentity['channel'];id:string;threadId?:string};authority:ConversationAuthority;
 knowledge:KnowledgeContext;
 /** Host-verified direct causal anchor. This is not a consumed event from an
  * older native response, and never broadens the current cohort watermark. */
 replyTo?:z.infer<typeof replyToSchema>;
 workRef?:z.infer<typeof nativeTaskWorkRef>;
}>;
export function conversationReplyAnchor(task:TaskContext):{taskRef:string;sourceRef:z.infer<typeof sourceRef>}|undefined{
 if(task.replyTo)return task.replyTo;
 const incoming=[...task.cohort].reverse().find(e=>e.kind==='incoming');
 return incoming?.sourceRef?{taskRef:incoming.taskRef,sourceRef:incoming.sourceRef}:undefined;
}
export type ConversationDeliveryReceipt={sessionId:string;taskRef:string;state:'admitted'|'uncertain';receipt?:DispatchReceipt};
export type ConversationHandle=Pick<AgentInstanceHandle,'dispatch'|'read'>;
export interface ConversationHost {
 /** Host-only native context registry. Required by production wiring. */
 retention?:NativeConversationRetention;
 /** Current authenticated owner/source/policy authority. Must fail closed for
  * restore, withdrawn sources, replaced generations or disabled channels. */
 authority(identity:ConversationIdentity):Promise<ConversationAuthority>;
 authorizeEvent(event:VerifiedConversationEvent):Promise<void>;
 open(sessionId:string):ConversationHandle;
 /** Same P1 service and knowledge space used by MCP; the supplied immutable
  * context is conversation_agent, even when an event was authored by owner. */
 knowledge(context:TaskContext):Promise<KnowledgeService>|KnowledgeService;
 /** Host role after authenticating the private session; never model input. */
 knowledgeClient?(identity:ConversationIdentity):'conversation_agent'|'curator';
 /** Current host domain authority for a system wake, including after admission. */
 assertTask?(task:TaskContext):Promise<void>;
}

function signal(row:EventRow):DeliveredMessage{
 if(!row.event_json)throw Error('conversation_context_withdrawn');
 const event=eventSchema.parse(JSON.parse(row.event_json));
 return {kind:'signal',type:'assistant.conversation.'+event.kind,attributes:{taskRef:row.task_ref},
  body:JSON.stringify({eventId:event.eventId,revision:event.revision,kind:event.kind,author:event.author,
   occurredAt:event.occurredAt,body:event.body,...(event.sourceRef?{sourceRef:event.sourceRef}:{}),...(event.attachmentKind?{attachmentKind:event.attachmentKind}:{}),
   ...(event.threadId?{threadId:event.threadId}:{}),...(event.actionState?{actionState:event.actionState}:{}),...(event.replyTo?{replyTo:event.replyTo}:{}),...(event.workRef?{workRef:event.workRef}:{})})};
}
/** Native intake may reorder JSON object keys. The envelope still has exactly
 * the host's fields and values; the body remains the exact original string. */
function sameDelivery(expected:DeliveredMessage,actual:DeliveredMessage){
 if(expected.kind!=='signal'||actual.kind!=='signal')return false;
 const keys=Object.keys(expected),actualKeys=Object.keys(actual);
 if(keys.length!==actualKeys.length||keys.some(key=>!Object.hasOwn(actual,key)))return false;
 if(expected.type!==actual.type||expected.body!==actual.body||expected.tagName!==actual.tagName)return false;
 const left=expected.attributes,right=actual.attributes;
 if(!left||!right)return left===right;
 const attributeKeys=Object.keys(left);
 return attributeKeys.length===Object.keys(right).length&&attributeKeys.every(key=>Object.hasOwn(right,key)&&left[key]===right[key]);
}
/** Durable admission around native Flue. This class does not send messages,
 * install providers, register public routes, or grant model spending. */
export class ConversationRuntime {
 constructor(private readonly db:D1Database,private readonly host:ConversationHost,private readonly clock=Date.now){}
 private async current(identity:ConversationIdentity){
  const id=await address(identity),row=await this.db.prepare('SELECT identity_json,tombstoned_at FROM assistant_native_conversations WHERE id=?').bind(id).first<{identity_json:string;tombstoned_at:number|null}>();
  if(!row||row.tombstoned_at!==null||row.identity_json!==JSON.stringify(identity))throw Error('conversation_context_withdrawn');
  return authoritySchema.parse(await this.host.authority(identity));
 }
 private async event(taskRef:string){
  const row=await this.db.prepare('SELECT * FROM assistant_native_conversation_events WHERE task_ref=?').bind(taskRef).first<EventRow>();
  if(!row||row.state==='withdrawn'||!row.event_json)throw Error('conversation_delivery_denied');return row;
 }
 private async replyAnchor(event:HostConversationEvent,sessionId:string,before?:number){
  if(!event.replyTo)return;
  const row=await this.event(event.replyTo.taskRef),anchor=eventSchema.parse(JSON.parse(row.event_json!));
  if(row.conversation_id!==sessionId||await address(anchor.identity)!==sessionId||anchor.kind!=='incoming'||anchor.author.kind!=='person'||!anchor.sourceRef
   ||JSON.stringify(anchor.sourceRef)!==JSON.stringify(event.replyTo.sourceRef)||(before!==undefined&&row.sequence>=before))throw Error('conversation_reply_anchor_denied');
 }
 async deliverConversation(event:VerifiedConversationEvent):Promise<ConversationDeliveryReceipt>{
  const parsed=eventSchema.parse(event),identity=immutable(parsed.identity),sessionId=await address(identity);
  await this.host.authorizeEvent(immutable(parsed) as VerifiedConversationEvent);
  await this.replyAnchor(parsed,sessionId);
  const authority=authoritySchema.parse(await this.host.authority(identity)),requestHash=await bridgeHash(parsed),taskRef='conversation-task-v1-'+await bridgeHash([sessionId,parsed.eventId,parsed.revision]);
  await this.db.prepare(`INSERT INTO assistant_native_conversations(id,installation_id,generation,identity_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`)
   .bind(sessionId,identity.installationId,identity.generation,JSON.stringify(identity),this.clock()).run();
  await this.host.retention?.register(identity);
  const currentAuthority=await this.current(identity);
  if(JSON.stringify(currentAuthority)!==JSON.stringify(authority))throw Error('conversation_authority_changed');
  if(parsed.sourceRef)await this.host.retention?.exposeSource(identity,parsed.sourceRef);
  if(parsed.replyTo)await this.host.retention?.exposeSource(identity,parsed.replyTo.sourceRef);
  // Admission and supersession share one D1 transaction. Replaying an older
  // event cannot supersede an intent based on a newer watermark.
  await this.db.batch([
   this.db.prepare(`INSERT INTO assistant_native_conversation_events(conversation_id,event_id,revision,task_ref,request_hash,event_json,authority_json,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_native_conversations WHERE id=? AND tombstoned_at IS NULL) ON CONFLICT DO NOTHING`)
    .bind(sessionId,parsed.eventId,parsed.revision,taskRef,requestHash,JSON.stringify(parsed),JSON.stringify(authority),this.clock(),sessionId),
   this.db.prepare(`UPDATE assistant_native_reply_intents SET state='superseded' WHERE conversation_id=? AND state IN ('proposed','approved')
    AND watermark<(SELECT sequence FROM assistant_native_conversation_events WHERE task_ref=? AND request_hash=?)`).bind(sessionId,taskRef,requestHash),
  ]);
  const row=await this.event(taskRef);
  await this.replyAnchor(parsed,sessionId,row.sequence);
  if(row.request_hash!==requestHash)throw Error('conversation_event_conflict');
  if(row.receipt_json)return {sessionId,taskRef,state:'admitted',receipt:JSON.parse(row.receipt_json)};
  // A lost native ACK is retried only with the SAME idempotency key and exact
  // payload. Flue2.3 owns admission dedupe, including concurrent dispatches.
  if(JSON.stringify(await this.current(identity))!==row.authority_json)throw Error('conversation_authority_changed');
  await this.db.prepare("UPDATE assistant_native_conversation_events SET state='dispatching' WHERE task_ref=? AND state IN ('pending','uncertain')").bind(taskRef).run();
  await this.host.retention?.assertCurrent(identity);
  const request:AgentHandleDispatchRequest={message:signal(row),initialData:identity,idempotencyKey:taskRef};
  try{
   const receipt=await this.host.open(sessionId).dispatch(request);
   await this.current(identity);
   await this.db.prepare("UPDATE assistant_native_conversation_events SET state='admitted',receipt_json=? WHERE task_ref=? AND state<>'withdrawn'").bind(JSON.stringify(receipt),taskRef).run();
   return {sessionId,taskRef,state:'admitted',receipt};
  }catch(error){
   await this.db.prepare("UPDATE assistant_native_conversation_events SET state='uncertain' WHERE task_ref=? AND state IN ('pending','dispatching','uncertain')").bind(taskRef).run();
   // No new delivery key, no inference that an uncertain native call failed.
   await this.current(identity);
   return {sessionId,taskRef,state:'uncertain'};
  }
 }
 /** The native cursor identifies an admitted event, never a grant. For a
  * coalesced response the host supplies the ordered task refs ACTUALLY consumed;
  * queued/unread events must not be included. Each resulting context is frozen. */
 async resolveTask(raw:ConversationIdentity,delivery:DeliveredMessage,consumedTaskRefs?:readonly string[]):Promise<TaskContext>{
  const identity=conversationIdentity.parse(raw),sessionId=await address(identity);
  if(delivery.kind!=='signal'||!delivery.attributes?.taskRef)throw Error('conversation_delivery_denied');
  const cursor=await this.event(delivery.attributes.taskRef);
  if(cursor.conversation_id!==sessionId||!sameDelivery(signal(cursor),delivery))throw Error('conversation_delivery_denied');
  const cursorInput=eventSchema.parse(JSON.parse(cursor.event_json!));await this.replyAnchor(cursorInput,sessionId,cursor.sequence);
  const refs=consumedTaskRefs?[...consumedTaskRefs]:[cursor.task_ref];
  if(!refs.length||refs.at(-1)!==cursor.task_ref||new Set(refs).size!==refs.length)throw Error('conversation_cohort_denied');
  const rows=[];for(const ref of refs){const row=await this.event(ref);if(row.conversation_id!==sessionId||row.sequence>(cursor.sequence)||rows.length&&row.sequence<=rows[rows.length-1].sequence)throw Error('conversation_cohort_denied');rows.push(row);}
  const authority=await this.current(identity);
  if(rows.some(row=>row.authority_json!==JSON.stringify(authority)))throw Error('conversation_authority_changed');
  const cohort=rows.map(row=>{const event=eventSchema.parse(JSON.parse(row.event_json!));return {taskRef:row.task_ref,eventId:row.event_id,revision:row.revision,sequence:row.sequence,kind:event.kind,occurredAt:event.occurredAt,author:event.author,...(event.threadId?{threadId:event.threadId}:{}),...(event.sourceRef?{sourceRef:event.sourceRef}:{}),...(event.workRef?{workRef:event.workRef}:{})};});
  const contextRef='conversation-context-v1-'+await bridgeHash([sessionId,refs,authority]);
  const cursorEvent=cohort[cohort.length-1];
  return immutable({contextRef,identity,sessionId,ownerId:authority.ownerId,taskRef:cursor.task_ref,cohort,watermark:cursor.sequence,
   returnChannel:{channel:identity.channel,id:identity.principalOrChatId,...(identity.channel==='telegram'&&cursorEvent.threadId?{threadId:cursorEvent.threadId}:{})},authority,
   knowledge:{scope:{installationId:identity.installationId,generation:identity.generation,sourceEpoch:authority.sourceEpoch,sourceGeneration:authority.sourceGeneration},client:this.host.knowledgeClient?.(identity)??'conversation_agent'},...(cursorInput.replyTo?{replyTo:cursorInput.replyTo}:{}),...(cursorInput.workRef?{workRef:cursorInput.workRef}:{})});
 }
 async assertTaskCurrent(task:TaskContext){
  await this.host.retention?.assertCurrent(task.identity);
  await this.assertTaskAuthority(task);
 }
 /** Current task authority only, for inner operations whose inputs do not
  * include the conversation history. Callers releasing/using that history
  * still require assertTaskCurrent before and after the operation. */
 async assertTaskAuthority(task:TaskContext){
  const authority=await this.current(task.identity);
  if(task.sessionId!==await address(task.identity)||JSON.stringify(authority)!==JSON.stringify(task.authority))throw Error('conversation_authority_changed');
  const refs=task.cohort.map(event=>event.taskRef),contextRef='conversation-context-v1-'+await bridgeHash([task.sessionId,refs,authority]);
  if(contextRef!==task.contextRef)throw Error('conversation_task_denied');
  // Re-read admitted events, rather than trusting model-provided context fields.
  const row=await this.event(task.taskRef),resolved=await this.resolveTask(task.identity,signal(row),refs);
  if(JSON.stringify(resolved)!==JSON.stringify(task))throw Error('conversation_task_denied');
  await this.host.assertTask?.(task);
 }
 /** Host-only rehydration of a cursor already observed by the native hook.
  * The provider obtains these refs from trusted consumption receipts. */
 async resolveStoredTask(identity:ConversationIdentity,taskRef:string,consumedTaskRefs?:readonly string[]){
  const row=await this.event(taskRef);return this.resolveTask(identity,signal(row),consumedTaskRefs);
 }
 async knowledge(task:TaskContext){await this.assertTaskCurrent(task);const knowledge=await this.host.knowledge(task);
  return this.host.retention?knowledge.withExposure(proof=>this.host.retention!.expose(task.identity,proof)):knowledge;
 }
 async read(taskRef:string,options?:Parameters<AgentInstanceHandle['read']>[1]){
  const row=await this.event(taskRef),event=eventSchema.parse(JSON.parse(row.event_json!));
  if(JSON.stringify(await this.current(event.identity))!==row.authority_json)throw Error('conversation_authority_changed');
  if(!row.receipt_json)return {state:'uncertain' as const,taskRef};
  await this.host.retention?.assertCurrent(event.identity);
  const reply=await this.host.open(row.conversation_id).read(JSON.parse(row.receipt_json),options);
  if(JSON.stringify(await this.current(event.identity))!==row.authority_json)throw Error('conversation_authority_changed');
  await this.host.retention?.assertCurrent(event.identity);
  return {state:'settled' as const,taskRef,reply};
 }
 /** Minimal intent boundary for the future action host. No outgoing effect.
  * Repeating the same context/text returns its existing receipt; uncertainty
  * must be queried on that same intent rather than creating another action. */
 async proposeReply(task:TaskContext,text:string){
  await this.assertTaskCurrent(task);if(typeof text!=='string'||!text.trim())throw Error('conversation_reply_empty');
  const id='conversation-intent-v1-'+await bridgeHash(task.contextRef),hash=await bridgeHash([task.returnChannel,text]);
  const guard=this.host.retention?.authorityGuard(task.sessionId)??{sql:'1',values:[]};
  await this.db.prepare(`INSERT INTO assistant_native_reply_intents(id,conversation_id,context_ref,watermark,request_hash,state,created_at)
   SELECT ?,?,?,?,?,CASE WHEN ?=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=?) THEN 'proposed' ELSE 'superseded' END,?
   WHERE EXISTS(SELECT 1 FROM assistant_native_conversations WHERE id=? AND tombstoned_at IS NULL) AND (${guard.sql}) ON CONFLICT DO NOTHING`)
   .bind(id,task.sessionId,task.contextRef,task.watermark,hash,task.watermark,task.sessionId,this.clock(),task.sessionId,...guard.values).run();
  const result=await this.intentStatus(task,id);if(result.requestHash!==hash)throw Error('conversation_intent_conflict');return result;
 }
 async intentStatus(task:TaskContext,id:string){
  await this.assertTaskCurrent(task);
  const guard=this.host.retention?.authorityGuard(task.sessionId)??{sql:'1',values:[]};
  // The source/policy latch shares the final read snapshot. An awaited check
  // alone cannot authorize a receipt after concurrent withdrawal/correction.
  const row=await this.db.prepare(`SELECT id,state,request_hash AS requestHash,watermark FROM assistant_native_reply_intents WHERE id=? AND conversation_id=? AND context_ref=? AND (${guard.sql})`)
   .bind(id,task.sessionId,task.contextRef,...guard.values).first<{id:string;state:string;requestHash:string;watermark:number}>();
  if(!row){await this.assertTaskCurrent(task);throw Error('conversation_intent_unavailable');}return immutable(row);
 }
 /** Host invalidation hook. This denies the old epoch and drops its event bodies;
  * it does NOT claim physical Flue transcript/compaction deletion (P5). Never
  * pass a model-selected identity here or reuse a tombstoned epoch. */
 async tombstone(identity:ConversationIdentity){
  if(this.host.retention){await this.host.retention.purge(identity);return;}
  const id=await address(conversationIdentity.parse(identity));
  await this.db.batch([
   this.db.prepare(`INSERT INTO assistant_native_conversations(id,installation_id,generation,identity_json,created_at,tombstoned_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET tombstoned_at=excluded.tombstoned_at`).bind(id,identity.installationId,identity.generation,JSON.stringify(identity),this.clock(),this.clock()),
   this.db.prepare("UPDATE assistant_native_conversation_events SET state='withdrawn',event_json=NULL WHERE conversation_id=?").bind(id),
   this.db.prepare("UPDATE assistant_native_reply_intents SET state='superseded' WHERE conversation_id=? AND state IN ('proposed','approved')").bind(id),
  ]);
 }
}
