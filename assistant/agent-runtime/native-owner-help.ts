import {z} from 'zod';
import {SourceAccess,type AccessGuard,type SourceSelectionRef} from '../access';
import {bridgeHash} from '../ingress';
import type {OriginScope} from '../origin-guard';
import {scopeKeys} from '../origin-guard';
import {telegramLinkGuard,telegramUpdateHash,type TelegramLinkFence} from '../telegram-auth';
import type {TelegramApi} from '../telegram';
import {jsonStatement} from '../d1-statement';
import {conversationReplyAnchor,type TaskContext,type ConversationDeliveryReceipt} from './conversation';

const together=(...guards:AccessGuard[]):AccessGuard=>({sql:guards.map(g=>`(${g.sql})`).join(' AND '),values:guards.flatMap(g=>g.values)});
const owner={kind:'owner'} as const;
const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const question=z.string().min(1).max(2000).refine(text=>!!text.trim());
const positive=z.number().int().positive().safe();
const reply=z.object({update_id:z.number().int().nonnegative().safe(),message:z.object({message_id:positive,date:z.number().int().nonnegative().safe(),from:z.object({id:positive,is_bot:z.literal(false)}).passthrough(),chat:z.object({id:positive,type:z.literal('private')}).passthrough(),text:z.string(),message_thread_id:positive.optional(),reply_to_message:z.object({message_id:positive,chat:z.object({id:positive,type:z.literal('private')}).passthrough(),message_thread_id:positive.optional()}).passthrough()}).passthrough()}).strict();
type Row={id:string;conversation_id:string;context_ref:string;task_json:string;anchor_task_ref:string;source_id:string;source_ref_json:string;original_sequence:number;question_text:string|null;request_hash:string;link_json:string;credential_hash:string;thread_id:number;state:string;message_id:number|null;owner_update_id:number|null;clarification_source_id:string|null;clarification_ref_json:string|null;receipt_json:string|null};
export type NativeHelpResume={questionId:string;task:TaskContext;anchor:{taskRef:string;sourceRef:SourceSelectionRef};originalSequence:number;
 eventId:string;updateId:number;ownerFence:TelegramLinkFence;sourceRef:SourceSelectionRef;text:string;occurredAt:number};
export type NativeOwnerHelpHost={db:D1Database;scope:OriginScope;getScope:()=>OriginScope;botInstance:string;credentialKey:string;api:TelegramApi;
 ownerFence:()=>Promise<TelegramLinkFence>;assertCurrent:(task:TaskContext)=>Promise<void>;
 authorityGuard:(task:TaskContext)=>Promise<AccessGuard>|AccessGuard;
 /** Must verify current Source latest incoming/manual state, not native event
  * sequence. Its result is the original provider message trigger. */
 activity:(task:TaskContext)=>Promise<{triggerSequence:number}>;
 exposeSource:(task:TaskContext,ref:SourceSelectionRef)=>Promise<void>;
 resume:(input:NativeHelpResume)=>Promise<ConversationDeliveryReceipt>;
 conversationLabel?:(task:TaskContext)=>Promise<string>};

/** Durable private question and authenticated quoted-reply correlation. No
 * model argument chooses question ID, return address, source, epoch or anchor. */
