import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {env} from 'cloudflare:test';
import type {DeliveredMessage} from '@flue/runtime';
import {NativeApplicationHost} from '../assistant/agent-runtime/native-host';
import {nativeAuthority,nativeGlobalBudgetGuard,nativeMode} from '../assistant/agent-runtime/native-policy';
import {readCaptureSnapshot} from '../src/assistant-source-reader';
import {readNativeCaptureInput} from '../src/native-input-reader';
import {readConversationActivity} from '../src/conversation-activity';
import {upsertDirectoryPage} from '../src/directory';
import {ingestEvent} from '../src/capture';
import type {Env} from '../src/env';
import type {AssistantEnv} from '../assistant/env';
import {receiveCapture,bridgeHash} from '../assistant/ingress';
import {SourceController} from '../assistant/sources';
import {InferenceBudget} from '../assistant/budget';
const transport=vi.hoisted(()=>({dispatch:vi.fn(),abort:vi.fn(),quiesce:vi.fn(),destroy:vi.fn(),deliveries:new Map<string,DeliveredMessage>()}));
vi.mock('../assistant/agent-runtime/native-transport',()=>({
 openNativeConversation:(sessionId:string)=>({dispatch:async(q:{idempotencyKey:string;message:DeliveredMessage})=>{transport.dispatch(sessionId,q);transport.deliveries.set(q.idempotencyKey,q.message);return {submissionId:q.idempotencyKey,uid:sessionId,acceptedAt:new Date().toISOString()};},read:async()=>({})}),
 nativeContextDestroyPort:()=>({abort:transport.abort,quiesce:transport.quiesce,destroy:transport.destroy}),
}));
const secret='native-host-synthetic-secret-more-than32',bot='native_host_bot';
beforeEach(async()=>{vi.clearAllMocks();transport.deliveries.clear();await env.DB.exec('DELETE FROM conversation_relationships; DELETE FROM owner_message_originals; DELETE FROM approved_sends; DELETE FROM actions; DELETE FROM assistant_capture_changes; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM chats;');});
afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const scope={installationId:crypto.randomUUID(),generation:'own-g1',sourceEpoch:'e1',sourceGeneration:'g1'};
 const source:Env={...env,OWNER_SUB:'owner',INSTALLATION_EPOCH:'e1',CONNECTION_GENERATION:'g1',CONNECTED_PHONE:'device',ZAPI_INSTANCE_ID:'instance',MAINTENANCE:'false',PUBLIC_ORIGIN:'http://localhost:8787',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ASSISTANT_READER_SECRET:secret};
 const own:AssistantEnv={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:'e1',BRIDGE_SOURCE_GENERATION:'g1',BRIDGE_SECRET:secret,
  NATIVE_CONVERSATIONS_MODE:'approval',NATIVE_CAPTURE_START_AFTER_SEQUENCE:'0',NATIVE_BUDGET_EXTERNAL_CARRY_MICROUSD:'40000',NATIVE_CONTEXT_ADMIN_SECRET:secret,OPENAI_API_KEY:'synthetic-api-key',
  TELEGRAM_BOT_INSTANCE:bot,TELEGRAM_BOT_TOKEN:'123456789:syntheticabcdefghijklmnopqrstuvwxyz',TELEGRAM_WEBHOOK_SECRET:'synthetic_webhook_secret_more_than32chars',
  CAPTURE_READER:{readSnapshot:q=>readCaptureSnapshot(source,q),readNativeInput:q=>readNativeCaptureInput(source,q),readConversationActivity:q=>readConversationActivity(source,q)}};
 await env.DB.prepare(`INSERT INTO assistant_telegram_links(installation_id,generation,bot_instance,source_epoch,source_generation,revision,state,user_id,chat_id,activation_cut) VALUES(?,?,?,?,?,1,'active','101','101',0)`)
  .bind(scope.installationId,scope.generation,bot,'e1','g1').run();
 const append=async(text:string,address='5585999999999',group=false,fromMe=false)=>{
  const {items}=await upsertDirectoryPage(source,{epoch:'e1',generation:'g1'},{items:[{externalId:address,kind:group?'group':'individual',name:'Pessoa sintética'}],complete:true});const chatId=items[0].id;
  const before=await env.DB.prepare('SELECT COALESCE(MAX(sequence),0) n FROM assistant_capture_changes').first<number>('n')??0;
  await ingestEvent(source,{epoch:'e1',generation:'g1'},{chatExternalId:address,chatKind:group?'group':'individual',externalId:crypto.randomUUID(),authorExternalId:group?'5585777777777':undefined,authorName:'Participante real',fromMe,kind:'text',text,timestamp:Date.now()});
  const row=await env.DB.prepare(`SELECT sequence,source_id,source_kind,operation FROM assistant_capture_changes WHERE sequence>? AND source_kind='message' ORDER BY sequence DESC LIMIT 1`).bind(before).first<{sequence:number;source_id:string;source_kind:'message';operation:'upsert'}>();
  if(!row)throw Error('fixture_capture');
  const stream=await env.DB.prepare(`SELECT read_sequence FROM assistant_capture_streams WHERE installation_id=? AND generation=? AND source_epoch='e1' AND source_generation='g1'`).bind(scope.installationId,scope.generation).first<number>('read_sequence')??0;
  const metadata={protocol:1,installationId:scope.installationId,generation:scope.generation,sourceEpoch:'e1',sourceGeneration:'g1',sequence:row.sequence,previousSequence:stream,chatId,sourceId:row.source_id,sourceKind:'message',operation:'upsert',recordedAt:Date.now()};
  // Bridge receipt staged off; test invokes the real native factory explicitly.
  const response=await receiveCapture(new Request('https://own.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify(metadata)}),{...own,NATIVE_CONVERSATIONS_MODE:'off'});expect(response.status).toBe(200);
  return {sequence:row.sequence,chatId,sourceId:row.source_id,text};
 };
 const ownerUpdate=async(updateId:number,text:string,threadId:number)=>{
  await env.DB.prepare(`INSERT INTO assistant_telegram_updates(installation_id,generation,bot_instance,update_id,payload_hash,token,source_epoch,source_generation,link_revision,user_id,chat_id,message_id,message_date,thread_id,text,outcome,state,received_at)
   VALUES(?,?,?,?,?,?,'e1','g1',1,'101','101',?,?,?,?,'pending','pending',?)`).bind(scope.installationId,scope.generation,bot,updateId,await bridgeHash([updateId,text,threadId]),crypto.randomUUID(),updateId+100,Math.floor(Date.now()/1000),threadId,text,Date.now()).run();
 };
 return {scope,source,own,append,ownerUpdate,host:()=>new NativeApplicationHost(own)};
}
async function latestTask(host:NativeApplicationHost,taskRef:string){const delivery=transport.deliveries.get(taskRef);if(!delivery)throw Error('fixture_delivery');
 const row=await env.DB.prepare('SELECT identity_json FROM assistant_native_conversations WHERE id=(SELECT conversation_id FROM assistant_native_conversation_events WHERE task_ref=?)').bind(taskRef).first<{identity_json:string}>();return host.runtime.resolveTask(JSON.parse(row!.identity_json),delivery);}
describe('native application composition on real D1 and Source reads',()=>{
 it('is off by default and cannot grant autonomous mode through a transcript or a lone mode flag',()=>{
  expect(nativeMode({})).toBe('off');expect(()=>nativeMode({NATIVE_CONVERSATIONS_MODE:'autonomous'})).toThrow('native_autonomous_disabled');
 });
 it('pins canonical incoming body/real participant/original sequence; one chat retains its native address',async()=>{
  const f=await fixture(),first=await f.append('Primeira mensagem'),second=await f.append('Segunda mensagem'),host=f.host();
  const a=await host.receiveCapture(first.sequence),b=await host.receiveCapture(second.sequence);expect(a.state,JSON.stringify(await env.DB.prepare('SELECT state,last_gap FROM assistant_native_capture_intake WHERE installation_id=?').bind(f.scope.installationId).all())).toBe('admitted');expect(b.state).toBe('admitted');
  const taskA=await latestTask(host,a.taskRef!),taskB=await latestTask(host,b.taskRef!);expect(taskA.sessionId).toBe(taskB.sessionId);
  const event=await env.DB.prepare('SELECT event_json FROM assistant_native_conversation_events WHERE task_ref=?').bind(a.taskRef!).first<string>('event_json');expect(JSON.parse(event!).body).toBe(first.text);expect(JSON.parse(event!).author.kind).toBe('person');
  expect(await env.DB.prepare('SELECT original_sequence FROM assistant_native_host_events WHERE event_id=?').bind(JSON.parse(event!).eventId).first('original_sequence')).toBe(first.sequence);
  await expect(host.activity(taskA)).rejects.toThrow('native_activity_superseded');
  expect((await host.activity(taskB)).triggerSequence).toBe(second.sequence);
  const other=await f.append('Outra conversa','5585888888888'),c=await host.receiveCapture(other.sequence);expect((await latestTask(host,c.taskRef!)).sessionId).not.toBe(taskA.sessionId);
 });
 it('deduplicates the already admitted Source sequence and preserves exact human manual authorship',async()=>{
  const f=await fixture(),incoming=await f.append('Eu já respondi','5585999999999',false,true),host=f.host();
  const a=await host.receiveCapture(incoming.sequence),b=await host.receiveCapture(incoming.sequence);expect(a).toEqual(b);expect(transport.dispatch).toHaveBeenCalledTimes(1);
  const task=await latestTask(host,a.taskRef!);expect(task.cohort[0]).toMatchObject({kind:'owner_manual',author:{kind:'owner',id:'101'}});
 });
 it('does not analyze a default group, honors explicit group permission, and preserves group participant identity',async()=>{
  const f=await fixture(),group=await f.append('Mensagem do grupo','120363999999999999-group',true),host=f.host();expect((await host.receiveCapture(group.sequence)).state).toBe('excluded');expect(transport.dispatch).not.toHaveBeenCalled();
  await env.DB.prepare(`INSERT INTO assistant_conversation_policies VALUES(?,?,?,'group',0,'respond',1)`).bind(f.scope.installationId,f.scope.generation,group.chatId).run();
  const later=await f.append('Nova pergunta no grupo','120363999999999999-group',true),result=await host.receiveCapture(later.sequence),task=await latestTask(host,result.taskRef!);
  expect(task.returnChannel.id).toBe(group.chatId);expect(task.cohort[0].author.id).not.toBe(group.chatId);expect(task.authority.mode).toBe('approval');
 });
 it('permits observe-group analysis with shadow-only effects and denies excluded private sources',async()=>{
  const f=await fixture(),group=await f.append('Observação','120363999999999999-group',true);
  await env.DB.prepare(`INSERT INTO assistant_conversation_policies VALUES(?,?,?,'group',0,'observe',1)`).bind(f.scope.installationId,f.scope.generation,group.chatId).run();
  const host=f.host(),result=await host.receiveCapture(group.sequence);expect((await latestTask(host,result.taskRef!)).authority.mode).toBe('shadow');
  const privateMessage=await f.append('Não analisar');await env.DB.prepare(`INSERT INTO assistant_conversation_policies VALUES(?,?,?,'private',1,'ignore',1)`).bind(f.scope.installationId,f.scope.generation,privateMessage.chatId).run();
  expect((await host.receiveCapture(privateMessage.sequence)).state).toBe('excluded');
 });
 it('requires an explicit activation cut and a preconfigured budget account/carry',async()=>{
  const f=await fixture(),message=await f.append('Nova mensagem');delete f.own.NATIVE_CAPTURE_START_AFTER_SEQUENCE;await expect(f.host().receiveCapture(message.sequence)).rejects.toThrow('native_capture_cut_unconfigured');
  f.own.NATIVE_CAPTURE_START_AFTER_SEQUENCE=String(message.sequence);expect((await f.host().receiveCapture(message.sequence)).state).toBe('before_activation');
  expect(()=>nativeGlobalBudgetGuard({})).toThrow('native_budget_carry_unconfigured');
  expect(nativeGlobalBudgetGuard({NATIVE_BUDGET_EXTERNAL_CARRY_MICROUSD:'40000'}).values).toEqual([40000,10000000]);
 });
 it('applies historical carry to reservations in every local generation/period, retaining uncertainty',async()=>{
  const f=await fixture();const old=new InferenceBudget(env.DB,{installationId:'synthetic-old-installation',generation:'old-g',period:'2026-01-01'});await old.configure(10000000);
  await old.reserve('uncertain-prior','a'.repeat(64),9900000);await old.uncertain('uncertain-prior');
  const guard=nativeGlobalBudgetGuard({...f.own,NATIVE_BUDGET_EXTERNAL_CARRY_MICROUSD:'133000'});
  expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
 });
 it('counts a blocked historical account without inheriting its unrelated block into the current account',async()=>{
  const f=await fixture(),old=new InferenceBudget(env.DB,{installationId:'old-account',generation:'old-g',period:'2026-01-01'});
  await old.configure(1000);await old.reserve('old-charge','a'.repeat(64),500);await old.settle('old-charge','a'.repeat(64),600);
  await env.DB.prepare(`UPDATE assistant_budget_accounts SET blocked=1 WHERE installation_id='old-account'`).run();
  const guard=nativeGlobalBudgetGuard(f.own);expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).not.toBeNull();
  const current=new InferenceBudget(env.DB,{installationId:f.scope.installationId,generation:f.scope.generation,period:'2026-10-29'});await current.configure(1000000);
  expect(await current.reserve('new-charge','b'.repeat(64),1000)).toMatchObject({state:'reserved'});
  await env.DB.prepare(`UPDATE assistant_budget_accounts SET blocked=1 WHERE installation_id=? AND generation=?`).bind(f.scope.installationId,f.scope.generation).run();
  await expect(current.reserve('blocked-current','c'.repeat(64),1000)).rejects.toThrow('budget_blocked');
 });
 it('keeps a single owner session across Telegram topics and persists exact attributed owner reports',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Contexto no tópico A',40);await f.ownerUpdate(2,'Pergunta no tópico B',43);const host=f.host(),a=await host.receiveTelegram(1),b=await host.receiveTelegram(2),taskA=await latestTask(host,a.taskRef),taskB=await latestTask(host,b.taskRef);
  expect(taskA.sessionId).toBe(taskB.sessionId);expect(taskA.returnChannel.threadId).toBe('40');expect(taskB.returnChannel.threadId).toBe('43');expect(taskB.cohort[0].author).toEqual({kind:'owner',id:'101'});
  const source=await env.DB.prepare('SELECT origin,original_text FROM assistant_sources s JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation AND v.source_id=s.id AND v.version=s.current_version WHERE s.id=?').bind(taskB.cohort[0].sourceRef!.id).first();expect(source).toEqual({origin:'owner_report',original_text:'Pergunta no tópico B'});
 });
 it('sends an owner answer once to the authenticated last topic with safe legible formatting',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pergunta',43);const host=f.host(),receipt=await host.receiveTelegram(1),task=await latestTask(host,receipt.taskRef);
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const body=JSON.parse(String(init?.body));expect(body).toMatchObject({chat_id:'101',message_thread_id:43,parse_mode:'HTML'});expect(body.text).toBe('✅ <b>Pronto</b>\n\nTexto &lt;seguro&gt;.');return Response.json({ok:true,result:{message_id:99,message_thread_id:43,chat:{id:101,type:'private'}}});});
  expect(await host.respondOwner(task,'✅ **Pronto**\n\nTexto <seguro>.')).toMatchObject({state:'sent',messageId:99});
  expect(await host.respondOwner(task,'✅ **Pronto**\n\nTexto <seguro>.')).toMatchObject({state:'sent',messageId:99});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps an uncertain Telegram effect and never retries it; source withdrawal blocks the old native context',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pergunta',43);const host=f.host(),receipt=await host.receiveTelegram(1),task=await latestTask(host,receipt.taskRef);
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('synthetic_timeout'));expect(await host.respondOwner(task,'Resposta')).toEqual({state:'uncertain'});expect(await host.respondOwner(task,'Resposta')).toMatchObject({state:'uncertain'});expect(fetch).toHaveBeenCalledTimes(1);
  const ref=task.cohort[0].sourceRef!;await new SourceController(env.DB,f.scope,{kind:'owner'}).withdraw(ref.id,ref.revision);
  await expect(host.runtime.assertTaskCurrent(task)).rejects.toThrow('conversation_context_withdrawn');expect(transport.destroy).toHaveBeenCalledWith(task.sessionId);
 });
 it('checks host scope and current group policy again rather than accepting initialData as authority',async()=>{
  const f=await fixture(),message=await f.append('Olá'),host=f.host(),receipt=await host.receiveCapture(message.sequence),task=await latestTask(host,receipt.taskRef!);
  await expect(nativeAuthority(f.own,{...task.identity,principalOrChatId:'unobserved'})).rejects.toThrow('native_conversation_denied');
  f.own.BRIDGE_SOURCE_GENERATION='changed';expect(()=>host.currentScope()).toThrow('native_configuration_changed');
 });
});
