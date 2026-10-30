import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { DeliveredMessage } from '@flue/runtime';
import type { Env } from '../src/env';
import { upsertDirectoryPage } from '../src/directory';
import { ingestEvent } from '../src/capture';
import { conversationActivity } from '../src/conversation-activity';
import { prepareApprovedSend, approvedSendStatus, executeNativeReply } from '../src/assistant-approved-send';
import type { SendProvider } from '../src/actions';
import { ConversationRuntime, verifiedConversationEvent, type ConversationAuthority } from '../assistant/agent-runtime/conversation';
import { NativeConversationRetention } from '../assistant/agent-runtime/conversation-retention';
import { NativeReplyActions } from '../assistant/agent-runtime/conversation-actions';
import { OriginGuard } from '../assistant/origin-guard';
import type { ApprovedSendActivityFence } from '../src/approved-send-contract';
import type { NativeReplyExecutionAuthority } from '../src/native-reply-contract';
const secret='s'.repeat(48);
beforeEach(async()=>{
 await env.DB.exec('DELETE FROM conversation_relationships; DELETE FROM owner_message_originals; DELETE FROM approved_sends; DELETE FROM actions; DELETE FROM assistant_capture_changes; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM chats;');
 await env.DB.exec('CREATE TABLE IF NOT EXISTS native_reply_test_grants(id TEXT PRIMARY KEY,active INTEGER,revision INTEGER);');
});
async function fixture(mode:ConversationAuthority['mode']='approval',enabled=false,group=false){
 const scope={installationId:crypto.randomUUID(),generation:'own-g1',sourceEpoch:'e1',sourceGeneration:'g1'};
 const identity={version:1 as const,installationId:scope.installationId,generation:scope.generation,channel:'whatsapp' as const,principalOrChatId:'',contextEpoch:'ctx1'};
 let authority:ConversationAuthority={ownerId:'owner',sourceEpoch:'e1',sourceGeneration:'g1',policyRevision:1,grantRef:scope.installationId,mode};
 let allowAutonomous=enabled,attempts=0,loseAck=false,onStatus:(()=>Promise<void>)|undefined,onAuthorization:(()=>Promise<void>)|undefined;
 const sent:Parameters<SendProvider['send']>[0][]=[];
 let actions:NativeReplyActions;
 const e:Env={...env,OWNER_SUB:'owner',INSTALLATION_EPOCH:'e1',CONNECTION_GENERATION:'g1',CONNECTED_PHONE:'device',ZAPI_INSTANCE_ID:'instance',MAINTENANCE:'false',PUBLIC_ORIGIN:'http://localhost:8787',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ASSISTANT_INSTALLATION_ID:scope.installationId,ASSISTANT_GENERATION:scope.generation,ASSISTANT_APPROVED_SEND_SECRET:secret,ASSISTANT_NATIVE_AUTONOMOUS_ENABLED:enabled?'true':'false',
 ASSISTANT_OWNER:{nativeReplyAuthorization:async(_scope:unknown,input:unknown)=>{const proof=await actions.authorize(input);await onAuthorization?.();return proof;},approvedSendAuthorization:async()=>{throw Error('legacy_human_authority_must_not_be_used');}} as unknown as Env['ASSISTANT_OWNER']};
 const address=group?'120363999999999999-group':'5585999999999';
 const {items}=await upsertDirectoryPage(e,{epoch:'e1',generation:'g1'},{items:[{externalId:address,kind:group?'group':'individual',name:'Nome <host>'}],complete:true});
 const chatId=items[0]!.id;identity.principalOrChatId=chatId;
 async function incoming(id='source-incoming',fromMe=false){return ingestEvent(e,{epoch:'e1',generation:'g1'},{chatExternalId:address,chatKind:group?'group':'individual',externalId:id,authorExternalId:group?'5585777777777':undefined,authorName:'Pessoa',fromMe,kind:'text',text:'Pergunta original',timestamp:Date.now()});}
 await incoming('source-incoming-'+scope.installationId);
 const observation=await conversationActivity(e,chatId);if(observation.state!=='available')throw Error('fixture_activity');
 const activity:ApprovedSendActivityFence={triggerSequence:observation.latestIncomingOriginalSequence,watermark:observation.watermark,relationshipRevision:observation.relationshipRevision,relationshipProof:observation.relationshipProof,members:observation.members.map(m=>m.chatId)};
 const origin=new OriginGuard(env.DB,()=>scope,{readSnapshot:async()=>{throw Error('no_exposures');}},secret);
 const retention=new NativeConversationRetention(env.DB,()=>scope,origin);
 let delivery:DeliveredMessage|undefined;
 const runtime=new ConversationRuntime(env.DB,{retention,authority:async()=>authority,authorizeEvent:async()=>{},open:()=>({dispatch:async q=>{if(typeof q==='string')throw Error('fixture_host_request');delivery=q.message as DeliveredMessage;return {submissionId:crypto.randomUUID(),uid:'native',acceptedAt:new Date().toISOString()};},read:async()=>{throw Error('unused');}}),knowledge:()=>{throw Error('unused');}});
 async function admit(eventId='event-1',kind:'incoming'|'owner_manual'='incoming'){
  await runtime.deliverConversation(verifiedConversationEvent({identity,eventId,revision:1,kind,author:{kind:kind==='incoming'?'person':'owner',id:'actual-person'},occurredAt:Date.now(),body:'Pergunta original'}));
  return runtime.resolveTask(identity,delivery!);
 }
 await env.DB.prepare('INSERT INTO native_reply_test_grants(id,active,revision) VALUES(?,1,1)').bind(scope.installationId).run();
 const provider:SendProvider={status:async()=>{await onStatus?.();return {connected:true,phone:'device'};},send:async envelope=>{attempts++;sent.push(envelope);if(loseAck)throw Error('lost_ack');return {messageId:'provider-one',zaapId:'zaap-one'};}};
 actions=new NativeReplyActions({db:env.DB,scope,runtime,retention,secret,autonomousEnabled:()=>allowAutonomous,
  authorityGuard:async task=>({sql:'EXISTS(SELECT 1 FROM native_reply_test_grants WHERE id=? AND active=1 AND revision=?)',values:[scope.installationId,task.authority.policyRevision]}),
  activity:async()=>activity,
  source:{prepare:q=>prepareApprovedSend(e,q),status:q=>approvedSendStatus(e,q),executeNative:q=>executeNativeReply(e,q,provider)}});
 const task=await admit();
 const propose=()=>actions.propose(task,{decision:'respond',text:'Resposta exata\ncom todas as linhas. ',summary:'Resumo útil'});
 async function reviewed(){const result=await propose();if(!result.intent)throw Error('missing_intent');return actions.approve(result.intent.id,'actual-human-click',{sql:'EXISTS(SELECT 1 FROM native_reply_test_grants WHERE id=? AND active=1)',values:[scope.installationId]});}
 return {actions,task,scope,e,chatId,address,provider,sent,propose,reviewed,admit,incoming,runtime,retention,activity,
  attempts:()=>attempts,setLostAck:()=>{loseAck=true;},setStatusHook:(hook:()=>Promise<void>)=>{onStatus=hook;},setAuthorizationHook:(hook:()=>Promise<void>)=>{onAuthorization=hook;},
  disable:()=>{allowAutonomous=false;e.ASSISTANT_NATIVE_AUTONOMOUS_ENABLED='false';},
  revise:()=>{authority={...authority,policyRevision:2};},revoke:()=>env.DB.prepare('UPDATE native_reply_test_grants SET active=0 WHERE id=?').bind(scope.installationId).run()};
}
describe('native reply authority with real Workers D1 and sole Source send boundary',()=>{
 it('preserves the same decision/text in all three modes; only authority differs and autonomous default is closed',async()=>{
  for(const mode of ['shadow','approval','autonomous'] as const){
   const f=await fixture(mode),result=await f.propose();expect(result.externalAttempt).toBe(false);
   expect(result.authority?.kind).toBe(mode==='shadow'?'shadow':mode==='approval'?'human_approval':'blocked');
   expect(await env.DB.prepare('SELECT text FROM assistant_native_reply_actions WHERE intent_id=?').bind(result.intent!.id).first<string>('text')).toBe('Resposta exata\ncom todas as linhas. ');
   expect(f.attempts()).toBe(0);
  }
 });
 it('shadow never prepares a Source action and silence generates no intent',async()=>{
  const f=await fixture('shadow'),result=await f.propose();expect((await f.actions.status(result.intent!.id)).externalAttempt).toBe(false);
  expect(await env.DB.prepare('SELECT action_id FROM assistant_native_reply_actions WHERE intent_id=?').bind(result.intent!.id).first('action_id')).toBeNull();
  expect(await f.actions.propose(f.task,{decision:'silence',summary:'Sem ação útil'})).toEqual({state:'silent',externalAttempt:false});
 });
 it('rejects model-selected destination/mode and freezes one exact body per intent',async()=>{
  const f=await fixture();await f.propose();
  await expect(f.actions.propose(f.task,{decision:'respond',text:'Outro texto'})).rejects.toThrow('conversation_intent_conflict');
  await expect(f.actions.propose(f.task,{decision:'respond',text:'Texto',mode:'autonomous',destination:'author'})).rejects.toThrow();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM approved_sends WHERE installation_id=?').bind(f.scope.installationId).first<number>('n')).toBe(1);
 });
 it('requires a real stored approval and sends once on concurrent/repeated execution',async()=>{
  const f=await fixture(),p=await f.propose(),fake={kind:'human_approval' as const,intentId:p.intent!.id,approvalId:'invented'};
  await expect(f.actions.execute(fake.intentId,fake)).rejects.toThrow('native_reply_denied');expect(f.attempts()).toBe(0);
  const authority=await f.reviewed();const results=await Promise.all([f.actions.execute(authority.intentId,authority),f.actions.execute(authority.intentId,authority)]);
  expect(results.map(r=>r.state)).toContain('accepted');expect(f.attempts()).toBe(1);
  const audit=await env.DB.prepare('SELECT approval_channel,approved_at FROM actions WHERE id=?').bind(p.prepared!.actionId).first<{approval_channel:string;approved_at:number|null}>();
  expect(audit?.approval_channel).toBe('native_telegram_owner');expect(audit?.approved_at).toBeTypeOf('number');
  expect((await f.propose()).state).toBe('accepted');
  await expect(f.actions.discard(authority.intentId,{sql:'1',values:[]})).rejects.toThrow('native_reply_superseded');
 });
 it('autonomous policy has distinct authority/audit with no fake approval id or human confirmation',async()=>{
  const f=await fixture('autonomous',true),result=await f.propose(),authority=result.authority as NativeReplyExecutionAuthority;
  expect(authority).toEqual({kind:'autonomous_policy',intentId:result.intent!.id,policyRevision:1,grantRef:f.scope.installationId});
  expect((await f.actions.execute(authority.intentId,authority)).state).toBe('accepted');expect(f.attempts()).toBe(1);
  expect(await env.DB.prepare('SELECT approval_channel,approved_at FROM actions WHERE id=?').bind(result.prepared!.actionId).first()).toEqual({approval_channel:'native_autonomous_policy',approved_at:null});
 });
 it('the Source autonomous gate independently denies even a forged/available owner proof',async()=>{
  const f=await fixture('autonomous',true),result=await f.propose(),authority=result.authority as NativeReplyExecutionAuthority;f.disable();
  await expect(executeNativeReply(f.e,{secret,scope:f.scope,actionId:result.prepared!.actionId,authority},f.provider)).rejects.toThrow('native_autonomous_disabled');expect(f.attempts()).toBe(0);
 });
 it('reconciles an autonomous uncertain Source receipt even when its gate is subsequently disabled',async()=>{
  const f=await fixture('autonomous',true),result=await f.propose(),authority=result.authority as NativeReplyExecutionAuthority;f.setLostAck();
  expect((await f.actions.execute(authority.intentId,authority)).state).toBe('uncertain');f.disable();
  expect((await executeNativeReply(f.e,{secret,scope:f.scope,actionId:result.prepared!.actionId,authority},f.provider)).status).toBe('uncertain');expect(f.attempts()).toBe(1);
 });
 it('discard, revoked grant, changed policy, native new event and tombstoned context deny pending effects',async()=>{
  for(const change of ['discard','grant','policy','incoming','tombstone'] as const){
   const f=await fixture(),authority=await f.reviewed();
   if(change==='discard')await f.actions.discard(authority.intentId,{sql:'1',values:[]});
   if(change==='grant')await f.revoke();if(change==='policy')f.revise();
   if(change==='incoming')await f.admit('new-native-event');if(change==='tombstone')await f.retention.purge(f.task.identity);
   await expect(f.actions.execute(authority.intentId,authority)).rejects.toThrow('native_reply_denied');expect(f.attempts()).toBe(0);
  }
 });
 it('checks source new message, manual owner response and changed directory target at the final claim',async()=>{
  for(const change of ['incoming','manual','target'] as const){
   const f=await fixture(),authority=await f.reviewed();
   f.setAuthorizationHook(async()=>{
    if(change==='target')await env.DB.prepare("UPDATE chats SET external_id='wrong-person' WHERE id=?").bind(f.chatId).run();
    else await f.incoming('later-'+change,change==='manual');
   });
   const result=await f.actions.execute(authority.intentId,authority);expect(result.state).toBe('proposed');expect(result.externalAttempt).toBe(false);expect(f.attempts()).toBe(0);
  }
 });
 it('rechecks native authority after provider status and rejects a changed request hash',async()=>{
  const f=await fixture(),authority=await f.reviewed(),p=await f.propose();f.setStatusHook(async()=>{await f.revoke();});
  await expect(f.actions.execute(authority.intentId,authority)).rejects.toThrow('native_reply_denied');expect(f.attempts()).toBe(0);
  expect(await f.actions.authorize({secret,actionId:p.prepared!.actionId,hash:'0'.repeat(64),authority})).toEqual({authorized:false});
 });
 it('rejects an altered retained body/hash instead of reinterpreting a human click',async()=>{
  const f=await fixture(),authority=await f.reviewed();
  await env.DB.prepare('UPDATE assistant_native_reply_actions SET text=? WHERE intent_id=?').bind('Alterado após revisão',authority.intentId).run();
  await expect(f.actions.execute(authority.intentId,authority)).rejects.toThrow('native_reply_denied');expect(f.attempts()).toBe(0);
 });
 it('sends to the host group address rather than its author',async()=>{
  const f=await fixture('approval',false,true),authority=await f.reviewed();await f.actions.execute(authority.intentId,authority);
  expect(f.sent).toHaveLength(1);expect(f.sent[0]).toMatchObject({destination:f.address,text:'Resposta exata\ncom todas as linhas. '});expect(f.address).not.toBe('5585777777777');
 });
 it('uncertainty reconciles the same Source attempt after revocation without retrying',async()=>{
  const f=await fixture(),authority=await f.reviewed();f.setLostAck();
  expect((await f.actions.execute(authority.intentId,authority)).state).toBe('uncertain');await f.revoke();
  expect((await f.actions.execute(authority.intentId,authority)).state).toBe('uncertain');expect((await f.actions.status(authority.intentId)).state).toBe('uncertain');expect(f.attempts()).toBe(1);
 });
});
