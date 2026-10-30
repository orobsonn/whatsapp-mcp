/** Native Flue/Pi + production conversation profile, synthetic SSE only.
 * A gated turn makes pending-versus-consumed observable without inference. */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root=resolve(import.meta.dirname,'..'),scratch=realpathSync(mkdtempSync(join(tmpdir(),'assistant-cohort-proof-')));
let config:any,runtime:Miniflare|undefined,externalCalls=0;
const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);
beforeAll(()=>{
 symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
 writeFileSync(join(scratch,'agents.ts'),`'use agent';
import {ConversationRuntimeAgent as Profile} from ${JSON.stringify(join(root,'assistant/agent-runtime/conversation-profiles.ts'))};
export function ConversationRuntimeAgent(){return Profile();}
ConversationRuntimeAgent.agentName='conversation-runtime';ConversationRuntimeAgent.initialData=Profile.initialData;ConversationRuntimeAgent.durability={maxAttempts:1,timeoutMs:120000};
`);
 writeFileSync(join(scratch,'app.ts'),`
import {init,setProvider} from '@flue/runtime';
import {getCloudflareContext} from '@flue/runtime/cloudflare';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {ConversationRuntimeAgent} from './agents';
import {configureConversationResolver} from ${JSON.stringify(join(root,'assistant/agent-runtime/conversation-profiles.ts'))};
import {ConversationRuntime,verifiedConversationEvent} from ${JSON.stringify(join(root,'assistant/agent-runtime/conversation.ts'))};
import {KnowledgeService} from ${JSON.stringify(join(root,'assistant/knowledge/service.ts'))};
const identity={version:1,installationId:'synthetic-cohort-proof',generation:'g1',channel:'telegram',principalOrChatId:'synthetic-owner',contextEpoch:'e1'};
function hostRuntime(env){return new ConversationRuntime(env.DB,{
 authority:async seed=>{if(JSON.stringify(seed)!==JSON.stringify(identity))throw Error('synthetic_scope_denied');return {ownerId:'synthetic-owner',sourceEpoch:'s1',sourceGeneration:'sg1',policyRevision:1,grantRef:'synthetic-host-only',mode:'shadow'};},
 authorizeEvent:async event=>{if(!event.eventId.startsWith('synthetic-event-'))throw Error('synthetic_event_denied');},
 open:id=>init(ConversationRuntimeAgent,{id}),
 knowledge:async task=>{
  await env.DB.prepare("INSERT INTO proof_events(kind,detail) VALUES('tool',?)").bind(JSON.stringify({taskRef:task.taskRef,cohort:task.cohort.map(e=>e.taskRef),authors:task.cohort.map(e=>e.author.id),returnChannel:task.returnChannel,contextRef:task.contextRef})).run();
  return new KnowledgeService(env.DB,()=>task.knowledge,{query:async()=>({claims:[]})});
 }
});}
configureConversationResolver(async env=>({runtime:hostRuntime(env),...(await env.DB.prepare("SELECT name FROM proof_flags WHERE name='finish-proof'").first()?{
 frame:async task=>({reads:{},media:{read:async()=>{throw Error('unexpected_media');}},effects:{
  respondOwner:async text=>{await env.DB.prepare("INSERT INTO proof_events(kind,detail) VALUES('effect',?)").bind(JSON.stringify({text,taskRef:task.taskRef,cohort:task.cohort.map(e=>e.taskRef)})).run();return {state:'sent'};},
  reply:async()=>{throw Error('unexpected_reply');},askOwner:async()=>{throw Error('unexpected_question');},calendarChange:async()=>{throw Error('unexpected_calendar');}}})}: {})}));
const native=openaiProvider(),base=native.getModels().find(m=>m.id==='gpt-6-luna');if(!base)throw Error('model_missing');
const model={...base,contextWindow:32768,maxTokens:512};
function options(original){return {...original,apiKey:'synthetic-no-credential',maxRetries:0,transport:'sse',fetch:async(_url,request)=>{
 const {env}=getCloudflareContext(),p=JSON.parse(request.body),raw=JSON.stringify(p.input);
 const sequence=Math.max(...[...raw.matchAll(/synthetic-event-([0-9]+)/g)].map(m=>Number(m[1])));
 const finishing=sequence>=10;
 const called=p.input.some(item=>item.type==='function_call'&&(finishing?item.name==='respond_owner'&&JSON.parse(item.arguments).text==='Synthetic completed delivery '+sequence:item.name==='knowledge_query'&&JSON.parse(item.arguments).predicate==='delivery-'+sequence));
 await env.DB.prepare("INSERT INTO proof_events(kind,detail) VALUES('transport',?)").bind(JSON.stringify({sequence,called,input:p.input})).run();
 if(sequence===1&&!called){
  const deadline=Date.now()+15000;while(!await env.DB.prepare("SELECT name FROM proof_flags WHERE name='release'").first()){
   if(Date.now()>deadline)throw Error('gate_timeout');await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
 if(sequence===2&&!called){
  const first=await env.DB.prepare("INSERT INTO proof_flags(name) VALUES('retried') ON CONFLICT DO NOTHING RETURNING name").first();
  if(first){await env.DB.prepare("INSERT INTO proof_events(kind,detail) VALUES('retry','synthetic-429')").run();return Response.json({error:{message:'synthetic transient throttle',type:'rate_limit_error',code:'rate_limit_exceeded'}},{status:429});}
 }
 const id='resp_'+crypto.randomUUID().replaceAll('-',''),text='Synthetic completed delivery '+sequence;
 const firstFinish=finishing?await env.DB.prepare("INSERT INTO proof_flags(name) VALUES(?) ON CONFLICT DO NOTHING RETURNING name").bind('first-finish-'+sequence).first():false;
 const final=called||finishing&&(!!firstFinish||sequence===11);
 const item=final?{type:'message',id:'msg_'+id,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}:{type:'function_call',id:'fc_'+id,call_id:'call_'+id,name:finishing?'respond_owner':'knowledge_query',arguments:JSON.stringify(finishing?{text}:{predicate:'delivery-'+sequence}),status:'completed'};
 const events=[{type:'response.created',response:{id}},{type:'response.output_item.added',output_index:0,item:{...item,...(final?{content:[]}:{arguments:''})}},...(final?[{type:'response.output_text.delta',output_index:0,content_index:0,delta:text}]:[{type:'response.function_call_arguments.done',output_index:0,arguments:item.arguments}]),{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}}];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+String.fromCharCode(10,10)).join(''),{headers:{'Content-Type':'text/event-stream'}});
 }};}
setProvider({...native,auth:{apiKey:{name:'Synthetic only',resolve:async()=>({auth:{apiKey:'synthetic-no-credential'}})}},getModels:()=>[model],stream:(m,c,o)=>native.stream(m,c,options(o)),streamSimple:(m,c,o)=>native.streamSimple(m,c,options(o))});
export default {async fetch(request,env){try{const {action,sequence,taskRef}=await request.json(),runtime=hostRuntime(env);
 if(action==='deliver')return Response.json(await runtime.deliverConversation(verifiedConversationEvent({identity,eventId:'synthetic-event-'+sequence,revision:1,kind:'incoming',author:{kind:'owner',id:'synthetic-author-'+sequence},occurredAt:sequence,body:'Synthetic question '+sequence,threadId:'topic-'+sequence})));
 if(action==='read')return Response.json(await runtime.read(taskRef,{signal:AbortSignal.timeout(30000)}));
 throw Error('unknown_action');
 }catch(error){return Response.json({error:String(error),cause:error.cause,outcome:error.outcome,submissionId:error.submissionId},{status:409});}}};
`);
 writeFileSync(join(scratch,'cloudflare.ts'),'export default {};');
 writeFileSync(join(scratch,'wrangler.jsonc'),JSON.stringify({name:'assistant-cohort-proof',compatibility_date:'2026-10-25',compatibility_flags:['nodejs_compat'],migrations:[{tag:'v1',new_sqlite_classes:['FlueConversationRuntimeAgent']}],d1_databases:[{binding:'DB',database_name:'synthetic',database_id:'00000000-0000-0000-0000-000000000001'}]}));
 writeFileSync(join(scratch,'vite.config.mts'),`
import {defineConfig} from 'vite';import {flue,flueWorkerConfig} from '@flue/vite';import {cloudflare} from '@cloudflare/vite-plugin';
export default defineConfig({root:${JSON.stringify(scratch)},envDir:false,plugins:[flue({target:'cloudflare',app:'app.ts',agents:'agents.ts',cloudflare:'cloudflare.ts',providers:[],tracing:false}),cloudflare({configPath:${JSON.stringify(join(scratch,'wrangler.jsonc'))},config:flueWorkerConfig(),persistState:false})],build:{outDir:${JSON.stringify(join(scratch,'dist'))}}});`);
 try{execFileSync(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build','--config',join(scratch,'vite.config.mts')],{cwd:root,stdio:'pipe'});}catch(error){throw Error(String((error as {stderr?:Buffer}).stderr??error));}
 const path=files(join(scratch,'dist')).find(path=>path.endsWith('wrangler.json'))!;
 config={...JSON.parse(readFileSync(path,'utf8')),directory:dirname(path)};
});
async function start(){
 await runtime?.dispose();const base=config.directory,main=resolve(base,config.main);
 runtime=new Miniflare({...convertV4MiniflareOptions({workers:[{name:'cohort-proof',modulesRoot:base,modules:[main,...files(base).filter(path=>/\.m?js$/.test(path)&&path!==main)].map(path=>({type:'ESModule' as const,path})),compatibilityDate:'2026-10-25',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],durableObjects:Object.fromEntries(config.durable_objects.bindings.map((binding:any)=>[binding.name,{className:binding.class_name,useSQLite:true}])),outboundService:()=>{externalCalls++;throw Error('external_forbidden');}}]}),resourcePersistencePath:join(scratch,'state')});
 return runtime.getD1Database('DB');
}
async function call(body:unknown){const response=await runtime!.dispatchFetch('https://synthetic.invalid/',{method:'POST',body:JSON.stringify(body)});const result=await response.json();expect(response.status,JSON.stringify(result)).toBe(200);return result as any;}
async function until(check:()=>Promise<boolean>){const deadline=Date.now()+20000;while(!await check()){if(Date.now()>deadline)throw Error('proof_wait_timeout');await new Promise(resolve=>setTimeout(resolve,20));}}
afterAll(async()=>{await runtime?.dispose();rmSync(scratch,{recursive:true,force:true});expect(externalCalls).toBe(0);});
async function initialize(db:Awaited<ReturnType<typeof start>>){
 if(!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_native_conversation_events'").first()){
  const sql=readFileSync(join(root,'assistant/migrations/0036_conversation_sessions.sql'),'utf8').replace(/^--.*$/gm,'');
  for(const statement of sql.split(';').filter(statement=>statement.trim()))await db.prepare(statement).run();
 }
 await db.prepare('CREATE TABLE IF NOT EXISTS proof_events(id INTEGER PRIMARY KEY,kind TEXT,detail TEXT)').run();await db.prepare('CREATE TABLE IF NOT EXISTS proof_flags(name TEXT PRIMARY KEY)').run();
}
test('real profile observes two joined deliveries, excludes pending input, retries the same cohort and resets after restart',async()=>{
 let db=await start();
 const sql=readFileSync(join(root,'assistant/migrations/0036_conversation_sessions.sql'),'utf8').replace(/^--.*$/gm,'');
 for(const statement of sql.split(';').filter(statement=>statement.trim()))await db.prepare(statement).run();
 await db.prepare('CREATE TABLE proof_events(id INTEGER PRIMARY KEY,kind TEXT,detail TEXT)').run();await db.prepare('CREATE TABLE proof_flags(name TEXT PRIMARY KEY)').run();
 const a=await call({action:'deliver',sequence:1});
 await until(async()=>Number(await db.prepare("SELECT count(*) FROM proof_events WHERE kind='transport'").first('count(*)'))===1);
 const b=await call({action:'deliver',sequence:2});expect(a.sessionId).toBe(b.sessionId);
 // B is admitted while A's model call is still blocked. No tool has read B.
 expect(await db.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='tool'").first('n')).toBe(0);
 await db.prepare("INSERT INTO proof_flags(name) VALUES('release')").run();
 const first=await call({action:'read',taskRef:a.taskRef}),joined=await call({action:'read',taskRef:b.taskRef});
 const metadata=first.reply.metadata.conversationCohort;
 expect(first.reply.text).toBe('Synthetic completed delivery 2');expect(joined.reply.text).toBe(first.reply.text);
 expect(metadata.taskRefs).toEqual([a.taskRef,b.taskRef]);expect(joined.reply.metadata.conversationCohort).toEqual(metadata);
 const tools=(await db.prepare("SELECT detail FROM proof_events WHERE kind='tool' ORDER BY id").all<{detail:string}>()).results.map(row=>JSON.parse(row.detail));
 expect(tools.map(tool=>tool.cohort)).toEqual([[a.taskRef],[a.taskRef,b.taskRef]]);
 expect(tools[1].authors).toEqual(['synthetic-author-1','synthetic-author-2']);
 expect(tools[1].returnChannel).toEqual({channel:'telegram',id:'synthetic-owner',threadId:'topic-2'});
 expect(tools[0].returnChannel.threadId).toBe('topic-1');
 expect(await db.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='retry'").first('n')).toBe(1);
 const payloads=(await db.prepare("SELECT detail FROM proof_events WHERE kind='transport' ORDER BY id").all<{detail:string}>()).results;
 expect(payloads[0].detail).not.toContain('synthetic-event-2');
 for(const payload of payloads){expect(payload.detail).not.toContain(metadata.responseToken);expect(payload.detail).not.toContain('conversationCohort');expect(payload.detail).not.toContain('synthetic-host-only');}
 db=await start();expect((await call({action:'read',taskRef:a.taskRef})).reply.metadata.conversationCohort).toEqual(metadata);
 const c=await call({action:'deliver',sequence:3}),next=await call({action:'read',taskRef:c.taskRef});
 expect(c.sessionId).toBe(a.sessionId);expect(next.reply.metadata.conversationCohort.taskRefs).toEqual([c.taskRef]);
 expect(next.reply.metadata.conversationCohort.responseToken).not.toBe(metadata.responseToken);
 const after=(await db.prepare("SELECT detail FROM proof_events WHERE kind='tool' ORDER BY id DESC LIMIT 1").first<{detail:string}>())!;
 expect(JSON.parse(after.detail).cohort).toEqual([c.taskRef]);expect(JSON.parse(after.detail).returnChannel.threadId).toBe('topic-3');
 const transport=(await db.prepare("SELECT detail FROM proof_events WHERE kind='transport' ORDER BY id DESC LIMIT 1").first<{detail:string}>())!;
 expect(transport.detail).toContain('synthetic-event-1');expect(transport.detail).toContain('synthetic-event-2');expect(transport.detail).toContain('synthetic-event-3');
});
test('finish continuation preserves the authenticated cursor and still rejects a second incomplete finish',async()=>{
 const db=await start();await initialize(db);await db.prepare("INSERT INTO proof_flags(name) VALUES('finish-proof')").run();
 const first=await call({action:'deliver',sequence:10}),completed=await call({action:'read',taskRef:first.taskRef});
 expect(completed.reply.metadata.conversationCohort.taskRefs).toEqual([first.taskRef]);
 const effects=(await db.prepare("SELECT detail FROM proof_events WHERE kind='effect'").all<{detail:string}>()).results.map(row=>JSON.parse(row.detail));
 expect(effects).toEqual([{text:'Synthetic completed delivery 10',taskRef:first.taskRef,cohort:[first.taskRef]}]);
 const second=await call({action:'deliver',sequence:11}),response=await runtime!.dispatchFetch('https://synthetic.invalid/',{method:'POST',body:JSON.stringify({action:'read',taskRef:second.taskRef})});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({outcome:'failed',submissionId:second.receipt.submissionId,cause:{type:'internal_error'}});
 // Public SDK errors intentionally redact the internal hook exception. Its
 // observable contract is one continuation, then failure without an effect.
 expect(await db.prepare("SELECT count(*) n FROM proof_events WHERE kind='transport' AND json_extract(detail,'$.sequence')=11").first<number>('n')).toBe(2);
 expect((await db.prepare("SELECT count(*) n FROM proof_events WHERE kind='effect'").first<number>('n'))).toBe(1);
});
