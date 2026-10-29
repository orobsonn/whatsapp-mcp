import {env} from 'cloudflare:test';
import {beforeEach,expect,test,vi} from 'vitest';
import {RetentionPurge} from '../assistant/retention-purge';
import {SourceController} from '../assistant/sources';
import {SourceAccess} from '../assistant/access';
import {KnowledgeService} from '../assistant/knowledge/service';
import type {KnowledgeCommand,KnowledgeContext,KnowledgePort} from '../assistant/knowledge/contracts';

const owner={kind:'owner'} as const,retirement={allow:async()=>{},withdraw:async()=>{}};
let context:KnowledgeContext,service:KnowledgeService,controller:SourceController,port:KnowledgePort;
beforeEach(()=>{
 context={scope:{installationId:crypto.randomUUID(),generation:'current',sourceEpoch:'epoch',sourceGeneration:'source'},client:'owner_mcp'};
 controller=new SourceController(env.DB,context.scope,owner,()=>100,retirement);
 port={remember:vi.fn(async operationId=>({operationId,state:'ready' as const})),status:vi.fn(async operationId=>({operationId,state:'ready' as const})),query:async()=>({claims:[]}),get_entity:async()=>null,find_entities:async()=>({entities:[]}),withdraw:async operationId=>({operationId,state:'ready' as const})};
 service=new KnowledgeService(env.DB,()=>context,port,()=>100,retirement);
});
async function report(operationId:string,text:string){return (await service.execute({kind:'context.report',operationId,text})).sourceRef as {id:string;revision:number;version:number;hash:string};}
function remember(refs:Awaited<ReturnType<typeof report>>[],operationId='remember'):KnowledgeCommand{return {kind:'remember',operationId,entities:[{key:'a',kind:'person',name:'Synthetic Alice'},{key:'b',kind:'project',name:'Synthetic Project'}],relations:[{subjectId:'a',objectId:'b',predicate:'owns',classification:'reported',evidence:refs.map(sourceRef=>({sourceRef,quote:'private'}))}]};}
async function purge(sourceId:string){const purge=new RetentionPurge(env.DB,context.scope,owner,()=>200,retirement);for(let pass=0;pass<20;pass++){const result=await purge.advance({kind:'source.purge',operationId:'purge',sourceId});if(result.state!=='pending')return result;}throw Error('purge_unfinished');}
async function session(sourceId:string,exposure:boolean,scope=context.scope){
 const id=crypto.randomUUID(),intent=crypto.randomUUID();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO assistant_native_conversations VALUES(?,?,?,'{}',NULL,1)").bind(id,scope.installationId,scope.generation),
  env.DB.prepare("INSERT INTO assistant_native_conversation_events(conversation_id,event_id,revision,task_ref,request_hash,event_json,authority_json,created_at) VALUES(?,'event',1,?,'hash',?,'{}',1)").bind(id,crypto.randomUUID(),JSON.stringify({body:'private copied event',...(exposure?{}:{sourceRef:{id:sourceId}})})),
  env.DB.prepare("INSERT INTO assistant_native_reply_intents VALUES(?,?,?,1,'hash','approved',1)").bind(intent,id,crypto.randomUUID()),
  env.DB.prepare("INSERT INTO assistant_native_reply_actions(intent_id,installation_id,generation,conversation_id,task_json,text,summary,action_id,prepared_json,authority_json,human_guard_json,receipt_json,created_at) VALUES(?,?,?,?,?,'private reply','private summary','action:'||?,?,'{}','{}',?,1)").bind(intent,scope.installationId,scope.generation,id,JSON.stringify({body:'private task'}),intent,JSON.stringify({text:'private prepared'}),JSON.stringify({actionId:'action:'+intent,status:'accepted'})),
  ...(exposure?[env.DB.prepare("INSERT INTO assistant_native_context_exposures VALUES(?,?,?,?,?,'{}',NULL,1)").bind(crypto.randomUUID(),scope.installationId,scope.generation,id,sourceId)]:[]),
 ]);return {id,intent};
}
const operation=(id:string)=>env.DB.prepare('SELECT * FROM assistant_knowledge_operations WHERE installation_id=? AND generation=? AND id=?').bind(context.scope.installationId,context.scope.generation,id).first<Record<string,unknown>>();
const terminal=(operationId:string)=>({operationId,state:'partial',error:'source_purged'});