export class NativeOwnerHelp {
 constructor(private readonly host:NativeOwnerHelpHost,private readonly clock=Date.now){if(host.credentialKey.length<32)throw Error('native_help_unconfigured');}
 private keys(){return [this.host.scope.installationId,this.host.scope.generation,this.host.botInstance];}
 private sql(sql:string,...values:(string|number|null)[]){return jsonStatement(this.host.db,sql,values);}
 private row(id:string){return this.sql('SELECT * FROM assistant_native_help_questions WHERE installation_id=? AND generation=? AND bot_instance=? AND id=?',...this.keys(),id).first<Row>();}
 private currentScope(){if(JSON.stringify(scopeKeys(this.host.getScope()))!==JSON.stringify(scopeKeys(this.host.scope)))throw Error('native_help_scope_changed');}
 private async current(task:TaskContext,resuming?:Row){
  this.currentScope();await this.host.assertCurrent(task);this.currentScope();
  if(task.identity.channel!=='whatsapp'||task.returnChannel.channel!=='whatsapp'||task.returnChannel.id!==task.identity.principalOrChatId)throw Error('native_help_channel_denied');
  const anchor=conversationReplyAnchor(task);if(!anchor)throw Error('native_help_anchor_missing');
  const access=new SourceAccess(this.host.db,this.host.scope,this.clock,'knowledge'),source=await access.read(owner,anchor.sourceRef.id,anchor.sourceRef.revision);
  if(!source||source.fence.source.origin!=='whatsapp'||source.fence.source.conversationId!==task.returnChannel.id||source.fence.source.version!==anchor.sourceRef.version||source.fence.source.hash!==anchor.sourceRef.hash||!source.text)throw Error('native_help_source_changed');
  const activity=await this.host.activity(task);if(!Number.isSafeInteger(activity.triggerSequence)||activity.triggerSequence<1)throw Error('native_help_anchor_missing');
  const fence=await this.host.ownerFence(),authority=await this.host.authorityGuard(task);
  if(fence.userId!==task.ownerId)throw Error('native_help_owner_changed');
  await this.host.exposeSource(task,anchor.sourceRef);
  const resumeRef=resuming?.state==='resuming'&&resuming.clarification_ref_json?JSON.parse(resuming.clarification_ref_json) as SourceSelectionRef:null;
  const continuation=resumeRef?` OR (event_id=? AND json_extract(event_json,'$.kind')='clarification'
    AND json_extract(event_json,'$.author.kind')='owner' AND json_extract(event_json,'$.author.id')=?
    AND json_extract(event_json,'$.sourceRef.id')=? AND json_extract(event_json,'$.sourceRef.revision')=? AND json_extract(event_json,'$.sourceRef.version')=? AND json_extract(event_json,'$.sourceRef.hash')=?
    AND json_extract(event_json,'$.replyTo.taskRef')=?)`:'';
  const guard=together(authority,telegramLinkGuard(fence),access.guard(owner,source.fence,this.clock()),{
   sql:`EXISTS(SELECT 1 FROM assistant_native_conversation_events WHERE conversation_id=? AND state<>'withdrawn'
    AND sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=?)
    AND ((task_ref=? AND sequence=?)${continuation}))`,values:[task.sessionId,task.sessionId,task.taskRef,task.watermark,
     ...(resumeRef?['help:'+resuming!.id+':owner:'+resuming!.owner_update_id,fence.userId,resumeRef.id,resumeRef.revision,resumeRef.version,resumeRef.hash,anchor.taskRef]:[])]});
  if(!await this.sql(`SELECT 1 WHERE ${guard.sql}`,...guard.values).first())throw Error('native_help_context_changed');
  return {task,anchor,source,fence,guard,originalSequence:activity.triggerSequence};
 }
 private async rowCurrent(row:Row,allowResuming=false){
  if(row.task_json==='{}'||!row.question_text||row.credential_hash!==await bridgeHash(this.host.credentialKey))throw Error('native_help_cancelled');
  const task=JSON.parse(row.task_json) as TaskContext,context=await this.current(task,allowResuming?row:undefined);
  if(context.anchor.taskRef!==row.anchor_task_ref||JSON.stringify(context.anchor.sourceRef)!==row.source_ref_json||context.originalSequence!==row.original_sequence||JSON.stringify(context.fence)!==row.link_json)throw Error('native_help_context_changed');
  const topic:AccessGuard={sql:`EXISTS(SELECT 1 FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=?
   AND link_revision=? AND slot='pending' AND state='ready' AND thread_id=? AND fence_json=?)`,values:[...this.keys(),context.fence.linkRevision,row.thread_id,row.link_json]};
  const guard=together(context.guard,topic);if(!await this.sql(`SELECT 1 WHERE ${guard.sql}`,...guard.values).first())throw Error('native_help_context_changed');
  return {...context,guard};
 }
 private stale(error:unknown){return error instanceof Error&&['native_activity_superseded','native_help_context_changed','native_help_source_changed','conversation_context_withdrawn','native_help_cancelled'].includes(error.message);}
 private async cancelStale(row:Row){await this.sql(`UPDATE assistant_native_help_questions SET state='cancelled',updated_at=? WHERE id=? AND link_json=? AND state IN ('sent','answered','resuming')`,this.clock(),row.id,row.link_json).run();return {state:'stale' as const,questionId:row.id};}
 async ask(task:TaskContext,rawQuestion:unknown){
  const text=question.parse(rawQuestion),context=await this.current(task),id=await bridgeHash(['native-help-v1',this.host.scope,task.contextRef]);
  const hash=await bridgeHash([text,context.anchor,context.originalSequence,context.fence,this.host.credentialKey]),topic=await this.sql(`SELECT thread_id FROM assistant_telegram_topics
   WHERE installation_id=? AND generation=? AND bot_instance=? AND link_revision=? AND slot='pending' AND state='ready' AND fence_json=?`,...this.keys(),context.fence.linkRevision,JSON.stringify(context.fence)).first<number>('thread_id');
  if(!topic)return {state:'topic_unavailable',questionId:id};
  let row=await this.row(id);
  if(!row){
   await this.sql(`INSERT INTO assistant_native_help_questions(installation_id,generation,bot_instance,id,conversation_id,context_ref,task_json,anchor_task_ref,source_id,source_ref_json,original_sequence,question_text,request_hash,link_json,credential_hash,thread_id,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,? WHERE ${context.guard.sql} ON CONFLICT DO NOTHING`,...this.keys(),id,task.sessionId,task.contextRef,JSON.stringify(task),context.anchor.taskRef,context.anchor.sourceRef.id,JSON.stringify(context.anchor.sourceRef),context.originalSequence,text,hash,JSON.stringify(context.fence),await bridgeHash(this.host.credentialKey),topic,this.clock(),this.clock(),...context.guard.values).run();
   row=await this.row(id);if(!row)throw Error('native_help_context_changed');
  }
  if(row.request_hash!==hash)throw Error('native_help_question_conflict');
  if(row.state!=='prepared')return {questionId:id,state:row.state==='attempting'?'uncertain':row.state};
  const label=this.host.conversationLabel?await this.host.conversationLabel(task):context.source.authorLabel??'Conversa do WhatsApp';
  const original=Array.from(context.source.text!).slice(0,600).join(''),clipped=original.length<context.source.text!.length;
  const body=`💬 <b>Preciso de uma orientação</b>\n\n<b>Conversa:</b> ${escape(label)}\n\n📩 <b>Mensagem recebida${clipped?' (trecho)':''}</b>\n${escape(original)}${clipped?'…':''}\n\n❓ ${escape(text)}\n\n<i>Responda a esta mensagem usando “Responder”. Sua orientação não aprova um envio ao WhatsApp.</i>`;
  if(new TextEncoder().encode(body).length>4096)return {questionId:id,state:'preview_too_large'};
  if(!await this.host.api.inspect())return {questionId:id,state:'unavailable'};
  const proof=await this.rowCurrent(row),claim=await this.sql(`UPDATE assistant_native_help_questions SET state='attempting',updated_at=? WHERE id=? AND state='prepared' AND ${proof.guard.sql} RETURNING id`,this.clock(),id,...proof.guard.values).first();
  if(!claim)return {questionId:id,state:'blocked'};
  try{await this.rowCurrent(row);const messageId=await this.host.api.send(proof.fence.chatId,row.thread_id,body,[]);
   await this.sql("UPDATE assistant_native_help_questions SET state='sent',message_id=?,updated_at=? WHERE id=? AND state='attempting'",positive.parse(messageId),this.clock(),id).run();
  }catch{await this.sql("UPDATE assistant_native_help_questions SET state='uncertain',updated_at=? WHERE id=? AND state='attempting'",this.clock(),id).run();}
  return {questionId:id,state:(await this.row(id))!.state};
 }
 /** Compatibility for a live provider retry. The raw body may verify its
  * existing receipt, but never backfills correlation or reconstructs a hash. */
 async recordReply(raw:unknown){
  this.currentScope();const parsed=reply.safeParse(raw);if(!parsed.success)return {state:'unrelated' as const};
  const hash=await telegramUpdateHash(raw);if(!hash)return {state:'unrelated' as const};
  const receipt=await this.sql('SELECT payload_hash FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=?',...this.keys(),parsed.data.update_id).first<{payload_hash:string}>();
  if(!receipt||receipt.payload_hash!==hash)return {state:'denied' as const};
  return this.recordPersistedReply(parsed.data.update_id);
 }
 /** The authenticated inbox committed these sanitized quote identifiers with
  * its pending payload receipt. This path also runs after a process restart or
  * an unavailable Source report, without any original webhook body. */
 async recordPersistedReply(updateId:number){
  this.currentScope();z.number().int().nonnegative().safe().parse(updateId);
  const fence=await this.host.ownerFence(),link=telegramLinkGuard(fence);
  const admitted=await this.sql(`SELECT payload_hash,message_id,thread_id,text,reply_to_message_id,reply_to_chat_id,reply_to_thread_id
   FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=?
   AND source_epoch=? AND source_generation=? AND link_revision=? AND user_id=? AND chat_id=?
   AND outcome='pending' AND state='pending' AND text IS NOT NULL AND ${link.sql}`,
   ...this.keys(),updateId,fence.sourceEpoch,fence.sourceGeneration,fence.linkRevision,fence.userId,fence.chatId,...link.values)
   .first<{payload_hash:string;message_id:number;thread_id:number|null;text:string;reply_to_message_id:number|null;reply_to_chat_id:string|null;reply_to_thread_id:number|null}>();
  if(!admitted)return {state:'denied' as const};
  if(admitted.reply_to_message_id===null)return {state:'unrelated' as const};
  if(admitted.reply_to_chat_id!==fence.chatId)return {state:'denied' as const};
  const prior=await this.sql('SELECT question_id,payload_hash,reply_to_message_id,link_json FROM assistant_native_help_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=?',...this.keys(),updateId).first<{question_id:string;payload_hash:string;reply_to_message_id:number;link_json:string}>();
  if(prior)return prior.payload_hash===admitted.payload_hash&&prior.reply_to_message_id===admitted.reply_to_message_id&&prior.link_json===JSON.stringify(fence)?{state:'recorded' as const,questionId:prior.question_id}:{state:'denied' as const};
  const row=await this.sql(`SELECT * FROM assistant_native_help_questions WHERE installation_id=? AND generation=? AND bot_instance=? AND message_id=? AND state='sent' AND link_json=?`,...this.keys(),admitted.reply_to_message_id,JSON.stringify(fence)).first<Row>();
  if(!row)return {state:'unrelated' as const};
  if(admitted.thread_id!==row.thread_id||(admitted.reply_to_thread_id!==null&&admitted.reply_to_thread_id!==row.thread_id))return {state:'denied' as const};
  let proof:Awaited<ReturnType<NativeOwnerHelp['rowCurrent']>>;
  try{proof=await this.rowCurrent(row);}catch(error){if(this.stale(error))return this.cancelStale(row);throw error;}
  const inbox:AccessGuard={sql:`EXISTS(SELECT 1 FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=? AND payload_hash=? AND source_epoch=? AND source_generation=? AND link_revision=? AND user_id=? AND chat_id=? AND message_id=? AND text=?
   AND reply_to_message_id=? AND reply_to_chat_id=? AND reply_to_thread_id IS ? AND thread_id IS ? AND outcome='pending' AND state='pending')`,
   values:[...this.keys(),updateId,admitted.payload_hash,fence.sourceEpoch,fence.sourceGeneration,fence.linkRevision,fence.userId,fence.chatId,admitted.message_id,admitted.text,admitted.reply_to_message_id,admitted.reply_to_chat_id,admitted.reply_to_thread_id,admitted.thread_id]};
  const guard=together(proof.guard,inbox);
  await this.host.db.batch([
   this.sql(`INSERT INTO assistant_native_help_replies(installation_id,generation,bot_instance,update_id,question_id,payload_hash,reply_to_message_id,link_json,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM assistant_native_help_questions WHERE id=? AND state='sent' AND owner_update_id IS NULL) ON CONFLICT DO NOTHING`,...this.keys(),updateId,row.id,admitted.payload_hash,admitted.reply_to_message_id,JSON.stringify(fence),this.clock(),...guard.values,row.id),
   this.sql(`UPDATE assistant_native_help_questions SET state='answered',owner_update_id=?,updated_at=? WHERE id=? AND state='sent' AND owner_update_id IS NULL AND EXISTS(SELECT 1 FROM assistant_native_help_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=? AND question_id=?) AND ${guard.sql}`,updateId,this.clock(),row.id,...this.keys(),updateId,row.id,...guard.values),
  ]);
  return (await this.row(row.id))?.owner_update_id===updateId?{state:'recorded' as const,questionId:row.id}:{state:'denied' as const};
 }
 /** Canonical owner input is supplied by the SAME authenticated adapter used
  * for owner Telegram. The service binds it to the quoted pending update. */
 async resume(updateId:number,sourceRef:SourceSelectionRef){
  this.currentScope();const link=await this.sql('SELECT question_id FROM assistant_native_help_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=?',...this.keys(),updateId).first<{question_id:string}>();
  if(!link)return {state:'unrelated' as const};const row=await this.row(link.question_id);if(!row)throw Error('native_help_missing');
  if(row.state==='resumed')return {state:'resumed' as const,questionId:row.id,receipt:row.receipt_json?JSON.parse(row.receipt_json):null};
  if(row.state==='cancelled')return {state:'stale' as const,questionId:row.id};
  if(!['answered','resuming'].includes(row.state)||row.owner_update_id!==updateId)throw Error('native_help_cancelled');
  let proof:Awaited<ReturnType<NativeOwnerHelp['rowCurrent']>>;
  try{proof=await this.rowCurrent(row,true);}catch(error){if(this.stale(error))return this.cancelStale(row);throw error;}
  const reply=await this.sql(`SELECT u.text,u.message_date,r.payload_hash FROM assistant_native_help_replies r JOIN assistant_telegram_updates u USING(installation_id,generation,bot_instance,update_id)
   WHERE r.installation_id=? AND r.generation=? AND r.bot_instance=? AND r.update_id=? AND r.question_id=? AND r.link_json=? AND u.payload_hash=r.payload_hash AND u.outcome='pending' AND u.state='pending'`,...this.keys(),updateId,row.id,row.link_json).first<{text:string;message_date:number;payload_hash:string}>();
  if(!reply)throw Error('native_help_reply_changed');
  const access=new SourceAccess(this.host.db,this.host.scope,this.clock,'knowledge'),input=await access.read(owner,sourceRef.id,sourceRef.revision);
  if(!input||input.fence.source.origin!=='owner_report'||input.authorId!==proof.fence.userId||input.fence.source.version!==sourceRef.version||input.fence.source.hash!==sourceRef.hash||input.text!==reply.text)throw Error('native_help_reply_changed');
  await this.host.exposeSource(proof.task,sourceRef);
  const guard=together(proof.guard,access.guard(owner,input.fence,this.clock()));
  const claimed=await this.sql(`UPDATE assistant_native_help_questions SET state='resuming',clarification_source_id=?,clarification_ref_json=?,updated_at=?
   WHERE id=? AND state IN ('answered','resuming') AND owner_update_id=? AND (clarification_ref_json IS NULL OR clarification_ref_json=?) AND ${guard.sql} RETURNING id`,sourceRef.id,JSON.stringify(sourceRef),this.clock(),row.id,updateId,JSON.stringify(sourceRef),...guard.values).first();
  if(!claimed)throw Error('native_help_context_changed');
  const receipt=await this.host.resume({questionId:row.id,eventId:'help:'+row.id+':owner:'+updateId,task:proof.task,anchor:proof.anchor,originalSequence:proof.originalSequence,updateId,ownerFence:proof.fence,sourceRef,text:reply.text,occurredAt:reply.message_date*1000});
  await this.sql(`UPDATE assistant_native_help_questions SET state=?,receipt_json=?,updated_at=? WHERE id=? AND state='resuming' AND owner_update_id=?`,receipt.state==='admitted'?'resumed':'resuming',JSON.stringify(receipt),this.clock(),row.id,updateId).run();
  return {questionId:row.id,state:receipt.state==='admitted'?'resumed' as const:'pending' as const,receipt};
 }
}
