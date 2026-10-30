import {env} from 'cloudflare:test';
import {describe,it,expect,vi} from 'vitest';
import type {DeliveredMessage} from '@flue/runtime';
import {SourceController} from '../assistant/sources';
import {SourceAccess,type SourceSelectionRef} from '../assistant/access';
import {OriginGuard} from '../assistant/origin-guard';
import {TelegramLink,telegramLinkGuard} from '../assistant/telegram-auth';
import type {TelegramApi} from '../assistant/telegram';
import {ConversationRuntime,verifiedConversationEvent,type HostConversationEvent} from '../assistant/agent-runtime/conversation';
import {NativeConversationRetention} from '../assistant/agent-runtime/conversation-retention';
import {NativeOwnerHelp,type NativeOwnerHelpHost,type NativeHelpResume} from '../assistant/agent-runtime/native-owner-help';
import {createNativeCalendarCapability} from '../assistant/agent-runtime/native-calendar';

const owner={kind:'owner'} as const,secret='synthetic-owner-help-secret-at-least-32',bot='owner_help_bot';
async function fixture(channel:'whatsapp'|'telegram'='whatsapp'){
 const scope={installationId:crypto.randomUUID(),generation:'own',sourceEpoch:'source',sourceGeneration:'sg'},sources=new SourceController(env.DB,scope,owner);
 const fence={...scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
 await env.DB.prepare("INSERT INTO assistant_telegram_links(installation_id,generation,bot_instance,source_epoch,source_generation,revision,state,user_id,chat_id,activation_cut) VALUES(?,?,?,?,?,1,'active','101','101',?)").bind(scope.installationId,scope.generation,bot,scope.sourceEpoch,scope.sourceGeneration,Math.floor(Date.now()/1000)-10).run();
 await env.DB.prepare("INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)").bind(scope.installationId,scope.generation,bot,JSON.stringify(fence)).run();
 const originalText=channel==='whatsapp'?'Preciso confirmar a condição do projeto.':'Agenda uma revisão rápida para amanhã às duas, por favor.';
 const original=await sources.createReport({originKey:'input',text:originalText,authorId:channel==='telegram'?'101':'participant',authorLabel:'Pessoa',occurredAt:Date.now()});
 const snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:'original-message',chatId:'wa-chat',sourceVersion:1,watermark:55,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:originalText,fromMe:false,authorId:'participant',messageId:'original-message',messageVersion:1}};
 const origin=new OriginGuard(env.DB,()=>scope,{readSnapshot:async()=>snapshot},secret);
 if(channel==='whatsapp'){
  const observed=await origin.observe(scope,{sourceKind:'message',sourceId:'original-message',chatId:'wa-chat'});
  await env.DB.batch([
   env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='wa-chat' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,original.id),
   env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,55,'private','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'wa-chat'),
   env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','original-message','wa-chat',?,55,?,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,original.id,observed.hash),
  ]);
 }
 async function reference(id:string){const source=(await new SourceAccess(env.DB,scope,Date.now,'knowledge').read(owner,id))!;return {id,revision:source.fence.source.revision,version:source.fence.source.version,hash:source.fence.source.hash};}
 const ref=await reference(original.id),identity={version:1 as const,installationId:scope.installationId,generation:scope.generation,channel,principalOrChatId:channel==='whatsapp'?'wa-chat':'101',contextEpoch:'epoch-one'};
 const retention=new NativeConversationRetention(env.DB,()=>scope,origin);let delivery:DeliveredMessage|undefined,loseNative=false,activityAllowed=true;
 const nativeKeys=new Set<string>(),dispatches:HostConversationEvent[]=[],resumes:NativeHelpResume[]=[];
 const runtime=new ConversationRuntime(env.DB,{retention,authority:async()=>({ownerId:'101',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,policyRevision:1,grantRef:'owner',mode:'approval'}),authorizeEvent:async()=>{},knowledge:()=>{throw Error('unused');},open:()=>({dispatch:async input=>{
  if(typeof input==='string')throw Error('bad_fixture');delivery=input.message as DeliveredMessage;
  const data=JSON.parse(delivery.body!);dispatches.push(data);nativeKeys.add(input.idempotencyKey!);
  if(loseNative){loseNative=false;throw Error('lost_native_ack');}
  return {submissionId:'native-'+input.idempotencyKey,uid:'same-native-instance',acceptedAt:new Date().toISOString()};
 },read:async()=>{throw Error('unused');}})});
 async function admit(event:HostConversationEvent,ownerLink:unknown=null){
  const result=await runtime.deliverConversation(verifiedConversationEvent(event));
  await env.DB.prepare(`INSERT INTO assistant_native_host_events(installation_id,generation,conversation_id,event_id,event_revision,request_hash,source_id,source_ref_json,original_sequence,owner_link_json,created_at)
   VALUES(?,?,?,?,?,'fixture',?,?,55,?,1) ON CONFLICT DO NOTHING`).bind(scope.installationId,scope.generation,result.sessionId,event.eventId,event.revision,event.sourceRef!.id,JSON.stringify(event.sourceRef),ownerLink?JSON.stringify(ownerLink):null).run();
  return result;
 }
 await admit({identity,eventId:'original-input',revision:1,kind:'incoming',author:{kind:channel==='telegram'?'owner':'person',id:channel==='telegram'?'101':'participant'},occurredAt:1,body:originalText,sourceRef:ref},channel==='telegram'?fence:null);
 const task=await runtime.resolveTask(identity,delivery!);
 const messages:{chat:string;thread:number|null;text:string;id:number}[]=[];let loseTelegram=false;
 const api:TelegramApi={inspect:async()=>true,createTopic:async()=>{throw Error('no_duplicate_topics');},answer:async()=>{},send:async(chat,thread,text)=>{const id=200+messages.length;messages.push({chat,thread,text,id});if(loseTelegram)throw Error('lost_telegram_ack');return id;}};
 const host:NativeOwnerHelpHost={db:env.DB,scope,getScope:()=>scope,botInstance:bot,credentialKey:secret,api,
  ownerFence:async()=>fence,assertCurrent:task=>runtime.assertTaskCurrent(task),authorityGuard:async task=>retention.authorityGuard(task.sessionId),
  activity:async()=>{if(!activityAllowed)throw Error('native_activity_superseded');return {triggerSequence:55};},exposeSource:(task,ref)=>retention.exposeSource(task.identity,ref),conversationLabel:async()=> 'Projeto <X>',
  resume:async input=>{resumes.push(input);return admit({identity:input.task.identity,eventId:input.eventId,revision:1,kind:'clarification',author:{kind:'owner',id:input.ownerFence.userId},occurredAt:input.occurredAt,body:input.text,sourceRef:input.sourceRef,replyTo:input.anchor},input.ownerFence);}};
 const help=new NativeOwnerHelp(host),telegram=new TelegramLink(env.DB,scope,bot,secret);
 function rawReply(updateId=100){return {update_id:updateId,message:{message_id:updateId+500,date:Math.floor(Date.now()/1000)-1,from:{id:101,is_bot:false},chat:{id:101,type:'private'},message_thread_id:42,text:'Pode considerar a condição especial do projeto.',reply_to_message:{message_id:messages[0].id,chat:{id:101,type:'private'},message_thread_id:42}}};}
 async function canonicalReply(raw=rawReply()){
  expect(await telegram.receive(raw)).toBe('pending');
  const reply=await sources.createReport({originKey:'reply-'+raw.update_id,text:raw.message.text,authorId:'101',occurredAt:raw.message.date*1000});
  return {raw,sourceRef:await reference(reply.id)};
 }
 return {scope,sources,ref,task,identity,runtime,retention,origin,host,help,api,fence,messages,resumes,dispatches,nativeKeys,originalText,reference,admit,rawReply,canonicalReply,
  currentDelivery:()=>delivery!,supersede:()=>{activityAllowed=false;},loseTelegram:()=>{loseTelegram=true;},loseNative:()=>{loseNative=true;}};
}
describe('native private owner help with canonical input and causal lineage',()=>{
 it('asks once, correlates an actual authenticated quote, and resumes the same WhatsApp conversation with both sources retained',async()=>{
  const f=await fixture();expect(await f.help.ask(f.task,'Qual condição devo considerar?')).toMatchObject({state:'sent'});
  expect(f.messages[0].text).toContain('Projeto &lt;X&gt;');expect(f.messages[0].text).toContain(f.originalText);expect(f.messages[0].text).toContain('não aprova um envio');
  await f.help.ask(f.task,'Qual condição devo considerar?');expect(f.messages).toHaveLength(1);
  const reply=await f.canonicalReply();expect(await f.help.recordReply(reply.raw)).toMatchObject({state:'recorded'});
  expect(await f.help.resume(reply.raw.update_id,reply.sourceRef)).toMatchObject({state:'resumed'});
  const resumed=await f.runtime.resolveTask(f.identity,f.currentDelivery());
  expect(resumed.cohort.map(e=>e.kind)).toEqual(['clarification']);expect(resumed.replyTo).toEqual({taskRef:f.task.taskRef,sourceRef:f.ref});
  expect(resumed.cohort[0].author).toEqual({kind:'owner',id:'101'});expect(resumed.returnChannel).toEqual(f.task.returnChannel);expect(resumed.watermark).toBeGreaterThan(f.task.watermark);
  const exposed=(await env.DB.prepare('SELECT source_id FROM assistant_native_context_exposures WHERE conversation_id=?').bind(f.task.sessionId).all<{source_id:string}>()).results.map(row=>row.source_id);
  expect(exposed).toContain(f.ref.id);expect(exposed).toContain(reply.sourceRef.id);
  expect(await f.help.resume(reply.raw.update_id,reply.sourceRef)).toMatchObject({state:'resumed'});expect(f.resumes).toHaveLength(1);
 });
 it.each(['owner','chat','thread','question','payload'] as const)('rejects a %s mismatch without resuming another conversation',async kind=>{
  const f=await fixture();await f.help.ask(f.task,'Qual condição?');const admitted=await f.canonicalReply(),raw=structuredClone(admitted.raw);
  if(kind==='owner')raw.message.from.id=102;if(kind==='chat')raw.message.chat.id=102;if(kind==='thread')raw.message.message_thread_id=41;if(kind==='question')raw.message.reply_to_message.message_id=999;if(kind==='payload')raw.message.text='Forged changed text';
  expect((await f.help.recordReply(raw)).state).not.toBe('recorded');expect((await f.help.resume(raw.update_id,admitted.sourceRef)).state).toBe('unrelated');expect(f.resumes).toHaveLength(0);
 });
 it('preserves unknown Telegram delivery with one attempt and does not fabricate a notice ID to correlate',async()=>{
  const f=await fixture();f.loseTelegram();expect(await f.help.ask(f.task,'Qual condição?')).toMatchObject({state:'uncertain'});expect(await f.help.ask(f.task,'Qual condição?')).toMatchObject({state:'uncertain'});expect(f.messages).toHaveLength(1);
  const r=await f.canonicalReply();expect(await f.help.recordReply(r.raw)).toMatchObject({state:'unrelated'});expect(f.resumes).toHaveLength(0);
 });
 it('reuses the exact native clarification after a lost admission acknowledgement, without inserting a fake old consumed task',async()=>{
  const f=await fixture();await f.help.ask(f.task,'Qual condição?');const r=await f.canonicalReply();await f.help.recordReply(r.raw);f.loseNative();
  expect(await f.help.resume(r.raw.update_id,r.sourceRef)).toMatchObject({state:'pending'});
  expect(await f.help.resume(r.raw.update_id,r.sourceRef)).toMatchObject({state:'resumed'});
  expect(f.nativeKeys.size).toBe(2);expect(f.resumes[0].eventId).toBe(f.resumes[1].eventId);
  const resumed=await f.runtime.resolveTask(f.identity,f.currentDelivery());expect(resumed.cohort).toHaveLength(1);expect(resumed.cohort[0].kind).toBe('clarification');
 });
 it('new incoming or a manual owner response prevents resuming an old source trigger',async()=>{
  const f=await fixture();await f.help.ask(f.task,'Qual condição?');const r=await f.canonicalReply();await f.help.recordReply(r.raw);f.supersede();
  expect(await f.help.resume(r.raw.update_id,r.sourceRef)).toMatchObject({state:'stale'});expect(f.resumes).toHaveLength(0);
 });
 it('retirement clears the question and denies its quoted reply even when the owner remains linked',async()=>{
  const f=await fixture();await f.help.ask(f.task,'Qual condição?');await f.retention.purge(f.identity);
  expect(await env.DB.prepare('SELECT task_json,question_text,state FROM assistant_native_help_questions WHERE conversation_id=?').bind(f.task.sessionId).first()).toEqual({task_json:'{}',question_text:null,state:'cancelled'});
  const r=await f.canonicalReply();expect(await f.help.recordReply(r.raw)).toMatchObject({state:'unrelated'});expect(f.resumes).toHaveLength(0);
 });
 it('refuses a copied anchor from another conversation and a recursive clarification anchor',async()=>{
  const f=await fixture(),other={...f.identity,principalOrChatId:'different-chat'};
  await expect(f.runtime.deliverConversation(verifiedConversationEvent({identity:other,eventId:'forged',revision:1,kind:'clarification',author:{kind:'owner',id:'101'},occurredAt:2,body:'owner reply',sourceRef:f.ref,replyTo:{taskRef:f.task.taskRef,sourceRef:f.ref}}))).rejects.toThrow('conversation_reply_anchor_denied');
  await f.help.ask(f.task,'Qual condição?');const r=await f.canonicalReply();await f.help.recordReply(r.raw);await f.help.resume(r.raw.update_id,r.sourceRef);
  const clarified=await f.runtime.resolveTask(f.identity,f.currentDelivery());
  await expect(f.runtime.deliverConversation(verifiedConversationEvent({identity:f.identity,eventId:'recursive',revision:1,kind:'clarification',author:{kind:'owner',id:'101'},occurredAt:3,body:'again',sourceRef:r.sourceRef,replyTo:{taskRef:clarified.taskRef,sourceRef:r.sourceRef}}))).rejects.toThrow('conversation_reply_anchor_denied');
 });
});

