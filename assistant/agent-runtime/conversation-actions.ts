import { useTool } from '@flue/runtime';
import * as v from 'valibot';
import { z } from 'zod';
import type { AccessGuard } from '../access';
import type { OriginScope } from '../origin-guard';
import type { NativeConversationRetention } from './conversation-retention';
import type { ConversationRuntime, TaskContext } from './conversation';
import { authorizeReply } from './action-policy';
import { approvedSendActivityFence, type ApprovedSendActivityFence, type ApprovedSendPrepared, type ApprovedSendReceipt } from '../../src/approved-send-contract';
import { nativeReplyAuthorizationRequest, nativeReplyAuthority, type NativeReplyAuthorization, type NativeReplyActuatorRPC, type NativeReplyExecutionAuthority } from '../../src/native-reply-contract';
import { safeEqual } from '../../src/core';
import { bridgeHash } from '../ingress';

const proposal=z.discriminatedUnion('decision',[
 z.object({decision:z.literal('respond'),text:z.string().min(1).max(8000).refine(s=>!!s.trim()),summary:z.string().max(2000).optional()}).strict(),
 z.object({decision:z.literal('silence'),summary:z.string().max(2000).optional()}).strict(),
]);
type Row={intent_id:string;conversation_id:string;task_json:string;text:string;summary:string;action_id:string|null;prepared_json:string|null;authority_json:string|null;human_guard_json:string|null;receipt_json:string|null;state:string};
export interface NativeReplyHost {
 db:D1Database;scope:OriginScope;runtime:ConversationRuntime;retention:NativeConversationRetention;
 source:NativeReplyActuatorRPC;secret:string;
 /** Must remain host-controlled and default false. */
 autonomousEnabled?:()=>boolean;
 /** Authenticate current grant/mode/policy and return the SAME statement latch
  * for grant/revision/source/install authority. A read-only check is insufficient. */
 authorityGuard(task:TaskContext):Promise<AccessGuard>;
 /** Real Source observation; must derive trigger from the actual task source. */
 activity(task:TaskContext):Promise<ApprovedSendActivityFence>;
}
const terminal=(s:string)=>!['proposed','approved'].includes(s);
const attempted=(s:string)=>['attempting','uncertain','accepted','sent','delivered','read','rejected'].includes(s);
/** Host-only action boundary. Not an RPC accepting arbitrary tasks/guards.
 * Each instance is configured by the authenticated native registry. */
