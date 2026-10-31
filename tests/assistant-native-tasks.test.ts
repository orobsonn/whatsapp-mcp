import {env,createExecutionContext} from 'cloudflare:test';
import {OwnerAssistant,OwnerQueries} from '../assistant/mcp';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {DeliveredMessage} from '@flue/runtime';
import {NativeApplicationHost} from '../assistant/agent-runtime/native-host';
import type {AssistantEnv} from '../assistant/env';
import {TelegramLink} from '../assistant/telegram-auth';
import {OwnerControl} from '../assistant/control';
import {InferenceBudget} from '../assistant/budget';
import {SourceController} from '../assistant/sources';
import type {TaskContext} from '../assistant/agent-runtime/conversation';
import {compactStatement} from '../assistant/d1-statement';
import {RetentionPurge} from '../assistant/retention-purge';
const transport=vi.hoisted(()=>({deliveries:new Map<string,DeliveredMessage>(),accepted:new Map<string,unknown>(),lostAck:false,dispatch:vi.fn(),abort:vi.fn(),destroy:vi.fn()}));
vi.mock('../assistant/agent-runtime/native-transport',()=>({
 openNativeConversation:(sessionId:string)=>({dispatch:async(q:{idempotencyKey:string;message:DeliveredMessage})=>{
  transport.dispatch(sessionId,q);transport.deliveries.set(q.idempotencyKey,q.message);
  const receipt=transport.accepted.get(q.idempotencyKey)??{submissionId:q.idempotencyKey,uid:sessionId,acceptedAt:new Date(1).toISOString()};transport.accepted.set(q.idempotencyKey,receipt);
  if(transport.lostAck){transport.lostAck=false;throw Error('lost_native_ack');}return receipt;},read:async()=>({})}),
 nativeContextDestroyPort:()=>({abort:transport.abort,quiesce:async()=>{},destroy:transport.destroy}),
}));
const secret='native-tasks-synthetic-only-more-than32',bot='native_tasks_bot';
const localISO=(at:number)=>new Date(at-10800000).toISOString().replace('Z','-03:00');
beforeEach(()=>{vi.clearAllMocks();transport.deliveries.clear();transport.accepted.clear();transport.lostAck=false;});
afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const scope={installationId:crypto.randomUUID(),generation:'own-tasks-g1',sourceEpoch:'tasks-source-e1',sourceGeneration:'tasks-source-g1'};
 const settings:AssistantEnv={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret,
  NATIVE_CONVERSATIONS_MODE:'approval',NATIVE_CAPTURE_START_AFTER_SEQUENCE:'0',NATIVE_BUDGET_EXTERNAL_CARRY_MICROUSD:'0',NATIVE_CONTEXT_ADMIN_SECRET:secret,OPENAI_API_KEY:'synthetic-not-a-credential',
  TELEGRAM_BOT_INSTANCE:bot,TELEGRAM_BOT_TOKEN:'123456789:syntheticabcdefghijklmnopqrstuvwxyz',TELEGRAM_WEBHOOK_SECRET:'native_task_synthetic_webhook_more_than32',CAPTURE_READER:{readSnapshot:async()=>{throw Error('no_whatsapp_reads');}}};
 await env.DB.prepare(`INSERT INTO assistant_telegram_links(installation_id,generation,bot_instance,source_epoch,source_generation,revision,state,user_id,chat_id,activation_cut) VALUES(?,?,?,?,?,1,'active','101','101',0)`)
  .bind(scope.installationId,scope.generation,bot,scope.sourceEpoch,scope.sourceGeneration).run();
 const activation={version:1,...{sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration},botInstance:bot,linkRevision:1,userId:'101',chatId:'101',activatedAt:1};
 await env.DB.prepare('INSERT INTO assistant_native_host_state(installation_id,generation,telegram_activation_json) VALUES(?,?,?)').bind(scope.installationId,scope.generation,JSON.stringify(activation)).run();
 const host=new NativeApplicationHost(settings);let update=0;
 async function ownerInput(text='Pedido sintético de missão',thread=43){
  const updateId=++update,raw={update_id:updateId,message:{message_id:updateId+100,date:Math.floor(Date.now()/1000),from:{id:101,is_bot:false},chat:{id:101,type:'private'},text,message_thread_id:thread}};
  expect(await new TelegramLink(env.DB,scope,bot,settings.TELEGRAM_WEBHOOK_SECRET!).receive(raw)).toBe('pending');
  const receipt=await host.receiveTelegram(updateId);return task(receipt.taskRef);
 }
 async function task(taskRef:string){
  const row=await env.DB.prepare('SELECT identity_json FROM assistant_native_conversations WHERE id=(SELECT conversation_id FROM assistant_native_conversation_events WHERE task_ref=?)').bind(taskRef).first<{identity_json:string}>();
  const delivery=transport.deliveries.get(taskRef);if(!row||!delivery)throw Error('fixture_task_missing');return host.runtime.resolveTask(JSON.parse(row.identity_json),delivery);
 }
 const control=new OwnerControl(env.DB,scope,{kind:'owner'});
 const count=async(table:string)=>env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE installation_id=? AND generation=?`).bind(scope.installationId,scope.generation).first<number>('n');
 async function wake(){const result=await host.tick();const row=await env.DB.prepare('SELECT task_ref FROM assistant_native_task_occurrences WHERE installation_id=? AND generation=? ORDER BY created_at DESC LIMIT 1').bind(scope.installationId,scope.generation).first<{task_ref:string}>();if(!row?.task_ref)throw Error('fixture_no_wake:'+JSON.stringify(result));return task(row.task_ref);}
 async function model(task:TaskContext,submission='synthetic-submission',turn='synthetic-turn'){
  await host.recordConsumed(task,submission);await new InferenceBudget(env.DB,{...scope,period:new Date().toISOString().slice(0,10)}).configure(1000000);return host.modelHost(task.sessionId,turn,submission);
 }
 return {scope,settings,host,ownerInput,task,wake,model,count,control,activation};
}
async function saved(f:Awaited<ReturnType<typeof fixture>>,task:TaskContext,objective='Pesquisar informação sintética',at=localISO(Date.now()-60000)){
 return await f.host.tasks().save(task,{objective,at}) as {id:string;revision:number;scheduledAt:number};
}
async function mcpFixture(){
 const f=await fixture();await f.ownerInput();
 const source=await new SourceController(env.DB,f.scope,{kind:'owner'}).create({originKey:'mcp-request',text:'Pedido do dono: lembrar privadamente sobre o retorno combinado.',occurredAt:Date.now(),audience:'owner'});
 await f.control.execute({kind:'policy.put',operationId:'mcp-policy',id:'synthetic-chat',expectedRevision:0,conversationKind:'private'});
 const command={kind:'fup.put' as const,operationId:'mcp-fup',id:'mcp-fup',expectedVersion:0,conversationId:'synthetic-chat',policyRevision:1,source:{id:source.id,revision:1},purpose:'Retorno privado ao dono',dueAt:localISO(Date.now()-60000),timezone:'America/Fortaleza',precision:'exact' as const,state:'scheduled' as const};
 const rpc=new OwnerAssistant(createExecutionContext(),f.settings);
 return {...f,source,command,rpc};
}
it('enrolls an authenticated MCP FUP atomically and wakes only the existing private owner session',async()=>{
 const f=await mcpFixture(),first=await f.rpc.control(f.scope,f.command);
 expect(first).toMatchObject({id:'mcp-fup',version:1,native:'enrolled'});
 expect(await f.rpc.control(f.scope,f.command)).toEqual(first);
 expect(await f.count('assistant_follow_ups')).toBe(1);expect(await f.count('assistant_native_task_bindings')).toBe(1);
 const due=await f.wake();expect(due.returnChannel).toEqual({channel:'telegram',id:'101'});
 expect(due.cohort[0]).toMatchObject({kind:'fup_due',author:{kind:'system'},workRef:{kind:'follow_up',id:'mcp-fup',version:1}});
 await expect(f.host.tasks().save(due,{objective:'Deadline is not a new owner request'})).rejects.toThrow('native_task_owner_required');
 expect(await f.count('assistant_jobs')).toBe(0);
 expect(await new OwnerQueries(env.DB,f.scope).execute({kind:'follow_up',id:'mcp-fup'})).toMatchObject({native:'enrolled'});
});
it.each(['link','activation','source','retention'] as const)('rejects an MCP FUP and its binding together when %s changes during admission',async change=>{
 const f=await mcpFixture(),original=OwnerControl.prototype.execute;
 vi.spyOn(OwnerControl.prototype,'execute').mockImplementation(async function(this:OwnerControl,input:unknown){
  if(change==='link')await env.DB.prepare("UPDATE assistant_telegram_links SET revision=revision+1 WHERE installation_id=?").bind(f.scope.installationId).run();
  if(change==='activation')await env.DB.prepare("UPDATE assistant_native_host_state SET telegram_activation_json=NULL WHERE installation_id=?").bind(f.scope.installationId).run();
  if(change==='source')await new SourceController(env.DB,f.scope,{kind:'owner'}).execute({kind:'source.withdraw',operationId:'withdraw-during-mcp',id:f.source.id,expectedRevision:1});
  if(change==='retention')await env.DB.prepare('INSERT INTO assistant_retention_runtime_hold(installation_id,operation_id,target_generation,active,created_at) VALUES(?,?,?,1,?)').bind(f.scope.installationId,'test','next',Date.now()).run();
  return original.call(this,input);
 });
 await expect(f.rpc.control(f.scope,f.command)).rejects.toThrow('control_precondition');
 expect(await f.count('assistant_follow_ups')).toBe(0);expect(await f.count('assistant_native_task_bindings')).toBe(0);
});
it.each(['paused','session','link','activation'] as const)('does not persist a scheduled MCP FUP when the native scheduler is unavailable: %s',async missing=>{
 const f=await mcpFixture();
 if(missing==='paused')f.settings.ROUTINES_PAUSED='true';
 else if(missing==='session')await env.DB.prepare('DELETE FROM assistant_native_context_channels WHERE installation_id=?').bind(f.scope.installationId).run();
 else if(missing==='link')await env.DB.prepare('DELETE FROM assistant_telegram_links WHERE installation_id=?').bind(f.scope.installationId).run();
 else await env.DB.prepare('UPDATE assistant_native_host_state SET telegram_activation_json=NULL WHERE installation_id=?').bind(f.scope.installationId).run();
 await expect(f.rpc.control(f.scope,f.command)).rejects.toThrow('control_scheduler_unavailable');
 expect(await f.count('assistant_follow_ups')).toBe(0);expect(await f.count('assistant_native_task_bindings')).toBe(0);
});
it('invalidates an old MCP wake on reschedule and refuses a withdrawn support source',async()=>{
 const f=await mcpFixture();await f.rpc.control(f.scope,f.command);const old=await f.wake();
 await f.rpc.control(f.scope,{...f.command,operationId:'mcp-reschedule',expectedVersion:1,dueAt:localISO(Date.now()-30000)});
 await expect(f.host.tasks().guardForTask(old)).rejects.toThrow();
 const next=await f.wake();expect(next.cohort[0].workRef).toMatchObject({version:2});
 await new SourceController(env.DB,f.scope,{kind:'owner'}).execute({kind:'source.withdraw',operationId:'withdraw-mcp-support',id:f.source.id,expectedRevision:1});
 await expect(f.host.tasks().guardForTask(next)).rejects.toThrow();
});
it('recovers the exact admitted MCP receipt after support withdrawal and scheduler pause without reenrolling',async()=>{
 const f=await mcpFixture(),first=await f.rpc.control(f.scope,f.command);
 await new SourceController(env.DB,f.scope,{kind:'owner'}).execute({kind:'source.withdraw',operationId:'withdraw-receipt-support',id:f.source.id,expectedRevision:1});
 f.settings.ROUTINES_PAUSED='true';
 expect(await f.rpc.control(f.scope,f.command)).toEqual(first);
 expect(await f.count('assistant_follow_ups')).toBe(1);expect(await f.count('assistant_native_task_bindings')).toBe(1);
});
it('accepts the same activation with a different stored JSON field order',async()=>{
 const f=await mcpFixture(),raw=JSON.stringify(Object.fromEntries(Object.entries(f.activation).reverse()));
 await env.DB.prepare('UPDATE assistant_native_host_state SET telegram_activation_json=? WHERE installation_id=?').bind(raw,f.scope.installationId).run();
 expect(await f.rpc.control(f.scope,f.command)).toMatchObject({native:'enrolled'});
 expect((await f.wake()).cohort[0].workRef).toMatchObject({id:'mcp-fup'});
});

it('creates mission plus explicit enrollment atomically, with deterministic retries and preserved edit deadline',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),input={objective:'Objetivo sintético',at:localISO(Date.now()-60000)};
 const first=await f.host.tasks().save(owner,input) as {id:string;revision:number;scheduledAt:number};
 expect(first).toMatchObject({revision:1,native:'enrolled',externalAttempt:false});expect(await f.host.tasks().save(owner,input)).toEqual(first);
 expect(await f.count('assistant_missions')).toBe(1);expect(await f.count('assistant_native_task_bindings')).toBe(1);expect(await f.count('assistant_jobs')).toBe(0);
 const edit={id:first.id,expectedRevision:1,objective:'Objetivo atualizado'};
 const changed=await f.host.tasks().save(owner,edit);expect(changed).toMatchObject({id:first.id,revision:2,scheduledAt:first.scheduledAt});
 expect(await f.host.tasks().save(owner,edit)).toEqual(changed);expect(await f.count('assistant_native_task_bindings')).toBe(2);
 const query=await f.host.tasks().query(owner,{kind:'mission',id:first.id});expect(query).toMatchObject({items:[{objective:'Objetivo atualizado',version:2,native:'enrolled',sourceRef:owner.cohort[0].sourceRef}]});
});
it('does not create a mission when owner admission loses its same-statement latch',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),tasks=f.host.tasks();
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS native_task_test_gate(id TEXT PRIMARY KEY,active INTEGER)').run();
 await env.DB.prepare('INSERT INTO native_task_test_gate VALUES(?,1)').bind(f.scope.installationId).run();
 Object.defineProperty(f.host,'actionAuthority',{value:async()=>({sql:'EXISTS(SELECT 1 FROM native_task_test_gate WHERE id=? AND active=1)',values:[f.scope.installationId]})});
 const original=OwnerControl.prototype.execute;
 vi.spyOn(OwnerControl.prototype,'execute').mockImplementation(async function(this:OwnerControl,input:unknown){await env.DB.prepare('UPDATE native_task_test_gate SET active=0 WHERE id=?').bind(f.scope.installationId).run();return original.call(this,input);});
 await expect(tasks.save(owner,{objective:'Não persistir'})).rejects.toThrow();expect(await f.count('assistant_missions')).toBe(0);expect(await f.count('assistant_native_task_bindings')).toBe(0);
});
it('wakes a scheduled mission as a system event in the SAME owner session/topic and stores no legacy job',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),mission=await saved(f,owner),due=await f.wake();
 expect(due.sessionId).toBe(owner.sessionId);expect(due.returnChannel).toEqual({channel:'telegram',id:'101',threadId:'43'});
 expect(due.cohort[0]).toMatchObject({kind:'mission_due',author:{kind:'system',id:'native-task-host'},workRef:{kind:'mission',id:mission.id,version:1}});
 expect(due.cohort[0].sourceRef).toEqual(owner.cohort[0].sourceRef);expect(await f.count('assistant_jobs')).toBe(0);
 await expect(f.host.tasks().save(due,{objective:'System cannot grant another task'})).rejects.toThrow('native_task_owner_required');
 const frame=await f.host.frame(due);await expect(frame.effects.calendarChange({verb:'create',summary:'Denied',start:'2026-11-01T10:00:00-03:00',end:'2026-11-01T11:00:00-03:00'})).rejects.toThrow('native_calendar_owner_required');
});
it('never drains legacy missions/FUPs: only an explicit current-version adoption wakes privately',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),ref=owner.cohort[0].sourceRef!;
 await f.control.execute({kind:'mission.put',operationId:'legacy-mission',id:'legacy',expectedRevision:0,objective:'Held legacy',source:{id:ref.id,revision:ref.revision},state:'active',nextEvaluationAt:1});
 await env.DB.prepare(`INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,?,'private',0,'ignore',1)`).bind(f.scope.installationId,f.scope.generation,'synthetic-chat').run();
 await f.control.execute({kind:'fup.put',operationId:'legacy-fup',id:'legacy-fup',expectedVersion:0,conversationId:'synthetic-chat',policyRevision:1,source:{id:ref.id,revision:ref.revision},purpose:'Avaliação privada do retorno',dueAt:Date.now()-60000,timezone:'America/Fortaleza',precision:'exact',state:'scheduled'});
 await f.host.tick();expect(await f.count('assistant_native_task_occurrences')).toBe(0);
 await f.host.tasks().adopt(owner,{kind:'follow_up',id:'legacy-fup',version:1});const due=await f.wake();
 expect(due.cohort[0]).toMatchObject({kind:'fup_due',workRef:{kind:'follow_up',id:'legacy-fup'}});expect(due.returnChannel.id).toBe('101');expect(await f.count('assistant_jobs')).toBe(0);
});
it('concurrent ticks and a lost native admission ACK reuse the same occurrence/session/key',async()=>{
 const f=await fixture(),owner=await f.ownerInput();await saved(f,owner);transport.lostAck=true;
 await Promise.all([f.host.tick(),f.host.tick()]);await f.host.tick();
 expect(await f.count('assistant_native_task_occurrences')).toBe(1);
 const row=await env.DB.prepare('SELECT state,conversation_id FROM assistant_native_task_occurrences WHERE installation_id=?').bind(f.scope.installationId).first();expect(row).toEqual({state:'admitted',conversation_id:owner.sessionId});
 const dueCalls=transport.dispatch.mock.calls.filter(([,request])=>request.message.type==='assistant.conversation.mission_due');
 expect(dueCalls.length).toBeGreaterThanOrEqual(1);expect(new Set(dueCalls.map(([,request])=>request.idempotencyKey)).size).toBe(1);
});
it('cancellation blocks the actual due model cursor even when a newer owner message is QUEUED; consuming it restores only its own authority',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),mission=await saved(f,owner),due=await f.wake(),model=await f.model(due);
 await f.control.execute({kind:'mission.set_state',operationId:'cancel-from-owner-mcp',id:mission.id,expectedRevision:1,state:'cancelled'});
 const queued=await f.ownerInput('Pergunta nova independente',42);
 await expect(model.assertAuthority()).rejects.toThrow('native_task_changed');
 expect(await compactStatement(env.DB,`SELECT 1 WHERE (${model.authorityGuard().sql})`,model.authorityGuard().values).first()).toBeNull();
 await expect(f.host.modelHost(due.sessionId,'another-paid-turn','synthetic-submission')).rejects.toThrow('native_task_changed');
 await f.host.recordConsumed(queued,'synthetic-submission');const next=await f.host.modelHost(queued.sessionId,'new-owner-turn','synthetic-submission');await expect(next.assertAuthority()).resolves.toBeUndefined();
 expect(transport.abort).not.toHaveBeenCalled();expect(transport.destroy).not.toHaveBeenCalled();
});
it('fails before model authorization when the host has no confirmed consumed cursor',async()=>{
 const f=await fixture(),owner=await f.ownerInput();await saved(f,owner);const due=await f.wake();
 await new InferenceBudget(env.DB,{...f.scope,period:new Date().toISOString().slice(0,10)}).configure(1000000);
 await expect(f.host.modelHost(due.sessionId,'unobserved','not-a-consumed-submission')).rejects.toThrow('native_model_consumption_unobserved');
 expect(await f.count('assistant_native_model_receipts')).toBe(0);
});
it('sends a useful private result once and records notification separately from mission completion',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),mission=await saved(f,owner),due=await f.wake(),sent:string[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{sent.push(String(options?.body));return Response.json({ok:true,result:{message_id:77,message_thread_id:43,chat:{id:101,type:'private'}}});});
 expect(await f.host.respondOwner(due,'Resultado sintético com evidência disponível.')).toMatchObject({state:'sent',messageId:77});
 expect(await f.host.respondOwner(due,'Resultado sintético com evidência disponível.')).toMatchObject({state:'sent',messageId:77});expect(sent).toHaveLength(1);
 expect(await env.DB.prepare('SELECT state FROM assistant_native_task_occurrences WHERE installation_id=?').bind(f.scope.installationId).first('state')).toBe('notified');
 expect(await env.DB.prepare('SELECT state FROM assistant_missions WHERE installation_id=? AND id=?').bind(f.scope.installationId,mission.id).first('state')).toBe('active');
});
it('does not notify the owner if a due occurrence was cancelled during preparation',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),mission=await saved(f,owner),due=await f.wake(),fetch=vi.spyOn(globalThis,'fetch');
 await f.control.execute({kind:'mission.set_state',operationId:'cancel-before-notice',id:mission.id,expectedRevision:1,state:'cancelled'});
 await expect(f.host.respondOwner(due,'Não publicar resultado velho')).rejects.toThrow('native_task_changed');expect(fetch).not.toHaveBeenCalled();
});
it('filters source text through knowledge access rather than exposing raw mission rows',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),source=await new SourceController(env.DB,f.scope,{kind:'owner'}).createReport({originKey:'excluded-task-source',text:'Fonte sintética privada',occurredAt:1});
 await f.control.execute({kind:'mission.put',operationId:'excluded-mission',id:'excluded-mission',expectedRevision:0,objective:'Objetivo que não deve aparecer',source:{id:source.id,revision:source.revision},state:'active'});
 await env.DB.prepare(`UPDATE assistant_sources SET origin='whatsapp',conversation_id='excluded-chat' WHERE installation_id=? AND id=?`).bind(f.scope.installationId,source.id).run();
 await env.DB.prepare(`INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,'excluded-chat','private',1,'ignore',1)`).bind(f.scope.installationId,f.scope.generation).run();
 const result=await f.host.tasks().query(owner,{kind:'mission',id:'excluded-mission'});expect(result).toMatchObject({items:[{content:'unavailable'}]});expect(JSON.stringify(result)).not.toContain('Objetivo que não deve aparecer');
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_native_context_exposures WHERE conversation_id=? AND source_id=?').bind(owner.sessionId,source.id).first('n')).toBe(0);
});
it('preserves occurrence identity after an epoch rotation instead of replaying work in another DO',async()=>{
 const f=await fixture(),owner=await f.ownerInput();await saved(f,owner);const due=await f.wake();
 await expect(env.DB.prepare('UPDATE assistant_native_task_occurrences SET conversation_id=? WHERE installation_id=?').bind('replacement-session',f.scope.installationId).run()).rejects.toThrow('native_task_occurrence_immutable');
 await f.host.retention.purge(due.identity);const fresh=await f.ownerInput('Novo contexto independente');expect(fresh.sessionId).not.toBe(due.sessionId);
 const dueCalls=()=>transport.dispatch.mock.calls.filter(([,request])=>request.message.type==='assistant.conversation.mission_due').length;
 const before=dueCalls();await f.host.tick();expect(dueCalls()).toBe(before);
 expect(due.sessionId).toBe(owner.sessionId);
});
it('purges enrollment and consumed copies when the authorizing source is retired, retaining only invalidated occurrence metadata',async()=>{
 const f=await fixture(),owner=await f.ownerInput();await saved(f,owner);const due=await f.wake();await f.host.recordConsumed(due,'consumed-before-withdraw');
 const ref=owner.cohort[0].sourceRef!,retirement={allow:async()=>{},withdraw:async()=>{}};
 await new SourceController(env.DB,f.scope,{kind:'owner'},Date.now,retirement).withdraw(ref.id,ref.revision);
 const purge=new RetentionPurge(env.DB,f.scope,{kind:'owner'},Date.now,retirement);let result:{state:string}={state:'pending'};
 for(let page=0;page<25&&result.state==='pending';page++)result=await purge.advance({kind:'source.purge',operationId:'purge-native-task-source',sourceId:ref.id});
 expect(result.state).toBe('complete');expect(await f.count('assistant_native_task_bindings')).toBe(0);expect(await f.count('assistant_native_consumed_inputs')).toBe(0);
 expect(await env.DB.prepare('SELECT state FROM assistant_native_task_occurrences WHERE installation_id=?').bind(f.scope.installationId).first('state')).toBe('invalidated');
 await expect(f.host.runtime.assertTaskCurrent(due)).rejects.toThrow();
 const fresh=await f.ownerInput('Pedido posterior independente');expect(fresh.sessionId).not.toBe(due.sessionId);
});

it('reads a full allowed page of independently sourced missions with exact exposure and pagination',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),sources=new SourceController(env.DB,f.scope,{kind:'owner'});
 for(let index=0;index<21;index++){
  const id='page-mission-'+String(index).padStart(2,'0'),source=await sources.createReport({originKey:id,text:'Fonte independente sintética '+index,occurredAt:1});
  await f.control.execute({kind:'mission.put',operationId:id,id,expectedRevision:0,objective:'Objetivo independente '+index,source:{id:source.id,revision:source.revision},state:'active'});
 }
 const page=await f.host.tasks().query(owner,{kind:'mission',limit:20});expect(page.items).toHaveLength(20);expect(page).toMatchObject({nextAfter:'page-mission-19',coverage:'current_page'});
 expect(await env.DB.prepare('SELECT COUNT(DISTINCT source_id) n FROM assistant_native_context_exposures WHERE conversation_id=?').bind(owner.sessionId).first('n')).toBe(21);
 const tail=await f.host.tasks().query(owner,{kind:'mission',after:page.nextAfter,limit:20});expect(tail.items).toMatchObject([{id:'page-mission-20',objective:'Objetivo independente 20'}]);expect(tail).not.toHaveProperty('nextAfter');
 const last=page.items.at(-1)!;if(!('sourceRef' in last))throw Error('fixture_source_missing');
 const expose=f.host.retention.exposeSource.bind(f.host.retention);let changed=false;
 vi.spyOn(f.host.retention,'exposeSource').mockImplementation(async(identity,ref)=>{await expose(identity,ref);if(ref.id===last.sourceRef.id&&!changed){changed=true;await f.control.execute({kind:'mission.set_state',operationId:'cancel-during-page',id:last.id,expectedRevision:1,state:'cancelled'});}});
 await expect(f.host.tasks().query(owner,{kind:'mission',limit:20})).rejects.toThrow('native_task_changed');
});

it('preserves the existing project when editing a mission through the native owner tool',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),ref=owner.cohort[0].sourceRef!;
 await f.control.execute({kind:'project.put',operationId:'project-command',id:'existing-project',expectedVersion:0,name:'Projeto sintético'});
 await f.control.execute({kind:'mission.put',operationId:'project-mission-command',id:'project-mission',expectedRevision:0,objective:'Objetivo original',source:{id:ref.id,revision:ref.revision},project:{id:'existing-project',revision:1},state:'active'});
 await f.host.tasks().save(owner,{id:'project-mission',expectedRevision:1,objective:'Objetivo editado'});
 expect(await env.DB.prepare('SELECT project_id FROM assistant_missions WHERE installation_id=? AND id=?').bind(f.scope.installationId,'project-mission').first('project_id')).toBe('existing-project');
});
it('checks every due in a large consumed cohort at provider and private-notice boundaries',async()=>{
 const f=await fixture(),owner=await f.ownerInput(),at=localISO(Date.now()-60000),missions:{id:string}[]=[];
 for(let index=0;index<26;index++)missions.push(await saved(f,owner,'Objetivo coorte '+index,at));
 for(let index=0;index<26;index++)await f.host.tick();
 const rows=await env.DB.prepare("SELECT e.task_ref FROM assistant_native_conversation_events e WHERE e.conversation_id=? AND json_extract(e.event_json,'$.kind')='mission_due' ORDER BY e.sequence").bind(owner.sessionId).all<{task_ref:string}>();
 expect(rows.results).toHaveLength(26);const refs=rows.results.map(row=>row.task_ref);
 for(const ref of refs)await f.host.recordConsumed(await f.task(ref),'many-due-submission');
 const task=await f.host.runtime.resolveTask(owner.identity,transport.deliveries.get(refs.at(-1)!)!,refs);
 await new InferenceBudget(env.DB,{...f.scope,period:new Date().toISOString().slice(0,10)}).configure(1000000);
 const model=await f.host.modelHost(owner.sessionId,'many-due-turn','many-due-submission');await expect(model.assertAuthority()).resolves.toBeUndefined();
 vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true,result:{message_id:78,message_thread_id:43,chat:{id:101,type:'private'}}}));
 expect(await f.host.respondOwner(task,'Resumo privado sintético da coorte.')).toMatchObject({state:'sent',messageId:78});
 const first=task.cohort[0].workRef!;
 await f.control.execute({kind:'mission.set_state',operationId:'cancel-first-in-large-cohort',id:first.id,expectedRevision:1,state:'cancelled'});
 await expect(model.assertAuthority()).rejects.toThrow('native_task_changed');
});
