import { z } from "zod";
import { dailySummarySchema } from "./routines";
import type { AccessGuard } from "./access";
import { DecisionJournal } from "./decisions";
import type { AssistantEnv } from "./env";
import { hostConfiguredSearch } from "./configured-search";
import type { OwnerAffinity } from "./mcp";
import { telegramLinkGuard, type TelegramLinkFence } from "./telegram-auth";
import { bridgeHash } from "./ingress";
const positive=z.number().int().positive().safe(),textId=z.string().min(1).max(256);
export const telegramSlot=z.enum(["general","summaries","pending","missions"]);
export const telegramReviewCommand=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("status")}).strict(),z.object({kind:z.literal("topics.ensure")}).strict(),
 z.object({kind:z.literal("notification.prepare"),operationId:textId,topic:telegramSlot,decisionId:textId,expiresAt:positive}).strict(),
 z.object({kind:z.literal("notification.dispatch"),id:z.string().uuid()}).strict(),
]);
const titles={general:"Geral",summaries:"Resumos",pending:"Pendências",missions:"Missões e retornos"};
type Slot=z.infer<typeof telegramSlot>;
type Buttons={text:string;callback_data:string}[][];
export interface TelegramApi { inspect():Promise<boolean>;createTopic(chat:string,name:string):Promise<number>;send(chat:string,thread:number,text:string,buttons:Buttons):Promise<number>;answer(id:string):Promise<void> }
/** Fixed provider surface. No arbitrary URLs, methods or model-visible token. */
export class TelegramBotApi implements TelegramApi {
 constructor(private token:string|undefined,private bot:string,private fetcher:typeof fetch=fetch){}
 private async call(method:"getMe"|"createForumTopic"|"sendMessage"|"answerCallbackQuery",body:unknown):Promise<unknown>{
  if(!this.token||!/^\d{6,20}:[A-Za-z0-9_-]{20,128}$/.test(this.token))throw new Error("telegram_api_unconfigured");
  const controller=new AbortController();let expired=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const operation=async()=>{
   const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),redirect:"manual",signal:controller.signal});
   if(expired||!response.ok)throw 0;reader=response.body?.getReader();if(!reader)throw 0;
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(expired)throw 0;if(done)break;size+=value.byteLength;if(size>65536){void reader.cancel().catch(()=>{});throw 0;}chunks.push(value);}}finally{reader.releaseLock();}
   if(expired)throw 0;const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
   const json=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));if(json.ok!==true)throw 0;return json.result;
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();void reader?.cancel().catch(()=>{});reject(new Error("telegram_api_deadline"));},10000);});
  try{return await Promise.race([operation(),deadline]);}
  catch{throw new Error("telegram_api_unavailable");}finally{clearTimeout(timer);}
 }
 async inspect(){const me=await this.call("getMe",{}) as {is_bot?:boolean;username?:string;has_topics_enabled?:boolean};return me.is_bot===true&&me.username?.toLowerCase()===this.bot.toLowerCase()&&me.has_topics_enabled===true;}
 async createTopic(chat:string,name:string){const result=await this.call("createForumTopic",{chat_id:chat,name}) as {message_thread_id?:number;name?:string};if(result.name!==name)throw new Error("telegram_topic_mismatch");return positive.parse(result.message_thread_id);}
 async send(chat:string,thread:number,text:string,buttons:Buttons){const result=await this.call("sendMessage",{chat_id:chat,message_thread_id:thread,text,protect_content:true,...(buttons.length?{reply_markup:{inline_keyboard:buttons}}:{})}) as {message_id?:number;message_thread_id?:number;chat?:{id?:number;type?:string}};
  if(String(result.chat?.id)!==chat||result.chat?.type!=="private"||result.message_thread_id!==thread)throw new Error("telegram_message_mismatch");return positive.parse(result.message_id);}
 async answer(id:string){if(await this.call("answerCallbackQuery",{callback_query_id:id,text:"Revisão registrada em modo sombra."})!==true)throw new Error("telegram_answer_unavailable");}
}
type Notice={id:string;operation_key:string;request_hash:string;fence_json:string;slot:Slot;thread_id:number;decision_id:string;proposal_hash:string;expires_at:number;review_hash:string;simulate_hash:string;state:string;preflights:number;attempt_token:string|null;message_id:number|null;review_state:string};
type Topic={slot:Slot;fence_json:string;state:string;thread_id:number|null;preflights:number};
type ReviewJournal=Pick<DecisionJournal,"get"|"admitReview">;
const ns="installation_id=? AND generation=? AND bot_instance=?";
/** Host capability only: authenticated named binding, scheduler, secret webhook.
 * No text is interpreted as control, and no callback authorizes an external act. */
