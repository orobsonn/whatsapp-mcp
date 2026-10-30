import {z} from 'zod';
import {OwnerControl,type NativeMissionEnrollment} from '../control';
import {CommandLedger} from '../command-ledger';
import {compactStatement,jsonStatement} from '../d1-statement';
import {SourceAccess,type AccessGuard,type SourceRead} from '../access';
import {bridgeHash} from '../ingress';
import {sourceRef} from '../source-proof-contract';
import {dueFollowUpGuard,fupInstant} from '../followups';
import type {AssistantEnv} from '../env';
import type {OriginGuard,OriginScope} from '../origin-guard';
import {telegramLinkGuard} from '../telegram-auth';
import {joinGuards,nativeOwnerFence,nativeTelegramActivation} from './native-policy';
import {conversationAddress,verifiedConversationEvent,type ConversationIdentity,type TaskContext,type HostConversationEvent,type ConversationRuntime,type ConversationDeliveryReceipt} from './conversation';
import type {NativeConversationRetention} from './conversation-retention';

const id=z.string().min(1).max(256),version=z.number().int().positive().safe();
const kind=z.enum(['mission','follow_up']);
export const nativeTaskQuery=z.object({kind,id:id.optional(),after:id.optional(),limit:z.number().int().min(1).max(20).default(10)}).strict();
export const nativeMissionSave=z.object({id:id.optional(),expectedRevision:z.number().int().nonnegative().safe().default(0),objective:z.string().min(1).max(2048),
 at:z.string().max(128).nullable().optional(),stopCondition:z.string().max(2048).nullable().optional()}).strict();
export const nativeTaskState=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('mission'),id,version,state:z.enum(['paused','resolved','cancelled'])}).strict(),
 z.object({kind:z.literal('follow_up'),id,version,state:z.enum(['paused','cancelled'])}).strict(),
]);
export const nativeTaskAdopt=z.object({kind,id,version}).strict();
type Ref=z.infer<typeof sourceRef>;
type Resource={id:string;version:number;source_id:string;source_revision:number;project_id:string|null;state:string;title:string;due_at:number|null;stop_condition:string|null};
type Binding={installation_id:string;generation:string;id:string;kind:z.infer<typeof kind>;resource_id:string;resource_version:number;source_ref_json:string;authorization_ref_json:string;
 owner_fence_json:string;activation_key:string;activation_json:string;principal_id:string;thread_id:string|null};
type Occurrence={id:string;binding_id:string;kind:z.infer<typeof kind>;resource_id:string;resource_version:number;due_at:number;conversation_id:string;identity_json:string;event_id:string;event_hash:string;state:string;task_ref:string|null;receipt_json:string|null};
type Host={db:D1Database;env:AssistantEnv;scope:OriginScope;runtime:ConversationRuntime;retention:NativeConversationRetention;origin:OriginGuard;
 authorityGuard(task:TaskContext):Promise<AccessGuard>;clock?:()=>number};
const owner={kind:'owner'} as const;
export const isNativeTaskDue=(event:{kind:string})=>event.kind==='mission_due'||event.kind==='fup_due';
const refOf=(read:SourceRead):Ref=>({id:read.id,revision:read.fence.source.revision,version:read.fence.source.version,hash:read.fence.source.hash});

/** Owner tasks use the existing mission/FUP models. The native tables only
 * record explicit enrollment, consumption and one receipt per occurrence.
 * No legacy JobQueue, new execution engine, WA action or recurring timer DSL. */