describe('native owner Calendar mutations',()=>{
 const mutation={verb:'create' as const,summary:'Revisão rápida',start:'2026-10-30T14:00:00-03:00',end:'2026-10-30T15:00:00-03:00'};
 async function calendar(channel:'telegram'|'whatsapp'='telegram'){
  const f=await fixture(channel),requests:Request[]=[];
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,'calendar','Agenda autorizada')").bind(f.scope.installationId,f.scope.generation).run();
  const grant=await f.sources.create({originKey:'calendar-write-grant',text:'Owner authorized single own-event Calendar writes.',occurredAt:1,projectId:'calendar'});
  const configuration={id:'primary',calendarId:'primary',projectId:'calendar',version:1,authorization:{sourceId:grant.id,revision:1}};
  const token=vi.fn(async()=>({state:'ready',accessToken:'synthetic-token',expiresAt:Date.now()+60000}));
  const settings={DB:env.DB,CALENDAR_OAUTH_PERMISSION:'write_owned',CALENDAR_WRITE_CALENDAR:JSON.stringify(configuration),CALENDAR_OAUTH_CONFIGURATION_VERSION:'1',CALENDAR_OAUTH_SECRET_EPOCH:'epoch',CALENDAR_OAUTH:{idFromName:()=>({}),get:()=>({token})}} as any;
  const options={db:env.DB,env:settings,scope:f.scope,getScope:()=>f.scope,task:f.task,assertCurrent:()=>f.runtime.assertTaskCurrent(f.task),authorityGuard:()=>f.retention.authorityGuard(f.task.sessionId),ownerFence:async()=>f.fence,expose:(proof:any)=>f.retention.expose(f.identity,proof),
   request:async(request:Request)=>{requests.push(request);return Response.json({...await request.json() as object,status:'confirmed',etag:'"created"'});}};
  return {...f,grant,settings,token,requests,options,calendar:createNativeCalendarCapability(options)};
 }
 it('lets the native agent interpret a natural authenticated owner request and uses the existing single-effect Calendar transport',async()=>{
  const f=await calendar();expect(await f.calendar.change(mutation)).toMatchObject({state:'applied',summary:mutation.summary});
  expect(await createNativeCalendarCapability(f.options).change(mutation)).toMatchObject({state:'applied'});expect(f.requests).toHaveLength(1);
  expect(f.requests[0].method).toBe('POST');expect(f.requests[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none');
  expect(await env.DB.prepare('SELECT request_id,authority_id FROM assistant_calendar_actions WHERE installation_id=?').bind(f.scope.installationId).first()).toEqual({request_id:f.ref.id,authority_id:f.grant.id});
 });
 it('a WhatsApp participant never acquires Calendar write authority from the message text or tool call',async()=>{
  const f=await calendar('whatsapp');await expect(f.calendar.change(mutation)).rejects.toThrow('native_calendar_owner_required');expect(f.token).not.toHaveBeenCalled();expect(f.requests).toHaveLength(0);
 });
 it('a quoted historical owner source without the authenticated owner host receipt does not grant a write',async()=>{
  const f=await calendar();await env.DB.prepare('UPDATE assistant_native_host_events SET owner_link_json=NULL WHERE conversation_id=?').bind(f.task.sessionId).run();
  await expect(f.calendar.change(mutation)).rejects.toThrow('native_calendar_owner_required');expect(f.requests).toHaveLength(0);
 });
 it('canonical Calendar grant withdrawal while OAuth is pending prevents the external write',async()=>{
  const f=await calendar();f.token.mockImplementationOnce(async()=>{await f.sources.withdraw(f.grant.id,1);return {state:'ready',accessToken:'synthetic-token',expiresAt:Date.now()+60000};});
  await expect(f.calendar.change(mutation)).rejects.toThrow();expect(f.requests).toHaveLength(0);
 });
 it('a newer native owner turn supersedes the old mutation before token completion',async()=>{
  const f=await calendar();f.token.mockImplementationOnce(async()=>{
   await f.admit({identity:f.identity,eventId:'new-owner-turn',revision:1,kind:'incoming',author:{kind:'owner',id:'101'},occurredAt:2,body:f.originalText,sourceRef:f.ref},f.fence);
   return {state:'ready',accessToken:'synthetic-token',expiresAt:Date.now()+60000};
  });
  await expect(f.calendar.change(mutation)).rejects.toThrow('native_calendar_authority_changed');expect(f.requests).toHaveLength(0);
 });
 it('a lost provider acknowledgement stays uncertain across capability recreation without a second mutation',async()=>{
  const f=await calendar(),request=vi.fn(async()=>{throw Error('lost_after_google_effect');});
  const first=createNativeCalendarCapability({...f.options,request});expect(await first.change(mutation)).toMatchObject({state:'uncertain'});
  expect(await createNativeCalendarCapability({...f.options,request}).change(mutation)).toMatchObject({state:'uncertain'});expect(request).toHaveBeenCalledOnce();
 });
});
