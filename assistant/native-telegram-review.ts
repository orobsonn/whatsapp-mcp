import { z } from 'zod';
import { SourceAccess, type AccessGuard, type SourceRead } from './access';
import { bridgeHash } from './ingress';
import { scopeKeys, type OriginFence, type OriginGuard, type OriginScope } from './origin-guard';
import { telegramLinkGuard, type TelegramLinkFence } from './telegram-auth';
import type { TelegramApi } from './telegram';
import type { NativeReplyActions } from './agent-runtime/conversation-actions';
import { conversationReplyAnchor,type TaskContext } from './agent-runtime/conversation';
import { nativeReplyAuthorizationRequest, type NativeReplyAuthorization } from '../src/native-reply-contract';
import { actionDigest } from '../src/send-envelope';
const ns='installation_id=? AND generation=? AND bot_instance=?',positive=z.number().int().positive().safe(),id=z.string().min(1).max(256);
const callbackSchema=z.object({update_id:z.number().int().nonnegative().safe(),callback_query:z.object({id,from:z.object({id:positive,is_bot:z.literal(false)}).passthrough(),chat_instance:id,data:z.string().regex(/^n_[A-Za-z0-9_-]{43}$/),message:z.object({message_id:positive,date:positive,message_thread_id:positive,chat:z.object({id:positive,type:z.literal('private')}).passthrough()}).passthrough()}).strict()}).strict();
export type NativeReplyReviewContext={source:SourceRead;origin:OriginFence;guard:AccessGuard};
export type NativeTelegramReplyReviewHost={db:D1Database;scope:OriginScope;getScope:()=>OriginScope;botInstance:string;key:string;api:TelegramApi;actions:NativeReplyActions;
 /** Host-authenticated current Source/Origin proof, never a model argument. */
 contextReader:(task:TaskContext)=>Promise<NativeReplyReviewContext>;
 /** Install/credential/restore latch supplied by the registry. */
 authorityGuard:()=>Promise<AccessGuard>|AccessGuard;
};
type Row={id:string;intent_id:string;conversation_id:string;operation_id:string;fence_json:string;credential_hash:string;thread_id:number;action_id:string;action_hash:string;review_hash:string;context_source_id:string|null;context_ref_json:string;context_guard_json:string|null;expires_at:number;state:string;message_id:number|null;approval_state:string;receipt_json:string|null;result_status:string|null;result_state:string};
const combine=(...guards:AccessGuard[]):AccessGuard=>({sql:guards.map(g=>`(${g.sql})`).join(' AND '),values:guards.flatMap(g=>g.values)});
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const html=(s:string)=>escape(s).replace(/^\*_([^\r\n_*]{1,160}:)_\*(?=\r?\n)/u,'<b><i>$1</i></b>');
const bytes=(s:string)=>new TextEncoder().encode(s).length;
const lastSource=(task:TaskContext)=>conversationReplyAnchor(task)?.sourceRef;
/** Real archive/Origin reader for factories. Observation hashes and source body
 * hashes have distinct semantics and are checked against their own fences. */
export async function readNativeReplyReviewContext(db:D1Database,scope:OriginScope,origin:OriginGuard,task:TaskContext):Promise<NativeReplyReviewContext>{
 const ref=lastSource(task);if(!ref)throw Error('native_review_context_unavailable');
 const access=new SourceAccess(db,scope,Date.now,'knowledge'),source=await access.read({kind:'owner'},ref.id,ref.revision),fence=await origin.fence(ref.id);
 if(!source||!fence||(await origin.checkContext(fence)).state!=='current')throw Error('native_review_context_unavailable');
 return {source,origin:fence,guard:combine(access.guard({kind:'owner'},source.fence,Date.now()),origin.localContextGuard(fence))};
}
/** Entire response and summary are shown, or there is no approve button.
 * Only the received message may have an explicitly labelled excerpt. */
