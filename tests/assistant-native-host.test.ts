import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {env} from 'cloudflare:test';
import type {DeliveredMessage} from '@flue/runtime';
import {NativeApplicationHost} from '../assistant/agent-runtime/native-host';
import {nativeAuthority,nativeGlobalBudgetGuard,nativeMode,nativeCuratorDispatchRequest} from '../assistant/agent-runtime/native-policy';
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
import {TelegramLink} from '../assistant/telegram-auth';
import {RetentionPurge} from '../assistant/retention-purge';
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
 const activate=async(activatedAt:number,extra:Record<string,unknown>={})=>{
  const cut={version:1,sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,botInstance:bot,linkRevision:1,userId:'101',chatId:'101',activatedAt,...extra};
  await env.DB.prepare('INSERT INTO assistant_native_host_state(installation_id,generation,telegram_activation_json) VALUES(?,?,?) ON CONFLICT(installation_id,generation) DO UPDATE SET telegram_activation_json=excluded.telegram_activation_json').bind(scope.installationId,scope.generation,JSON.stringify(cut)).run();
 };
 await activate(1);
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
 const ownerUpdate=async(updateId:number,text:string,threadId:number,replyTo?:number)=>{
  const raw={update_id:updateId,message:{message_id:updateId+100,date:Math.floor(Date.now()/1000),from:{id:101,is_bot:false},chat:{id:101,type:'private'},text,message_thread_id:threadId,...(replyTo?{reply_to_message:{message_id:replyTo,chat:{id:101,type:'private'},message_thread_id:threadId}}:{})}};
  expect(await new TelegramLink(env.DB,scope,bot,own.TELEGRAM_WEBHOOK_SECRET!).receive(raw)).toBe('pending');return raw;
 };
 return {scope,source,own,append,ownerUpdate,activate,host:()=>new NativeApplicationHost(own)};
}
async function latestTask(host:NativeApplicationHost,taskRef:string){const delivery=transport.deliveries.get(taskRef);if(!delivery)throw Error('fixture_delivery');
 const row=await env.DB.prepare('SELECT identity_json FROM assistant_native_conversations WHERE id=(SELECT conversation_id FROM assistant_native_conversation_events WHERE task_ref=?)').bind(taskRef).first<{identity_json:string}>();return host.runtime.resolveTask(JSON.parse(row!.identity_json),delivery);}
