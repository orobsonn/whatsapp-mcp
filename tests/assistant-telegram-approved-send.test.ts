import { env } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { TelegramApprovedSendReview } from '../assistant/telegram-approved-send';
import { bridgeHash } from '../assistant/ingress';
import { actionDigest } from '../src/send-envelope';
import type { AssistantEnv } from '../assistant/env';
import type { DecisionJournal } from '../assistant/decisions';
import type { TelegramApi } from '../assistant/telegram';
import type { ApprovedSendActuatorRPC } from '../src/approved-send-contract';

let host: TelegramApprovedSendReview, config: AssistantEnv, now: number, scope: {installationId:string;generation:string;sourceEpoch:string;sourceGeneration:string};
let api: TelegramApi, actuator: ApprovedSendActuatorRPC, current: boolean;
const bot='synthetic_bot', secret='approved-send-synthetic-secret-at-least-32', actionId='641ad152-63df-42c0-a921-0f13cae7e9bd';
const proposal={decision:'proposed',text:'Podemos conversar amanhã às 10h?'};
const envelope={kind:'text' as const,chatId:'synthetic-conversation',text:proposal.text};
const q=(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args);
beforeEach(async()=>{
 proposal.decision='proposed';proposal.text=envelope.text;
 now=2000000;current=true;scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'e1',sourceGeneration:'c1'};
 await q(`INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',0)`,scope.installationId,scope.generation,bot,scope.sourceEpoch,scope.sourceGeneration).run();
 const fence={...scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
 await q(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`,scope.installationId,scope.generation,bot,JSON.stringify(fence)).run();
 api={inspect:vi.fn(async()=>true),createTopic:vi.fn(async()=>42),send:vi.fn(async()=>200),answer:vi.fn(async()=>{})};
 const hash=await actionDigest(envelope);
 actuator={prepare:vi.fn(async()=>({actionId,hash,envelope,target:{chatId:envelope.chatId,name:'Pessoa sintética',address:'5511000000000',kind:'individual' as const},expiresAt:now+600000})),execute:vi.fn(async()=>({actionId,hash,status:'accepted',providerMessageId:'synthetic-provider',providerZaapId:null,error:null,expiresAt:now+600000})),status:vi.fn(async()=>({actionId,hash,status:'accepted',providerMessageId:'synthetic-provider',providerZaapId:null,error:null,expiresAt:now+600000}))};
 config={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,FLUE_EPISODES_ENABLED:'shadow',WHATSAPP_APPROVED_SEND_ENABLED:'true',WHATSAPP_APPROVED_SEND_SECRET:secret,WHATSAPP_APPROVED_SEND:actuator,PROACTIVE_PILOT_JSON:JSON.stringify({id:'synthetic-pilot',revision:1,startAfterSequence:10,chatIds:[envelope.chatId]})};
 const journal={get:vi.fn(async()=>({freshness:current?'current':'stale',subject:{kind:'capture_event',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,chatId:envelope.chatId,sequence:11,metadataHash:'a'.repeat(64)},proposal})),admitReview:vi.fn(async(_id:string,hash:string,build:Parameters<DecisionJournal['admitReview']>[2])=>current&&hash===await bridgeHash(proposal)?env.DB.batch(build({sql:'1',values:[]})):null)} as unknown as Pick<DecisionJournal,'get'|'admitReview'>;
 host=new TelegramApprovedSendReview(config,scope,bot,'synthetic-callback-hmac-secret',api,journal,()=>now);
});
function callback(index=0){const call=vi.mocked(api.send).mock.calls[0];return {update_id:100,callback_query:{id:'query-100',from:{id:101,is_bot:false},chat_instance:'synthetic',data:call[3][0][index].callback_data,message:{message_id:200,date:2000,message_thread_id:42,chat:{id:101,type:'private'}}}};}
it('shows exact destination and entire text, then sends only on the owner approval',async()=>{
 expect(await host.dispatchDecision('d1','routine:one')).toMatchObject({state:'sent'});
 expect(api.send).toHaveBeenCalledTimes(1);expect(vi.mocked(api.send).mock.calls[0][2]).toContain(proposal.text);expect(vi.mocked(api.send).mock.calls[0][2]).toContain('5511000000000');expect(actuator.execute).not.toHaveBeenCalled();
 expect(await host.receiveCallback(callback())).toBe('approved');expect(actuator.execute).toHaveBeenCalledTimes(1);
 expect(await host.receiveCallback(callback())).toBe('duplicate');expect(actuator.execute).toHaveBeenCalledTimes(1);
 const sent=vi.mocked(api.send).mock.calls[1][2];expect(sent).toContain('Aceito pelo WhatsApp');expect(sent).not.toContain('Entregue');
});
it('accepts real Telegram user/chat metadata without treating it as authority',async()=>{
 await host.dispatchDecision('d1','routine:one');
 const update=callback();
 Object.assign(update.callback_query.from,{first_name:'Synthetic',username:'synthetic_owner',language_code:'pt-br'});
 Object.assign(update.callback_query.message.chat,{first_name:'Synthetic',username:'synthetic_owner'});
 Object.assign(update.callback_query.message,{is_topic_message:true,text:'Provider preview',from:{id:123,is_bot:true,first_name:'Synthetic bot'}});
 expect(await host.receiveCallback(update)).toBe('approved');expect(actuator.execute).toHaveBeenCalledTimes(1);
});
it.each(['owner','thread','message','chat','bot'] as const)('rejects another %s without sending',async field=>{
 await host.dispatchDecision('d1','routine:one');const update=callback();
 if(field==='owner')update.callback_query.from.id=102;if(field==='thread')update.callback_query.message.message_thread_id=43;if(field==='message')update.callback_query.message.message_id=201;if(field==='chat')update.callback_query.message.chat.id=102;if(field==='bot')update.callback_query.from.is_bot=true;
 expect(await host.receiveCallback(update)).toBe('denied');expect(actuator.execute).not.toHaveBeenCalled();
});
it('rejects an old simulation callback and an expired real approval',async()=>{
 await host.dispatchDecision('d1','routine:one');const old=callback();old.callback_query.data='r_'+'a'.repeat(43);expect(await host.receiveCallback(old)).toBe('unsupported');
 now+=600001;expect(await host.receiveCallback(callback())).toBe('denied');expect(actuator.execute).not.toHaveBeenCalled();
});
it('discards without calling the actuator',async()=>{
 await host.dispatchDecision('d1','routine:one');expect(await host.receiveCallback(callback(1))).toBe('discarded');expect(actuator.execute).not.toHaveBeenCalled();
});
it('routes uncertainty to an owner clarification without preparing a WhatsApp action',async()=>{
 proposal.decision='waiting_context';
 expect(await host.dispatchDecision('d1','routine:one')).toMatchObject({state:'needs_clarification'});
 expect(actuator.prepare).not.toHaveBeenCalled();expect(actuator.execute).not.toHaveBeenCalled();expect(api.send).not.toHaveBeenCalled();
});
it('preserves correct silence without asking a question or preparing a send',async()=>{
 proposal.decision='no_reply';proposal.text='';
 expect(await host.dispatchDecision('d1','routine:one')).toMatchObject({state:'not_applicable'});
 expect(actuator.prepare).not.toHaveBeenCalled();expect(api.send).not.toHaveBeenCalled();
});
it('does not invent a clarification from a stale or empty proposal',async()=>{
 proposal.decision='waiting_context';current=false;
 expect(await host.dispatchDecision('d1','routine:one')).toMatchObject({state:'blocked'});
 current=true;proposal.text='';expect(await host.dispatchDecision('d1','routine:one')).toMatchObject({state:'clarification_unavailable'});
 expect(actuator.prepare).not.toHaveBeenCalled();expect(api.send).not.toHaveBeenCalled();
});
it('authorizes the exact action only after a real owner callback, with a short grant',async()=>{
 await host.dispatchDecision('d1','routine:one');const row=await q(`SELECT id FROM assistant_telegram_send_reviews WHERE installation_id=?`,scope.installationId).first<{id:string}>();
 const proof={secret,approvalId:row!.id,actionId,hash:await actionDigest(envelope)};
 expect(await host.authorize(proof)).toEqual({authorized:false});
 await host.receiveCallback(callback());
 expect(await host.authorize(proof)).toEqual({authorized:true,approvalId:row!.id,actionId,hash:proof.hash,expiresAt:now+10000});
 expect(await host.authorize({...proof,secret:'wrong-secret'})).toEqual({authorized:false});
 expect(await host.authorize({...proof,hash:'b'.repeat(64)})).toEqual({authorized:false});
});
it('a second human click has a new update ID and checks the same send without repeating it',async()=>{
 await host.dispatchDecision('d1','routine:one');await host.receiveCallback(callback());
 current=false;const again=callback();again.update_id=101;again.callback_query.id='query-101';
 expect(await host.receiveCallback(again)).toBe('duplicate');expect(actuator.execute).toHaveBeenCalledTimes(1);expect(actuator.status).toHaveBeenCalledTimes(1);
});
it.each(['source','link','pilot','runtime'])('refuses authorization after %s changes',async kind=>{
 await host.dispatchDecision('d1','routine:one');await host.receiveCallback(callback());const row=await q(`SELECT id FROM assistant_telegram_send_reviews WHERE installation_id=?`,scope.installationId).first<{id:string}>();
 if(kind==='source')current=false;if(kind==='link')await q(`UPDATE assistant_telegram_links SET revision=2 WHERE installation_id=?`,scope.installationId).run();if(kind==='pilot')config.PROACTIVE_PILOT_JSON='{}';if(kind==='runtime')config.WHATSAPP_APPROVED_SEND_ENABLED='false';
 expect(await host.authorize({secret,approvalId:row!.id,actionId,hash:await actionDigest(envelope)})).toEqual({authorized:false});
});
it('records uncertainty without repeating a send or the preview on retry',async()=>{
 await host.dispatchDecision('d1','routine:one');vi.mocked(actuator.execute).mockRejectedValueOnce(Error('network_lost'));
 expect(await host.receiveCallback(callback())).toBe('approved');expect(await host.receiveCallback(callback())).toBe('duplicate');expect(actuator.execute).toHaveBeenCalledTimes(1);
 expect(actuator.status).toHaveBeenCalledTimes(1);
 const receipt=await q(`SELECT receipt_json FROM assistant_telegram_send_reviews WHERE installation_id=?`,scope.installationId).first<string>('receipt_json');expect(JSON.parse(receipt!).status).toBe('accepted');
 expect(await host.dispatchDecision('d1','routine:one')).toMatchObject({state:'sent'});expect(vi.mocked(api.send).mock.calls.filter(call=>call[3].length)).toHaveLength(1);
});