export function nativeReplyPreview(target:{name:string;address:string;kind:string},text:string,received:{text:string;authorLabel:string|null},summary:string):string|null{
 const prefix=`💬 <b>Sugestão de resposta</b>\n\n<b>Conversa:</b> ${escape(target.name)}\n${escape(target.address)}${target.kind==='group'?' · Grupo':''}\n\n`;
 const suffix=`${summary?`\n\n🧭 <b>Resumo da IA</b>\n${escape(summary)}`:''}\n\n✍️ <b>Resposta sugerida</b>\n${html(text)}\n\n<i>Aprovar envia esta resposta ao WhatsApp.</i>`;
 const author=received.authorLabel?`<b>Autor informado:</b> ${escape(received.authorLabel)}\n`:'';
 const limit=Math.min(1000,4096-bytes(prefix+suffix+author+'📩 <b>Mensagem recebida (trecho)</b>\n…')-24);
 if(limit<Math.min(80,bytes(escape(received.text))))return null;
 let excerpt='';for(const point of received.text){if(bytes(escape(excerpt+point))>limit)break;excerpt+=point;}
 const clipped=excerpt.length<received.text.length;
 const body=prefix+`📩 <b>Mensagem recebida${clipped?' (trecho)':''}</b>\n`+author+html(excerpt)+(clipped?'…':'')+suffix;
 return bytes(body)<=4096?body:null;
}
/** Private adapter; the router MUST authenticate the Telegram webhook transport
 * before calling receiveCallback. Provider JSON alone is not authentication. */
