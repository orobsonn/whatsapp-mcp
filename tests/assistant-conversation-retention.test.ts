import {env} from 'cloudflare:test';
import {beforeEach,expect,it,vi} from 'vitest';
import {NativeConversationRetention} from '../assistant/agent-runtime/conversation-retention';
import {ConversationRuntime,verifiedConversationEvent,type ConversationHost,type ConversationIdentity} from '../assistant/agent-runtime/conversation';
import {KnowledgeService} from '../assistant/knowledge/service';
import type {KnowledgePort,KnowledgeClaim} from '../assistant/knowledge/contracts';
import {SourceAccess} from '../assistant/access';
import {SourceController} from '../assistant/sources';
import {OriginGuard} from '../assistant/origin-guard';
let identity:ConversationIdentity,retention:NativeConversationRetention,runtime:ConversationRuntime;
let scope:{installationId:string;generation:string;sourceEpoch:string;sourceGeneration:string};
let ref:{id:string;revision:number;version:number;hash:string};
let snapshot:any,unavailable:boolean,guard:OriginGuard;
let destroyed:string[],steps:string[];
let host:ConversationHost;
const port:KnowledgePort={async remember(operationId:string){return {operationId,state:'ready' as const};},async status(operationId:string){return {operationId,state:'ready' as const};},async query(){return {claims:[]};},async get_entity(){return null;},async find_entities(){return {entities:[]};},async withdraw(operationId:string){return {operationId,state:'ready' as const};}};
beforeEach(async()=>{
 vi.restoreAllMocks();
 scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'e1',sourceGeneration:'sg1'};
 identity={version:1,...{installationId:scope.installationId,generation:scope.generation},channel:'whatsapp',principalOrChatId:'chat-A',contextEpoch:'ctx1'};
 unavailable=false;destroyed=[];steps=[];
 guard=new OriginGuard(env.DB,()=>scope,{async readSnapshot(){if(unavailable)throw Error('offline');return snapshot;}},'synthetic');
 retention=new NativeConversationRetention(env.DB,()=>scope,guard,{async abort(id){steps.push('abort');},async quiesce(id){steps.push('quiesce');},async destroy(id){steps.push('destroy');destroyed.push(id);}},()=>100);
 host={async authority(){return {ownerId:'owner',sourceEpoch:'e1',sourceGeneration:'sg1',policyRevision:1,grantRef:'host',mode:'shadow'};},async authorizeEvent(){},open(){return {async dispatch(){return {submissionId:'s',uid:'u',acceptedAt:new Date(0).toISOString()};},async read(){return {text:'synthetic',data:{},submissionId:'s'};}};},knowledge(task){return new KnowledgeService(env.DB,()=>task.knowledge,port,()=>100,undefined,guard);},retention};
 runtime=new ConversationRuntime(env.DB,host,()=>100);
 const service=new KnowledgeService(env.DB,()=>({scope,client:'owner_mcp'}),port,()=>100);
 ref=(await service.execute({kind:'context.report',operationId:'report',text:'Nora leads Cedar.'})).sourceRef;
});
async function admit(chat=identity.principalOrChatId,eventId=crypto.randomUUID(),sourceRef?:typeof ref){const id={...identity,principalOrChatId:chat};const receipt=await runtime.deliverConversation(verifiedConversationEvent({identity:id,eventId,revision:1,kind:'incoming',author:{kind:'person',id:'nora'},occurredAt:1,body:'Synthetic input',...(sourceRef?{sourceRef}:{})}));return {id,receipt};}
async function expose(id:ConversationIdentity){const source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!;await retention.expose(id,{sources:[source.fence],origins:[]});}
it('reexposes an existing page with constant global checks and the final authority check intact',async()=>{
 const a=await admit(),refs=[ref],service=new KnowledgeService(env.DB,()=>({scope,client:'owner_mcp'}),port,()=>100);
 for(let i=0;i<2;i++)refs.push((await service.execute({kind:'context.report',operationId:'replay-page-'+i,text:'Synthetic page evidence '+i})).sourceRef);
 const access=new SourceAccess(env.DB,scope,()=>100,'knowledge'),sources=[];
 for(const r of refs)sources.push((await access.read({kind:'owner'},r.id))!.fence);
 await retention.expose(a.id,{sources,origins:[]});
 const checks=vi.spyOn(retention,'assertCurrent');
 await retention.expose(a.id,{sources,origins:[]});expect(checks).toHaveBeenCalledTimes(2);
});
it('stops exposure registration when cancellation arrives during the origin proof',async()=>{
 const origin=await captured(),a=await admit(),source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!,controller=new AbortController();
 vi.spyOn(guard,'checkContext').mockImplementation(async()=>{controller.abort(new Error('exposure_cancelled'));return {state:'current'};});
 await expect(retention.expose(a.id,{sources:[source.fence],origins:[origin]},controller.signal)).rejects.toThrow('exposure_cancelled');
 expect(await env.DB.prepare('SELECT count(*) n FROM assistant_native_context_exposures WHERE conversation_id=?').bind(a.receipt.sessionId).first('n')).toBe(0);
});
async function captured(){
 snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:'e1',sourceGeneration:'sg1',sourceKind:'message',sourceId:'m1',chatId:'source-chat',sourceVersion:1,watermark:1,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Nora leads Cedar.',messageId:'m1',messageVersion:1}};
 const observed=await guard.observe(scope,{sourceKind:'message',sourceId:'m1',chatId:'source-chat'});
 await env.DB.batch([env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='source-chat' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,ref.id),env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'private','available')").bind(scope.installationId,scope.generation,'e1','sg1','source-chat'),env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','m1','source-chat',?,1,?,0)").bind(scope.installationId,scope.generation,'e1','sg1',ref.id,observed.hash)]);
 return (await guard.fence(ref.id))!;
}
it('keeps a context and native address when only source chat activity advances; action freshness still rejects',async()=>{
 const origin=await captured(),a=await admit();const source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!;
 await retention.expose(a.id,{sources:[source.fence],origins:[origin]});snapshot.watermark=2;
 await env.DB.prepare('UPDATE assistant_origin_conversations SET watermark=2 WHERE installation_id=?').bind(scope.installationId).run();
 expect(await guard.check(origin)).toBe(false);expect(await guard.checkContext(origin)).toEqual({state:'current'});
 await expect(retention.assertCurrent(a.id)).resolves.toBeUndefined();expect((await admit()).receipt.sessionId).toBe(a.receipt.sessionId);expect(destroyed).toEqual([]);
});
it('tombstones only sessions exposed to a corrected source before purging and blocks stale callbacks',async()=>{
 const a=await admit(),b=await admit('chat-B');await expose(a.id);await runtime.proposeReply(await runtime.resolveTask(a.id,{kind:'signal',type:'assistant.conversation.incoming',attributes:{taskRef:a.receipt.taskRef},body:JSON.stringify({eventId:(await env.DB.prepare('SELECT event_id FROM assistant_native_conversation_events WHERE task_ref=?').bind(a.receipt.taskRef).first<any>()).event_id,revision:1,kind:'incoming',author:{kind:'person',id:'nora'},occurredAt:1,body:'Synthetic input'})}),'reply');
 await new SourceController(env.DB,scope,{kind:'owner'},()=>100).correctReport(ref.id,1,{text:'Corrected',occurredAt:2});
 await expect(retention.assertCurrent(a.id)).rejects.toThrow('conversation_context_withdrawn');await expect(retention.assertCurrent(b.id)).resolves.toBeUndefined();
 expect(steps).toEqual(['abort','quiesce','destroy']);expect(destroyed).toEqual([a.receipt.sessionId]);
 expect(await env.DB.prepare('SELECT event_json FROM assistant_native_conversation_events WHERE task_ref=?').bind(a.receipt.taskRef).first()).toEqual({event_json:null});
 await expect(expose(a.id)).rejects.toThrow('conversation_context_withdrawn');
});
it('suspends unavailable Reader checks without tombstoning and resumes the same epoch',async()=>{
 const origin=await captured(),a=await admit(),source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!;
 await retention.expose(a.id,{sources:[source.fence],origins:[origin]});unavailable=true;
 await expect(retention.assertCurrent(a.id)).rejects.toThrow('conversation_context_unavailable');expect(destroyed).toEqual([]);
 unavailable=false;await expect(retention.assertCurrent(a.id)).resolves.toBeUndefined();
});
it.each(['reader','local'] as const)('diagnoses %s proof failure without logging evidence or arbitrary exception text',async phase=>{
 const origin=await captured(),a=await admit(),source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!;
 await retention.expose(a.id,{sources:[source.fence],origins:[origin]});
 const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
 if(phase==='reader')unavailable=true;else vi.spyOn(guard,'fence').mockRejectedValueOnce(Error('PRIVATE_SENTINEL SQL source-chat Nora leads Cedar.'));
 await expect(retention.assertCurrent(a.id)).rejects.toThrow('conversation_context_unavailable');
 expect(warning).toHaveBeenCalledWith('native_context_proof_diagnostic',expect.objectContaining({phase:phase==='reader'?'reader_rpc':'pre_fence_sql',reason:phase==='reader'?'reader_unavailable':'exception',sourceKind:'message'}));
 const logged=JSON.stringify(warning.mock.calls);for(const privateValue of ['PRIVATE_SENTINEL','Nora','source-chat',ref.id])expect(logged).not.toContain(privateValue);
 expect(destroyed).toEqual([]);
});
it('registers event source dependencies before native dispatch and denies unsupported WhatsApp proofs',async()=>{
 await captured();const a=await admit('chat-A','event',ref);expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM assistant_native_context_exposures WHERE conversation_id=?').bind(a.receipt.sessionId).first()).toEqual({count:1});
 const source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!;
 await expect(retention.expose(a.id,{sources:[source.fence],origins:[]})).rejects.toThrow('conversation_exposure_proof');
});
it('denies the relational authority latch after a correction even before invalidation runs',async()=>{
 const a=await admit();await expose(a.id);const latch=retention.authorityGuard(a.receipt.sessionId);const valid=async()=>env.DB.prepare(`SELECT CASE WHEN (${latch.sql}) THEN 1 ELSE 0 END AS valid`).bind(...latch.values).first();
 expect(await valid()).toEqual({valid:1});await new SourceController(env.DB,scope,{kind:'owner'},()=>100).withdraw(ref.id,1);expect(await valid()).toEqual({valid:0});
});
it('a tombstoned epoch cannot become the logical channel current identity again',async()=>{
 const a=await admit();expect(await retention.currentIdentity('whatsapp','chat-A')).toEqual(a.id);await retention.purge(a.id);expect(await retention.currentIdentity('whatsapp','chat-A')).toBeNull();
 await expect(admit()).rejects.toThrow('conversation_context_withdrawn');const fresh={...identity,contextEpoch:'ctx2'};await retention.register(fresh);expect(await retention.currentIdentity('whatsapp','chat-A')).toEqual(fresh);
});