describe('native application composition on real D1 and Source reads',()=>{
 it('native owner input replay stays retired after purge via cron and duplicate webhook, while a fresh update remains live',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pedido sintético original',43);const host=f.host(),first=await host.receiveTelegram(1),task=await latestTask(host,first.taskRef);
  await host.retention.purge(task.identity);const calls=transport.dispatch.mock.calls.length;
  await host.tick();expect(transport.dispatch).toHaveBeenCalledTimes(calls);
  expect(await host.receiveTelegram(1)).toMatchObject({state:'retired',sessionId:task.sessionId,taskRef:first.taskRef});expect(transport.dispatch).toHaveBeenCalledTimes(calls);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_conversations WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
  await f.ownerUpdate(2,'Pedido novo legítimo',42);const next=await host.receiveTelegram(2);expect(next.state).toBe('admitted');expect(next.sessionId).not.toBe(task.sessionId);
 });
 it('native owner input replay reuses a host-only admission after a crash before the native event',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pedido sintético com ACK pendente',43);const host=f.host(),dispatch=vi.spyOn(host.runtime,'deliverConversation');
  dispatch.mockRejectedValueOnce(Error('synthetic_before_native_admission'));
  await expect(host.receiveTelegram(1)).rejects.toThrow('synthetic_before_native_admission');
  const original=await env.DB.prepare('SELECT conversation_id FROM assistant_native_host_events WHERE installation_id=?').bind(f.scope.installationId).first<{conversation_id:string}>();expect(original).not.toBeNull();
  const result=await host.receiveTelegram(1);expect(result).toMatchObject({state:'admitted',sessionId:original!.conversation_id});expect(transport.dispatch).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_conversations WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
 });
 it('native owner input replay preserves the same immutable session and native key after an unknown admission ACK',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pedido sintético com recibo incerto',43);const host=f.host();
  transport.dispatch.mockImplementationOnce(()=>{throw Error('synthetic_lost_ack');});const first=await host.receiveTelegram(1);expect(first.state).toBe('uncertain');
  const replay=await host.receiveTelegram(1);expect(replay.state).toBe('admitted');expect(replay.sessionId).toBe(first.sessionId);expect(replay.taskRef).toBe(first.taskRef);
  expect(transport.dispatch.mock.calls[0]).toEqual(transport.dispatch.mock.calls[1]);
  await expect(env.DB.prepare('UPDATE assistant_telegram_updates SET native_identity_json=? WHERE installation_id=? AND update_id=1').bind('{}',f.scope.installationId).run()).rejects.toThrow('native_telegram_input_binding_immutable');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_conversations WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
 });
 it('native owner input replay cannot allocate a losing epoch after another caller admitted and purged the same update',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pedido sintético concorrente',43);const a=f.host(),b=f.host();
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),blocked=new Promise<void>(resolve=>entered=resolve);
  const current=a.retention.currentIdentity.bind(a.retention);let first=true;
  vi.spyOn(a.retention,'currentIdentity').mockImplementation(async(...args)=>{const value=await current(...args);if(first){first=false;entered();await gate;}return value;});
  const losing=a.receiveTelegram(1);await blocked;const winner=await b.receiveTelegram(1),task=await latestTask(b,winner.taskRef);await b.retention.purge(task.identity);release();
  expect(await losing).toMatchObject({state:'retired',sessionId:task.sessionId});expect(transport.dispatch).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_conversations WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
 });
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
 it('deduplicates Source input and keeps unattributed own-device output distinct from human authority',async()=>{
  const f=await fixture(),incoming=await f.append('Eu já respondi','5585999999999',false,true),host=f.host();
  const a=await host.receiveCapture(incoming.sequence),b=await host.receiveCapture(incoming.sequence);expect(a).toEqual(b);expect(transport.dispatch).toHaveBeenCalledTimes(1);
  const task=await latestTask(host,a.taskRef!);expect(task.cohort[0]).toMatchObject({kind:'action_result',author:{kind:'system',id:'own-device-unattributed'}});
 });
 it.each([['conversation_exposure_proof','conversation_exposure_proof'],['private diagnostic that must never be persisted','native_admission_unavailable']])('records a bounded admission gap instead of leaving a failed capture pending: %s',async(message,gap)=>{
  const f=await fixture(),input=await f.append('Mensagem sintética para diagnóstico'),host=f.host();
  vi.spyOn(host.runtime,'deliverConversation').mockRejectedValueOnce(Error(message));
  await expect(host.receiveCapture(input.sequence)).rejects.toThrow(message);
  expect(await env.DB.prepare('SELECT state,last_gap FROM assistant_native_capture_intake WHERE installation_id=? AND sequence=?').bind(f.scope.installationId,input.sequence).first()).toEqual({state:'unavailable',last_gap:gap});
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
 it('never turns a legacy pending owner request into a new native command, including a delayed retry',async()=>{
  const f=await fixture(),cut=Math.floor(Date.now()/1000)-10;
  await f.ownerUpdate(1,'Pedido antigo ainda pendente',43);
  await env.DB.prepare('UPDATE assistant_telegram_updates SET message_date=?,received_at=? WHERE installation_id=? AND update_id=1').bind(cut-60,(cut-60)*1000,f.scope.installationId).run();
  await f.activate(cut*1000);
  await expect(f.host().receiveTelegram(1)).rejects.toThrow('native_owner_input_denied');
  expect(transport.dispatch).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_sources WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(0);
  // A retry received now does not make its old message date a new command.
  await env.DB.prepare('UPDATE assistant_telegram_updates SET received_at=? WHERE installation_id=? AND update_id=1').bind(Date.now(),f.scope.installationId).run();
  await expect(f.host().receiveTelegram(1)).rejects.toThrow('native_owner_input_denied');
  await f.ownerUpdate(2,'Pedido realmente novo',43);
  expect(await f.host().receiveTelegram(2)).toMatchObject({state:'admitted'});
 });
 it('requires a Telegram activation cut and excludes old pending rows before cron pagination',async()=>{
  const f=await fixture(),cut=Math.floor(Date.now()/1000)-10;
  await env.DB.prepare('UPDATE assistant_native_host_state SET telegram_activation_json=NULL WHERE installation_id=?').bind(f.scope.installationId).run();
  await f.ownerUpdate(1,'Pedido antigo',43);
  await expect(f.host().receiveTelegram(1)).rejects.toThrow('native_telegram_cut_unconfigured');
  await f.activate(cut*1000);
  for(let id=2;id<=6;id++)await f.ownerUpdate(id,'Outra pendência legada',43);
  await env.DB.prepare('UPDATE assistant_telegram_updates SET message_date=?,received_at=? WHERE installation_id=?').bind(cut-60,(cut-60)*1000,f.scope.installationId).run();
  await f.ownerUpdate(7,'Novo pedido depois do corte',43);
  await f.host().tick();
  expect(transport.dispatch).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare('SELECT event_id FROM assistant_native_conversation_events WHERE conversation_id IN (SELECT id FROM assistant_native_conversations WHERE installation_id=?)').bind(f.scope.installationId).first('event_id')).toBe('telegram:'+bot+':7');
 });
 it('binds the cut to the exact owner link and revokes an earlier admitted authority when it changes',async()=>{
  const f=await fixture();await f.ownerUpdate(91,'Pedido atual',43);const host=f.host(),receipt=await host.receiveTelegram(91),task=await latestTask(host,receipt.taskRef);
  await f.activate(Date.now()-5000,{linkRevision:2});
  await expect(f.host().receiveTelegram(91)).rejects.toThrow('native_telegram_cut_denied');
  await f.activate(Date.now()-5000);
  await expect(host.runtime.assertTaskCurrent(task)).rejects.toThrow('native_authority_denied');
  await host.retention.purge(task.identity);
  // Smaller update IDs remain valid when Telegram restarts their sequence.
  await f.ownerUpdate(3,'Pedido posterior com ID menor',43);
  expect(await f.host().receiveTelegram(3)).toMatchObject({state:'admitted'});
 });
 it('sends an owner answer once to the authenticated last topic with safe legible formatting',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Pergunta',43);const host=f.host(),receipt=await host.receiveTelegram(1),task=await latestTask(host,receipt.taskRef);
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const body=JSON.parse(String(init?.body));expect(body).toMatchObject({chat_id:'101',message_thread_id:43,parse_mode:'HTML'});expect(body.text).toBe('✅ <b>Pronto</b>\n\nTexto &lt;seguro&gt;.');return Response.json({ok:true,result:{message_id:99,message_thread_id:43,chat:{id:101,type:'private'}}});});
  expect(await host.respondOwner(task,'✅ **Pronto**\n\nTexto <seguro>.')).toMatchObject({state:'sent',messageId:99});
  expect(await host.respondOwner(task,'✅ **Pronto**\n\nTexto <seguro>.')).toMatchObject({state:'sent',messageId:99});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('preserves the exact authenticated owner link used by Calendar after native activation',async()=>{
  const f=await fixture();await f.ownerUpdate(1,'Crie um evento de validação amanhã.',43);
  const host=f.host(),receipt=await host.receiveTelegram(1),task=await latestTask(host,receipt.taskRef),frame=await host.frame(task);
  // This fixture has no Google credential. Reaching the honest configuration
  // result proves actual ingress and Calendar agree on the owner's authority.
  expect(await frame.effects.calendarChange({verb:'create',summary:'Validação sintética',start:'2026-11-01T09:00:00-03:00',end:'2026-11-01T09:30:00-03:00'})).toEqual({state:'pending_configuration',dependency:'calendar_write_owned'});
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
 it('keeps daily curation disabled by default and gives an enabled curator its private native session/client',async()=>{
  const f=await fixture();expect(await f.host().dispatchCurator()).toEqual({state:'disabled'});expect(transport.dispatch).not.toHaveBeenCalled();
  f.own.NATIVE_CURATOR_ENABLED='true';f.own.NATIVE_CURATOR_SCHEDULE_ENABLED='true';await new SourceController(env.DB,f.scope,{kind:'owner'}).createReport({originKey:'curator-evidence',text:'Nora participa do projeto Cedar.',occurredAt:1});
  const host=f.host(),receipt=await host.dispatchCurator(Date.parse('2031-01-01T06:00:00Z'));if(receipt.state!=='admitted'&&receipt.state!=='uncertain')throw Error('fixture_curator');
  const task=await latestTask(host,receipt.taskRef);expect(task.identity.principalOrChatId).toBe('curator:101');expect(task.knowledge.client).toBe('curator');expect(task.authority.mode).toBe('shadow');expect(task.cohort[0].author).toEqual({kind:'system',id:'curator-host'});expect(task.cohort[0].sourceRef).toBeUndefined();
  const frame=await host.frame(task);expect(frame.curator).toBeDefined();const page=await frame.curator!.curator.next(frame.curator!.runId);expect(page.items).toHaveLength(1);expect(page.items[0].text).toBe('Nora participa do projeto Cedar.');
  await expect(frame.effects.reply({decision:'respond',text:'Terceiro'})).rejects.toThrow('native_reply_channel_denied');
  await expect(frame.effects.respondOwner('Destino livre')).rejects.toThrow('native_owner_response_denied');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_context_exposures WHERE conversation_id=?').bind(task.sessionId).first<number>('n')).toBe(1);
 });
 it('curator finish produces one short daily summary in the fixed owner summary topic',async()=>{
  const f=await fixture();f.own.NATIVE_CURATOR_ENABLED='true';f.own.NATIVE_CURATOR_SCHEDULE_ENABLED='true';await new SourceController(env.DB,f.scope,{kind:'owner'}).createReport({originKey:'curator-source',text:'Contexto do projeto.',occurredAt:1});
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
  await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'summaries',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  const host=f.host(),receipt=await host.dispatchCurator(Date.parse('2031-01-01T06:00:00Z'));if(receipt.state!=='admitted'&&receipt.state!=='uncertain')throw Error('fixture_curator');
  const task=await latestTask(host,receipt.taskRef),frame=await host.frame(task),curator=frame.curator!,page=await curator.curator.next(curator.runId);await curator.curator.acknowledge(curator.runId,page.items[0].sequence,{state:'evaluated'});
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const body=JSON.parse(String(init?.body));expect(body).toMatchObject({chat_id:'101',message_thread_id:42,parse_mode:'HTML'});expect(body.text).toContain('1 fontes avaliadas');expect(body.text).not.toContain('Contexto do projeto.');return Response.json({ok:true,result:{message_id:100,message_thread_id:42,chat:{id:101,type:'private'}}});});
  expect(await curator.finish({})).toMatchObject({state:'complete',notice:{state:'accepted'}});expect(await curator.finish({})).toMatchObject({state:'complete',notice:{state:'already_claimed'}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps recurrence off without a sample even when curator capability is available, before creating identity or a daily run',async()=>{
  const f=await fixture();f.own.NATIVE_CURATOR_ENABLED='true';const host=f.host(),identity=vi.spyOn(host,'identity');
  expect(await host.dispatchCurator(Date.parse('2031-01-01T06:00:00Z'))).toEqual({state:'disabled'});expect(identity).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_curator_runs WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(0);
 });
 it('rejects sample-plus-recurrence instead of silently changing the configured daily operation',()=>{
  expect(()=>nativeCuratorDispatchRequest({NATIVE_CURATOR_ENABLED:'true',NATIVE_CURATOR_SCHEDULE_ENABLED:'true',NATIVE_CURATOR_SAMPLE_REQUEST:'{}'})).toThrow('native_curator_configuration_conflict');
 });
 it('dispatches a host-fixed sample once without daily activation and labels its private summary as window coverage',async()=>{
  const f=await fixture();f.own.NATIVE_CURATOR_ENABLED='true';f.own.NATIVE_CURATOR_SCHEDULE_ENABLED='false';
  await new SourceController(env.DB,f.scope,{kind:'owner'}).createReport({originKey:'sample-curator-source',text:'Preferências relatadas pelo dono, sem ativação.',occurredAt:1});
  const to=await env.DB.prepare('SELECT MAX(sequence) n FROM assistant_source_changes WHERE installation_id=? AND generation=?').bind(f.scope.installationId,f.scope.generation).first<number>('n');
  f.own.NATIVE_CURATOR_SAMPLE_REQUEST=JSON.stringify({operationId:'curator-real-sample-1',window:{fromSequence:to!-1,toSequence:to,day:'2026-10-29',timezone:'America/Fortaleza'}});
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};await env.DB.prepare("INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'summaries',?,'ready',42)").bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  const host=f.host(),a=await host.dispatchCurator(),b=await host.dispatchCurator();expect(a).toEqual(b);expect(transport.dispatch).toHaveBeenCalledTimes(1);if(a.state!=='admitted'&&a.state!=='uncertain')throw Error('fixture_sample');
  const task=await latestTask(host,a.taskRef),frame=await host.frame(task),curator=frame.curator!,page=await curator.curator.next(curator.runId);expect(page.items).toHaveLength(1);expect(page.coverage.scope).toBe('sample_window');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_curator_state WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(0);
  await curator.curator.acknowledge(curator.runId,page.items[0].sequence,{state:'evaluated'});
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const body=JSON.parse(String(init?.body));expect(body.text).toContain('AMOSTRA DA MEMÓRIA');expect(body.text).toContain('Somente a janela');expect(body.text).not.toContain('REVISÃO DA MEMÓRIA');return Response.json({ok:true,result:{message_id:101,message_thread_id:42,chat:{id:101,type:'private'}}});});
  expect(await curator.finish({})).toMatchObject({kind:'sample',state:'complete',notice:{state:'accepted'}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps a sample bound to its original native receipt after context retirement without creating another epoch or model attempt',async()=>{
  const f=await fixture();f.own.NATIVE_CURATOR_ENABLED='true';f.own.NATIVE_CURATOR_SCHEDULE_ENABLED='false';await new SourceController(env.DB,f.scope,{kind:'owner'}).createReport({originKey:'sample-retire-source',text:'Amostra a retirar.',occurredAt:1});
  const to=await env.DB.prepare('SELECT MAX(sequence) n FROM assistant_source_changes WHERE installation_id=? AND generation=?').bind(f.scope.installationId,f.scope.generation).first<number>('n');
  const request={operationId:'sample-stable-retired',window:{fromSequence:to!-1,toSequence:to,day:'2026-10-29',timezone:'America/Fortaleza'}};f.own.NATIVE_CURATOR_SAMPLE_REQUEST=JSON.stringify(request);
  const host=f.host(),first=await host.dispatchCurator();if(first.state!=='admitted'&&first.state!=='uncertain')throw Error('fixture_sample');const task=await latestTask(host,first.taskRef);
  await host.retention.purge(task.identity);
  expect(await f.host().dispatchCurator()).toEqual({state:'retired',runId:task.cohort[0].eventId.slice(12),sessionId:first.sessionId,taskRef:first.taskRef});expect(transport.dispatch).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_conversations WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
  f.own.NATIVE_CURATOR_SAMPLE_REQUEST=JSON.stringify({...request,window:{...request.window,fromSequence:to}});
  await expect(f.host().dispatchCurator()).rejects.toThrow('curator_sample_conflict');expect(transport.dispatch).toHaveBeenCalledTimes(1);
 });
 it('binds the sample atomically when another dispatcher admits and retires it after the first dispatcher read null',async()=>{
  const f=await fixture();f.own.NATIVE_CURATOR_ENABLED='true';f.own.NATIVE_CURATOR_SCHEDULE_ENABLED='false';await new SourceController(env.DB,f.scope,{kind:'owner'}).createReport({originKey:'sample-interleaving',text:'Amostra concorrente.',occurredAt:1});
  const to=await env.DB.prepare('SELECT MAX(sequence) n FROM assistant_source_changes WHERE installation_id=? AND generation=?').bind(f.scope.installationId,f.scope.generation).first<number>('n');
  f.own.NATIVE_CURATOR_SAMPLE_REQUEST=JSON.stringify({operationId:'sample-null-admit-purge',window:{fromSequence:to!-1,toSequence:to,day:'2026-10-29',timezone:'America/Fortaleza'}});
  let selected=false,paused!:()=>void,resume!:()=>void;const stopped=new Promise<void>(resolve=>{paused=resolve;}),released=new Promise<void>(resolve=>{resume=resolve;});
  function statement(original:D1PreparedStatement,block:boolean):D1PreparedStatement{return new Proxy(original,{get(target,key){
   if(key==='bind')return (...args:(string|number|null)[])=>statement(target.bind(...args),block);
   if(key==='first'&&block)return async(...args:[])=>{const value=await target.first(...args);expect(value).toBeNull();paused();await released;return value;};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});}
  f.own.DB=new Proxy(env.DB,{get(target,key){
   if(key==='prepare')return (query:string)=>{const block=!selected&&(query.includes('SELECT r.id run_id')||query.includes('SELECT * FROM assistant_curator_runs')&&query.includes('day=?'));if(block)selected=true;return statement(target.prepare(query),block);};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const a=f.host(),first=a.dispatchCurator();await stopped;
  try{
   const b=f.host(),winner=await b.dispatchCurator();if(winner.state!=='admitted'&&winner.state!=='uncertain')throw Error('fixture_sample');const task=await latestTask(b,winner.taskRef),runId=task.cohort[0].eventId.slice(12),curator=await b.curator(task.identity);
   await expect(curator.event(runId,{...task.identity,contextEpoch:'different-epoch'},'101')).rejects.toThrow('curator_sample_binding_denied');
   await expect(env.DB.prepare('UPDATE assistant_curator_runs SET native_session_id=? WHERE installation_id=? AND generation=? AND id=?').bind('replacement',f.scope.installationId,f.scope.generation,runId).run()).rejects.toThrow('curator_sample_binding_immutable');
   await b.retention.purge(task.identity);resume();
   expect(await first).toEqual({state:'retired',runId:task.cohort[0].eventId.slice(12),sessionId:winner.sessionId,taskRef:winner.taskRef});
   expect(transport.dispatch).toHaveBeenCalledTimes(1);expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_conversations WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
  }finally{resume();await first.catch(()=>{});}
 });
 it('asks privately and resumes a quoted authenticated owner clarification in the same WhatsApp session without faking an old cohort',async()=>{
  const f=await fixture(),incoming=await f.append('Você confirma a condição?'),host=f.host(),a=await host.receiveCapture(incoming.sequence),originalTask=await latestTask(host,a.taskRef!);
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
  await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>String(url).endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}):Response.json({ok:true,result:{message_id:77,message_thread_id:42,chat:{id:101,type:'private'}}}));
  const frame=await host.frame(originalTask);expect(await frame.effects.askOwner('Qual condição devo usar?')).toMatchObject({state:'sent'});
  const raw=await f.ownerUpdate(7,'Use a condição de cem reais.',42,77),receipt=await host.receiveTelegram(7,raw),task=await latestTask(host,receipt.taskRef);
  expect(task.sessionId).toBe(originalTask.sessionId);expect(task.cohort).toHaveLength(1);expect(task.cohort[0]).toMatchObject({kind:'clarification',author:{kind:'owner',id:'101'}});expect(task.replyTo).toEqual({taskRef:originalTask.taskRef,sourceRef:originalTask.cohort[0].sourceRef});
  expect((await host.activity(task)).triggerSequence).toBe(incoming.sequence);expect(task.returnChannel.id).toBe(incoming.chatId);
  await expect((await host.frame(task)).effects.calendarChange({verb:'create',summary:'Não autorizado por WhatsApp',start:'2031-01-01T10:00:00-03:00',end:'2031-01-01T11:00:00-03:00'})).rejects.toThrow('native_calendar_owner_required');
  expect(fetch).toHaveBeenCalledTimes(2);expect(await host.receiveTelegram(7,raw)).toMatchObject({taskRef:task.taskRef,state:'admitted'});
 });
 it('recovers a quoted owner clarification from the authenticated inbox after a crash before the native handler',async()=>{
  const f=await fixture(),incoming=await f.append('Pergunta que requer orientação'),host=f.host(),a=await host.receiveCapture(incoming.sequence),originalTask=await latestTask(host,a.taskRef!);
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
  await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}):Response.json({ok:true,result:{message_id:77,message_thread_id:42,chat:{id:101,type:'private'}}}));
  await(await host.frame(originalTask)).effects.askOwner('Qual condição devo considerar?');
  await f.ownerUpdate(21,'Use a condição especial.',42,77);
  expect(await env.DB.prepare(`SELECT reply_to_message_id,reply_to_chat_id,reply_to_thread_id FROM assistant_telegram_updates WHERE installation_id=? AND update_id=21`).bind(f.scope.installationId).first()).toEqual({reply_to_message_id:77,reply_to_chat_id:'101',reply_to_thread_id:42});
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_help_replies WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(0);
  // Simulate process loss: no raw webhook body is passed to the resumed host.
  const recovered=f.host(),receipt=await recovered.receiveTelegram(21),task=await latestTask(recovered,receipt.taskRef);
  expect(task.sessionId).toBe(originalTask.sessionId);expect(task.cohort.map(event=>event.kind)).toEqual(['clarification']);
  expect(task.replyTo).toEqual({taskRef:originalTask.taskRef,sourceRef:originalTask.cohort[0].sourceRef});
  expect(await env.DB.prepare(`SELECT COUNT(*) n FROM assistant_native_context_channels WHERE installation_id=? AND channel='telegram'`).bind(f.scope.installationId).first('n')).toBe(0);
 });
 it.each(['before','after'] as const)('retains help correlation when Source.report fails %s its commit, then recovers without provider retry',async phase=>{
  const f=await fixture(),incoming=await f.append('Pergunta atual'),host=f.host(),a=await host.receiveCapture(incoming.sequence),originalTask=await latestTask(host,a.taskRef!);
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
  await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}):Response.json({ok:true,result:{message_id:77,message_thread_id:42,chat:{id:101,type:'private'}}}));
  await(await host.frame(originalTask)).effects.askOwner('Como devo responder?');await f.ownerUpdate(22,'A condição está aprovada para esta conversa.',42,77);
  const execute=SourceController.prototype.execute;let fail=true;
  const spy=vi.spyOn(SourceController.prototype,'execute').mockImplementation(async function(this:SourceController,input){
   if(fail&&(input as {kind?:string}).kind==='source.report'){fail=false;if(phase==='after')await execute.call(this,input);throw Error('synthetic_source_report_unavailable');}
   return execute.call(this,input);
  });
  await expect(host.receiveTelegram(22)).rejects.toThrow('synthetic_source_report_unavailable');spy.mockRestore();
  expect(await env.DB.prepare('SELECT state,owner_update_id FROM assistant_native_help_questions WHERE conversation_id=?').bind(originalTask.sessionId).first()).toEqual({state:'answered',owner_update_id:22});
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_help_replies WHERE installation_id=?').bind(f.scope.installationId).first('n')).toBe(1);
  const recovered=f.host(),receipt=await recovered.receiveTelegram(22),task=await latestTask(recovered,receipt.taskRef);
  expect(task.sessionId).toBe(originalTask.sessionId);expect(task.cohort[0]).toMatchObject({kind:'clarification',author:{kind:'owner',id:'101'}});
  expect(await recovered.receiveTelegram(22)).toMatchObject({taskRef:task.taskRef,state:'admitted'});
 });
 it.each(['quote','thread','link'] as const)('persisted %s mismatch never resumes the WhatsApp question',async kind=>{
  const f=await fixture(),incoming=await f.append('Pergunta'),host=f.host(),a=await host.receiveCapture(incoming.sequence),originalTask=await latestTask(host,a.taskRef!);
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
  await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}):Response.json({ok:true,result:{message_id:77,message_thread_id:42,chat:{id:101,type:'private'}}}));
  await(await host.frame(originalTask)).effects.askOwner('Qual orientação?');
  await f.ownerUpdate(23,'Minha orientação.',kind==='thread'?43:42,kind==='quote'?999:77);
  if(kind==='link')await env.DB.prepare(`UPDATE assistant_telegram_links SET revision=2 WHERE installation_id=?`).bind(f.scope.installationId).run();
  expect((await(await host.help()).recordPersistedReply(23)).state).not.toBe('recorded');
  expect(await env.DB.prepare('SELECT owner_update_id FROM assistant_native_help_questions WHERE conversation_id=?').bind(originalTask.sessionId).first('owner_update_id')).toBeNull();
 });
 it('retired source plus retained quote identifiers cannot restore a help question or dispatch its old WhatsApp context',async()=>{
  const f=await fixture(),incoming=await f.append('Pergunta a retirar'),host=f.host(),a=await host.receiveCapture(incoming.sequence),originalTask=await latestTask(host,a.taskRef!);
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
  await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}):Response.json({ok:true,result:{message_id:77,message_thread_id:42,chat:{id:101,type:'private'}}}));
  await(await host.frame(originalTask)).effects.askOwner('Qual orientação?');await f.ownerUpdate(24,'Resposta à pergunta retirada.',42,77);
  const ref=originalTask.cohort[0].sourceRef!,retirement={allow:async()=>{},withdraw:async()=>{}};
  await new SourceController(env.DB,f.scope,{kind:'owner'},Date.now,retirement).withdraw(ref.id,ref.revision);
  const purge=new RetentionPurge(env.DB,f.scope,{kind:'owner'},Date.now,retirement);let result:{state:string}={state:'pending'};
  for(let page=0;page<25&&result.state==='pending';page++)result=await purge.advance({kind:'source.purge',operationId:'purge-pending-quoted-help',sourceId:ref.id});
  expect(result.state).toBe('complete');const count=transport.dispatch.mock.calls.length;
  expect((await(await f.host().help()).recordPersistedReply(24)).state).not.toBe('recorded');
  expect(await env.DB.prepare('SELECT state FROM assistant_native_help_questions WHERE conversation_id=?').bind(originalTask.sessionId).first('state')).toBe('cancelled');
  expect(transport.dispatch).toHaveBeenCalledTimes(count);
 });
 it('treats a quoted answer to a superseded question as stale instead of looping a 503 or resurrecting WhatsApp work',async()=>{
  const f=await fixture(),incoming=await f.append('Mensagem antiga'),host=f.host(),a=await host.receiveCapture(incoming.sequence),originalTask=await latestTask(host,a.taskRef!);
  const fence={...f.scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};await env.DB.prepare(`INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)`).bind(f.scope.installationId,f.scope.generation,bot,JSON.stringify(fence)).run();
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}):Response.json({ok:true,result:{message_id:77,message_thread_id:42,chat:{id:101,type:'private'}}}));
  await(await host.frame(originalTask)).effects.askOwner('Qual resposta?');const newer=await f.append('Mensagem nova');await host.receiveCapture(newer.sequence);
  const raw=await f.ownerUpdate(8,'Sobre a pergunta antiga: sim.',42,77),receipt=await host.receiveTelegram(8,raw),task=await latestTask(host,receipt.taskRef);
  expect(task.identity.channel).toBe('telegram');expect(task.replyTo).toBeUndefined();expect(await env.DB.prepare(`SELECT state FROM assistant_native_help_questions WHERE context_ref=?`).bind(originalTask.contextRef).first('state')).toBe('cancelled');
 });
 it('admits an image as exact canonical metadata so the agent can choose perception without eager OCR or a fabricated caption',async()=>{
  const f=await fixture(),incoming=await f.append('temporary'),mediaId=crypto.randomUUID();
  await env.DB.prepare(`UPDATE messages SET kind='image',text=NULL,version=2 WHERE id=?`).bind(incoming.sourceId).run();
  await env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,message_version,epoch,generation,kind,mime,size,sha256,object_key,state,source_url,created_at) VALUES(?,?,?,2,'e1','g1','image','image/png',100,?,'synthetic/image','ready','https://provider.invalid/private',?)`)
   .bind(mediaId,incoming.chatId,incoming.sourceId,'b'.repeat(64),Date.now()).run();
  const seq=await env.DB.prepare(`SELECT MAX(sequence) n FROM assistant_capture_changes WHERE source_kind='media' AND source_id=?`).bind(mediaId).first<number>('n');if(!seq)throw Error('fixture_media_sequence');
  const metadata={protocol:1,installationId:f.scope.installationId,generation:f.scope.generation,sourceEpoch:'e1',sourceGeneration:'g1',sequence:seq,previousSequence:incoming.sequence,chatId:incoming.chatId,sourceId:mediaId,sourceKind:'media',operation:'upsert',recordedAt:Date.now()};
  expect((await receiveCapture(new Request('https://own.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify(metadata)}),{...f.own,NATIVE_CONVERSATIONS_MODE:'off'})).status).toBe(200);
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('no_eager_model_or_binary_request'));
  const host=f.host(),receipt=await host.receiveCapture(seq);expect(receipt.state).toBe('admitted');const task=await latestTask(host,receipt.taskRef!);
  const raw=await env.DB.prepare(`SELECT event_json FROM assistant_native_conversation_events WHERE task_ref=?`).bind(task.taskRef).first<string>('event_json'),body=JSON.parse(JSON.parse(raw!).body);
  expect(body.kind).toBe('image');expect(body.media.id).toBe(mediaId);expect(body.text).toBeUndefined();expect(task.cohort[0].sourceRef).toBeDefined();expect(fetch).not.toHaveBeenCalled();
  expect(await(await host.frame(task)).media.read(task.cohort[0].sourceRef)).toEqual({state:'unavailable',reason:'media_context_unconfigured'});
 });
});