export class NativeReplyActions {
 constructor(private readonly host:NativeReplyHost,private readonly clock=Date.now){
  if(host.secret.length<32)throw Error('native_reply_unconfigured');
 }
 private async row(id:string):Promise<Row>{
  const s=this.host.scope,row=await this.host.db.prepare(`SELECT a.*,i.state FROM assistant_native_reply_actions a JOIN assistant_native_reply_intents i ON i.id=a.intent_id
   WHERE a.intent_id=? AND a.installation_id=? AND a.generation=?`).bind(id,s.installationId,s.generation).first<Row>();
  if(!row)throw Error('native_reply_unavailable');return row;
 }
 private async guard(task:TaskContext):Promise<AccessGuard>{
  const h=this.host,s=h.scope;
  if(task.identity.installationId!==s.installationId||task.identity.generation!==s.generation||task.authority.sourceEpoch!==s.sourceEpoch||task.authority.sourceGeneration!==s.sourceGeneration||task.returnChannel.channel!=='whatsapp'||task.returnChannel.id!==task.identity.principalOrChatId)throw Error('native_reply_scope');
  await h.runtime.assertTaskCurrent(task);await h.retention.assertCurrent(task.identity);
  const authority=await h.authorityGuard(task),retention=h.retention.authorityGuard(task.sessionId);
  return {sql:`(${authority.sql}) AND (${retention.sql}) AND EXISTS(SELECT 1 FROM assistant_native_conversation_events e
   WHERE e.task_ref=? AND e.conversation_id=? AND e.sequence=? AND e.authority_json=? AND e.state<>'withdrawn'
   AND e.sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=e.conversation_id))`,
   values:[...authority.values,...retention.values,task.taskRef,task.sessionId,task.watermark,JSON.stringify(task.authority)]};
 }
 private async current(row:Row){
  if(row.task_json==='{}')throw Error('native_reply_withdrawn');
  const task=JSON.parse(row.task_json) as TaskContext,guard=await this.guard(task),requestHash=await bridgeHash([task.returnChannel,row.text]);
  if(!await this.host.db.prepare(`SELECT 1 FROM assistant_native_reply_intents WHERE id=? AND conversation_id=? AND context_ref=? AND request_hash=? AND state IN ('proposed','approved') AND (${guard.sql})`)
   .bind(row.intent_id,row.conversation_id,task.contextRef,requestHash,...guard.values).first())throw Error('native_reply_superseded');
  return {task,guard};
 }
 async propose(task:TaskContext,input:unknown){
  const q=proposal.parse(input),guard=await this.guard(task);
  if(q.decision==='silence')return {state:'silent' as const,externalAttempt:false as const};
  const intent=await this.host.runtime.proposeReply(task,q.text);
  if(intent.state!=='proposed')return {intent,state:intent.state,externalAttempt:false as const};
  await this.host.db.prepare(`INSERT INTO assistant_native_reply_actions(intent_id,installation_id,generation,conversation_id,task_json,text,summary,created_at)
   SELECT ?,?,?,?,?,?,?,? WHERE (${guard.sql}) AND EXISTS(SELECT 1 FROM assistant_native_reply_intents WHERE id=? AND state='proposed') ON CONFLICT DO NOTHING`)
   .bind(intent.id,task.identity.installationId,task.identity.generation,task.sessionId,JSON.stringify(task),q.text,q.summary??'',this.clock(),...guard.values,intent.id).run();
  const row=await this.row(intent.id);await this.current(row);
  if(row.text!==q.text)throw Error('native_reply_conflict');
  const authority=authorizeReply(task,intent,this.host.autonomousEnabled?.()===true);
  // Shadow stores the very same intelligent proposal without a Source effect.
  if(authority.kind==='shadow'||authority.kind==='blocked')return {intent,authority,state:'proposed' as const,externalAttempt:false as const};
  const prepared=await this.prepare(intent.id);
  if(authority.kind==='autonomous_policy'){
   const checked=await this.current(await this.row(intent.id));
   await this.host.db.prepare(`UPDATE assistant_native_reply_actions SET authority_json=? WHERE intent_id=? AND (${checked.guard.sql})`)
    .bind(JSON.stringify(authority),intent.id,...checked.guard.values).run();
  }
  return {intent,authority,prepared,state:'proposed' as const,externalAttempt:false as const};
 }
 /** Exact native proposal for the authenticated owner review adapter. Names,
  * received content and Source references must still be resolved by its host. */
 async review(intentId:string){
  const row=await this.row(intentId),{task}=await this.current(row);
  return {intentId,task,text:row.text,summary:row.summary,prepared:row.prepared_json?JSON.parse(row.prepared_json) as ApprovedSendPrepared:null};
 }
 async prepare(intentId:string):Promise<ApprovedSendPrepared>{
  const row=await this.row(intentId),{task}=await this.current(row),authority=authorizeReply(task,{id:intentId},this.host.autonomousEnabled?.()===true);
  if(authority.kind==='shadow'||authority.kind==='blocked')throw Error('native_reply_not_authorized');
  if(row.prepared_json)return JSON.parse(row.prepared_json) as ApprovedSendPrepared;
  const activity=approvedSendActivityFence.parse(await this.host.activity(task));
  const prepared=await this.host.source.prepare({secret:this.host.secret,scope:this.host.scope,operationId:intentId,envelope:{kind:'text',chatId:task.returnChannel.id,text:row.text},activity});
  if(prepared.target.chatId!==task.returnChannel.id||prepared.envelope.chatId!==task.returnChannel.id||prepared.envelope.text!==row.text)throw Error('native_reply_target_changed');
  const checked=await this.current(row);
  await this.host.db.prepare(`UPDATE assistant_native_reply_actions SET action_id=?,prepared_json=? WHERE intent_id=? AND (action_id IS NULL OR action_id=?) AND (${checked.guard.sql})`)
   .bind(prepared.actionId,JSON.stringify(prepared),intentId,prepared.actionId,...checked.guard.values).run();
  const saved=await this.row(intentId);if(saved.action_id!==prepared.actionId||!saved.prepared_json)throw Error('native_reply_changed');
  return JSON.parse(saved.prepared_json);
 }
 /** Called ONLY after an authenticated, exact owner callback. The supplied SQL
  * guard must bind its still-active Telegram link/review, not model arguments. */
 async approve(intentId:string,approvalId:string,humanGuard:AccessGuard){
  const row=await this.row(intentId),{task,guard}=await this.current(row);
  if(task.authority.mode!=='approval'||!row.action_id||!row.prepared_json)throw Error('native_reply_not_approvable');
  const authority=nativeReplyAuthority.parse({kind:'human_approval',intentId,approvalId});
  const result=await this.host.db.prepare(`UPDATE assistant_native_reply_actions SET authority_json=?,human_guard_json=?
   WHERE intent_id=? AND (authority_json IS NULL OR authority_json=?) AND (${guard.sql}) AND (${humanGuard.sql})`)
   .bind(JSON.stringify(authority),JSON.stringify(humanGuard),intentId,JSON.stringify(authority),...guard.values,...humanGuard.values).run();
  if(result.meta.changes!==1)throw Error('native_reply_approval_denied');
  return authority;
 }
 async discard(intentId:string,humanGuard:AccessGuard){
  const row=await this.row(intentId),{guard}=await this.current(row);
  const result=await this.host.db.prepare(`UPDATE assistant_native_reply_intents SET state='discarded' WHERE id=? AND state IN ('proposed','approved') AND (${guard.sql}) AND (${humanGuard.sql})`)
   .bind(intentId,...guard.values,...humanGuard.values).run();
  if(result.meta.changes!==1)throw Error('native_reply_discard_denied');return {intentId,state:'discarded' as const,externalAttempt:false as const};
 }
 /** Private Own authorization RPC helper. A five-second proof is not a
  * cross-worker transaction or a promise of instantaneous remote revocation. */
 async authorize(input:unknown):Promise<NativeReplyAuthorization>{
  const q=nativeReplyAuthorizationRequest.parse(input);
  if(!await safeEqual(this.host.secret,q.secret))return {authorized:false};
  try{
   const row=await this.row(q.authority.intentId),{task,guard}=await this.current(row);
   if(row.action_id!==q.actionId||!row.prepared_json||row.authority_json!==JSON.stringify(q.authority))return {authorized:false};
   const prepared=JSON.parse(row.prepared_json) as ApprovedSendPrepared;
   if(prepared.hash!==q.hash||prepared.expiresAt<=this.clock())return {authorized:false};
   let human:AccessGuard={sql:'1',values:[]};
   if(q.authority.kind==='autonomous_policy'){
    const current=authorizeReply(task,{id:row.intent_id},this.host.autonomousEnabled?.()===true);
    if(current.kind!=='autonomous_policy'||JSON.stringify(current)!==JSON.stringify(q.authority))return {authorized:false};
   }else{
    if(task.authority.mode!=='approval'||!row.human_guard_json)return {authorized:false};human=JSON.parse(row.human_guard_json);
   }
   const allowed=await this.host.db.prepare(`SELECT 1 FROM assistant_native_reply_actions a JOIN assistant_native_reply_intents i ON i.id=a.intent_id
    WHERE a.intent_id=? AND a.action_id=? AND a.authority_json=? AND i.state IN ('proposed','approved') AND (${guard.sql}) AND (${human.sql})`)
    .bind(row.intent_id,q.actionId,JSON.stringify(q.authority),...guard.values,...human.values).first();
   return allowed?{authorized:true,actionId:q.actionId,hash:q.hash,authority:q.authority,expiresAt:this.clock()+5000}:{authorized:false};
  }catch{return {authorized:false};}
 }
 private async recordReceipt(row:Row,receipt:ApprovedSendReceipt){
  const state=['accepted','sent'].includes(receipt.status)?'accepted':['delivered','read'].includes(receipt.status)?'delivered'
   :['attempting','uncertain'].includes(receipt.status)?'uncertain':receipt.status==='rejected'?'attempted':null;
  await this.host.db.batch([
   this.host.db.prepare('UPDATE assistant_native_reply_actions SET receipt_json=? WHERE intent_id=? AND action_id=?').bind(JSON.stringify(receipt),row.intent_id,row.action_id),
   this.host.db.prepare('UPDATE assistant_native_reply_intents SET state=? WHERE id=? AND ? IS NOT NULL').bind(state,row.intent_id,state),
  ]);
 }
 async status(intentId:string){
  const row=await this.row(intentId);
  if(!row.action_id)return {intentId,state:row.state,externalAttempt:false as const};
  const receipt=await this.host.source.status({secret:this.host.secret,scope:this.host.scope,actionId:row.action_id});
  await this.recordReceipt(row,receipt);
  return {intentId,state:receipt.status,receipt,externalAttempt:attempted(receipt.status)};
 }
 async execute(intentId:string,authority:NativeReplyExecutionAuthority){
  authority=nativeReplyAuthority.parse(authority);if(authority.intentId!==intentId)throw Error('native_reply_authority_mismatch');
  const row=await this.row(intentId);if(!row.action_id)throw Error('native_reply_not_prepared');
  // Reconcile an already claimed attempt even after authority withdrawal. A
  // proposed Source action still requires a current native proof before send.
  const previous=await this.host.source.status({secret:this.host.secret,scope:this.host.scope,actionId:row.action_id});
  if(terminal(previous.status)){await this.recordReceipt(row,previous);return {intentId,state:previous.status,receipt:previous,externalAttempt:attempted(previous.status)};}
  if(!(await this.authorize({secret:this.host.secret,actionId:row.action_id,hash:previous.hash,authority})).authorized)throw Error('native_reply_denied');
  const receipt:ApprovedSendReceipt=await this.host.source.executeNative({secret:this.host.secret,scope:this.host.scope,actionId:row.action_id,authority});
  // Minimal receipt may be recorded after invalidation; no body is re-exposed.
  await this.recordReceipt(row,receipt);
  return {intentId,state:receipt.status,receipt,externalAttempt:attempted(receipt.status)};
 }
}
export type NativeActionFrame={runtime:ConversationRuntime;task:TaskContext;actions:NativeReplyActions};
/** Only decision/text/summary are model inputs. Destination, mode, actor and
 * policy are resolved from this native frame by the host. */
export function useConversationActionTools(resolveNativeFrame:()=>Promise<NativeActionFrame>){
 useTool({name:'propose_reply',description:'Propose the exact full reply to this conversation, or deliberately stay silent. The host alone determines whether review or policy may authorize delivery.',
  input:v.strictObject({decision:v.picklist(['respond','silence']),text:v.optional(v.pipe(v.string(),v.maxLength(8000))),summary:v.optional(v.pipe(v.string(),v.maxLength(2000)))}),
  async run({data}){const {runtime,task,actions}=await resolveNativeFrame();await runtime.assertTaskCurrent(task);const result=await actions.propose(task,data);return {output:JSON.stringify({state:result.state,intentId:result.intent?.id,authority:result.authority?.kind,externalAttempt:false})};}});
}
