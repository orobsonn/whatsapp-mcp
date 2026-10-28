import { z } from 'zod';
import type { AssistantEnv } from './env';
import type { OwnerAffinity } from './mcp';
import type { DecisionJournal } from './decisions';
import type { AccessGuard } from './access';
import { bridgeHash } from './ingress';
import { telegramLinkGuard, type TelegramLinkFence } from './telegram-auth';
import { TelegramBotApi, type TelegramApi } from './telegram';
import { retentionExecutionGuard } from './retention-execution';
import { assertRestoredGeneration } from './retention-runtime';
import { hostConfiguredSearch } from './configured-search';
import { DecisionJournal as Journal } from './decisions';
import { outgoingPort } from './outgoing';
import { actionDigest, canonicalEnvelope } from '../src/send-envelope';
import type { ApprovedSendPrepared, ApprovedSendReceipt, ApprovedSendAuthorization } from '../src/approved-send-contract';
import {approvedSendActivityFence} from '../src/approved-send-contract';
import {readPilotConversationActivity,activityPolicyGuard,pilotAllowsConversation} from './proactive-pilot';
import {Episodes} from './agent/episodes';
import {boundEpisode} from './agent/contracts';
import {SourceAccess} from './access';

const ns='installation_id=? AND generation=? AND bot_instance=?';
type JournalPort=Pick<DecisionJournal,'get'|'admitReview'>;
type Row={id:string;operation_id:string;decision_id:string;proposal_hash:string;fence_json:string;pilot_json:string;credential_hash:string;thread_id:number;action_id:string;action_hash:string;envelope_json:string;target_json:string;expires_at:number;state:string;message_id:number|null;approval_state:string;receipt_json:string|null;result_notice:string};
const positive=z.number().int().positive().safe(), label=z.string().min(1).max(256);
const callbackSchema=z.object({update_id:z.number().int().nonnegative().safe(),callback_query:z.object({id:label,from:z.object({id:positive,is_bot:z.literal(false)}).passthrough(),chat_instance:label,data:z.string().regex(/^w_[A-Za-z0-9_-]{43}$/),message:z.object({message_id:positive,date:positive,message_thread_id:positive,chat:z.object({id:positive,type:z.literal('private')}).passthrough()}).passthrough()}).strict()}).strict();
const authorizationInput=z.object({secret:z.string().max(256),approvalId:label,actionId:z.uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const receivedContext=z.object({sourceId:label,revision:positive,version:positive,hash:z.string().regex(/^[a-f0-9]{64}$/),text:z.string().min(1).max(32768)}).strict();
type ReceivedContext=z.infer<typeof receivedContext>;
type ReviewDetail=Awaited<ReturnType<JournalPort['get']>>;
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

/** Host-only actuator. The model can propose text; only this authenticated
 * callback records approval. Historical r_ simulation buttons never reach it. */
export class TelegramApprovedSendReview {
 constructor(private env:AssistantEnv,private scope:OwnerAffinity,private bot:string,private key:string,private api:TelegramApi,private journal:JournalPort,private clock=Date.now,private hostGuard?:()=>AccessGuard,private contextReader?:(detail:ReviewDetail)=>Promise<ReceivedContext|null>){}
 private keys(){return [this.scope.installationId,this.scope.generation,this.bot];}
 private sql(sql:string,...values:(string|number|null)[]){return this.env.DB!.prepare(sql).bind(...values);}
 private configured(){return this.env.WHATSAPP_APPROVED_SEND_ENABLED==='true'&&this.env.FLUE_EPISODES_ENABLED==='shadow'&&this.env.ROUTINES_PAUSED!=='true'&&!!this.env.WHATSAPP_APPROVED_SEND&&!!this.env.WHATSAPP_APPROVED_SEND_SECRET&&this.env.INSTALLATION_ID===this.scope.installationId&&this.env.OPERATIONAL_GENERATION===this.scope.generation&&this.env.BRIDGE_SOURCE_EPOCH===this.scope.sourceEpoch&&this.env.BRIDGE_SOURCE_GENERATION===this.scope.sourceGeneration;}
 private guard(){const local=retentionExecutionGuard(this.scope),host=this.hostGuard?.();return host?{sql:`(${local.sql}) AND (${host.sql})`,values:[...local.values,...host.values]}:local;}
 private async active(){if(!this.configured())throw Error('approved_send_disabled');const guard=this.guard();if(!await this.sql(`SELECT 1 WHERE ${guard.sql}`,...guard.values).first())throw Error('approved_send_paused');}
 private row(id:string){return this.sql(`SELECT * FROM assistant_telegram_send_reviews WHERE ${ns} AND id=?`,...this.keys(),id).first<Row>();}
 private async fence():Promise<TelegramLinkFence>{const row=await this.sql(`SELECT revision,user_id,chat_id FROM assistant_telegram_links WHERE ${ns} AND source_epoch=? AND source_generation=? AND state='active'`,...this.keys(),this.scope.sourceEpoch,this.scope.sourceGeneration).first<{revision:number;user_id:string;chat_id:string}>();if(!row)throw Error('telegram_unlinked');return {...this.scope,botInstance:this.bot,linkRevision:row.revision,userId:row.user_id,chatId:row.chat_id};}
 private gates(row:Row){const fence=JSON.parse(row.fence_json) as TelegramLinkFence,link=telegramLinkGuard(fence),effect=this.guard(),activity=approvedSendActivityFence.safeParse(JSON.parse(row.target_json).activity),policy=activity.success?activityPolicyGuard(this.scope,activity.data.members):{sql:'0',values:[]};return {sql:`(${link.sql}) AND (${effect.sql}) AND (${policy.sql}) AND EXISTS(SELECT 1 FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot='pending' AND state='ready' AND thread_id=? AND fence_json=?)`,values:[...link.values,...effect.values,...policy.values,...this.keys(),fence.linkRevision,row.thread_id,row.fence_json]};}
 private async capability(row:Row,action:'approved'|'discarded'){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(this.key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['telegram-approved-send-v1',row.id,row.fence_json,row.pilot_json,row.thread_id,row.decision_id,row.proposal_hash,row.action_id,row.action_hash,row.target_json,row.expires_at,action]))));
  return 'w_'+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 }
 private async received(detail:ReviewDetail):Promise<ReceivedContext|null>{
  try{
   if(this.contextReader)return receivedContext.nullable().parse(await this.contextReader(detail));
   if(!('proposal'in detail)||!detail.proposal||detail.subject?.kind!=='capture_event')return null;
   const proposal=detail.proposal,raw=await new Episodes(this.env.DB!,this.scope,this.clock).get(proposal.binding.episodeId);
   if(!raw||raw.binding_hash!==proposal.binding.bindingHash||raw.job_id!==proposal.binding.jobId)return null;
   const binding=boundEpisode(raw).binding;
   if(JSON.stringify(binding.subject)!==JSON.stringify(detail.subject))return null;
   const source=binding.context.sources.find(row=>row.id===binding.lease.source_id);
   if(!source?.text?.trim()||source.fence.source.origin!=='whatsapp'||source.fence.source.conversationId!==detail.subject.chatId)return null;
   const current=await new SourceAccess(this.env.DB!,this.scope).read({kind:'owner'},source.id,source.fence.source.revision,this.clock());
   if(!current||current.text!==source.text||Object.keys(source.fence.source).some(key=>source.fence.source[key as keyof typeof source.fence.source]!==current.fence.source[key as keyof typeof current.fence.source]))return null;
   return receivedContext.parse({sourceId:source.id,revision:source.fence.source.revision,version:source.fence.source.version,hash:source.fence.source.hash,text:source.text});
  }catch{return null;}
 }
 private preview(target:ApprovedSendPrepared['target'],text:string,context:ReceivedContext,summary:string|null):string|null{
  const prefix=`💬 <b>SUGESTÃO DE RESPOSTA</b>\n\n<b>Conversa:</b> ${escape(target.name)}\n${escape(target.address)}${target.kind==='group'?' · Grupo':''}\n\n`;
  const suffix=`${summary?`\n\n🧭 <b>Resumo da IA</b>\n${escape(summary)}`:''}\n\n✍️ <b>Resposta sugerida</b>\n${escape(text)}\n\n<i>Aprovar envia apenas a resposta sugerida ao WhatsApp.</i>`;
  const label='📩 <b>Mensagem recebida';
  const limit=Math.min(1000,4096-prefix.length-suffix.length-label.length-' (trecho)</b>\n…'.length);
  if(limit<Math.min(80,escape(context.text).length))return null;
  let excerpt='',length=0;
  for(const point of context.text){const size=escape(point).length;if(length+size>limit)break;excerpt+=point;length+=size;}
  const clipped=excerpt.length<context.text.length;
  const body=prefix+label+(clipped?' (trecho)':'')+'</b>\n'+escape(excerpt)+(clipped?'…':'')+suffix;
  return body.length<=4096?body:null;
 }
 private async current(row:Row){
  if(!this.configured()||row.pilot_json!==this.env.PROACTIVE_PILOT_JSON||row.credential_hash!==await bridgeHash(this.key)||row.expires_at<=this.clock())return false;
  const detail=await this.journal.get(row.decision_id);if(!('proposal' in detail)||!detail.proposal||detail.freshness!=='current'||await bridgeHash(detail.proposal)!==row.proposal_hash||detail.proposal.decision!=='proposed')return false;
  const subject=detail.subject;if(subject?.kind!=='capture_event'||!await pilotAllowsConversation(this.env,subject)||subject.sourceEpoch!==this.scope.sourceEpoch||subject.sourceGeneration!==this.scope.sourceGeneration)return false;
  const activity=await readPilotConversationActivity(this.env,subject),frozen=approvedSendActivityFence.safeParse(JSON.parse(row.target_json).activity);if(activity.state!=='current'||!frozen.success||JSON.stringify(activity.activity)!==JSON.stringify(frozen.data))return false;
  const context=await this.received(detail),review=JSON.parse(row.target_json).review;
  if(!context||JSON.stringify(review)!==JSON.stringify({received:context,summary:detail.proposal.contextSummary?.trim()||null}))return false;
  const envelope=JSON.parse(row.envelope_json);return envelope.chatId===subject.chatId&&envelope.text===detail.proposal.text&&await actionDigest(envelope)===row.action_hash;
 }
 async dispatchDecision(decisionId:string,operationId:string):Promise<{id:string;state:string}>{
  await this.active();const id=await bridgeHash(['telegram-approved-send-v1',this.scope,this.bot,operationId]);let row=await this.row(id);
  if(!row){
   const detail=await this.journal.get(decisionId);if(!('proposal' in detail)||!detail.proposal||detail.freshness!=='current'||detail.subject?.kind!=='capture_event')return {id,state:'blocked'};
   if(!await pilotAllowsConversation(this.env,detail.subject))return {id,state:'blocked'};
   const activity=await readPilotConversationActivity(this.env,detail.subject);if(activity.state!=='current')return {id,state:'blocked'};
   if(detail.proposal.decision==='waiting_context')return {id,state:detail.proposal.text.trim()?'needs_clarification':'clarification_unavailable'};
   if(detail.proposal.decision!=='proposed')return {id,state:'not_applicable'};
   const context=await this.received(detail);if(!context)return {id,state:'context_unavailable'};
   const summary=detail.proposal.contextSummary?.trim()||null;
   const fence=await this.fence(),topic=await this.sql(`SELECT thread_id,fence_json FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot='pending' AND state='ready'`,...this.keys(),fence.linkRevision).first<{thread_id:number;fence_json:string}>();if(!topic||topic.fence_json!==JSON.stringify(fence))return {id,state:'blocked'};
   const envelope={kind:'text' as const,chatId:detail.subject.chatId,text:detail.proposal.text};
   // No truncation: the human must see the exact entire approved body.
   if(escape(envelope.text).length>3000)return {id,state:'preview_too_large'};
   const prepared=await this.env.WHATSAPP_APPROVED_SEND!.prepare({secret:this.env.WHATSAPP_APPROVED_SEND_SECRET!,scope:this.scope,operationId:id,envelope,activity:activity.activity});
   const preparedActivity=approvedSendActivityFence.safeParse(prepared.activity);
   if(!preparedActivity.success||JSON.stringify(preparedActivity.data)!==JSON.stringify(activity.activity)||canonicalEnvelope(prepared.envelope)!==canonicalEnvelope(envelope)||prepared.hash!==await actionDigest(envelope)||prepared.target.chatId!==envelope.chatId||!prepared.target.address||prepared.expiresAt<=this.clock()||prepared.expiresAt>this.clock()+600000)throw Error('approved_send_prepare_mismatch');
   if(!this.preview(prepared.target,envelope.text,context,summary))return {id,state:'preview_too_large'};
   row={id,operation_id:operationId,decision_id:decisionId,proposal_hash:await bridgeHash(detail.proposal),fence_json:JSON.stringify(fence),pilot_json:this.env.PROACTIVE_PILOT_JSON??'',credential_hash:await bridgeHash(this.key),thread_id:topic.thread_id,action_id:prepared.actionId,action_hash:prepared.hash,envelope_json:canonicalEnvelope(envelope),target_json:JSON.stringify({...prepared.target,activity:preparedActivity.data,review:{received:context,summary}}),expires_at:prepared.expiresAt,state:'prepared',message_id:null,approval_state:'pending',receipt_json:null,result_notice:'pending'};
   if(!await this.current(row))return {id,state:'blocked'};const gate=this.gates(row),value=row;
   const admission=await this.journal.admitReview(decisionId,row.proposal_hash,guard=>[this.sql(`INSERT INTO assistant_telegram_send_reviews(installation_id,generation,bot_instance,id,operation_id,decision_id,proposal_hash,fence_json,pilot_json,credential_hash,thread_id,action_id,action_hash,envelope_json,target_json,expires_at,state) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared' WHERE ${guard.sql} AND ${gate.sql} ON CONFLICT DO NOTHING RETURNING id`,...this.keys(),value.id,value.operation_id,value.decision_id,value.proposal_hash,value.fence_json,value.pilot_json,value.credential_hash,value.thread_id,value.action_id,value.action_hash,value.envelope_json,value.target_json,value.expires_at,...guard.values,...gate.values)]);
   row=await this.row(id);if(!row||!admission)return {id,state:'blocked'};
  }
  if(row.operation_id!==operationId||row.decision_id!==decisionId)throw Error('approved_send_conflict');
  if(row.state!=='prepared')return {id,state:row.state};
  if(!await this.api.inspect()||!await this.current(row))return {id,state:'blocked'};
  const target=JSON.parse(row.target_json) as ApprovedSendPrepared['target']&{review:{received:ReceivedContext;summary:string|null}},envelope=JSON.parse(row.envelope_json) as ApprovedSendPrepared['envelope'];
  const body=this.preview(target,envelope.text,target.review.received,target.review.summary);
  if(!body)return {id,state:'preview_too_large'};
  const gate=this.gates(row),value=row;
  const admitted=await this.journal.admitReview(row.decision_id,row.proposal_hash,guard=>[this.sql(`UPDATE assistant_telegram_send_reviews SET state='attempting' WHERE ${ns} AND id=? AND state='prepared' AND expires_at>? AND ${guard.sql} AND ${gate.sql} RETURNING id`,...this.keys(),value.id,this.clock(),...guard.values,...gate.values)]);
  if(!admitted?.[0].results.length)return {id,state:'blocked'};
  try{await this.active();const message=await this.api.send((JSON.parse(row.fence_json) as TelegramLinkFence).chatId,row.thread_id,body,[[{text:'✅ Aprovar e enviar',callback_data:await this.capability(row,'approved')},{text:'❌ Descartar',callback_data:await this.capability(row,'discarded')}]]);await this.sql(`UPDATE assistant_telegram_send_reviews SET state='sent',message_id=? WHERE ${ns} AND id=? AND state='attempting'`,message,...this.keys(),id).run();}
  catch{await this.sql(`UPDATE assistant_telegram_send_reviews SET state='uncertain' WHERE ${ns} AND id=? AND state='attempting'`,...this.keys(),id).run();}
  return {id,state:(await this.row(id))!.state};
 }
 async authorize(raw:unknown):Promise<ApprovedSendAuthorization>{
  try{
   const q=authorizationInput.parse(raw);if(!this.configured()||await bridgeHash(q.secret)!==await bridgeHash(this.env.WHATSAPP_APPROVED_SEND_SECRET!))return {authorized:false};
   const row=await this.row(q.approvalId);if(!row||row.approval_state!=='approved'||row.action_id!==q.actionId||row.action_hash!==q.hash||!await this.current(row))return {authorized:false};
   const gate=this.gates(row),saved=await this.journal.admitReview(row.decision_id,row.proposal_hash,guard=>[this.sql(`SELECT id FROM assistant_telegram_send_reviews WHERE ${ns} AND id=? AND approval_state='approved' AND expires_at>? AND EXISTS(SELECT 1 FROM assistant_telegram_send_callbacks c WHERE c.installation_id=assistant_telegram_send_reviews.installation_id AND c.generation=assistant_telegram_send_reviews.generation AND c.bot_instance=assistant_telegram_send_reviews.bot_instance AND c.review_id=assistant_telegram_send_reviews.id AND c.action='approved') AND ${guard.sql} AND ${gate.sql}`,...this.keys(),row.id,this.clock(),...guard.values,...gate.values)]);
   return saved?.[0].results.length?{authorized:true,actionId:q.actionId,hash:q.hash,approvalId:row.id,expiresAt:Math.min(row.expires_at,this.clock()+10000)}:{authorized:false};
  }catch{return {authorized:false};}
 }
 async receiveCallback(raw:unknown):Promise<string>{
  let input:unknown;try{if(new TextEncoder().encode(JSON.stringify(raw)).length>65536)return 'denied';input=JSON.parse(JSON.stringify(raw));}catch{return 'denied';}
  const data=(input as {callback_query?:{data?:unknown}})?.callback_query?.data;if(typeof data!=='string'||!data.startsWith('w_'))return 'unsupported';
  const parsed=callbackSchema.safeParse(input);if(!parsed.success)return 'denied';const update=parsed.data,c=update.callback_query;
  if(['sender_chat','via_bot','forward_origin','forward_from','forward_from_chat','business_connection_id'].some(key=>key in c.message))return 'denied';
  const hash=await bridgeHash({update_id:update.update_id,callback_query:{id:c.id,from:{id:c.from.id,is_bot:false},chat_instance:c.chat_instance,data:c.data,message:{message_id:c.message.message_id,date:c.message.date,message_thread_id:c.message.message_thread_id,chat:{id:c.message.chat.id,type:'private'}}}}),prior=await this.sql(`SELECT payload_hash,review_id FROM assistant_telegram_send_callbacks WHERE ${ns} AND (update_id=? OR query_id=?)`,...this.keys(),update.update_id,c.id).first<{payload_hash:string;review_id:string}>();if(prior){if(prior.payload_hash!==hash)return 'conflict';const row=await this.row(prior.review_id);if(row?.approval_state==='approved')try{await this.reconcileOne(row);}catch{/* Unknown results are retained; no repeat send. */}return 'duplicate';}
  // At most one pending preview per logical action; lookup never trusts a model ID.
  const rows=await this.sql(`SELECT * FROM assistant_telegram_send_reviews WHERE ${ns} AND message_id=? AND thread_id=? AND state='sent' AND expires_at>? LIMIT 2`,...this.keys(),c.message.message_id,c.message.message_thread_id,this.clock()).all<Row>();
  if(rows.results.length!==1)return 'denied';const row=rows.results[0],fence=JSON.parse(row.fence_json) as TelegramLinkFence;
  if(String(c.from.id)!==fence.userId||String(c.message.chat.id)!==fence.chatId)return 'denied';
  const action=c.data===await this.capability(row,'approved')?'approved':c.data===await this.capability(row,'discarded')?'discarded':null;if(!action)return 'denied';
  if(row.approval_state!=='pending'){
   if(row.approval_state!==action)return 'denied';const gate=this.gates(row);if(!this.configured()||!await this.sql(`SELECT 1 WHERE ${gate.sql}`,...gate.values).first())return 'denied';
   if(action==='approved')try{await this.reconcileOne(row);}catch{/* Read-only reconciliation never repeats an execution. */}
   try{await this.api.answer(c.id,'Esta decisão já foi registrada. Nenhum novo envio foi feito.');}catch{}
   return 'duplicate';
  }
  if(!await this.current(row))return 'denied';
  const gate=this.gates(row),receipt=`EXISTS(SELECT 1 FROM assistant_telegram_send_callbacks WHERE ${ns} AND update_id=? AND payload_hash=?)`;
  const saved=await this.journal.admitReview(row.decision_id,row.proposal_hash,guard=>[
   this.sql(`INSERT INTO assistant_telegram_send_callbacks SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND ${gate.sql} AND EXISTS(SELECT 1 FROM assistant_telegram_send_reviews WHERE ${ns} AND id=? AND approval_state='pending' AND state='sent' AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM assistant_telegram_updates WHERE ${ns} AND update_id=?) ON CONFLICT DO NOTHING RETURNING review_id`,...this.keys(),update.update_id,c.id,hash,row.id,action,this.clock(),...guard.values,...gate.values,...this.keys(),row.id,this.clock(),...this.keys(),update.update_id),
   this.sql(`UPDATE assistant_telegram_send_reviews SET approval_state=? WHERE ${ns} AND id=? AND approval_state='pending' AND ${receipt}`,action,...this.keys(),row.id,...this.keys(),update.update_id,hash),
  ]);
  if(!saved?.[0].results.length)return 'denied';
  try{await this.api.answer(c.id,action==='approved'?'Aprovação registrada. Consultando envio.':'Sugestão descartada.');}catch{/* The durable human receipt remains authoritative. */}
  if(action==='approved'){
   try{const receipt=await this.env.WHATSAPP_APPROVED_SEND!.execute({secret:this.env.WHATSAPP_APPROVED_SEND_SECRET!,scope:this.scope,actionId:row.action_id,approvalId:row.id});await this.sql(`UPDATE assistant_telegram_send_reviews SET receipt_json=? WHERE ${ns} AND id=?`,JSON.stringify(receipt),...this.keys(),row.id).run();await this.result(row,receipt);}
   catch{await this.sql(`UPDATE assistant_telegram_send_reviews SET receipt_json=? WHERE ${ns} AND id=?`,JSON.stringify({status:'uncertain'}),...this.keys(),row.id).run();await this.result(row,{status:'uncertain'});}
  }else await this.result(row,{status:'discarded'});
  return action;
 }
 private async reconcileOne(row:Row){
  await this.active();const gate=this.gates(row);if(!await this.sql(`SELECT 1 WHERE ${gate.sql}`,...gate.values).first())return;
  const status=await this.env.WHATSAPP_APPROVED_SEND!.status({secret:this.env.WHATSAPP_APPROVED_SEND_SECRET!,scope:this.scope,actionId:row.action_id});
  if(status.actionId!==row.action_id||status.hash!==row.action_hash||!['proposed','approved','accepted','sent','delivered','read','uncertain','rejected','cancelled','expired'].includes(status.status))throw Error('approved_send_status_mismatch');
  const previous=row.receipt_json?JSON.parse(row.receipt_json).status:null,changed=previous!==status.status;
  const updated=await this.sql(`UPDATE assistant_telegram_send_reviews SET receipt_json=?,last_checked_at=?,result_notice=CASE WHEN ?=1 AND result_notice IN ('sent','uncertain') THEN 'pending' ELSE result_notice END WHERE ${ns} AND id=? AND receipt_json IS ? RETURNING id`,JSON.stringify(status),this.clock(),changed?1:0,...this.keys(),row.id,row.receipt_json).all();
  if(updated.results.length&&changed)await this.result(row,status);
 }
 /** Metadata reconciliation only. Never invokes execute or creates a replacement action. */
 async reconcile(){
  if(!this.configured())return;
  const rows=await this.sql(`SELECT * FROM assistant_telegram_send_reviews WHERE ${ns} AND approval_state='approved' AND state='sent' AND (receipt_json IS NULL OR json_extract(receipt_json,'$.status') NOT IN ('delivered','read','rejected','cancelled','expired')) ORDER BY last_checked_at,id LIMIT 3`,...this.keys()).all<Row>();
  for(const row of rows.results)try{await this.reconcileOne(row);}catch{/* Preserve the action and its uncertainty. */}
 }
 private async result(row:Row,receipt:Pick<ApprovedSendReceipt,'status'>){
  const labels:Record<string,string>={accepted:'⏳ <b>Aceito pelo WhatsApp</b>\n\nO provedor aceitou a mensagem; a entrega ainda não foi confirmada.',sent:'✅ <b>Mensagem enviada</b>',delivered:'✅ <b>Mensagem entregue</b>',read:'✅ <b>Mensagem lida</b>',rejected:'❌ <b>Envio recusado</b>',cancelled:'❌ <b>Envio cancelado</b>',expired:'⌛ <b>Aprovação expirada</b>',discarded:'❌ <b>Sugestão descartada</b>\n\nNenhuma mensagem foi enviada.',uncertain:'⏳ <b>Resultado do envio em conferência</b>\n\nNão vou repetir a tentativa enquanto confiro o resultado.'};
  const gate=this.gates(row),claim=await this.sql(`UPDATE assistant_telegram_send_reviews SET result_notice='attempting' WHERE ${ns} AND id=? AND result_notice='pending' AND ${gate.sql} RETURNING id`,...this.keys(),row.id,...gate.values).all();if(!claim.results.length)return;
  try{await this.active();await this.api.send((JSON.parse(row.fence_json) as TelegramLinkFence).chatId,row.thread_id,labels[receipt.status]??'⏳ <b>Envio ainda não confirmado</b>',[]);await this.sql(`UPDATE assistant_telegram_send_reviews SET result_notice='sent' WHERE ${ns} AND id=? AND result_notice='attempting'`,...this.keys(),row.id).run();}catch{await this.sql(`UPDATE assistant_telegram_send_reviews SET result_notice='uncertain' WHERE ${ns} AND id=? AND result_notice='attempting'`,...this.keys(),row.id).run();}
 }
}

