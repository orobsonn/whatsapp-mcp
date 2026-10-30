/** Disposable CF seam proof. Native Flue/Pi and production provider protocol;
 * controlled SSE is test data, not an intelligent response or a paid model. */
import {ConversationRuntime,conversationAddress,verifiedConversationEvent,type ConversationIdentity,type ConversationHandle,type TaskContext} from '../../assistant/agent-runtime/conversation';
import {InferenceBudget} from '../../assistant/budget';
import type {ConversationProviderHost} from '../../assistant/agent-runtime/conversation-provider';
import {KnowledgeService} from '../../assistant/knowledge/service';
export type SeamMode='error'|'normal'|'uncertain'|'overflow'|'headroom';
export type SeamRun={run:string;mode:SeamMode;session_id:string;identity_json:string;released:number;cancelled:number};
type Op={sessionId:string;turnId:string;submissionId?:string};
type Call={leader:string;task_ref:string;input_kind:'due'|'owner';transports:number};
const runs=`CREATE TABLE IF NOT EXISTS sdk_seam_runs(run TEXT PRIMARY KEY,mode TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,identity_json TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0,cancelled INTEGER NOT NULL DEFAULT 0)`;
const scope=(r:SeamRun)=>({installationId:'synthetic-sdk-seam',generation:'sdk-seam-'+r.run,sourceEpoch:'synthetic-e1',sourceGeneration:'synthetic-g1'});
export async function findSeamRun(db:D1Database,sessionId:string){await db.prepare(runs).run();return db.prepare('SELECT * FROM sdk_seam_runs WHERE session_id=?').bind(sessionId).first<SeamRun>();}
async function load(db:D1Database,run:string){const r=await db.prepare('SELECT * FROM sdk_seam_runs WHERE run=?').bind(run).first<SeamRun>();if(!r)throw Error('sdk_seam_run_missing');return r;}
export async function setupSeamRun(db:D1Database,run:string,mode:SeamMode){
 if(!/^[a-f0-9-]{36}$/.test(run)||!['error','normal','uncertain','overflow','headroom'].includes(mode))throw Error('sdk_seam_input');
 await db.prepare(runs).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS sdk_seam_consumed(run TEXT NOT NULL,leader TEXT NOT NULL,task_ref TEXT NOT NULL,event_sequence INTEGER NOT NULL,input_kind TEXT NOT NULL,PRIMARY KEY(run,leader,task_ref))`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS sdk_seam_calls(run TEXT NOT NULL,turn_id TEXT NOT NULL,leader TEXT NOT NULL,task_ref TEXT NOT NULL,input_kind TEXT NOT NULL,transports INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run,turn_id))`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS sdk_seam_payloads(run TEXT NOT NULL,turn_id TEXT NOT NULL,compaction INTEGER NOT NULL,output_limit INTEGER NOT NULL,PRIMARY KEY(run,turn_id))`).run();
 const identity:ConversationIdentity={version:1,installationId:'synthetic-sdk-seam',generation:'sdk-seam-'+run,channel:'telegram',principalOrChatId:'synthetic-owner',contextEpoch:'one-native-epoch'};
 const id=await conversationAddress(identity,'telegram','synthetic-owner',identity.contextEpoch);
 await db.prepare('INSERT INTO sdk_seam_runs(run,mode,session_id,identity_json) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(run,mode,id,JSON.stringify(identity)).run();
 const saved=await load(db,run);if(saved.mode!==mode)throw Error('sdk_seam_run_conflict');
 await new InferenceBudget(db,{...scope(saved),period:'synthetic-sdk-seam-ledger'}).configure(1_000_000);
 return {run,mode,sessionId:id,paidModelCalls:0,modelTransport:'controlled-sse',ledger:'simulated-not-invoice'};
}
export function seamRuntime(db:D1Database,run:SeamRun,open:(id:string)=>ConversationHandle){
 return new ConversationRuntime(db,{authority:async identity=>{
  if(JSON.stringify(identity)!==run.identity_json)throw Error('sdk_seam_identity');
  return {ownerId:'synthetic-owner',sourceEpoch:'synthetic-e1',sourceGeneration:'synthetic-g1',policyRevision:1,grantRef:'synthetic-seam-only',mode:'shadow'};
 },authorizeEvent:async event=>{if(!['sdk-seam-due','sdk-seam-owner'].includes(event.eventId)||JSON.stringify(event.identity)!==run.identity_json)throw Error('sdk_seam_event');},open,
 knowledge:task=>{const unused=async()=>{throw Error('sdk_seam_unexpected_knowledge_tool');};return new KnowledgeService(db,()=>task.knowledge,{query:unused,remember:unused,status:unused,get_entity:unused,find_entities:unused,withdraw:unused});}});
}
export async function seamConsumed(db:D1Database,run:SeamRun,task:TaskContext,submissionId?:string){
 if(!submissionId||task.sessionId!==run.session_id)throw Error('sdk_seam_consumption');
 await db.prepare('INSERT INTO sdk_seam_consumed(run,leader,task_ref,event_sequence,input_kind) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING')
  .bind(run.run,submissionId,task.taskRef,task.watermark,task.workRef?'due':'owner').run();
}
export async function seamModelHost(db:D1Database,run:SeamRun,op:Op):Promise<ConversationProviderHost>{
 if(!op.submissionId||op.sessionId!==run.session_id)throw Error('sdk_seam_model_operation');
 let call=await db.prepare('SELECT * FROM sdk_seam_calls WHERE run=? AND turn_id=?').bind(run.run,op.turnId).first<Call>();
 if(!call){
  const cursor=await db.prepare('SELECT * FROM sdk_seam_consumed WHERE run=? AND leader=? ORDER BY event_sequence DESC LIMIT 1').bind(run.run,op.submissionId).first<Call>();
  if(!cursor)throw Error('sdk_seam_unobserved');
  await db.prepare('INSERT INTO sdk_seam_calls(run,turn_id,leader,task_ref,input_kind) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(run.run,op.turnId,op.submissionId,cursor.task_ref,cursor.input_kind).run();
  call=await db.prepare('SELECT * FROM sdk_seam_calls WHERE run=? AND turn_id=?').bind(run.run,op.turnId).first<Call>();
 }
 if(!call||call.leader!==op.submissionId)throw Error('sdk_seam_model_conflict');
 // The grant is captured per real native model turn, before transport awaits.
 const due=call.input_kind==='due',guard={sql:`EXISTS(SELECT 1 FROM sdk_seam_runs WHERE run=? AND session_id=?${due?' AND cancelled=0':''})`,values:[run.run,run.session_id]};
 return {scope:{...scope(run),period:'synthetic-sdk-seam-ledger'},sessionId:run.session_id,contextEpoch:JSON.parse(run.identity_json).contextEpoch,turnId:op.turnId,
  budget:new InferenceBudget(db,{...scope(run),period:'synthetic-sdk-seam-ledger'}),authorityGuard:()=>guard,
  async assertAuthority(){if(!await db.prepare(`SELECT 1 WHERE (${guard.sql})`).bind(...guard.values).first())throw Error('native_task_changed');},
  globalBudgetGuard:()=>({sql:'1',values:[]}),maxOutputTokens:512,maxRequestBytes:2_000_000,maxResponseBytes:1_000_000,timeoutMs:60000};
}
export function seamResponsesFetch(db:D1Database,run:SeamRun,op:Op):typeof fetch{return (async(_url,options)=>{
 const call=await db.prepare('SELECT * FROM sdk_seam_calls WHERE run=? AND turn_id=?').bind(run.run,op.turnId).first<Call>();if(!call)throw Error('sdk_seam_uncaptured_transport');
 await db.prepare('UPDATE sdk_seam_calls SET transports=transports+1 WHERE run=? AND turn_id=?').bind(run.run,op.turnId).run();
 const payload=JSON.parse(options?.body as string),compaction=!(payload.tools?.length),outputLimit=payload.max_output_tokens;
 await db.prepare('INSERT INTO sdk_seam_payloads(run,turn_id,compaction,output_limit) VALUES(?,?,?,?)').bind(run.run,op.turnId,compaction?1:0,outputLimit).run();
 if(call.input_kind==='due'){
  const deadline=Date.now()+45000;
  while(!(await load(db,run.run)).released){if(Date.now()>deadline||options?.signal?.aborted)throw Error('sdk_seam_gate_timeout');await new Promise(resolve=>setTimeout(resolve,50));}
 }
 if(run.mode==='uncertain')throw Error('synthetic_ambiguous_transport_only');
 const ownerCalls=await db.prepare("SELECT count(*) n FROM sdk_seam_payloads p JOIN sdk_seam_calls c ON c.run=p.run AND c.turn_id=p.turn_id WHERE c.run=? AND c.input_kind='owner' AND p.compaction=0").bind(run.run).first<number>('n');
 if(run.mode==='overflow'&&call.input_kind==='owner'&&!compaction&&ownerCalls===1)return Response.json({error:{code:'context_length_exceeded',message:'Synthetic private provider body must not enter native context'}},{status:400});
 const first=await db.prepare('SELECT count(*) n FROM sdk_seam_payloads WHERE run=? AND compaction=0').bind(run.run).first<number>('n');
 if(run.mode==='headroom'&&!compaction&&first===1){
  const id='resp_'+crypto.randomUUID().replaceAll('-',''),item={type:'function_call',id:'fc_'+id,call_id:'call_'+id,name:'knowledge_entities',arguments:'{"query":"Synthetic"}',status:'completed'};
  // Keep enough recent assistant context for Flue to split this tool turn;
  // the original long owner input must then be summarized natively.
  const text='Synthetic retained assistant context. '.repeat(160),note={type:'message',id:'msg_'+id,role:'assistant',phase:'commentary',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  const events=[{type:'response.created',response:{id}},{type:'response.output_item.added',output_index:0,item:{...note,content:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item:note},{type:'response.output_item.added',output_index:1,item:{...item,arguments:''}},{type:'response.function_call_arguments.done',output_index:1,arguments:item.arguments},{type:'response.output_item.done',output_index:1,item},{type:'response.completed',response:{id,status:'completed',output:[note,item],usage:{input_tokens:268899,output_tokens:418,total_tokens:269317}}}];
  return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 }
 const text='CONTROLLED_SDK_SEAM_'+call.input_kind.toUpperCase(),id='resp_'+crypto.randomUUID().replaceAll('-','');
 const item={type:'message',id:'msg_'+id,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 const events=[{type:'response.created',response:{id}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}}];
 return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 }) as typeof fetch;}
export async function seamProbeAction(db:D1Database,body:{action:string;run:string;mode?:SeamMode;kind?:'due'|'owner';taskRef?:string},open:(id:string)=>ConversationHandle){
 if(body.action==='sdk-seam-setup')return setupSeamRun(db,body.run,body.mode!);
 const run=await load(db,body.run),runtime=seamRuntime(db,run,open),identity=JSON.parse(run.identity_json) as ConversationIdentity;
 if(body.action==='sdk-seam-release'){await db.prepare('UPDATE sdk_seam_runs SET released=1,cancelled=? WHERE run=?').bind(run.mode==='error'?1:0,run.run).run();return {released:true,cancelled:run.mode==='error'};}
 if(body.action==='sdk-seam-dispatch'){
  const due=body.kind==='due';if(!due&&body.kind!=='owner')throw Error('sdk_seam_input');
  const text=(due?'Synthetic due protocol input':'Synthetic new owner protocol input')+(['overflow','headroom'].includes(run.mode)?' Synthetic retained original context.'.repeat(200):'');
  return runtime.deliverConversation(verifiedConversationEvent({identity,eventId:due?'sdk-seam-due':'sdk-seam-owner',revision:1,kind:due?'mission_due':'incoming',author:due?{kind:'system',id:'native-task-host'}:{kind:'owner',id:'synthetic-owner'},occurredAt:due?1:2,body:text,threadId:'43',
   ...(due?{sourceRef:{id:'synthetic-seam-source',revision:1,version:1,hash:'a'.repeat(64)},workRef:{kind:'mission',bindingId:'synthetic-binding',occurrenceId:'synthetic-occurrence',id:'synthetic-mission',version:1,dueAt:1}}:{})}));
 }
 if(body.action==='sdk-seam-read'){
  try{return {outcome:'succeeded',result:await runtime.read(body.taskRef!,{signal:AbortSignal.timeout(20000)})};}
  catch(error){if(error instanceof Error&&error.name==='AgentRunError')return {outcome:(error as Error&{outcome:string}).outcome};throw error;}
 }
 if(body.action==='sdk-seam-inspect')return {run,paidModelCalls:0,externalModelCalls:0,transport:'controlled-sse-only',
  consumed:(await db.prepare('SELECT leader,task_ref,event_sequence,input_kind FROM sdk_seam_consumed WHERE run=? ORDER BY event_sequence').bind(run.run).all()).results,
  calls:(await db.prepare('SELECT turn_id,leader,task_ref,input_kind,transports FROM sdk_seam_calls WHERE run=? ORDER BY rowid').bind(run.run).all()).results,
  payloads:(await db.prepare('SELECT turn_id,compaction,output_limit FROM sdk_seam_payloads WHERE run=? ORDER BY rowid').bind(run.run).all()).results,
  modelReceipts:(await db.prepare('SELECT turn_id,state,input_tokens,output_tokens,actual_units FROM assistant_native_model_receipts WHERE session_id=?').bind(run.session_id).all()).results};
 throw Error('sdk_seam_action');
}