export class NativeTelegramReplyReview {
 constructor(private readonly host:NativeTelegramReplyReviewHost,private readonly clock=Date.now){
  if(!/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(host.botInstance)||host.key.length<32)throw Error('native_review_unconfigured');
 }
 private keys(){return [this.host.scope.installationId,this.host.scope.generation,this.host.botInstance];}
 private sql(sql:string,...values:(string|number|null)[]){return this.host.db.prepare(sql).bind(...values);}
 private row(id:string){return this.sql(`SELECT * FROM assistant_native_telegram_reviews WHERE ${ns} AND id=?`,...this.keys(),id).first<Row>();}
 private async active(){
  if(JSON.stringify(scopeKeys(this.host.getScope()))!==JSON.stringify(scopeKeys(this.host.scope)))throw Error('native_review_scope_changed');
  const guard=await this.host.authorityGuard();if(!await this.sql(`SELECT 1 WHERE ${guard.sql}`,...guard.values).first())throw Error('native_review_blocked');return guard;
 }
 private async fence():Promise<TelegramLinkFence>{
  const row=await this.sql(`SELECT revision,user_id,chat_id FROM assistant_telegram_links WHERE ${ns} AND source_epoch=? AND source_generation=? AND state='active'`,...this.keys(),this.host.scope.sourceEpoch,this.host.scope.sourceGeneration).first<{revision:number;user_id:string;chat_id:string}>();
  if(!row)throw Error('telegram_unlinked');return {...this.host.scope,botInstance:this.host.botInstance,linkRevision:row.revision,userId:row.user_id,chatId:row.chat_id};
 }
 private async transportGuard(row:Row){
  const fence=JSON.parse(row.fence_json) as TelegramLinkFence;
  if(row.credential_hash!==await bridgeHash(this.host.key))throw Error('native_review_credentials_changed');
  return combine(await this.active(),telegramLinkGuard(fence),{sql:`EXISTS(SELECT 1 FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot='pending' AND state='ready' AND thread_id=? AND fence_json=?)`,values:[...this.keys(),fence.linkRevision,row.thread_id,row.fence_json]});
 }
 private async context(task:TaskContext){
  const proof=await this.host.contextReader(task),ref=lastSource(task),source=proof.source,f=source.fence.source,o=proof.origin;
  if(!ref||source.id!==ref.id||f.id!==ref.id||f.revision!==ref.revision||f.version!==ref.version||f.hash!==ref.hash||f.origin!=='whatsapp'||f.conversationId!==task.returnChannel.id||!source.text?.trim()
   ||source.fence.installationId!==this.host.scope.installationId||source.fence.generation!==this.host.scope.generation
   ||o.canonicalId!==ref.id||o.revision!==ref.revision||o.version!==ref.version||o.chatId!==task.returnChannel.id||!['message','derivative'].includes(o.sourceKind)||JSON.stringify(scopeKeys(o))!==JSON.stringify(scopeKeys(this.host.scope)))throw Error('native_review_context_changed');
  if(!proof.guard?.sql||!Array.isArray(proof.guard.values)||!await this.sql(`SELECT 1 WHERE ${proof.guard.sql}`,...proof.guard.values).first())throw Error('native_review_context_changed');
  return {received:{sourceRef:ref,text:source.text,authorLabel:source.authorLabel},guard:proof.guard,origin:o};
 }
 private async snapshot(intentId:string){
  const review=await this.host.actions.review(intentId);if(review.task.authority.mode!=='approval'||!review.prepared)throw Error('native_review_not_approval');
  const prepared=review.prepared;
  if(prepared.envelope.text!==review.text||prepared.envelope.chatId!==review.task.returnChannel.id||prepared.target.chatId!==review.task.returnChannel.id||prepared.hash!==await actionDigest(prepared.envelope)||prepared.expiresAt<=this.clock())throw Error('native_review_changed');
  const context=await this.context(review.task),ref=context.received.sourceRef;
  // Native retention already embeds current SourceAccess + Origin guards for
  // every exposed source. Bind this exact preview to that retained dependency
  // rather than duplicate those deep predicates (D1: 100 parameters/depth).
  const exposure:AccessGuard={sql:`EXISTS(SELECT 1 FROM assistant_native_context_exposures e WHERE e.conversation_id=? AND e.source_id=?
   AND json_extract(e.source_fence_json,'$.source.id')=e.source_id AND json_extract(e.source_fence_json,'$.source.origin')='whatsapp'
   AND json_extract(e.source_fence_json,'$.source.revision')=? AND json_extract(e.source_fence_json,'$.source.version')=? AND json_extract(e.source_fence_json,'$.source.hash')=?
   AND json_extract(e.origin_fence_json,'$.canonicalId')=e.source_id AND json_extract(e.origin_fence_json,'$.sourceKind')=?
   AND json_extract(e.origin_fence_json,'$.sourceId')=? AND json_extract(e.origin_fence_json,'$.chatId')=? AND json_extract(e.origin_fence_json,'$.hash')=?)`,
   values:[review.task.sessionId,ref.id,ref.revision,ref.version,ref.hash,context.origin.sourceKind,context.origin.sourceId,context.origin.chatId,context.origin.hash]};
  if(!await this.sql(`SELECT 1 WHERE ${exposure.sql}`,...exposure.values).first())throw Error('native_review_untracked_context');
  return {review,body:{received:context.received,text:review.text,summary:review.summary,target:prepared.target},guard:combine(review.guard,exposure),contextGuard:exposure};
 }
 private async current(row:Row){
  if(row.expires_at<=this.clock()||row.context_ref_json==='{}')throw Error('native_review_expired');
  const snapshot=await this.snapshot(row.intent_id),prepared=snapshot.review.prepared!;
  if(row.review_hash!==await bridgeHash(snapshot.body)||prepared.actionId!==row.action_id||prepared.hash!==row.action_hash)throw Error('native_review_changed');
  return combine(await this.transportGuard(row),snapshot.guard,{sql:`EXISTS(SELECT 1 FROM assistant_native_reply_intents WHERE id=? AND state IN ('proposed','approved'))`,values:[row.intent_id]});
 }
 private async capability(row:Row,action:'approved'|'discarded'){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(this.host.key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['native-telegram-review-v1',this.host.scope,this.host.botInstance,row.id,row.intent_id,row.fence_json,row.credential_hash,row.thread_id,row.action_id,row.action_hash,row.review_hash,row.expires_at,action]))));
  return 'n_'+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 }
 async dispatch(intentId:string,operationId:string):Promise<{id:string;state:string}>{
  id.parse(intentId);id.parse(operationId);await this.active();const reviewId=await bridgeHash(['native-telegram-review-v1',this.host.scope,this.host.botInstance,intentId]);let row=await this.row(reviewId);
  if(!row){
   const snapshot=await this.snapshot(intentId),prepared=snapshot.review.prepared!,fence=await this.fence();
   const topic=await this.sql(`SELECT thread_id FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot='pending' AND state='ready' AND fence_json=?`,...this.keys(),fence.linkRevision,JSON.stringify(fence)).first<{thread_id:number}>();
   if(!topic)return {id:reviewId,state:'topic_unavailable'};
   if(!nativeReplyPreview(prepared.target,snapshot.body.text,snapshot.body.received,snapshot.body.summary))return {id:reviewId,state:'preview_too_large'};
   row={id:reviewId,intent_id:intentId,conversation_id:snapshot.review.task.sessionId,operation_id:operationId,fence_json:JSON.stringify(fence),credential_hash:await bridgeHash(this.host.key),thread_id:topic.thread_id,action_id:prepared.actionId,action_hash:prepared.hash,review_hash:await bridgeHash(snapshot.body),context_source_id:snapshot.body.received.sourceRef.id,context_ref_json:JSON.stringify(snapshot.body.received.sourceRef),context_guard_json:JSON.stringify(snapshot.contextGuard),expires_at:prepared.expiresAt,state:'prepared',message_id:null,approval_state:'pending',receipt_json:null,result_status:null,result_state:'pending'};
   const gate=await this.current(row);
   await this.sql(`INSERT INTO assistant_native_telegram_reviews(installation_id,generation,bot_instance,id,intent_id,conversation_id,operation_id,fence_json,credential_hash,thread_id,action_id,action_hash,review_hash,context_source_id,context_ref_json,context_guard_json,expires_at,state,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',? WHERE ${gate.sql} ON CONFLICT DO NOTHING`,...this.keys(),row.id,row.intent_id,row.conversation_id,row.operation_id,row.fence_json,row.credential_hash,row.thread_id,row.action_id,row.action_hash,row.review_hash,row.context_source_id,row.context_ref_json,row.context_guard_json,row.expires_at,this.clock(),...gate.values).run();
   row=await this.row(reviewId);if(!row)return {id:reviewId,state:'blocked'};
  }
  if(row.intent_id!==intentId||row.operation_id!==operationId)throw Error('native_review_conflict');
  if(row.state!=='prepared')return {id:row.id,state:row.state==='attempting'?'uncertain':row.state};
  if(!await this.host.api.inspect())return {id:row.id,state:'blocked'};
  const gate=await this.current(row),{body}=await this.snapshot(row.intent_id),preview=nativeReplyPreview(body.target,body.text,body.received,body.summary);
  if(!preview)return {id:row.id,state:'preview_too_large'};
  const claim=await this.sql(`UPDATE assistant_native_telegram_reviews SET state='attempting' WHERE ${ns} AND id=? AND state='prepared' AND expires_at>? AND ${gate.sql} RETURNING id`,...this.keys(),row.id,this.clock(),...gate.values).first();
  if(!claim)return {id:row.id,state:'blocked'};
  try{
   const final=await this.current(row);if(!await this.sql(`SELECT 1 WHERE ${final.sql}`,...final.values).first())throw Error('native_review_changed');
   const message=await this.host.api.send((JSON.parse(row.fence_json) as TelegramLinkFence).chatId,row.thread_id,preview,[[{text:'✅ Aprovar e enviar',callback_data:await this.capability(row,'approved')},{text:'❌ Descartar',callback_data:await this.capability(row,'discarded')}]]);
   await this.sql(`UPDATE assistant_native_telegram_reviews SET state='sent',message_id=? WHERE ${ns} AND id=? AND state='attempting'`,positive.parse(message),...this.keys(),row.id).run();
  }catch{await this.sql(`UPDATE assistant_native_telegram_reviews SET state='uncertain' WHERE ${ns} AND id=? AND state='attempting'`,...this.keys(),row.id).run();}
  return {id:row.id,state:(await this.row(row.id))!.state};
 }
 private approvalGuard(row:Row,transport:AccessGuard){
  const context:AccessGuard=row.context_guard_json?JSON.parse(row.context_guard_json):{sql:'0',values:[]};
  return combine(transport,context,{sql:`EXISTS(SELECT 1 FROM assistant_native_telegram_reviews r JOIN assistant_native_telegram_callbacks c ON c.installation_id=r.installation_id AND c.generation=r.generation AND c.bot_instance=r.bot_instance AND c.review_id=r.id
   WHERE r.installation_id=? AND r.generation=? AND r.bot_instance=? AND r.id=? AND r.intent_id=? AND r.action_id=? AND r.action_hash=? AND r.review_hash=? AND r.credential_hash=? AND r.message_id=? AND r.thread_id=? AND r.approval_state='approved' AND c.action='approved' AND r.expires_at>?)`,values:[...this.keys(),row.id,row.intent_id,row.action_id,row.action_hash,row.review_hash,row.credential_hash,row.message_id,row.thread_id,this.clock()]});
 }
 /** Real approval proof delegate for Own RPC factories. Core also revalidates
  * this persisted review/link/source SQL guard before its short-lived proof. */
 async authorize(raw:unknown):Promise<NativeReplyAuthorization>{
  try{const input=nativeReplyAuthorizationRequest.parse(raw);if(input.authority.kind!=='human_approval')return {authorized:false};
   const row=await this.row(input.authority.approvalId);if(!row||row.intent_id!==input.authority.intentId)return {authorized:false};await this.current(row);return this.host.actions.authorize(input);
  }catch{return {authorized:false};}
 }
 async receiveCallback(raw:unknown):Promise<string>{
  let input:unknown;try{const json=JSON.stringify(raw);if(bytes(json)>65536)return 'denied';input=JSON.parse(json);}catch{return 'denied';}
  const data=(input as {callback_query?:{data?:unknown}})?.callback_query?.data;if(typeof data!=='string'||!data.startsWith('n_'))return 'unsupported';
  const parsed=callbackSchema.safeParse(input);if(!parsed.success)return 'denied';const update=parsed.data,c=update.callback_query;
  if(['sender_chat','via_bot','forward_origin','forward_from','forward_from_chat','business_connection_id'].some(key=>key in c.message))return 'denied';
  const payloadHash=await bridgeHash([update.update_id,c.id,c.from.id,c.chat_instance,c.data,c.message.message_id,c.message.date,c.message.message_thread_id,c.message.chat.id]);
  const rows=await this.sql(`SELECT * FROM assistant_native_telegram_reviews WHERE ${ns} AND message_id=? AND thread_id=? AND state='sent' AND json_extract(fence_json,'$.chatId')=? LIMIT 2`,...this.keys(),c.message.message_id,c.message.message_thread_id,String(c.message.chat.id)).all<Row>();
  if(rows.results.length!==1)return 'denied';const row=rows.results[0],fence=JSON.parse(row.fence_json) as TelegramLinkFence;
  if(String(c.from.id)!==fence.userId||String(c.message.chat.id)!==fence.chatId)return 'denied';
  const action=c.data===await this.capability(row,'approved')?'approved':c.data===await this.capability(row,'discarded')?'discarded':null;if(!action)return 'denied';
  let transport:AccessGuard;try{transport=await this.transportGuard(row);if(!await this.sql(`SELECT 1 WHERE ${transport.sql}`,...transport.values).first())return 'denied';}catch{return 'denied';}
  const prior=await this.sql(`SELECT payload_hash,review_id FROM assistant_native_telegram_callbacks WHERE ${ns} AND (update_id=? OR query_id=?)`,...this.keys(),update.update_id,c.id).first<{payload_hash:string;review_id:string}>();
  if(prior&&(prior.payload_hash!==payloadHash||prior.review_id!==row.id))return 'conflict';
  if(prior||row.approval_state!=='pending'){
   if(row.approval_state!==action)return 'denied';if(action==='approved')try{await this.reconcile(row.id);}catch{}
   try{await this.host.api.answer(c.id,'Decisão já registrada. Nenhum novo envio foi feito.');}catch{}return 'duplicate';
  }
  let gate:AccessGuard;try{gate=await this.current(row);}catch{return 'denied';}
  const receipt=`EXISTS(SELECT 1 FROM assistant_native_telegram_callbacks WHERE ${ns} AND review_id=? AND update_id=? AND payload_hash=? AND action=?)`;
  const results=await this.host.db.batch([
   this.sql(`INSERT INTO assistant_native_telegram_callbacks(installation_id,generation,bot_instance,update_id,query_id,payload_hash,review_id,action,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${gate.sql} AND EXISTS(SELECT 1 FROM assistant_native_telegram_reviews WHERE ${ns} AND id=? AND state='sent' AND approval_state='pending') ON CONFLICT DO NOTHING RETURNING review_id`,...this.keys(),update.update_id,c.id,payloadHash,row.id,action,this.clock(),...gate.values,...this.keys(),row.id),
   this.sql(`UPDATE assistant_native_telegram_reviews SET approval_state=? WHERE ${ns} AND id=? AND approval_state='pending' AND ${receipt}`,action,...this.keys(),row.id,...this.keys(),row.id,update.update_id,payloadHash,action),
  ]);
  if(!results[0].results.length)return 'denied';
  try{
   if(action==='approved'){
    const authority=await this.host.actions.approve(row.intent_id,row.id,this.approvalGuard(row,transport));
    await this.host.actions.execute(row.intent_id,authority);
   }else await this.host.actions.discard(row.intent_id,combine(transport,{sql:`EXISTS(SELECT 1 FROM assistant_native_telegram_reviews WHERE ${ns} AND id=? AND approval_state='discarded')`,values:[...this.keys(),row.id]}));
  }catch{/* Reconcile the sole Source action; an exception never permits retry. */}
  if(action==='approved')try{await this.reconcile(row.id);}catch{}
  else await this.result(row,'discarded');
  try{await this.host.api.answer(c.id,action==='approved'?'Aprovação registrada. Confira o resultado nesta conversa.':'Sugestão descartada.');}catch{}
  return action;
 }
 async status(reviewId:string){
  const row=await this.row(reviewId);if(!row)throw Error('native_review_unavailable');
  const gate=await this.transportGuard(row);if(!await this.sql(`SELECT 1 WHERE ${gate.sql}`,...gate.values).first())throw Error('native_review_blocked');
  return {id:row.id,intentId:row.intent_id,noticeState:row.state==='attempting'?'uncertain':row.state,approvalState:row.approval_state,result:row.receipt_json?JSON.parse(row.receipt_json):null};
 }
 /** Read-only Source reconciliation. Never calls execute, even when the first
  * callback crashed before a provider attempt. */
 async reconcile(reviewId:string){
  const row=await this.row(reviewId);if(!row)throw Error('native_review_unavailable');
  const gate=await this.transportGuard(row);if(!await this.sql(`SELECT 1 WHERE ${gate.sql}`,...gate.values).first())throw Error('native_review_blocked');
  if(row.approval_state!=='approved')return this.status(row.id);
  const status=await this.host.actions.status(row.intent_id);
  if(!('receipt'in status)||!status.receipt||status.receipt.actionId!==row.action_id||status.receipt.hash!==row.action_hash)throw Error('native_review_status_mismatch');
  const saved=await this.sql(`UPDATE assistant_native_telegram_reviews SET receipt_json=?,result_state=CASE WHEN result_status IS ? THEN result_state ELSE 'pending' END,result_status=? WHERE ${ns} AND id=? AND receipt_json IS ? RETURNING id`,JSON.stringify(status.receipt),status.state,status.state,...this.keys(),row.id,row.receipt_json).first();
  if(saved)await this.result((await this.row(row.id))!,status.state);return this.status(row.id);
 }
 private async result(row:Row,status:string){
  const labels:Record<string,string>={accepted:'⏳ <b>Aceito pelo WhatsApp</b>\n\nO provedor aceitou a mensagem. A entrega ainda não foi confirmada.',sent:'✅ <b>Mensagem enviada</b>',delivered:'✅ <b>Mensagem entregue</b>',read:'✅ <b>Mensagem lida</b>',uncertain:'⏳ <b>Resultado em conferência</b>\n\nNão vou repetir a tentativa enquanto confiro o resultado.',rejected:'❌ <b>Envio recusado</b>',cancelled:'❌ <b>Envio cancelado</b>',expired:'⌛ <b>Aprovação expirada</b>',discarded:'❌ <b>Sugestão descartada</b>\n\nNenhuma mensagem foi enviada.',proposed:'⚠️ <b>Envio não confirmado</b>\n\nA aprovação foi registrada, mas a conversa precisa ser reavaliada.',approved:'⏳ <b>Envio ainda não confirmado</b>'};
  let gate:AccessGuard;try{gate=await this.transportGuard(row);}catch{return;}
  const claim=await this.sql(`UPDATE assistant_native_telegram_reviews SET result_state='attempting',result_status=? WHERE ${ns} AND id=? AND result_state='pending' AND (result_status IS ? OR result_status IS NULL) AND ${gate.sql} RETURNING id`,status,...this.keys(),row.id,status,...gate.values).first();if(!claim)return;
  try{await this.active();await this.host.api.send((JSON.parse(row.fence_json) as TelegramLinkFence).chatId,row.thread_id,labels[status]??labels.uncertain,[]);await this.sql(`UPDATE assistant_native_telegram_reviews SET result_state='sent' WHERE ${ns} AND id=? AND result_state='attempting' AND result_status=?`,...this.keys(),row.id,status).run();}
  catch{await this.sql(`UPDATE assistant_native_telegram_reviews SET result_state='uncertain' WHERE ${ns} AND id=? AND result_state='attempting' AND result_status=?`,...this.keys(),row.id,status).run();}
 }
}