export class TelegramReview {
 constructor(private db:D1Database,private scope:OwnerAffinity,private bot:string,private secret:string,private api:TelegramApi,private journal:ReviewJournal,private clock=Date.now,private hostEffectGuard?:()=>AccessGuard){
  this.scope=Object.freeze({...scope});if(!/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(bot)||!/^[A-Za-z0-9_-]{32,256}$/.test(secret))throw new Error("telegram_unconfigured");
 }
 private keys(){return [this.scope.installationId,this.scope.generation,this.bot];}
 private sql(sql:string,...values:(string|number|null)[]){return this.db.prepare(sql).bind(...values);}
 private async fence():Promise<TelegramLinkFence>{
  const row=await this.sql(`SELECT revision,user_id,chat_id FROM assistant_telegram_links WHERE ${ns} AND source_epoch=? AND source_generation=? AND state='active'`,...this.keys(),this.scope.sourceEpoch,this.scope.sourceGeneration).first<{revision:number;user_id:string;chat_id:string}>();
  if(!row)throw new Error("telegram_unlinked");return {...this.scope,botInstance:this.bot,linkRevision:row.revision,userId:row.user_id,chatId:row.chat_id};
 }
 private gate(fence:TelegramLinkFence){return telegramLinkGuard(fence);}
 private async notice(id:string){return this.sql(`SELECT * FROM assistant_telegram_notifications WHERE ${ns} AND id=?`,...this.keys(),id).first<Notice>();}
 private topicGuard(notice:Notice){const fence=JSON.parse(notice.fence_json) as TelegramLinkFence;return {sql:`EXISTS(SELECT 1 FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot=? AND state='ready' AND thread_id=? AND fence_json=?)`,values:[...this.keys(),fence.linkRevision,notice.slot,notice.thread_id,notice.fence_json]};}
 private async capability(notice:Pick<Notice,"id"|"fence_json"|"slot"|"thread_id"|"decision_id"|"proposal_hash"|"expires_at">,action:"reviewed"|"simulated"){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(this.secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(JSON.stringify(["telegram-review-v1",notice.id,notice.fence_json,notice.slot,notice.thread_id,notice.decision_id,notice.proposal_hash,notice.expires_at,action]))));
  return "r_"+btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
 }
 async execute(raw:unknown):Promise<unknown>{
  const command=telegramReviewCommand.parse(raw);
  if(command.kind==="status"){
   const fence=await this.fence(),notifications=(await this.sql(`SELECT id,state,review_state,preflights FROM assistant_telegram_notifications WHERE ${ns} AND fence_json=? ORDER BY id LIMIT 21`,...this.keys(),JSON.stringify(fence)).all()).results;
   return {mode:"shadow",topics:(await this.sql(`SELECT slot,state,thread_id,preflights FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? ORDER BY slot`,...this.keys(),fence.linkRevision).all()).results,notifications:notifications.slice(0,20),notificationCoverage:{limit:20,truncated:notifications.length>20}};
  }
  if(command.kind==="topics.ensure")return this.ensureTopics();
  if(command.kind==="notification.dispatch")return this.dispatch(command.id);
  const fence=await this.fence(),now=this.clock();if(command.expiresAt<=now||command.expiresAt>now+86400000)throw new Error("telegram_expiry");
  const hash=await bridgeHash(command),prior=await this.sql(`SELECT id,request_hash FROM assistant_telegram_notifications WHERE ${ns} AND operation_key=?`,...this.keys(),command.operationId).first<{id:string;request_hash:string}>();
  if(prior){if(prior.request_hash!==hash)throw new Error("telegram_conflict");return {id:prior.id,state:(await this.notice(prior.id))!.state};}
  const topic=await this.sql(`SELECT * FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot=? AND state='ready'`,...this.keys(),fence.linkRevision,command.topic).first<Topic>();
  if(!topic?.thread_id||topic.fence_json!==JSON.stringify(fence))throw new Error("telegram_topic_unavailable");
  const detail=await this.journal.get(command.decisionId);if(!("proposal"in detail)||detail.freshness!=="current")throw new Error("telegram_proposal_unavailable");
  const notice={id:crypto.randomUUID(),fence_json:JSON.stringify(fence),slot:command.topic,thread_id:topic.thread_id,decision_id:command.decisionId,proposal_hash:await bridgeHash(detail.proposal),expires_at:command.expiresAt};
  const review=await bridgeHash(await this.capability(notice,"reviewed")),simulate=await bridgeHash(await this.capability(notice,"simulated")),link=this.gate(fence);
  const saved=await this.journal.admitReview(notice.decision_id,notice.proposal_hash,guard=>[this.sql(`INSERT INTO assistant_telegram_notifications(installation_id,generation,bot_instance,id,operation_key,request_hash,fence_json,slot,thread_id,decision_id,proposal_hash,expires_at,review_hash,simulate_hash,state) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared' WHERE ${guard.sql} AND ${link.sql} AND ? > ? ON CONFLICT DO NOTHING RETURNING id`,...this.keys(),notice.id,command.operationId,hash,notice.fence_json,notice.slot,notice.thread_id,notice.decision_id,notice.proposal_hash,notice.expires_at,review,simulate,...guard.values,...link.values,notice.expires_at,this.clock())]);
  if(!saved?.[0].results.length)throw new Error("telegram_precondition");return {id:notice.id,state:"prepared"};
 }
 private async ensureTopics(){
  const fence=await this.fence(),link=this.gate(fence);
  for(const slot of telegramSlot.options){
   await this.sql(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state) SELECT ?,?,?,?,?,?,'prepared' WHERE ${link.sql} ON CONFLICT DO NOTHING`,...this.keys(),fence.linkRevision,slot,JSON.stringify(fence),...link.values).run();
   const admitted=await this.sql(`UPDATE assistant_telegram_topics SET preflights=preflights+1 WHERE ${ns} AND link_revision=? AND slot=? AND state='prepared' AND preflights<3 AND ${link.sql} RETURNING slot`,...this.keys(),fence.linkRevision,slot,...link.values).all();if(!admitted.results.length)continue;
   try{if(!await this.api.inspect())throw 0;}catch{await this.sql(`UPDATE assistant_telegram_topics SET state=CASE WHEN preflights=3 THEN 'failed' ELSE state END WHERE ${ns} AND link_revision=? AND slot=? AND state='prepared'`,...this.keys(),fence.linkRevision,slot).run();continue;}
   const claim=await this.sql(`UPDATE assistant_telegram_topics SET state='attempting' WHERE ${ns} AND link_revision=? AND slot=? AND state='prepared' AND ${link.sql} RETURNING slot`,...this.keys(),fence.linkRevision,slot,...link.values).all();if(!claim.results.length)continue;
   try{const thread=positive.parse(await this.api.createTopic(fence.chatId,titles[slot]));await this.sql(`UPDATE assistant_telegram_topics SET state='ready',thread_id=? WHERE ${ns} AND link_revision=? AND slot=? AND state='attempting'`,thread,...this.keys(),fence.linkRevision,slot).run();}
   catch{await this.sql(`UPDATE assistant_telegram_topics SET state='uncertain' WHERE ${ns} AND link_revision=? AND slot=? AND state='attempting'`,...this.keys(),fence.linkRevision,slot).run();}
  }
  return this.execute({kind:"status"});
 }
 private async failPreflight(id:string){await this.sql(`UPDATE assistant_telegram_notifications SET state=CASE WHEN preflights=3 THEN 'failed' ELSE state END WHERE ${ns} AND id=? AND state='prepared'`,...this.keys(),id).run();}
 private async dispatch(id:string){
  const notice=await this.notice(id);if(!notice)throw new Error("telegram_notification_unavailable");if(notice.state!=="prepared")return {id,state:notice.state};
  const fence=JSON.parse(notice.fence_json) as TelegramLinkFence,link=this.gate(fence),topic=this.topicGuard(notice);
  const preflight=await this.sql(`UPDATE assistant_telegram_notifications SET preflights=preflights+1 WHERE ${ns} AND id=? AND state='prepared' AND preflights<3 AND expires_at>? AND ${link.sql} AND ${topic.sql} RETURNING id`,...this.keys(),id,this.clock(),...link.values,...topic.values).all();
  if(!preflight.results.length)return {id,state:"blocked"};
  let detail:Awaited<ReturnType<ReviewJournal["get"]>>;
  try{if(!await this.api.inspect())throw 0;detail=await this.journal.get(notice.decision_id);if(!("proposal"in detail)||detail.freshness!=="current"||await bridgeHash(detail.proposal)!==notice.proposal_hash)throw 0;}
  catch{await this.sql(`UPDATE assistant_telegram_notifications SET state=CASE WHEN preflights=3 THEN 'failed' ELSE state END WHERE ${ns} AND id=? AND state='prepared'`,...this.keys(),id).run();return {id,state:"blocked"};}
  const body=`[Sombra · ${titles[notice.slot]}]\n${detail.proposal!.decision==="no_reply"?"Silêncio proposto.":detail.proposal!.text}`;
  if(new TextEncoder().encode(body).length>4096){await this.sql(`UPDATE assistant_telegram_notifications SET state='failed' WHERE ${ns} AND id=? AND state='prepared'`,...this.keys(),id).run();return {id,state:"failed"};}
  const buttons:Buttons=[[{text:"Registrar revisão",callback_data:await this.capability(notice,"reviewed")},{text:"Aprovar simulação",callback_data:await this.capability(notice,"simulated")}]];
  if(await bridgeHash(buttons[0][0].callback_data)!==notice.review_hash||await bridgeHash(buttons[0][1].callback_data)!==notice.simulate_hash){await this.sql(`UPDATE assistant_telegram_notifications SET state='cancelled' WHERE ${ns} AND id=? AND state='prepared'`,...this.keys(),id).run();return {id,state:"cancelled"};}
  const token=crypto.randomUUID();
  const admitted=await this.journal.admitReview(notice.decision_id,notice.proposal_hash,guard=>{const effect=this.hostEffectGuard?.()??{sql:"1",values:[]};return [this.sql(`UPDATE assistant_telegram_notifications SET state='attempting',attempt_token=? WHERE ${ns} AND id=? AND state='prepared' AND proposal_hash=? AND expires_at>? AND ${guard.sql} AND ${link.sql} AND ${topic.sql} AND ${effect.sql} RETURNING id`,token,...this.keys(),id,notice.proposal_hash,this.clock(),...guard.values,...link.values,...topic.values,...effect.values)];});
  if(!admitted?.[0].results.length){await this.failPreflight(id);return {id,state:"blocked"};}
  // No asynchronous preparation after the final Journal+Link admission.
  try{const message=positive.parse(await this.api.send(fence.chatId,notice.thread_id,body,buttons));await this.sql(`UPDATE assistant_telegram_notifications SET state='sent',message_id=? WHERE ${ns} AND id=? AND state='attempting' AND attempt_token=?`,message,...this.keys(),id,token).run();}
  catch{await this.sql(`UPDATE assistant_telegram_notifications SET state='uncertain' WHERE ${ns} AND id=? AND state='attempting' AND attempt_token=?`,...this.keys(),id,token).run();}
  return {id,state:(await this.notice(id))!.state};
 }
 /** Typed host summary: no fabricated owner note/proposal or arbitrary text. */
 async publishDailySummary(reviewId:string):Promise<{state:string}>{
  const today=new Date(this.clock()).toISOString().slice(0,10),fence=await this.fence(),link=this.gate(fence),keys=this.keys();
  const row=await this.sql(`SELECT payload_json,payload_hash,period FROM assistant_routine_reviews WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND id=?`,this.scope.installationId,this.scope.generation,this.scope.sourceEpoch,this.scope.sourceGeneration,reviewId).first<{payload_json:string;payload_hash:string;period:string}>();
  if(!row||row.period!==today)return {state:"stale"};const summary=dailySummarySchema.parse(JSON.parse(row.payload_json));if(await bridgeHash(summary)!==row.payload_hash)return {state:"blocked"};
  const topic=await this.sql(`SELECT thread_id FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot='summaries' AND fence_json=? AND state='ready'`,...keys,fence.linkRevision,JSON.stringify(fence)).first<{thread_id:number}>();if(!topic)return {state:"topic_unavailable"};
  await this.sql(`UPDATE assistant_telegram_summaries SET state='cancelled' WHERE ${ns} AND period<>? AND state='prepared'`,...keys,today).run();
  await this.sql(`INSERT INTO assistant_telegram_summaries(installation_id,generation,bot_instance,review_id,period,payload_hash,fence_json,thread_id,state) SELECT ?,?,?,?,?,?,?,?,'prepared' WHERE ${link.sql} ON CONFLICT DO NOTHING`,...keys,reviewId,today,row.payload_hash,JSON.stringify(fence),topic.thread_id,...link.values).run();
  const prior=await this.sql(`SELECT state,fence_json FROM assistant_telegram_summaries WHERE ${ns} AND review_id=?`,...keys,reviewId).first<{state:string;fence_json:string}>();if(!prior)return {state:"blocked"};if(prior.state!=="prepared")return {state:prior.state};if(prior.fence_json!==JSON.stringify(fence))return {state:"link_changed"};
  const prepared=await this.sql(`UPDATE assistant_telegram_summaries SET preflights=preflights+1 WHERE ${ns} AND review_id=? AND state='prepared' AND preflights<3 AND ${link.sql} RETURNING review_id`,...keys,reviewId,...link.values).all();if(!prepared.results.length)return {state:"blocked"};
  try{if(!await this.api.inspect())throw 0;}catch{await this.sql(`UPDATE assistant_telegram_summaries SET state=CASE WHEN preflights=3 THEN 'failed' ELSE state END WHERE ${ns} AND review_id=? AND state='prepared'`,...keys,reviewId).run();return {state:"blocked"};}
  const body=`[Sombra · Relatório acumulado]\nSnapshot: ${new Date(summary.snapshotAt).toISOString()}; contagens cumulativas desta geração, não apenas do dia.\nPausa no snapshot: ${summary.paused?"ativa":"inativa"}; conversas pausadas: ${summary.pausedConversations}.\nSilêncios registrados: ${summary.journal.silence??0}; não avaliados: ${summary.journal.not_evaluated??0}; pendentes: ${summary.journal.pending??0}; incertos: ${summary.journal.uncertain??0}.\nLacunas: ${summary.gaps}; retornos bloqueados/pausados: ${summary.blockedFollowUps}.\nOrçamento: ${{available:"disponível",blocked:"bloqueado",exhausted:"esgotado",unconfigured:"não configurado"}[summary.budget.state]}; comprometido nesta geração US$${(summary.budget.committedMicroUsd/1e6).toFixed(6)}, incluindo US$${(summary.budget.uncertainMicroUsd/1e6).toFixed(6)} incertos.\nContagens do diário até o snapshot; vigência do conteúdo não revalidada. Relações canônicas ainda incompletas.`;
  const effect=this.hostEffectGuard?.()??{sql:"1",values:[]},token=crypto.randomUUID(),admitted=await this.sql(`UPDATE assistant_telegram_summaries SET state='attempting',attempt_token=? WHERE ${ns} AND review_id=? AND state='prepared' AND fence_json=? AND payload_hash=? AND period=? AND ${link.sql}
   AND EXISTS(SELECT 1 FROM assistant_routine_reviews WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND id=? AND payload_hash=? AND period=?)
   AND EXISTS(SELECT 1 FROM assistant_telegram_topics WHERE ${ns} AND link_revision=? AND slot='summaries' AND thread_id=? AND state='ready' AND fence_json=?) AND ${effect.sql} RETURNING review_id`,token,...keys,reviewId,JSON.stringify(fence),row.payload_hash,today,...link.values,this.scope.installationId,this.scope.generation,this.scope.sourceEpoch,this.scope.sourceGeneration,reviewId,row.payload_hash,today,...keys,fence.linkRevision,topic.thread_id,JSON.stringify(fence),...effect.values).all();
  if(!admitted.results.length)return {state:"blocked"};
  try{const message=positive.parse(await this.api.send(fence.chatId,topic.thread_id,body,[]));await this.sql(`UPDATE assistant_telegram_summaries SET state='sent',message_id=? WHERE ${ns} AND review_id=? AND state='attempting' AND attempt_token=?`,message,...keys,reviewId,token).run();}
  catch{await this.sql(`UPDATE assistant_telegram_summaries SET state='uncertain' WHERE ${ns} AND review_id=? AND state='attempting' AND attempt_token=?`,...keys,reviewId,token).run();}
  return {state:(await this.sql(`SELECT state FROM assistant_telegram_summaries WHERE ${ns} AND review_id=?`,...keys,reviewId).first<string>("state"))!};
 }
 async receiveCallback(input:unknown):Promise<string>{
  const update=parseCallback(input);if(!update)return "unsupported";
  const callback=update.callback_query,msg=callback.message,hash=await bridgeHash(update),prior=await this.sql(`SELECT payload_hash FROM assistant_telegram_reviews WHERE ${ns} AND update_id=?`,...this.keys(),update.update_id).first<{payload_hash:string}>();
  if(prior)return prior.payload_hash===hash?"duplicate":"conflict";
  const notice=await this.sql(`SELECT * FROM assistant_telegram_notifications WHERE ${ns} AND (review_hash=? OR simulate_hash=?)`,...this.keys(),await bridgeHash(callback.data),await bridgeHash(callback.data)).first<Notice>();
  if(!notice)return "denied";const action=await this.capability(notice,"reviewed")===callback.data?"reviewed":await this.capability(notice,"simulated")===callback.data?"simulated":null;
  const fence=JSON.parse(notice.fence_json) as TelegramLinkFence;
  if(!action||String(callback.from.id)!==fence.userId||String(msg.chat.id)!==fence.chatId||msg.message_thread_id!==notice.thread_id||msg.message_id!==notice.message_id||notice.state!=="sent"||notice.expires_at<=this.clock()||notice.review_state!=="pending")return "denied";
  const link=this.gate(fence),topic=this.topicGuard(notice),receipt=`EXISTS(SELECT 1 FROM assistant_telegram_reviews WHERE ${ns} AND update_id=? AND query_id=? AND payload_hash=?)`,receiptValues=[...this.keys(),update.update_id,callback.id,hash];
  const saved=await this.journal.admitReview(notice.decision_id,notice.proposal_hash,guard=>[
   this.sql(`INSERT INTO assistant_telegram_reviews SELECT ?,?,?,?,?,?,?,?,'attempting',? WHERE ${guard.sql} AND ${link.sql} AND ${topic.sql} AND EXISTS(SELECT 1 FROM assistant_telegram_notifications WHERE ${ns} AND id=? AND state='sent' AND review_state='pending' AND expires_at>? AND proposal_hash=? AND message_id=?) AND NOT EXISTS(SELECT 1 FROM assistant_telegram_updates WHERE ${ns} AND update_id=?) ON CONFLICT DO NOTHING RETURNING notification_id`,...this.keys(),update.update_id,callback.id,hash,notice.id,action,this.clock(),...guard.values,...link.values,...topic.values,...this.keys(),notice.id,this.clock(),notice.proposal_hash,msg.message_id,...this.keys(),update.update_id),
   this.sql(`UPDATE assistant_telegram_notifications SET review_state=? WHERE ${ns} AND id=? AND review_state='pending' AND ${receipt} AND ${guard.sql} AND ${link.sql}`,action,...this.keys(),notice.id,...receiptValues,...guard.values,...link.values),
  ]);
  if(!saved?.[0].results.length)return "denied";
  try{await this.api.answer(callback.id);await this.sql(`UPDATE assistant_telegram_reviews SET answer_state='answered' WHERE ${ns} AND update_id=? AND payload_hash=?`,...this.keys(),update.update_id,hash).run();}
  catch{await this.sql(`UPDATE assistant_telegram_reviews SET answer_state='uncertain' WHERE ${ns} AND update_id=? AND answer_state='attempting'`,...this.keys(),update.update_id).run();}
  return action;
 }
}
function parseCallback(input:unknown){
 const person=z.object({id:positive,is_bot:z.literal(false)}).passthrough(),chat=z.object({id:positive,type:z.literal("private")}).passthrough();
 const schema=z.object({update_id:z.number().int().nonnegative().safe(),callback_query:z.object({id:textId,from:person,chat_instance:textId,data:z.string().regex(/^r_[A-Za-z0-9_-]{43}$/),message:z.object({message_id:positive,date:positive,message_thread_id:positive,chat}).passthrough()}).strict()}).strict();
 try{const json=JSON.stringify(input);if(new TextEncoder().encode(json).length>65536)throw 0;const result=schema.parse(JSON.parse(json));if(["sender_chat","via_bot","forward_origin","forward_from","forward_from_chat","business_connection_id"].some(key=>key in result.callback_query.message))return null;
  // Own only canonical provider fields used for authentication/idempotence.
  const c=result.callback_query,m=c.message;return {update_id:result.update_id,callback_query:{id:c.id,from:{id:c.from.id,is_bot:false as const},chat_instance:c.chat_instance,data:c.data,message:{message_id:m.message_id,date:m.date,message_thread_id:m.message_thread_id,chat:{id:m.chat.id,type:"private" as const}}}};
 }catch{return null;}
}

/** Product wiring only. Neither raw tokens nor this capability enter tools. */
export async function createTelegramReview(env:AssistantEnv,scope:OwnerAffinity,hostEffectGuard?:()=>AccessGuard){
 if(!env.DB||!env.TELEGRAM_WEBHOOK_SECRET||!env.TELEGRAM_BOT_INSTANCE)throw new Error("telegram_unconfigured");
 const {origin,semantic}=hostConfiguredSearch(env,"owner_read");
 const journal=new DecisionJournal(env.DB,scope,{kind:"owner"},{origin,semantic});
 // Rotating either credential invalidates old buttons/prepared notifications.
 const key=await bridgeHash(["telegram-review-credentials-v1",env.TELEGRAM_WEBHOOK_SECRET,env.TELEGRAM_BOT_TOKEN??"unconfigured"]);
 return new TelegramReview(env.DB,scope,env.TELEGRAM_BOT_INSTANCE,key,new TelegramBotApi(env.TELEGRAM_BOT_TOKEN,env.TELEGRAM_BOT_INSTANCE),journal,Date.now,hostEffectGuard);
}
