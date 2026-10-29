import {beforeEach,describe,expect,it,vi} from 'vitest';
import {env} from 'cloudflare:test';
import type {DeliveredMessage} from '@flue/runtime';
import type {Env} from '../src/env';
import {upsertDirectoryPage} from '../src/directory';
import {ingestEvent} from '../src/capture';
import {conversationActivity} from '../src/conversation-activity';
import {prepareApprovedSend,approvedSendStatus,executeNativeReply} from '../src/assistant-approved-send';
import {ConversationRuntime,verifiedConversationEvent} from '../assistant/agent-runtime/conversation';
import {NativeConversationRetention} from '../assistant/agent-runtime/conversation-retention';
import {NativeReplyActions} from '../assistant/agent-runtime/conversation-actions';
import {NativeTelegramReplyReview,readNativeReplyReviewContext,nativeReplyPreview,type NativeTelegramReplyReviewHost} from '../assistant/native-telegram-review';
import {SourceController} from '../assistant/sources';
import {SourceAccess} from '../assistant/access';
import {OriginGuard} from '../assistant/origin-guard';
import {telegramLinkGuard} from '../assistant/telegram-auth';
import type {TelegramApi} from '../assistant/telegram';
const secret='synthetic-native-send-secret-at-least-32',bot='native_test_bot',key='synthetic-native-telegram-key-at-least-32';
beforeEach(async()=>{await env.DB.exec('DELETE FROM conversation_relationships; DELETE FROM owner_message_originals; DELETE FROM approved_sends; DELETE FROM actions; DELETE FROM assistant_capture_changes; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM chats;');});
async function fixture(group=false,text='Resposta integral\ncom <todas> as linhas & 😀. '){
 const scope={installationId:crypto.randomUUID(),generation:'own-g1',sourceEpoch:'e1',sourceGeneration:'g1'};let currentScope={...scope};
 let review:NativeTelegramReplyReview,sourceAttempts=0,noticeLost=false,sourceLost=false,telegramMessageId=200;
 const sourceSent:unknown[]=[];
 const e:Env={...env,OWNER_SUB:'owner',INSTALLATION_EPOCH:'e1',CONNECTION_GENERATION:'g1',CONNECTED_PHONE:'device',ZAPI_INSTANCE_ID:'instance',MAINTENANCE:'false',PUBLIC_ORIGIN:'http://localhost:8787',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ASSISTANT_INSTALLATION_ID:scope.installationId,ASSISTANT_GENERATION:scope.generation,ASSISTANT_APPROVED_SEND_SECRET:secret,
  ASSISTANT_OWNER:{nativeReplyAuthorization:async(_scope:unknown,input:Parameters<NativeTelegramReplyReview['authorize']>[0])=>review.authorize(input),approvedSendAuthorization:async()=>{throw Error('legacy_human_proof_forbidden');}} as unknown as Env['ASSISTANT_OWNER']};
 const address=group?'120363999999999999-group':'5585999999999';
 const {items}=await upsertDirectoryPage(e,{epoch:'e1',generation:'g1'},{items:[{externalId:address,kind:group?'group':'individual',name:'Nome <da conversa>'}],complete:true});const chatId=items[0]!.id;
 const received='*_Nina:_*\nVocê pode <confirmar> & responder? 😀';
 const incoming=(id:string,fromMe=false)=>ingestEvent(e,{epoch:'e1',generation:'g1'},{chatExternalId:address,chatKind:group?'group':'individual',externalId:id,authorExternalId:group?'5585777777777':undefined,authorName:'Nina',fromMe,kind:'text',text:received,timestamp:Date.now()});
 await incoming('source-incoming');
 const activity=await conversationActivity(e,chatId);if(activity.state!=='available')throw Error('fixture_activity');const trigger=activity.latestIncomingOriginalSequence;
 const ref0=await new SourceController(env.DB,scope,{kind:'owner'}).createReport({originKey:'synthetic-context',text:received,authorLabel:'Nina <informada>',occurredAt:Date.now()});
 const snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:'e1',sourceGeneration:'g1',sourceKind:'message',sourceId:'source-message',chatId,sourceVersion:1,watermark:1,conversationKind:group?'group':'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:received,messageId:'source-message',messageVersion:1}};
 const origin=new OriginGuard(env.DB,()=>scope,{readSnapshot:async()=>snapshot},secret),observed=await origin.observe(scope,{sourceKind:'message',sourceId:'source-message',chatId});
 await env.DB.batch([
  env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id=? WHERE installation_id=? AND generation=? AND id=?").bind(chatId,scope.installationId,scope.generation,ref0.id),
  env.DB.prepare('INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,?,\'available\')').bind(scope.installationId,scope.generation,'e1','g1',chatId,group?'group':'private'),
  env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','source-message',?,?,1,?,0)").bind(scope.installationId,scope.generation,'e1','g1',chatId,ref0.id,observed.hash),
 ]);
 if(group)await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,group_mode,revision) VALUES(?,?,?,'group','respond',1)").bind(scope.installationId,scope.generation,chatId).run();
 const source=(await new SourceAccess(env.DB,scope,Date.now,'knowledge').read({kind:'owner'},ref0.id))!;
 const ref={id:source.id,revision:source.fence.source.revision,version:source.fence.source.version,hash:source.fence.source.hash};
 const retention=new NativeConversationRetention(env.DB,()=>scope,origin);let delivery:DeliveredMessage|undefined;
 const identity={version:1 as const,installationId:scope.installationId,generation:scope.generation,channel:'whatsapp' as const,principalOrChatId:chatId,contextEpoch:'ctx1'};
 const runtime=new ConversationRuntime(env.DB,{retention,authority:async()=>({ownerId:'owner',sourceEpoch:'e1',sourceGeneration:'g1',policyRevision:1,grantRef:'owner-allow',mode:'approval'}),authorizeEvent:async()=>{},open:()=>({dispatch:async q=>{if(typeof q==='string')throw Error('fixture_dispatch');delivery=q.message as DeliveredMessage;return {submissionId:crypto.randomUUID(),uid:'native',acceptedAt:new Date().toISOString()};},read:async()=>{throw Error('unused');}}),knowledge:()=>{throw Error('unused');}});
 const admit=async(eventId='native-incoming')=>{await runtime.deliverConversation(verifiedConversationEvent({identity,eventId,revision:1,kind:'incoming',author:{kind:'person',id:'real-participant'},occurredAt:Date.now(),body:received,sourceRef:ref}));return runtime.resolveTask(identity,delivery!);};
 const actions=new NativeReplyActions({db:env.DB,scope,runtime,retention,secret,authorityGuard:async()=>({sql:'1',values:[]}),activity:async()=>{
  const current=await conversationActivity(e,chatId);if(current.state!=='available')throw Error('fixture_activity_blocked');return {triggerSequence:trigger,watermark:current.watermark,relationshipRevision:current.relationshipRevision,relationshipProof:current.relationshipProof,members:current.members.map(m=>m.chatId)};
 },source:{prepare:q=>prepareApprovedSend(e,q),status:q=>approvedSendStatus(e,q),executeNative:q=>executeNativeReply(e,q,{status:async()=>({connected:true,phone:'device'}),send:async body=>{sourceAttempts++;sourceSent.push(body);if(sourceLost)throw Error('source_timeout');return {messageId:'provider-one',zaapId:'zaap-one'};}})}});
 const task=await admit(),proposal=await actions.propose(task,{decision:'respond',text,summary:'Resumo útil <confiável> & completo.'});if(!proposal.intent)throw Error('fixture_intent');const intentId=proposal.intent.id;
 const fence={...scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
 await env.DB.prepare("INSERT INTO assistant_telegram_links(installation_id,generation,bot_instance,source_epoch,source_generation,revision,state,user_id,chat_id,activation_cut) VALUES(?,?,?,?,?,1,'active','101','101',?)").bind(scope.installationId,scope.generation,bot,'e1','g1',Date.now()).run();
 for(const [i,slot] of ['general','summaries','pending','missions'].entries())await env.DB.prepare("INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,?,?,'ready',?)").bind(scope.installationId,scope.generation,bot,slot,JSON.stringify(fence),40+i).run();
 const messages:{chat:string;thread:number|null;text:string;buttons:{text:string;callback_data:string}[][];messageId:number}[]=[];
 const api:TelegramApi={inspect:vi.fn(async()=>true),createTopic:vi.fn(async()=>{throw Error('must_reuse_existing_topics');}),send:vi.fn(async(chat,thread,text,buttons)=>{const messageId=telegramMessageId++;messages.push({chat,thread,text,buttons,messageId});if(noticeLost)throw Error('telegram_timeout');return messageId;}),answer:vi.fn(async()=>{})};
 const host:NativeTelegramReplyReviewHost={db:env.DB,scope,getScope:()=>currentScope,botInstance:bot,key,api,actions,contextReader:t=>readNativeReplyReviewContext(env.DB,scope,origin,t),authorityGuard:()=>telegramLinkGuard(fence)};
 review=new NativeTelegramReplyReview(host);
 const callback=(button=0,updateId=100)=>({update_id:updateId,callback_query:{id:'query-'+updateId,from:{id:101,is_bot:false},chat_instance:'transport-chat',data:messages[0].buttons[0][button].callback_data,message:{message_id:messages[0].messageId,date:Math.floor(Date.now()/1000),message_thread_id:42,chat:{id:101,type:'private'}}}});
 return {review,host,actions,intentId,task,proposal,ref,scope,e,api,messages,sourceSent,address,chatId,origin,retention,snapshot,callback,admit,incoming,received,text,
  dispatch:()=>review.dispatch(intentId,'native-notice-1'),attempts:()=>sourceAttempts,loseNotice:()=>{noticeLost=true;},loseSource:()=>{sourceLost=true;},replaceScope:()=>{currentScope={...scope,sourceGeneration:'replaced'};},
  revokeLink:()=>env.DB.prepare("UPDATE assistant_telegram_links SET revision=revision+1,state='revoked',user_id=NULL,chat_id=NULL,activation_cut=NULL WHERE installation_id=?").bind(scope.installationId).run()};
}
describe('native owner Telegram review, real D1/Source action and fake providers',()=>{
 it('shows original source, useful summary, exact whole response and escaped HTML; reuses the four topics',async()=>{
  const f=await fixture();expect((await f.dispatch()).state).toBe('sent');expect(f.attempts()).toBe(0);expect(f.messages).toHaveLength(1);
  const body=f.messages[0].text;expect(body).toContain('<b><i>Nina:</i></b>\nVocê pode &lt;confirmar&gt; &amp; responder? 😀');expect(body).toContain('Nina &lt;informada&gt;');expect(body).toContain('Resumo útil &lt;confiável&gt; &amp; completo.');expect(body).toContain('Resposta integral\ncom &lt;todas&gt; as linhas &amp; 😀. ');expect(body).toContain('\n\n✍️');
  expect(f.messages[0].buttons[0].map(b=>b.text)).toEqual(['✅ Aprovar e enviar','❌ Descartar']);expect(f.messages[0].buttons[0][0].callback_data).toMatch(/^n_[\w-]{43}$/);expect(f.api.createTopic).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_telegram_topics WHERE installation_id=?').bind(f.scope.installationId).first<number>('n')).toBe(4);
  const row=await env.DB.prepare('SELECT * FROM assistant_native_telegram_reviews WHERE installation_id=?').bind(f.scope.installationId).first();expect(JSON.stringify(row)).not.toContain(f.received);expect(JSON.stringify(row)).not.toContain(f.text);
 });
 it('one authenticated approval sends once through Source and every replay only reconciles',async()=>{
  const f=await fixture();await f.dispatch();expect(await f.review.receiveCallback(f.callback())).toBe('approved');expect(f.attempts()).toBe(1);
  expect(f.messages[1].text).toContain('Aceito pelo WhatsApp');expect(f.messages[1].text).toContain('entrega ainda não foi confirmada');
  expect(await f.review.receiveCallback(f.callback())).toBe('duplicate');expect(await f.review.receiveCallback(f.callback(0,101))).toBe('duplicate');expect(f.attempts()).toBe(1);expect(f.messages).toHaveLength(2);
  const status=await f.review.status((await f.dispatch()).id);expect(status.result.status).toBe('accepted');
  expect(await env.DB.prepare('SELECT approval_channel FROM actions WHERE id=?').bind(f.proposal.prepared!.actionId).first<string>('approval_channel')).toBe('native_telegram_owner');
 });
 it.each(['user','chat','thread','message','forged','bot','forwarded','legacy'] as const)('denies %s callbacks with no WhatsApp attempt',async kind=>{
  const f=await fixture();await f.dispatch();const c=f.callback();
  if(kind==='user')c.callback_query.from.id=102;if(kind==='chat')c.callback_query.message.chat.id=102;if(kind==='thread')c.callback_query.message.message_thread_id=41;if(kind==='message')c.callback_query.message.message_id=999;if(kind==='forged')c.callback_query.data='n_'+'a'.repeat(43);if(kind==='bot')c.callback_query.from.is_bot=true;if(kind==='forwarded')Object.assign(c.callback_query.message,{via_bot:{id:1}});if(kind==='legacy')c.callback_query.data='w_'+'a'.repeat(43);
  expect(await f.review.receiveCallback(c)).toBe(kind==='legacy'?'unsupported':'denied');expect(f.attempts()).toBe(0);
 });
 it('rejects changed update/query payload and the opposite button after approval',async()=>{
  const f=await fixture();await f.dispatch();const c=f.callback();expect(await f.review.receiveCallback(c)).toBe('approved');
  const opposite=f.callback(1,101);expect(await f.review.receiveCallback(opposite)).toBe('denied');const changed=f.callback();changed.callback_query.chat_instance='changed';expect(await f.review.receiveCallback(changed)).toBe('conflict');expect(f.attempts()).toBe(1);
 });
 it('discards without a Source attempt and cannot approve the discarded review',async()=>{
  const f=await fixture();await f.dispatch();expect(await f.review.receiveCallback(f.callback(1))).toBe('discarded');expect(f.attempts()).toBe(0);expect(f.messages[1].text).toContain('Nenhuma mensagem foi enviada');expect(await f.review.receiveCallback(f.callback(0,101))).toBe('denied');
 });
 it.each(['link','scope','key','source','incoming','manual','native','excluded'] as const)('denies %s changes after the preview',async kind=>{
  const f=await fixture();await f.dispatch();
  if(kind==='link')await f.revokeLink();if(kind==='scope')f.replaceScope();if(kind==='key')f.review=new NativeTelegramReplyReview({...f.host,key:key+'-new'});
  if(kind==='source')f.snapshot.content.text='Texto corrigido';if(kind==='incoming')await f.incoming('new-question');if(kind==='manual')await f.incoming('owner-manual',true);if(kind==='native')await f.admit('new-native-incoming');
  if(kind==='excluded')await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,?,'private',1,'ignore',1)").bind(f.scope.installationId,f.scope.generation,f.chatId).run();
  expect(await f.review.receiveCallback(f.callback())).toBe('denied');expect(f.attempts()).toBe(0);
 });
 it('keeps the owner link SQL fence live in the actual Source authorization',async()=>{
  const f=await fixture();await f.dispatch();const approve=vi.spyOn(f.actions,'execute').mockImplementationOnce(async()=>{await f.revokeLink();throw Error('revoked_before_source');});
  expect(await f.review.receiveCallback(f.callback())).toBe('approved');expect(approve).toHaveBeenCalledOnce();expect(f.attempts()).toBe(0);
  const authority={kind:'human_approval' as const,intentId:f.intentId,approvalId:(await env.DB.prepare('SELECT id FROM assistant_native_telegram_reviews WHERE installation_id=?').bind(f.scope.installationId).first<string>('id'))!};
  expect(await f.actions.authorize({secret,actionId:f.proposal.prepared!.actionId,hash:f.proposal.prepared!.hash,authority})).toEqual({authorized:false});
 });
 it('sends a group reply to the group address and displays participant label as data',async()=>{
  const f=await fixture(true);await f.dispatch();expect(f.messages[0].text).toContain(' · Grupo');expect(await f.review.receiveCallback(f.callback())).toBe('approved');expect(f.sourceSent).toMatchObject([{destination:f.address,text:f.text}]);expect(f.address).not.toBe('5585777777777');
 });
 it('does not repeat a Telegram notice with lost ACK, another operation id or concurrent dispatch',async()=>{
  const f=await fixture();f.loseNotice();const results=await Promise.all([f.dispatch(),f.dispatch()]);expect(results.map(r=>r.state)).toContain('uncertain');expect(f.messages).toHaveLength(1);expect((await f.dispatch()).state).toBe('uncertain');
  await expect(f.review.dispatch(f.intentId,'replacement-op')).rejects.toThrow('native_review_conflict');expect(f.messages).toHaveLength(1);expect(f.attempts()).toBe(0);
 });
 it('keeps an uncertain WhatsApp receipt and never executes again on callback or reconciliation',async()=>{
  const f=await fixture();await f.dispatch();f.loseSource();expect(await f.review.receiveCallback(f.callback())).toBe('approved');expect(f.attempts()).toBe(1);expect(f.messages[1].text).toContain('Não vou repetir');
  const id=(await f.dispatch()).id;await f.review.reconcile(id);await f.review.receiveCallback(f.callback(0,101));expect((await f.review.status(id)).result.status).toBe('uncertain');expect(f.attempts()).toBe(1);
 });
 it('reconciles accepted→delivered as a distinct state without another Source execution',async()=>{
  const f=await fixture();await f.dispatch();await f.review.receiveCallback(f.callback());await env.DB.prepare("UPDATE actions SET status='delivered' WHERE id=?").bind(f.proposal.prepared!.actionId).run();const id=(await f.dispatch()).id;
  expect((await f.review.reconcile(id)).result.status).toBe('delivered');expect(f.messages[2].text).toContain('Mensagem entregue');expect(f.attempts()).toBe(1);
 });
 it('refuses a response too large to show completely and never creates buttons for a truncated body',async()=>{
  const f=await fixture(false,'😀'.repeat(1600));expect((await f.dispatch()).state).toBe('preview_too_large');expect(f.messages).toHaveLength(0);expect(f.attempts()).toBe(0);
  expect(nativeReplyPreview({name:'Nome',address:'123',kind:'individual'},'resposta',{text:'x'.repeat(10000),authorLabel:null},'resumo')).toContain('Mensagem recebida (trecho)');
 });
 it('requires the actual latest incoming SourceRef and current source proof, not names or supplied text',async()=>{
  const f=await fixture(),reader=f.host.contextReader;f.host.contextReader=async task=>{const proof=await reader(task);return {...proof,source:{...proof.source,fence:{...proof.source.fence,source:{...proof.source.fence.source,hash:'0'.repeat(64)}}}};};
  await expect(f.dispatch()).rejects.toThrow('native_review_context_changed');expect(f.messages).toHaveLength(0);
 });
 it('tombstone revokes callbacks and clears copied reference guards while retaining receipts',async()=>{
  const f=await fixture();await f.dispatch();await f.retention.purge(f.task.identity);
  const row=await env.DB.prepare('SELECT context_ref_json,context_guard_json,context_source_id,state FROM assistant_native_telegram_reviews WHERE installation_id=?').bind(f.scope.installationId).first();
  expect(row).toEqual({context_ref_json:'{}',context_guard_json:null,context_source_id:null,state:'cancelled'});expect(await f.review.receiveCallback(f.callback())).toBe('denied');expect(f.attempts()).toBe(0);
 });
});
