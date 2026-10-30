/** Synthetic protocol fixture for the disposable Cloudflare worker.
 * The transport is a Responses SSE simulator, never an inference call. Native
 * Flue/Pi own tools and history; KnowledgeService talks to the real graph. */
import {ConversationRuntime,conversationAddress,verifiedConversationEvent,type ConversationIdentity,type ConversationHandle} from '../../assistant/agent-runtime/conversation';
import {NativeConversationRetention,type NativeContextDestroyPort} from '../../assistant/agent-runtime/conversation-retention';
import {OriginGuard} from '../../assistant/origin-guard';
import {KnowledgeService} from '../../assistant/knowledge/service';
import {HttpKnowledgePort} from '../../assistant/knowledge/http-port';
import {InferenceBudget} from '../../assistant/budget';
import type {ConversationProviderHost} from '../../assistant/agent-runtime/conversation-provider';
import type {KnowledgeContext} from '../../assistant/knowledge/contracts';

export type NativeProbeRun={run:string;setupState?:'pending'|'ready';predicate:string;scope:{installationId:string;generation:string;sourceEpoch:string;sourceGeneration:string};sourceRef:{id:string;revision:number;version:number;hash:string};a:ConversationIdentity;b:ConversationIdentity};
const endpoint='https://assistente-memoria.robsonlins.com/knowledge';
export function probeKnowledge(db:D1Database,token:string,run:NativeProbeRun,client:KnowledgeContext['client']){
 const context:KnowledgeContext={scope:run.scope,client};
 return new KnowledgeService(db,()=>context,new HttpKnowledgePort({endpoint,token,namespace:{installationId:'synthetic-cf-knowledge',generation:'knowledge-v1'},operationalGeneration:run.scope.generation,client}));
}
export async function setupNativeProbe(db:D1Database,token:string,requestedRun=crypto.randomUUID()){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestedRun))throw Error('native_probe_run_invalid');
 await db.prepare('CREATE TABLE IF NOT EXISTS native_probe_runs(run TEXT PRIMARY KEY,payload TEXT NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS native_probe_transports(id INTEGER PRIMARY KEY,run TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,detail TEXT NOT NULL)').run();
 const run=requestedRun,scope={installationId:'synthetic-cf-knowledge',generation:'conversation-'+run,sourceEpoch:'synthetic-e1',sourceGeneration:'synthetic-sg1'};
 const identity=(principal:string):ConversationIdentity=>({version:1,installationId:scope.installationId,generation:scope.generation,channel:'whatsapp',principalOrChatId:principal,contextEpoch:'native-epoch-1'});
 const existing=await db.prepare('SELECT payload FROM native_probe_runs WHERE run=?').bind(run).first<{payload:string}>();
 if(existing){const saved=JSON.parse(existing.payload) as NativeProbeRun;if(saved.setupState!=='pending')return saved;}
 const fixture={run,setupState:'pending',predicate:'synthetic-native-leads-'+run,scope,a:identity('synthetic-chat-A'),b:identity('synthetic-chat-B')} as NativeProbeRun;
 // Record identity before any source/graph mutation. A lost setup ACK is
 // reconciled with this exact run and these exact operation IDs.
 await db.prepare('INSERT INTO native_probe_runs(run,payload) VALUES(?,?) ON CONFLICT DO NOTHING').bind(run,JSON.stringify(fixture)).run();
 const owner=probeKnowledge(db,token,fixture,'owner_mcp'),text='Synthetic person '+run+' leads synthetic project '+run+'.';
 // Report origin keys survive operational generations as retirement fences.
 // A fresh test must create a fresh source, never resurrect a withdrawn key.
 const report=await owner.execute({kind:'context.report',operationId:'owner-mcp-report-'+run,text}) as any;
 if(report.state!=='recorded'||report.origin!=='owner_report')throw Error('native_probe_report');fixture.sourceRef=report.sourceRef;
 const remembered=await owner.execute({kind:'remember',operationId:'owner-mcp-seed-relation',entities:[{key:'person',kind:'person',name:'Synthetic person '+run},{key:'project',kind:'project',name:'Synthetic project '+run}],relations:[{subjectId:'person',predicate:fixture.predicate,objectId:'project',classification:'reported',evidence:[{sourceRef:fixture.sourceRef,quote:text}]}]});
 if(remembered.state!=='ready')throw Error('native_probe_seed_uncertain');
 const budget=new InferenceBudget(db,{...scope,period:'synthetic-protocol-ledger'});await budget.configure(10_000_000);
 fixture.setupState='ready';await db.prepare('UPDATE native_probe_runs SET payload=? WHERE run=?').bind(JSON.stringify(fixture),run).run();
 return fixture;
}
export async function loadNativeProbe(db:D1Database,run:string){const row=await db.prepare('SELECT payload FROM native_probe_runs WHERE run=?').bind(run).first<{payload:string}>();if(!row)throw Error('native_probe_run_missing');const saved=JSON.parse(row.payload) as NativeProbeRun;if(saved.setupState==='pending'||!saved.sourceRef)throw Error('native_probe_setup_pending');return saved;}
export function createNativeProbeRuntime(db:D1Database,token:string,run:NativeProbeRun,open:(id:string)=>ConversationHandle,native?:NativeContextDestroyPort){
 const origin=new OriginGuard(db,()=>run.scope,{async readSnapshot(){throw Error('synthetic_probe_has_no_whatsapp_reader');}},'synthetic-only');
 const retention=new NativeConversationRetention(db,()=>run.scope,origin,native);
 const runtime=new ConversationRuntime(db,{retention,authority:async identity=>{
  if(identity.installationId!==run.scope.installationId||identity.generation!==run.scope.generation)throw Error('synthetic_scope_denied');
  return {ownerId:'synthetic-owner',sourceEpoch:run.scope.sourceEpoch,sourceGeneration:run.scope.sourceGeneration,policyRevision:1,grantRef:'synthetic-host-grant',mode:'shadow'};
 },authorizeEvent:async event=>{if(event.identity.generation!==run.scope.generation||!event.eventId.startsWith('synthetic-'))throw Error('synthetic_event_denied');},open,
 knowledge:task=>probeKnowledge(db,token,run,task.knowledge.client)});
 return {runtime,retention};
}
export async function nativeProbeEvent(db:D1Database,token:string,run:NativeProbeRun,chat:'a'|'b',sequence:number,body?:string){
 const text=body??(chat==='a'?'PROBE_QUERY:'+run.predicate:'Synthetic isolated acknowledgement B '+sequence);
 // The event's source proves its exact original input. The independently
 // seeded factual source is reached later through the real knowledge tool.
 const input=chat==='a'?await probeKnowledge(db,token,run,'owner_mcp').execute({kind:'context.report',operationId:'owner-input-'+run.run+'-'+chat+'-'+sequence,text,occurredAt:sequence}) as any:undefined;
 if(input&&input.state!=='recorded')throw Error('native_probe_input_report_uncertain');
 return verifiedConversationEvent({identity:run[chat],eventId:'synthetic-event-'+chat+'-'+sequence,revision:1,kind:'incoming',author:{kind:'person',id:'synthetic-participant-'+sequence},occurredAt:sequence,body:text,...(input?{sourceRef:input.sourceRef}:{})});
}
export async function nativeProbeModelHost(db:D1Database,run:NativeProbeRun,identity:ConversationIdentity,sessionId:string,turnId:string,retention:NativeConversationRetention):Promise<ConversationProviderHost>{
 if(sessionId!==await conversationAddress(identity,identity.channel,identity.principalOrChatId,identity.contextEpoch))throw Error('synthetic_model_session');
 const scope={...run.scope,period:'synthetic-protocol-ledger'};
 return {scope,sessionId,contextEpoch:identity.contextEpoch,turnId,budget:new InferenceBudget(db,scope),assertAuthority:()=>retention.assertCurrent(identity),authorityGuard:()=>retention.authorityGuard(sessionId),
 globalBudgetGuard:()=>({sql:`COALESCE((SELECT SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END) FROM assistant_budget_reservations WHERE installation_id=?),0)<=?`,values:[scope.installationId,10_000_000]}),maxOutputTokens:512,maxRequestBytes:2_000_000,maxResponseBytes:1_000_000,timeoutMs:15000};
}
/** Choose tools from the current native user message, and construct the answer
 * solely from the real function_call_output. No hardcoded relation/person. */