export class NativeTasks {
 private readonly clock:()=>number;
 constructor(private readonly h:Host){this.clock=h.clock??Date.now;}
 private keys(){return [this.h.scope.installationId,this.h.scope.generation];}
 private sql(sql:string,...values:(string|number|null)[]){return compactStatement(this.h.db,sql,values);}
 private async resource(type:z.infer<typeof kind>,key:string,expected?:number){
  const row=await this.sql(type==='mission'
   ?`SELECT id,revision version,source_id,source_revision,project_id,state,objective title,next_evaluation_at due_at,stop_condition FROM assistant_missions WHERE installation_id=? AND generation=? AND id=?`
   :`SELECT id,version,source_id,source_revision,project_id,state,purpose title,CASE WHEN due_at IS NOT NULL THEN next_evaluation_at END due_at,condition_text stop_condition FROM assistant_follow_ups WHERE installation_id=? AND generation=? AND id=? ORDER BY version DESC LIMIT 1`,...this.keys(),key).first<Resource>();
  if(!row||expected!==undefined&&row.version!==expected)throw Error('native_task_changed');return row;
 }
 private domain(type:z.infer<typeof kind>,row:Resource,due=false):AccessGuard{
  if(type==='follow_up')return joinGuards(dueFollowUpGuard(this.h.scope,{id:row.id,version:row.version},{id:row.source_id,revision:row.source_revision},due?this.clock():Math.max(this.clock(),row.due_at??0)),{
   sql:'EXISTS(SELECT 1 FROM assistant_follow_ups WHERE installation_id=? AND generation=? AND id=? AND version=? AND purpose=? AND next_evaluation_at=?)',values:[...this.keys(),row.id,row.version,row.title,row.due_at]});
  return {sql:`EXISTS(SELECT 1 FROM assistant_missions WHERE installation_id=? AND generation=? AND id=? AND revision=? AND source_id=? AND source_revision=? AND objective=? AND state='active' AND next_evaluation_at IS ?${due?' AND next_evaluation_at<=?':''})`,
   values:[...this.keys(),row.id,row.version,row.source_id,row.source_revision,row.title,row.due_at,...(due?[this.clock()]:[])]};
 }
 private async source(ref:Ref){
  const access=new SourceAccess(this.h.db,this.h.scope,this.clock,'knowledge'),read=await access.read(owner,ref.id,ref.revision);
  if(!read||read.fence.source.version!==ref.version||read.fence.source.hash!==ref.hash)throw Error('native_task_source_unavailable');
  let guard=access.guard(owner,read.fence,this.clock());
  if(read.fence.source.origin==='whatsapp'){
   const origin=await this.h.origin.fence(ref.id);if(!origin||(await this.h.origin.checkContext(origin)).state!=='current')throw Error('native_task_source_unavailable');
   guard=joinGuards(guard,this.h.origin.localContextGuard(origin));
  }
  return {read,guard};
 }
 private combine(guards:AccessGuard[]):AccessGuard{
  // Keep authority predicates balanced even when many due events join. Every
  // event remains checked; no predicate is replaced by a head-only shortcut.
  const unique=[...new Map(guards.map(guard=>[JSON.stringify([guard.sql,guard.values]),guard])).values()];
  let expressions=unique.map(guard=>`(${guard.sql})`);
  while(expressions.length>1){const next:string[]=[];for(let i=0;i<expressions.length;i+=2)next.push(i+1<expressions.length?`(${expressions[i]} AND ${expressions[i+1]})`:expressions[i]);expressions=next;}
  return {sql:expressions[0]??'1',values:unique.flatMap(guard=>guard.values)};
 }
 private async check(guard:AccessGuard){if(!await jsonStatement(this.h.db,`SELECT 1 WHERE (${guard.sql})`,guard.values).first())throw Error('native_task_changed');}
 private async ownerContext(task:TaskContext,write=false){
  await this.h.runtime.assertTaskCurrent(task);const fence=await nativeOwnerFence(this.h.env,this.h.scope),activation=await nativeTelegramActivation(this.h.env,this.h.scope,fence);
  if(task.identity.channel!=='telegram'||task.identity.principalOrChatId!==fence.userId||task.ownerId!==fence.userId)throw Error('native_task_owner_required');
  const base=joinGuards(await this.h.authorityGuard(task),telegramLinkGuard(fence),activation.guard,this.h.retention.authorityGuard(task.sessionId));
  if(!write)return {fence,activation,guard:base};
  const last=task.cohort.at(-1),ref=last?.sourceRef;
  if(!last||last.kind!=='incoming'||last.author.kind!=='owner'||last.author.id!==fence.userId||!ref)throw Error('native_task_owner_required');
  const row=await this.sql(`SELECT e.event_json,h.owner_link_json,h.source_ref_json,h.telegram_activation_key FROM assistant_native_conversation_events e JOIN assistant_native_host_events h
   ON h.conversation_id=e.conversation_id AND h.event_id=e.event_id AND h.event_revision=e.revision WHERE e.task_ref=? AND e.conversation_id=? AND e.sequence=? AND e.state<>'withdrawn'`,last.taskRef,task.sessionId,last.sequence)
   .first<{event_json:string;owner_link_json:string|null;source_ref_json:string;telegram_activation_key:string}>();
  if(!row||row.owner_link_json!==JSON.stringify(fence)||row.source_ref_json!==JSON.stringify(ref)||row.telegram_activation_key!==activation.key)throw Error('native_task_owner_required');
  const proof=await this.source(ref);
  if(proof.read.fence.source.origin!=='owner_report'||proof.read.text!==JSON.parse(row.event_json).body)throw Error('native_task_owner_required');
  await this.h.retention.exposeSource(task.identity,ref);
  const guard=joinGuards(base,proof.guard,{sql:`EXISTS(SELECT 1 FROM assistant_native_conversation_events WHERE task_ref=? AND conversation_id=? AND sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=?) AND state<>'withdrawn')`,values:[last.taskRef,task.sessionId,task.sessionId]});
  await this.check(guard);return {fence,activation,guard,ref,text:proof.read.text,occurredAt:proof.read.occurredAt};
 }
 /** Reuse the authenticated current owner input for a cross-channel request;
  * tool arguments never supply its body, actor or authority. */
 async ownerRequest(task:TaskContext){
  const context=await this.ownerContext(task,true);
  if(!context.ref||typeof context.text!=='string'||context.occurredAt===undefined)throw Error('native_task_owner_required');
  return {...context,ref:context.ref,text:context.text,occurredAt:context.occurredAt};
 }
 private async binding(type:z.infer<typeof kind>,key:string,v:number){return this.sql('SELECT * FROM assistant_native_task_bindings WHERE installation_id=? AND generation=? AND kind=? AND resource_id=? AND resource_version=?',...this.keys(),type,key,v).first<Binding>();}
 private async enrollment(task:TaskContext,type:z.infer<typeof kind>,key:string,v:number,work:Ref,context:Awaited<ReturnType<NativeTasks['ownerContext']>>):Promise<NativeMissionEnrollment>{
  if(!context.ref)throw Error('native_task_owner_required');
  const raw=await this.sql('SELECT telegram_activation_json FROM assistant_native_host_state WHERE installation_id=? AND generation=?',...this.keys()).first<string>('telegram_activation_json');if(!raw)throw Error('native_task_owner_required');
  return {id:'native-task-binding:'+await bridgeHash([this.keys(),type,key,v]),sourceRefJSON:JSON.stringify(work),authorizationRefJSON:JSON.stringify(context.ref),ownerFenceJSON:JSON.stringify(context.fence),activationKey:context.activation.key,activationJSON:raw,principalId:task.ownerId,threadId:task.returnChannel.threadId??null};
 }
 async save(task:TaskContext,raw:unknown){
  const input=nativeMissionSave.parse(raw),context=await this.ownerContext(task,true);
  if(Boolean(input.id)!==Boolean(input.expectedRevision))throw Error('native_task_revision_required');
  const operationId='native-mission-save:'+await bridgeHash([this.keys(),context.ref,input]);
  const previous=await this.sql('SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id=?',...this.keys(),operationId).first<string>('result_json');
  if(previous){const receipt=JSON.parse(previous) as {id:string;revision:number};const snapshot=await this.sql('SELECT body_json FROM assistant_mission_versions WHERE installation_id=? AND generation=? AND id=? AND revision=?',...this.keys(),receipt.id,receipt.revision).first<string>('body_json');
   return {...receipt,native:'enrolled',scheduledAt:snapshot?JSON.parse(snapshot).nextEvaluationAt:null,timezone:'America/Fortaleza',externalAttempt:false};}
  const old=input.id?await this.resource('mission',input.id,input.expectedRevision):null;
  const projectRevision=old?.project_id?await this.sql('SELECT revision FROM assistant_project_revisions WHERE installation_id=? AND generation=? AND project_id=?',...this.keys(),old.project_id).first<number>('revision'):null;
  if(old?.project_id&&!projectRevision)throw Error('native_task_changed');
  const at=input.at===undefined?old?.due_at??null:input.at===null?null:fupInstant(input.at,'America/Fortaleza');
  const normalized={objective:input.objective,at,stopCondition:input.stopCondition===undefined?old?.stop_condition??null:input.stopCondition};
  const key=input.id??'native-mission:'+await bridgeHash([this.keys(),context.ref,normalized]),ref=context.ref!;
  const native=await this.enrollment(task,'mission',key,input.expectedRevision+1,ref,context);
  const receipt=await new OwnerControl(this.h.db,this.h.scope,owner,this.clock,undefined,()=>context.guard,native).execute({kind:'mission.put',operationId,id:key,expectedRevision:input.expectedRevision,
   objective:input.objective,source:{id:ref.id,revision:ref.revision},...(old?.project_id?{project:{id:old.project_id,revision:projectRevision!}}:{}),state:'active',...(at!==null?{nextEvaluationAt:at}:{}),...(normalized.stopCondition?{stopCondition:normalized.stopCondition}:{})});
  await this.check(context.guard);return {...receipt,native:'enrolled',scheduledAt:at,timezone:'America/Fortaleza',externalAttempt:false};
 }
 async setState(task:TaskContext,raw:unknown){
  const input=nativeTaskState.parse(raw),context=await this.ownerContext(task,true),operationId='native-task-state:'+await bridgeHash([this.keys(),context.ref,input]);
  const command=input.kind==='mission'?{kind:'mission.set_state' as const,operationId,id:input.id,expectedRevision:input.version,state:input.state}
   :{kind:input.state==='paused'?'fup.pause' as const:'fup.cancel' as const,operationId,id:input.id,expectedVersion:input.version};
  const receipt=await new OwnerControl(this.h.db,this.h.scope,owner,this.clock,undefined,()=>context.guard).execute(command);
  await this.check(context.guard);return {...receipt,externalAttempt:false};
 }
 async adopt(task:TaskContext,raw:unknown){
  const input=nativeTaskAdopt.parse(raw),context=await this.ownerContext(task,true),operationId='native-task-adopt:'+await bridgeHash([this.keys(),context.ref,input]),ledger=new CommandLedger(this.h.db,this.h.scope,operationId,await bridgeHash(input));
  const previous=await ledger.recover();if(previous)return previous;
  const row=await this.resource(input.kind,input.id,input.version);
  const read=await new SourceAccess(this.h.db,this.h.scope,this.clock,'knowledge').read(owner,row.source_id,row.source_revision);if(!read)throw Error('native_task_source_unavailable');
  const ref=refOf(read),proof=await this.source(ref),guard=joinGuards(context.guard,proof.guard,this.domain(input.kind,row));
  const existing=await this.binding(input.kind,input.id,input.version);
  if(existing){
   if(existing.owner_fence_json!==JSON.stringify(context.fence)||existing.activation_key!==context.activation.key||existing.source_ref_json!==JSON.stringify(ref))throw Error('native_task_revision_required');
   await this.source(sourceRef.parse(JSON.parse(existing.authorization_ref_json)));
  }
  const binding=await this.enrollment(task,input.kind,input.id,input.version,ref,context);
  const result={operationId,id:input.id,version:input.version,kind:input.kind,native:'enrolled',scheduledAt:row.due_at,externalAttempt:false};
  await this.h.db.batch([ledger.admit(result,this.clock(),guard.sql,guard.values),ledger.statement(`INSERT INTO assistant_native_task_bindings(installation_id,generation,id,kind,resource_id,resource_version,source_ref_json,authorization_ref_json,owner_fence_json,activation_key,activation_json,principal_id,thread_id,created_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE $gate ON CONFLICT DO NOTHING`,...this.keys(),binding.id,input.kind,input.id,input.version,binding.sourceRefJSON,binding.authorizationRefJSON,binding.ownerFenceJSON,binding.activationKey,binding.activationJSON,binding.principalId,binding.threadId,this.clock())]);
  const saved=await ledger.recover();if(!saved)throw Error('native_task_changed');return saved;
 }
 async query(task:TaskContext,raw:unknown){
  const input=nativeTaskQuery.parse(raw),context=await this.ownerContext(task),table=input.kind==='mission'?'assistant_missions':'assistant_follow_ups';
  const rows=await this.sql(`SELECT id FROM ${table} t WHERE installation_id=? AND generation=? ${input.id?'AND id=?':'AND id>?'} ${input.kind==='follow_up'?'AND version=(SELECT MAX(version) FROM assistant_follow_ups x WHERE x.installation_id=t.installation_id AND x.generation=t.generation AND x.id=t.id)':''} ORDER BY id LIMIT ?`,...this.keys(),input.id??input.after??'',input.limit+1).all<{id:string}>();
  const items=[],guards:AccessGuard[]=[context.guard];
  for(const key of rows.results.slice(0,input.limit)){
   const row=await this.resource(input.kind,key.id),base={kind:input.kind,id:row.id,version:row.version,state:row.state,scheduledAt:row.due_at};
   const read=await new SourceAccess(this.h.db,this.h.scope,this.clock,'knowledge').read(owner,row.source_id,row.source_revision);
   if(!read){items.push({...base,content:'unavailable'});continue;}
   const ref=refOf(read),proof=await this.source(ref);await this.h.retention.exposeSource(task.identity,ref);guards.push(proof.guard);
   guards.push({sql:input.kind==='mission'?'EXISTS(SELECT 1 FROM assistant_missions WHERE installation_id=? AND generation=? AND id=? AND revision=? AND state=? AND objective=?)':'EXISTS(SELECT 1 FROM assistant_follow_ups WHERE installation_id=? AND generation=? AND id=? AND version=? AND state=? AND purpose=? AND version=(SELECT MAX(version) FROM assistant_follow_ups x WHERE x.installation_id=? AND x.generation=? AND x.id=?))',values:[...this.keys(),row.id,row.version,row.state,row.title,...(input.kind==='follow_up'?[...this.keys(),row.id]:[])]});
   const enrolled=await this.binding(input.kind,row.id,row.version),occurrences=enrolled?await this.sql('SELECT state FROM assistant_native_task_occurrences WHERE installation_id=? AND generation=? AND binding_id=? ORDER BY created_at DESC LIMIT 1',...this.keys(),enrolled.id).first<{state:string}>():null;
   items.push({...base,objective:row.title,stopCondition:row.stop_condition,sourceRef:ref,native:enrolled?occurrences?.state??'enrolled':'not_enrolled'});
  }
  // One snapshot validates every source/domain fence in the returned page.
  await this.check(this.combine(guards));
  return {items,...(rows.results.length>input.limit?{nextAfter:rows.results[input.limit-1].id}:{}),coverage:'current_page',externalAttempt:false};
 }
 private async occurrence(key:string){const row=await this.sql('SELECT * FROM assistant_native_task_occurrences WHERE installation_id=? AND generation=? AND id=?',...this.keys(),key).first<Occurrence>();if(!row)throw Error('native_task_occurrence_unavailable');return row;}
 private async occurrenceGuard(occurrence:Occurrence,shared?:{sources:Map<string,Awaited<ReturnType<NativeTasks['source']>>>;retention:AccessGuard}){
  const b=await this.sql('SELECT * FROM assistant_native_task_bindings WHERE installation_id=? AND generation=? AND id=?',...this.keys(),occurrence.binding_id).first<Binding>();
  if(!b||b.kind!==occurrence.kind||b.resource_id!==occurrence.resource_id||b.resource_version!==occurrence.resource_version)throw Error('native_task_changed');
  const proof=async(raw:string)=>{const ref=sourceRef.parse(JSON.parse(raw)),key=JSON.stringify(ref),cached=shared?.sources.get(key);if(cached)return cached;const current=await this.source(ref);shared?.sources.set(key,current);return current;};
  const row=await this.resource(b.kind,b.resource_id,b.resource_version),work=await proof(b.source_ref_json),auth=await proof(b.authorization_ref_json);
  if(row.source_id!==work.read.id||row.source_revision!==work.read.fence.source.revision||row.due_at!==occurrence.due_at)throw Error('native_task_changed');
  const ownerFence=await nativeOwnerFence(this.h.env,this.h.scope),activation=await nativeTelegramActivation(this.h.env,this.h.scope,ownerFence);
  if(JSON.stringify(ownerFence)!==b.owner_fence_json||activation.key!==b.activation_key||ownerFence.userId!==b.principal_id)throw Error('native_task_changed');
  const guards=[this.domain(b.kind,row,true),work.guard,auth.guard,telegramLinkGuard(ownerFence),activation.guard,shared?.retention??this.h.retention.authorityGuard(occurrence.conversation_id),{
   sql:`EXISTS(SELECT 1 FROM assistant_native_task_occurrences WHERE installation_id=? AND generation=? AND id=? AND binding_id=? AND conversation_id=? AND state<>'invalidated')`,values:[...this.keys(),occurrence.id,b.id,occurrence.conversation_id]}];
  return {binding:b,row,guards,guard:this.combine(guards)};
 }
 async guardForTask(task:TaskContext):Promise<AccessGuard>{
  // A real new owner request owns its own authority. A revoked old wake in
  // history never disables that owner channel or grants an administrative tool.
  if(!task.workRef)return {sql:'1',values:[]};
  const guards:AccessGuard[]=[],shared={sources:new Map<string,Awaited<ReturnType<NativeTasks['source']>>>(),retention:this.h.retention.authorityGuard(task.sessionId)};
  for(const event of task.cohort){if(!event.workRef)continue;
   const occurrence=await this.occurrence(event.workRef.occurrenceId);
   if(occurrence.conversation_id!==task.sessionId||JSON.stringify(event.workRef)!==JSON.stringify(this.workRef(occurrence)))throw Error('native_task_changed');
   const proof=await this.occurrenceGuard(occurrence,shared);guards.push(...proof.guards);
  }
  const guard=this.combine(guards);await this.check(guard);return guard;
 }
 private workRef(o:Occurrence){return {kind:o.kind,bindingId:o.binding_id,occurrenceId:o.id,id:o.resource_id,version:o.resource_version,dueAt:o.due_at};}
 private event(o:Occurrence,b:Binding,row:Resource):HostConversationEvent{return verifiedConversationEvent({identity:JSON.parse(o.identity_json),eventId:o.event_id,revision:1,kind:b.kind==='mission'?'mission_due':'fup_due',author:{kind:'system',id:'native-task-host'},occurredAt:o.due_at,
  body:JSON.stringify({type:'scheduled_owner_task',objective:row.title,dueAt:o.due_at,condition:row.stop_condition,instructions:'Evaluate the current task and its evidence; a deadline does not prove a condition satisfied. Research when useful, then respond privately to the owner. This system wake grants no administrative changes or third-party sending.'}),
  sourceRef:sourceRef.parse(JSON.parse(b.source_ref_json)),workRef:this.workRef(o),...(b.thread_id?{threadId:b.thread_id}:{})});}
 async authorizeEvent(event:HostConversationEvent){
  if(!isNativeTaskDue(event)||!event.workRef)throw Error('native_task_event_denied');
  const o=await this.occurrence(event.workRef.occurrenceId),proof=await this.occurrenceGuard(o),expected=this.event(o,proof.binding,proof.row);
  if(o.event_hash!==await bridgeHash(event)||JSON.stringify(expected)!==JSON.stringify(event)||!await this.sql('SELECT 1 FROM assistant_native_host_events WHERE conversation_id=? AND event_id=? AND event_revision=1 AND request_hash=? AND source_ref_json=? AND telegram_activation_key=?',o.conversation_id,o.event_id,o.event_hash,proof.binding.source_ref_json,proof.binding.activation_key).first())throw Error('native_task_event_denied');await this.check(proof.guard);
 }
 async dispatchDue(deliver:(event:HostConversationEvent,guard:AccessGuard,activationKey:string,ownerFence:unknown)=>Promise<ConversationDeliveryReceipt>){
  const candidates=await this.sql(`SELECT b.* FROM assistant_native_task_bindings b
   LEFT JOIN assistant_missions m ON b.kind='mission' AND m.installation_id=b.installation_id AND m.generation=b.generation AND m.id=b.resource_id AND m.revision=b.resource_version
   LEFT JOIN assistant_follow_ups f ON b.kind='follow_up' AND f.installation_id=b.installation_id AND f.generation=b.generation AND f.id=b.resource_id AND f.version=b.resource_version
   WHERE b.installation_id=? AND b.generation=? AND ((m.state='active' AND m.next_evaluation_at<=?) OR (f.state IN ('scheduled','awaiting_condition') AND f.due_at IS NOT NULL AND f.next_evaluation_at<=? AND f.version=(SELECT MAX(version) FROM assistant_follow_ups x WHERE x.installation_id=f.installation_id AND x.generation=f.generation AND x.id=f.id)))
   AND NOT EXISTS(SELECT 1 FROM assistant_native_task_occurrences o WHERE o.installation_id=b.installation_id AND o.generation=b.generation AND o.binding_id=b.id AND o.state IN ('admitted','notified','invalidated'))
   ORDER BY COALESCE((SELECT MAX(o.last_attempt_at) FROM assistant_native_task_occurrences o WHERE o.installation_id=b.installation_id AND o.generation=b.generation AND o.binding_id=b.id),0),b.created_at,b.id LIMIT 1`,...this.keys(),this.clock(),this.clock()).all<Binding>();
  if(!candidates.results.length)return {state:'idle'};
  const b=candidates.results[0];let o:Occurrence|undefined;
  try{
   const row=await this.resource(b.kind,b.resource_id,b.resource_version);if(row.due_at===null)throw Error('native_task_unscheduled');
   const key='native-task-occurrence:'+await bridgeHash([this.keys(),b.kind,b.resource_id,b.resource_version,row.due_at]);
   const identity=await this.h.retention.currentIdentity('telegram',b.principal_id);if(!identity)throw Error('native_task_session_unavailable');
   const sessionId=await conversationAddress(identity,'telegram',b.principal_id,identity.contextEpoch);
   const proposed:Occurrence={id:key,binding_id:b.id,kind:b.kind,resource_id:b.resource_id,resource_version:b.resource_version,due_at:row.due_at,conversation_id:sessionId,identity_json:JSON.stringify(identity),event_id:'task:'+key,event_hash:'',state:'pending',task_ref:null,receipt_json:null};
   proposed.event_hash=await bridgeHash(this.event(proposed,b,row));
   // Seal the winner before dispatch/registration. No losing caller rotates a
   // context or reclassifies an already admitted occurrence under a new epoch.
   await this.sql(`INSERT INTO assistant_native_task_occurrences(installation_id,generation,id,binding_id,kind,resource_id,resource_version,due_at,conversation_id,identity_json,event_id,event_hash,state,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT DO NOTHING`,...this.keys(),key,b.id,b.kind,b.resource_id,b.resource_version,row.due_at,sessionId,JSON.stringify(identity),proposed.event_id,proposed.event_hash,this.clock()).run();
   o=await this.occurrence(key);await this.sql('UPDATE assistant_native_task_occurrences SET last_attempt_at=? WHERE installation_id=? AND generation=? AND id=?',this.clock(),...this.keys(),o.id).run();
   const proof=await this.occurrenceGuard(o);await this.check(proof.guard);
   if(o.identity_json!==JSON.stringify(identity))throw Error('native_task_context_changed');
   await this.h.retention.exposeSource(identity,sourceRef.parse(JSON.parse(b.authorization_ref_json)));
   const receipt=await deliver(this.event(o,proof.binding,proof.row),proof.guard,b.activation_key,JSON.parse(b.owner_fence_json));
   await this.sql('UPDATE assistant_native_task_occurrences SET state=?,task_ref=?,receipt_json=? WHERE installation_id=? AND generation=? AND id=? AND state IN (\'pending\',\'uncertain\')',receipt.state,receipt.taskRef,receipt.receipt?JSON.stringify(receipt.receipt):null,...this.keys(),o.id).run();
   return {state:receipt.state,occurrenceId:o.id};
  }catch(error){
   const code=error instanceof Error?error.message:'';
   const permanent=['native_task_changed','native_task_context_changed','conversation_context_withdrawn'].includes(code);
   if(o&&permanent)await this.sql("UPDATE assistant_native_task_occurrences SET state='invalidated' WHERE installation_id=? AND generation=? AND id=? AND state IN ('pending','uncertain')",...this.keys(),o.id).run();
   return {state:'blocked',reason:permanent?code:code==='native_task_source_unavailable'?code:'native_task_unavailable'};
  }
 }
 /** Records an observed private transport ACK, not proof the mission was
  * fulfilled. A concurrent cancellation cannot erase that external fact. */
 async notified(task:TaskContext){if(!task.workRef)return;for(const event of task.cohort)if(event.workRef)await this.sql("UPDATE assistant_native_task_occurrences SET state='notified' WHERE installation_id=? AND generation=? AND id=? AND conversation_id=? AND state IN ('pending','admitted','uncertain')",...this.keys(),event.workRef.occurrenceId,task.sessionId).run();}
}