export async function createTelegramApprovedSendReview(env:AssistantEnv,scope:OwnerAffinity,hostGuard?:()=>AccessGuard){
 if(!env.DB||!env.TELEGRAM_BOT_INSTANCE||!env.TELEGRAM_WEBHOOK_SECRET)throw Error('telegram_unconfigured');
 const {origin,semantic,ownerOncePlan}=hostConfiguredSearch(env,'owner_read');
 const key=await bridgeHash(['telegram-approved-send-credentials-v1',env.TELEGRAM_WEBHOOK_SECRET,env.TELEGRAM_BOT_TOKEN??'',env.WHATSAPP_APPROVED_SEND_SECRET??'']);
 const effect=async()=>{await assertRestoredGeneration(env);if(env.WHATSAPP_APPROVED_SEND_ENABLED!=='true'||env.ROUTINES_PAUSED==='true')throw Error('approved_send_disabled');const local=retentionExecutionGuard(scope),host=hostGuard?.(),guard=host?{sql:`(${local.sql}) AND (${host.sql})`,values:[...local.values,...host.values]}:local;if(!await env.DB!.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first())throw Error('approved_send_paused');};
 return new TelegramApprovedSendReview(env,scope,env.TELEGRAM_BOT_INSTANCE,key,new TelegramBotApi(env.TELEGRAM_BOT_TOKEN,env.TELEGRAM_BOT_INSTANCE,fetch,effect,'HTML'),new Journal(env.DB,scope,{kind:'owner'},{origin,semantic,ownerOncePlan,outgoing:outgoingPort(env)}),Date.now,hostGuard);
}