export function nativeProbeResponsesFetch(db:D1Database,operation:()=>{run:string;sessionId:string;turnId:string}):typeof fetch{return (async(_url,init)=>{
 const host=operation(),payload=JSON.parse(String(init?.body)),tail=payload.input.at(-1),hasOutput=tail?.type==='function_call_output';
 const users=payload.input.filter((x:any)=>x.role==='user'),lastUser=users.at(-1),match=JSON.stringify(lastUser??'').match(/PROBE_QUERY:([A-Za-z0-9-]+)/);
 const compaction=!(payload.tools??[]).some((t:any)=>t.name==='knowledge_query');
 let result:any,text:string;
 if(hasOutput){result=typeof tail.output==='string'?JSON.parse(tail.output):tail.output;const claims=result.claims??result.output?.claims??[];
  text=JSON.stringify({state:'synthetic-protocol-result',claims:claims.map((c:any)=>({subject:c.subject.name,predicate:c.predicate,object:c.object.name,sourceRefs:c.evidence.map((e:any)=>e.sourceRef)}))});
 }else text=compaction?'Synthetic native compaction summary':JSON.stringify({state:'synthetic-ack',currentUser:lastUser??null});
 const callTool=!hasOutput&&!compaction&&!!match;
 const delayMs=Math.min(10000,Number(JSON.stringify(lastUser??'').match(/PROBE_DELAY_MS:(\d+)/)?.[1]??0));
 await db.prepare('INSERT INTO native_probe_transports(run,session_id,turn_id,detail) VALUES(?,?,?,?)').bind(host.run,host.sessionId,host.turnId,JSON.stringify({model:payload.model,inputItems:payload.input.length,tools:(payload.tools??[]).map((t:any)=>t.name),toolOutput:hasOutput,toolRequested:callTool,compaction,delayMs,derivedClaimCount:result?.claims?.length??0,priorUserCount:users.length,returnedText:callTool?null:text})).run();
 if(delayMs)await new Promise<void>((resolve,reject)=>{
  const signal=init?.signal;if(signal?.aborted){reject(Error('synthetic_transport_aborted'));return;}
  const aborted=()=>{clearTimeout(timer);reject(Error('synthetic_transport_aborted'));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',aborted);resolve();},delayMs);
  signal?.addEventListener('abort',aborted,{once:true});
 });
 const id='resp_'+crypto.randomUUID().replaceAll('-',''),item:any=callTool?{type:'function_call',id:'fc_'+id,call_id:'call_'+id,name:'knowledge_query',arguments:JSON.stringify({predicate:match![1],limit:20}),status:'completed'}:{type:'message',id:'msg_'+id,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 const inputTokens=Math.ceil(JSON.stringify(payload.input).length/4),outputTokens=128;
 const events=[{type:'response.created',response:{id}},{type:'response.output_item.added',output_index:0,item:{...item,...(callTool?{arguments:''}:{content:[]})}},...(callTool?[{type:'response.function_call_arguments.done',output_index:0,arguments:item.arguments}]:[{type:'response.output_text.delta',output_index:0,content_index:0,delta:text}]),{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:inputTokens,output_tokens:outputTokens,total_tokens:inputTokens+outputTokens}}}];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 }) as typeof fetch;}