it('blocks publication when a tool source is withdrawn concurrently with exposure registration',async()=>{
 const a=await admit();const claim:KnowledgeClaim={id:'claim',subject:{id:'nora',kind:'person',name:'Nora'},predicate:'leads',object:{id:'cedar',kind:'project',name:'Cedar'},classification:'reported',evidence:[{id:'e',sourceRef:ref}],supportGroups:[{id:'g',evidence:[{id:'e',sourceRef:ref}]}]};
 vi.spyOn(port,'query').mockResolvedValue({claims:[claim]});
 const service=new KnowledgeService(env.DB,()=>({scope,client:'conversation_agent'}),port,()=>100).withExposure(async proof=>{
  await new SourceController(env.DB,scope,{kind:'owner'},()=>100).withdraw(ref.id,1);await retention.expose(a.id,proof);
 });
 await expect(service.execute({kind:'query'})).rejects.toThrow('conversation_exposure_changed');
 expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM assistant_native_context_exposures WHERE conversation_id=?').bind(a.receipt.sessionId).first()).toEqual({count:0});
});
it('tracks proof metadata for entities before exposing names and rejects source-free native claims',async()=>{
 const a=await admit();const claim:KnowledgeClaim={id:'claim',subject:{id:'nora',kind:'person',name:'Nora'},predicate:'leads',object:{id:'cedar',kind:'project',name:'Cedar'},classification:'reported',evidence:[{id:'e',sourceRef:ref}],supportGroups:[{id:'g',evidence:[{id:'e',sourceRef:ref}]}]};
 vi.spyOn(port,'query').mockResolvedValue({claims:[claim]});vi.spyOn(port,'find_entities').mockResolvedValue({entities:[claim.subject]});
 const service=new KnowledgeService(env.DB,()=>({scope,client:'conversation_agent'}),port,()=>100).withExposure(proof=>retention.expose(a.id,proof));
 expect(await service.execute({kind:'entities'})).toMatchObject({entities:[{name:'Nora'}]});
 expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM assistant_native_context_exposures WHERE conversation_id=?').bind(a.receipt.sessionId).first()).toEqual({count:1});
 vi.spyOn(port,'query').mockResolvedValue({claims:[{...claim,evidence:[],supportGroups:[]}]});
 expect(await service.execute({kind:'query'})).toMatchObject({claims:[]});
});
it('exclusion of one observed group invalidates the epoch even with another valid support source',async()=>{
 await captured();snapshot.conversationKind='group';const observed=await guard.observe(scope,{sourceKind:'message',sourceId:'m1',chatId:'source-chat'});
 await env.DB.batch([env.DB.prepare("UPDATE assistant_origin_conversations SET kind='group' WHERE installation_id=?").bind(scope.installationId),env.DB.prepare('UPDATE assistant_source_origins SET observation_hash=? WHERE installation_id=?').bind(observed.hash,scope.installationId),env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,group_mode) VALUES(?,?,'source-chat','group','observe')").bind(scope.installationId,scope.generation)]);
 const a=await admit(),origin=(await guard.fence(ref.id))!,source=(await new SourceAccess(env.DB,scope,()=>100,'knowledge').read({kind:'owner'},ref.id))!;
 await retention.expose(a.id,{sources:[source.fence],origins:[origin]});
 await env.DB.prepare("UPDATE assistant_conversation_policies SET excluded=1,revision=revision+1 WHERE installation_id=? AND conversation_id='source-chat'").bind(scope.installationId).run();
 await expect(retention.assertCurrent(a.id)).rejects.toThrow('conversation_context_withdrawn');expect(destroyed).toEqual([a.receipt.sessionId]);
});
it('never claims physical deletion when the native destroy port is absent or fails',async()=>{
 const a=await admit(),withoutPort=new NativeConversationRetention(env.DB,()=>scope,guard,undefined,()=>100);
 expect(await withoutPort.purge(a.id)).toEqual({state:'tombstoned',sessionId:a.receipt.sessionId});
 const failing=new NativeConversationRetention(env.DB,()=>scope,guard,{async abort(){},async quiesce(){},async destroy(){throw Error('native unavailable');}},()=>100);
 expect(await failing.purge(a.id)).toEqual({state:'tombstoned',sessionId:a.receipt.sessionId});
 expect(await env.DB.prepare('SELECT state FROM assistant_native_context_purges WHERE conversation_id=?').bind(a.receipt.sessionId).first()).toEqual({state:'tombstoned'});
});

// Fault injection at statement execution, after all awaited authority checks.
function raceAtIntentSql(kind:'read'|'insert',mutate:()=>Promise<void>){
 let injected=false;
 return {get injected(){return injected;},db:new Proxy(env.DB,{get(db,key){
  if(key!=='prepare'){const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}
  return (sql:string)=>{
   const matches=kind==='read'?sql.startsWith('SELECT id,state,request_hash AS requestHash'):sql.startsWith('INSERT INTO assistant_native_reply_intents');
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(statement,method){
    if(method==='bind')return (...values:unknown[])=>wrap(statement.bind(...values));
    const value=Reflect.get(statement,method);
    if(matches&&method===(kind==='read'?'first':'run'))return async(...args:unknown[])=>{if(!injected){injected=true;await mutate();}return value.apply(statement,args);};
    return typeof value==='function'?value.bind(statement):value;
   }});
   return wrap(db.prepare(sql));
  };
 }})};
}
async function taskFor(a:Awaited<ReturnType<typeof admit>>){
 const stored=await env.DB.prepare('SELECT event_json FROM assistant_native_conversation_events WHERE task_ref=?').bind(a.receipt.taskRef).first<{event_json:string}>();
 const {identity:_,...body}=JSON.parse(stored!.event_json);
 return runtime.resolveTask(a.id,{kind:'signal',type:'assistant.conversation.incoming',attributes:{taskRef:a.receipt.taskRef},body:JSON.stringify(body)});
}
it.each(['proposed','approved'] as const)('denies %s status when withdrawal occurs exactly at final intent SQL',async(state)=>{
 const a=await admit();await expose(a.id);const task=await taskFor(a),intent=await runtime.proposeReply(task,'Synthetic reply');
 await env.DB.prepare('UPDATE assistant_native_reply_intents SET state=? WHERE id=?').bind(state,intent.id).run();
 const race=raceAtIntentSql('read',async()=>{await new SourceController(env.DB,scope,{kind:'owner'},()=>100).withdraw(ref.id,1);});
 const raced=new ConversationRuntime(race.db,host,()=>100);
 await expect(raced.intentStatus(task,intent.id)).rejects.toThrow('conversation_context_withdrawn');expect(race.injected).toBe(true);
});
it.each(['withdraw','correction','exclusion'] as const)('does not persist an intent when %s occurs exactly at final intent SQL',async(kind)=>{
 if(kind==='exclusion')await captured();const a=await admit('chat-A','event',ref),task=await taskFor(a);
 const race=raceAtIntentSql('insert',async()=>{
  const sources=new SourceController(env.DB,scope,{kind:'owner'},()=>100);
  if(kind==='withdraw')await sources.withdraw(ref.id,1);
  else if(kind==='correction')await sources.correctReport(ref.id,1,{text:'Corrected',occurredAt:2});
  else await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded) VALUES(?,?,'source-chat','private',1)").bind(scope.installationId,scope.generation).run();
 });
 const raced=new ConversationRuntime(race.db,host,()=>100);
 await expect(raced.proposeReply(task,'Synthetic reply')).rejects.toThrow('conversation_context_withdrawn');expect(race.injected).toBe(true);
 expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM assistant_native_reply_intents WHERE conversation_id=?').bind(a.receipt.sessionId).first()).toEqual({count:0});
});