test('purges exact native/knowledge/FTS closure, preserves independent context and all financial generations, and replays terminal receipts',async()=>{
 const a=await report('report-a','private uniquepurgeterm'),b=await report('report-b','private survivingterm'),command=remember([a,b]);
 await service.execute(command);
 const exposed=await session(a.id,true),fallback=await session(a.id,false),independent=await session(b.id,true),foreign=await session(a.id,true,{...context.scope,installationId:crypto.randomUUID()});
 // Accepted owner report can have its source committed before its ACK/response.
 await env.DB.prepare("UPDATE assistant_knowledge_operations SET response_json=NULL,normalized_json=NULL,state='accepted' WHERE installation_id=? AND id='report-a'").bind(context.scope.installationId).run();
 // Typed host paths, including the legacy array fence form, must be erased.
 for(const [id,request,normalized,fences,response] of [
  ['request-id',{sourceId:a.id,text:'private'},null,null,null],
  ['previous-ref',{}, {previousRef:{id:a.id},sourceCommand:{text:'private'}},null,null],
  ['fence-only',{}, {entities:[{name:'private'}]},[{source:{id:a.id}}],null],
  ['response-only',{},null,null,{sourceRef:{id:a.id},text:'private'}],
  ['unrelated',{text:a.id},null,null,null],
  ['modern-fence-only',{},null,{sources:[{source:{id:a.id}}],origins:[]},null],
  ['request-ref',{sourceRef:{id:a.id},text:'private'},null,null,null],
  ['normalized-evidence',{}, {relations:[{evidence:[{sourceRef:{id:a.id},quote:'private'}]}]},null,null],
 ] as const)await env.DB.prepare("INSERT INTO assistant_knowledge_operations VALUES(?,?,?,'remember','owner_mcp','hash',?,?,?,'accepted',?,NULL,1,1)").bind(context.scope.installationId,context.scope.generation,id,JSON.stringify(request),normalized?JSON.stringify(normalized):null,fences?JSON.stringify(fences):null,response?JSON.stringify(response):null).run();
 for(const [generation,state,period] of [['current','attempting','now'],['historic','uncertain','before']] as const)await env.DB.prepare('INSERT INTO assistant_native_model_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)').bind(context.scope.installationId,generation,exposed.id,'epoch','turn','operation-'+generation,period,'hash','price',10,state).run();
 const reviewId=crypto.randomUUID();
 await env.DB.prepare(`INSERT INTO assistant_native_telegram_reviews(installation_id,generation,bot_instance,id,intent_id,conversation_id,operation_id,fence_json,credential_hash,thread_id,action_id,action_hash,review_hash,context_source_id,context_ref_json,context_guard_json,expires_at,state,created_at) VALUES(?,?,'bot',?,?,?,'review','{}','hash',1,'action','hash','hash',?,?,?,1000,'sent',1)`).bind(context.scope.installationId,context.scope.generation,reviewId,exposed.intent,exposed.id,a.id,JSON.stringify(a),JSON.stringify({sql:'source guard',values:[a.id]})).run();
 await env.DB.prepare("INSERT INTO assistant_native_model_receipts VALUES(?,?,'paid-session','epoch','turn','paid-operation','now','hash','price',10,'complete',1,2,3)").bind(context.scope.installationId,context.scope.generation).run();
 for(const [generation,period,state,actual] of [['current','now','reserved',null],['historic','before','settled',3],['current','previous','uncertain',null]] as const)await env.DB.batch([
  env.DB.prepare('INSERT INTO assistant_budget_accounts VALUES(?,?,?,1000,0)').bind(context.scope.installationId,generation,period),
  env.DB.prepare('INSERT INTO assistant_budget_reservations VALUES(?,?,?,?,?,10,?,?)').bind(context.scope.installationId,generation,'budget-'+generation+'-'+period,period,'a'.repeat(64),state,actual),
 ]);
 const finances=async()=>({native:(await env.DB.prepare('SELECT * FROM assistant_native_model_receipts WHERE installation_id=? ORDER BY generation,operation_key').bind(context.scope.installationId).all()).results,budget:(await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=? ORDER BY generation,period').bind(context.scope.installationId).all()).results});
 const financialBefore=await finances();
 await controller.withdraw(a.id,a.revision);const result=await purge(a.id);
 expect(result).toMatchObject({state:'complete',d1:'purged',nativeContexts:'tombstoned_pending_physical',externalIndex:'pending',financial:'preserved_installation_all_generations'});
 expect(await purge(a.id)).toEqual(result);
 expect(await env.DB.prepare('SELECT count(*) AS n FROM assistant_source_versions WHERE installation_id=? AND source_id=?').bind(context.scope.installationId,a.id).first('n')).toBe(0);
 expect(await new SourceAccess(env.DB,context.scope).read(owner,b.id)).not.toBeNull();
 for(const record of [exposed,fallback]){
  expect(await env.DB.prepare('SELECT tombstoned_at FROM assistant_native_conversations WHERE id=?').bind(record.id).first('tombstoned_at')).toBe(200);
  expect(await env.DB.prepare('SELECT event_json,state FROM assistant_native_conversation_events WHERE conversation_id=?').bind(record.id).first()).toEqual({event_json:null,state:'withdrawn'});
  expect(await env.DB.prepare('SELECT state FROM assistant_native_reply_intents WHERE id=?').bind(record.intent).first('state')).toBe('superseded');
  expect(await env.DB.prepare('SELECT state FROM assistant_native_context_purges WHERE conversation_id=?').bind(record.id).first('state')).toBe('tombstoned');
  expect(await env.DB.prepare('SELECT task_json,text,summary,prepared_json,authority_json,human_guard_json,action_id,receipt_json FROM assistant_native_reply_actions WHERE intent_id=?').bind(record.intent).first()).toEqual({task_json:'{}',text:'',summary:'',prepared_json:null,authority_json:null,human_guard_json:null,action_id:'action:'+record.intent,receipt_json:JSON.stringify({actionId:'action:'+record.intent,status:'accepted'})});
 }
 for(const record of [independent,foreign])expect(await env.DB.prepare('SELECT event_json FROM assistant_native_conversation_events WHERE conversation_id=?').bind(record.id).first('event_json')).toContain('private');
 for(const id of ['report-a','remember','request-id','previous-ref','fence-only','response-only','modern-fence-only','request-ref','normalized-evidence']){
  expect(await operation(id)).toMatchObject({request_json:'{}',normalized_json:null,source_fences_json:null,response_json:JSON.stringify(terminal(id)),state:'complete',error:'source_purged'});
  expect(await service.execute({kind:'status',operationId:id})).toEqual(terminal(id));
 }
 expect(await service.execute(command)).toEqual(terminal('remember'));
 await expect(service.execute({...command,operationId:'after-purge'} as KnowledgeCommand)).rejects.toThrow('knowledge_source_unavailable');
 expect(await operation('after-purge')).toBeNull();
 expect(await service.execute({kind:'context.report',operationId:'report-a',text:'private uniquepurgeterm'})).toEqual(terminal('report-a'));
 expect(await operation('report-b')).not.toHaveProperty('error','source_purged');
 expect((await operation('unrelated'))?.request_json).toContain(a.id);
 expect(port.remember).toHaveBeenCalledTimes(1);expect(port.status).not.toHaveBeenCalled();
 expect(await env.DB.prepare("SELECT count(*) AS n FROM assistant_archive_text WHERE assistant_archive_text MATCH 'uniquepurgeterm'").first('n')).toBe(0);
 expect(await env.DB.prepare("SELECT count(*) AS n FROM assistant_archive_text WHERE assistant_archive_text MATCH 'survivingterm' AND installation_id=?").bind(context.scope.installationId).first('n')).toBe(1);
 expect(await finances()).toEqual(financialBefore);
 expect(await env.DB.prepare('SELECT context_source_id,context_ref_json,context_guard_json,state FROM assistant_native_telegram_reviews WHERE id=?').bind(reviewId).first()).toEqual({context_source_id:null,context_ref_json:'{}',context_guard_json:null,state:'cancelled'});
});

test('a native write completing after purge cannot resurrect operation payload or a ready receipt',async()=>{
 const a=await report('report','private race'),command=remember([a]);let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),waiting=new Promise<void>(resolve=>{release=resolve;});
 port.remember=vi.fn(async operationId=>{enter();await waiting;return {operationId,state:'ready' as const};});
 const pending=service.execute(command);await entered;await controller.withdraw(a.id,a.revision);expect(await purge(a.id)).toMatchObject({state:'complete'});release();
 expect(await pending).toEqual(terminal('remember'));
 expect(await service.execute(command)).toEqual(terminal('remember'));expect(port.remember).toHaveBeenCalledTimes(1);
 expect(await operation('remember')).toMatchObject({request_json:'{}',normalized_json:null,source_fences_json:null,response_json:JSON.stringify(terminal('remember')),error:'source_purged'});
});

test('an owner report completion after purge stays terminal even when its Source ACK was still in flight',async()=>{
 let enter!:()=>void,release!:()=>void,sourceId!:string;const entered=new Promise<void>(resolve=>{enter=resolve;}),waiting=new Promise<void>(resolve=>{release=resolve;});
 const execute=SourceController.prototype.execute,spy=vi.spyOn(SourceController.prototype,'execute').mockImplementation(async function(this:SourceController,raw){const result=await execute.call(this,raw);if((raw as {kind:string}).kind==='source.report'){sourceId=result.id;enter();await waiting;}return result;});
 try{const pending=service.execute({kind:'context.report',operationId:'late-report',text:'private delayed report'});await entered;await controller.withdraw(sourceId,1);expect(await purge(sourceId)).toMatchObject({state:'complete'});release();expect(await pending).toEqual(terminal('late-report'));expect(await operation('late-report')).toMatchObject({request_json:'{}',normalized_json:null,error:'source_purged'});}finally{spy.mockRestore();release();}
});

test('native host admission links purge owner Telegram originals and retained frames without touching another request',async()=>{
 const a=await report('host-owner-a','private owner input A'),b=await report('host-owner-b','private owner input B');
 const dependent=await session(a.id,false),independent=await session(b.id,false);
 // Only the host admission retains the source association here: the source
 // must still invalidate a frame whose event payload no longer carries it.
 await env.DB.prepare("UPDATE assistant_native_conversation_events SET event_json=? WHERE conversation_id=?").bind(JSON.stringify({body:'private native copy A'}),dependent.id).run();
 for(const [record,ref,updateId] of [[dependent,a,77],[independent,b,78]] as const){
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO assistant_native_host_events(installation_id,generation,conversation_id,event_id,event_revision,request_hash,source_id,source_ref_json,original_sequence,owner_link_json,created_at) VALUES(?,?,?, ?,1,'hash',?,?,NULL,'{}',1)`).bind(context.scope.installationId,context.scope.generation,record.id,'telegram:synthetic_bot:'+updateId,ref.id,JSON.stringify(ref)),
   env.DB.prepare(`INSERT INTO assistant_native_owner_responses(installation_id,generation,context_ref,conversation_id,request_hash,link_json,thread_id,state,created_at) VALUES(?,?,?,?, 'hash','{}',1,'attempting',1)`).bind(context.scope.installationId,context.scope.generation,'context:'+record.id,record.id),
   env.DB.prepare(`INSERT INTO assistant_telegram_updates(installation_id,generation,bot_instance,update_id,payload_hash,token,source_epoch,source_generation,link_revision,user_id,chat_id,message_id,message_date,thread_id,text,outcome,state,received_at) VALUES(?,?,'synthetic_bot',?,?,'token','epoch','source',1,'101','101',?,1,1,?,'pending','pending',1)`).bind(context.scope.installationId,context.scope.generation,updateId,'0'.repeat(64),updateId,ref.id===a.id?'private owner input A':'private owner input B'),
  ]);
 }
 await controller.withdraw(a.id,1);expect(await purge(a.id)).toMatchObject({state:'complete',nativeContexts:'tombstoned_pending_physical'});
 expect(await env.DB.prepare('SELECT tombstoned_at FROM assistant_native_conversations WHERE id=?').bind(dependent.id).first('tombstoned_at')).toBe(200);
 expect(await env.DB.prepare('SELECT source_ref_json,owner_link_json FROM assistant_native_host_events WHERE conversation_id=?').bind(dependent.id).first()).toEqual({source_ref_json:'{}',owner_link_json:null});
 expect(await env.DB.prepare('SELECT state FROM assistant_native_owner_responses WHERE conversation_id=?').bind(dependent.id).first('state')).toBe('cancelled');
 expect(await env.DB.prepare('SELECT text,state FROM assistant_telegram_updates WHERE installation_id=? AND update_id=77').bind(context.scope.installationId).first()).toEqual({text:null,state:'cancelled'});
 expect(await env.DB.prepare('SELECT text,state FROM assistant_telegram_updates WHERE installation_id=? AND update_id=78').bind(context.scope.installationId).first()).toEqual({text:'private owner input B',state:'pending'});
 expect(await env.DB.prepare('SELECT tombstoned_at FROM assistant_native_conversations WHERE id=?').bind(independent.id).first('tombstoned_at')).toBeNull();
});

test.each(['anchor','clarification'] as const)('purges native help copies and exact Telegram reply when its %s source is removed',async which=>{
 const anchor=await report('help-anchor','private original question'),clarification=await report('help-owner','private owner clarification');
 const dependent=await session(anchor.id,false),question=crypto.randomUUID();
 await env.DB.prepare(`INSERT INTO assistant_native_help_questions(installation_id,generation,bot_instance,id,conversation_id,context_ref,task_json,anchor_task_ref,source_id,source_ref_json,original_sequence,question_text,request_hash,link_json,credential_hash,thread_id,state,message_id,owner_update_id,clarification_source_id,clarification_ref_json,created_at,updated_at)
  VALUES(?,?,'synthetic_bot',?,?,?,'{"body":"private task"}','anchor-task',?,?,1,'private help question','hash','{}','hash',42,'answered',501,89,?,?,1,1)`)
  .bind(context.scope.installationId,context.scope.generation,question,dependent.id,'help-context:'+question,anchor.id,JSON.stringify(anchor),clarification.id,JSON.stringify(clarification)).run();
 await env.DB.prepare(`INSERT INTO assistant_native_help_replies(installation_id,generation,bot_instance,update_id,question_id,payload_hash,reply_to_message_id,link_json,created_at) VALUES(?,?,'synthetic_bot',89,?,'hash',501,'{}',1)`)
  .bind(context.scope.installationId,context.scope.generation,question).run();
 for(const [updateId,text] of [[89,'private owner clarification'],[90,'unrelated owner input']] as const)await env.DB.prepare(`INSERT INTO assistant_telegram_updates(installation_id,generation,bot_instance,update_id,payload_hash,token,source_epoch,source_generation,link_revision,user_id,chat_id,message_id,message_date,thread_id,text,outcome,state,received_at) VALUES(?,?,'synthetic_bot',?,?,'token','epoch','source',1,'101','101',?,1,42,?,'pending','pending',1)`)
  .bind(context.scope.installationId,context.scope.generation,updateId,'0'.repeat(64),updateId,text).run();
 const removed=which==='anchor'?anchor:clarification;await controller.withdraw(removed.id,1);
 expect(await purge(removed.id)).toMatchObject({state:'complete',nativeContexts:'tombstoned_pending_physical'});
 expect(await env.DB.prepare('SELECT task_json,source_ref_json,question_text,clarification_ref_json,state FROM assistant_native_help_questions WHERE id=?').bind(question).first())
  .toEqual({task_json:'{}',source_ref_json:'{}',question_text:null,clarification_ref_json:null,state:'cancelled'});
 expect(await env.DB.prepare('SELECT text,state FROM assistant_telegram_updates WHERE installation_id=? AND update_id=89').bind(context.scope.installationId).first()).toEqual({text:null,state:'cancelled'});
 expect(await env.DB.prepare('SELECT text,state FROM assistant_telegram_updates WHERE installation_id=? AND update_id=90').bind(context.scope.installationId).first()).toEqual({text:'unrelated owner input',state:'pending'});
});
