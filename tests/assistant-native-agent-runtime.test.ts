/** P0 compatibility probe: real Flue + Pi/OpenAI protocol, synthetic HTTP only.
 * No production agents or model credentials; does not measure model judgment. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const root=resolve(import.meta.dirname,".."), scratch=realpathSync(mkdtempSync(join(tmpdir(),"assistant-native-proof-")));
let config:any, runtime:Miniflare|undefined, externalCalls=0;
const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
beforeAll(()=>{
 symlinkSync(join(root,"node_modules"),join(scratch,"node_modules"),"dir");
 writeFileSync(join(scratch,"agents.ts"),`
'use agent';
import {useModel,useTool,useInitialData,useDelivery} from '@flue/runtime';
import {getCloudflareContext,extend} from '@flue/runtime/cloudflare';
export const cloudflare=extend({base:Base=>class extends Base{async proofRevision(){return this.env.PROBE_REVISION||'local';}async eraseForOwner(grant){if(grant!=='synthetic-owner-grant')throw Error('purge_denied');await this.destroy();}}});
import * as v from 'valibot';
export function NativeProof(){
 const seed=useInitialData(); const delivery=useDelivery();
 useModel('openai/gpt-6-luna',{thinkingLevel:'low',compaction:{reserveTokens:512,keepRecentTokens:128}});
 useTool({name:'lookup_relation',description:'Read the evidence for who leads the requested project.',input:v.object({project:v.string()}),async run({data}){
 const {env}=getCloudflareContext(); await env.DB.prepare('INSERT INTO proof_events(kind,detail) VALUES(?,?)').bind('tool',data.project).run();
 return {output:{person:'Nora',relation:'leads',project:data.project,evidence:'synthetic-original-1'}};
 }});
 return 'Use lookup_relation for project questions. Answer only from evidence. Internal seed:'+JSON.stringify(seed);
}
NativeProof.agentName='native-proof'; NativeProof.durability={maxAttempts:1,timeoutMs:30000};
`);
 writeFileSync(join(scratch,"app.ts"),`
import {init,setProvider,getAgentInstance} from '@flue/runtime';
import {getCloudflareContext} from '@flue/runtime/cloudflare';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {NativeProof} from './agents';
import {runKnowledgePolicyProof} from ${JSON.stringify(join(root,'tests/fixtures/assistant-knowledge-policy-probe.ts'))};
const native=openaiProvider();
const base=native.getModels().find(m=>m.id==='gpt-6-luna'); if(!base)throw Error('native_model_missing');
const model={...base,contextWindow:2048,maxTokens:256};
function options(original){let reserved=false; return {...original,apiKey:'synthetic-not-a-credential',maxRetries:0,transport:'sse',
 async onPayload(payload){const {env}=getCloudflareContext();
 const denied=await env.DB.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='deny'").first('n');
 if(denied)throw Error('budget_denied');
 const claim=await env.DB.prepare('INSERT INTO proof_claims(request) VALUES(?) ON CONFLICT DO NOTHING RETURNING request').bind(JSON.stringify(payload)).first();if(!claim)throw Error('already_attempted'); await env.DB.prepare('INSERT INTO proof_events(kind,detail) VALUES(?,?)').bind('reserved',JSON.stringify({tools:payload.tools,inputs:payload.input.length})).run();reserved=true;},
 async fetch(url,request){if(!reserved)throw Error('transport_without_reservation');reserved=false;const {env}=getCloudflareContext();
 const p=JSON.parse(request.body);await env.DB.prepare('INSERT INTO proof_events(kind,detail) VALUES(?,?)').bind('transport',JSON.stringify({toolResult:p.input.some(i=>i.type==='function_call_output'),tools:p.tools,tail:p.input.at(-1)})).run();
 if(await env.DB.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='timeout'").first('n')){await env.DB.prepare("INSERT INTO proof_events(kind,detail) VALUES('uncertain','synthetic-timeout')").run();throw Error('synthetic_timeout');}
 const isToolResult=p.input.at(-1)?.type==='function_call_output';
 const compact=!JSON.stringify(p.tools||[]).includes('lookup_relation');
 const id='resp_'+crypto.randomUUID().replaceAll('-',''),call='call_'+crypto.randomUUID().replaceAll('-','');
 const item=compact||isToolResult?{type:'message',id:'msg_'+id,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:compact?'Synthetic retained summary':'Nora leads Cedar, according to synthetic-original-1.',annotations:[]}]}:{type:'function_call',id:'fc_'+id,call_id:call,name:'lookup_relation',arguments:JSON.stringify({project:'Cedar'}),status:'completed'};
 const events=[{type:'response.created',response:{id}}, {type:'response.output_item.added',output_index:0,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]})}}, ...(item.type==='message'?[{type:'response.output_text.delta',output_index:0,content_index:0,delta:item.content[0].text}]:[{type:'response.function_call_arguments.done',output_index:0,arguments:item.arguments}]), {type:'response.output_item.done',output_index:0,item}, {type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:Math.ceil(JSON.stringify(p.input).length/4),output_tokens:20,total_tokens:Math.ceil(JSON.stringify(p.input).length/4)+20}}}];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+String.fromCharCode(10,10)).join(''),{headers:{'Content-Type':'text/event-stream'}});
 }};}
setProvider({...native,auth:{apiKey:{name:'Synthetic only',resolve:async()=>({auth:{apiKey:'synthetic-not-a-credential'}})}},getModels:()=>[model],stream:(m,c,o)=>native.stream(m,c,options(o)),streamSimple:(m,c,o)=>native.streamSimple(m,c,options(o))});
export default {async fetch(request,env){if(env.DEPLOYED_PROBE==='true'&&(!env.PROBE_BEARER||request.headers.get('Authorization')!=='Bearer '+env.PROBE_BEARER))return new Response(null,{status:403});const {id,message,receipt,action,grant}=await request.json();
 if(action==='bootstrap'){for(const sql of ['CREATE TABLE IF NOT EXISTS proof_events(id INTEGER PRIMARY KEY,kind TEXT,detail TEXT)','CREATE TABLE IF NOT EXISTS proof_claims(request TEXT PRIMARY KEY)','CREATE TABLE IF NOT EXISTS proof_tombstones(id TEXT PRIMARY KEY)'])await env.DB.prepare(sql).run();return Response.json({state:'ready',data:'synthetic-only'});}
 if(action==='knowledge-policy')return Response.json(await runKnowledgePolicyProof(env.DB));
 if(action==='events')return Response.json(await env.DB.prepare('SELECT kind,detail FROM proof_events ORDER BY id').all());
 if(action==='deny'||action==='timeout'){await env.DB.prepare('INSERT INTO proof_events(kind,detail) VALUES(?,?)').bind(action,'synthetic-only').run();return Response.json({state:'configured'});}
 if(action==='clear-flags'){await env.DB.prepare("DELETE FROM proof_events WHERE kind IN ('deny','timeout')").run();return Response.json({state:'configured'});}
const handle=init(NativeProof,{id});try{
 if(action==='inspect')return Response.json({instance:await getAgentInstance(NativeProof,id),revision:await env.FLUE_NATIVE_PROOF_AGENT.get(env.FLUE_NATIVE_PROOF_AGENT.idFromName(id)).proofRevision()});
 if(action==='purge'){if(grant!=='synthetic-owner-grant')return new Response(null,{status:403});await env.DB.prepare('INSERT INTO proof_tombstones(id) VALUES(?) ON CONFLICT DO NOTHING').bind(id).run();try{await env.FLUE_NATIVE_PROOF_AGENT.get(env.FLUE_NATIVE_PROOF_AGENT.idFromName(id)).eraseForOwner(grant);}catch{}return Response.json({state:'withdrawn'});}
 if(await env.DB.prepare('SELECT id FROM proof_tombstones WHERE id=?').bind(id).first())return Response.json({error:'context_withdrawn'},{status:403});
 if(receipt){const reply=await handle.read(receipt,{signal:AbortSignal.timeout(20000)});return Response.json(reply);}
 return Response.json(await handle.dispatch({message,initialData:{owner:'synthetic-owner'}}));
 }catch(error){return Response.json({error:'native_proof_failed',detail:String(error),cause:String(error.cause)},{status:409});}}};
`);
 writeFileSync(join(scratch,"cloudflare.ts"),`export default {};`);
 writeFileSync(join(scratch,"wrangler.jsonc"),JSON.stringify({name:'assistant-native-proof',compatibility_date:'2026-10-25',compatibility_flags:['nodejs_compat'],migrations:[{tag:'v1',new_sqlite_classes:['FlueNativeProofAgent']}],d1_databases:[{binding:'DB',database_name:'synthetic',database_id:'00000000-0000-0000-0000-000000000001'}]}));
 writeFileSync(join(scratch,"vite.config.mts"),`
import {defineConfig} from 'vite'; import {flue,flueWorkerConfig} from '@flue/vite'; import {cloudflare} from '@cloudflare/vite-plugin';
export default defineConfig({root:${JSON.stringify(scratch)},envDir:false,plugins:[flue({target:'cloudflare',app:'app.ts',agents:'agents.ts',cloudflare:'cloudflare.ts',providers:[],tracing:false}),cloudflare({configPath:${JSON.stringify(join(scratch,'wrangler.jsonc'))},config:flueWorkerConfig(),persistState:false})],build:{outDir:${JSON.stringify(join(scratch,'dist'))}}});`);
 execFileSync(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build','--config',join(scratch,'vite.config.mts')],{cwd:root,stdio:'pipe'});
 const path=files(join(scratch,'dist')).find(p=>p.endsWith('wrangler.json'))!;
 config={...JSON.parse(readFileSync(path,'utf8')),directory:dirname(path)};
 if(process.env.ASSISTANT_NATIVE_PROBE_ARTIFACT){const dest=resolve(process.env.ASSISTANT_NATIVE_PROBE_ARTIFACT);mkdirSync(dest,{recursive:true,mode:0o700});for(const name of ['app.ts','agents.ts','cloudflare.ts'])copyFileSync(join(scratch,name),join(dest,name));}
});
async function start(state:string){
 await runtime?.dispose();const base=config.directory,main=resolve(base,config.main);
 runtime=new Miniflare({...convertV4MiniflareOptions({workers:[{name:'native-proof',modulesRoot:base,modules:[main,...files(base).filter(p=>/\.m?js$/.test(p)&&p!==main)].map(path=>({type:'ESModule' as const,path})),compatibilityDate:'2026-10-25',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],durableObjects:Object.fromEntries(config.durable_objects.bindings.map((b:any)=>[b.name,{className:b.class_name,useSQLite:true}])),outboundService:()=>{externalCalls++;throw Error('external_forbidden');}}]}),resourcePersistencePath:join(scratch,state)});
 const db=await runtime.getD1Database('DB');await db.prepare('CREATE TABLE IF NOT EXISTS proof_events(id INTEGER PRIMARY KEY,kind TEXT,detail TEXT)').run();await db.prepare('CREATE TABLE IF NOT EXISTS proof_claims(request TEXT PRIMARY KEY)').run();await db.prepare('CREATE TABLE IF NOT EXISTS proof_tombstones(id TEXT PRIMARY KEY)').run();return db;
}
async function call(body:unknown){const res=await runtime!.dispatchFetch('https://synthetic.invalid/',{method:'POST',body:JSON.stringify(body)});const text=await res.text();return {status:res.status,body:text?JSON.parse(text):null};}
async function prompt(id:string,message:string){const admitted=await call({id,message});expect(admitted,JSON.stringify(admitted)).toMatchObject({status:200});return call({id,receipt:admitted.body});}
afterAll(async()=>{await runtime?.dispose();rmSync(scratch,{recursive:true,force:true});expect(externalCalls).toBe(0);});
test('native Pi protocol executes a Flue tool and retains the same conversation after restart',async()=>{
 let db=await start('continuity');
 const first=await prompt('wa-chat-A','Who leads Cedar?');expect(first,JSON.stringify(first)).toMatchObject({status:200});expect(first.body.text).toContain('Nora leads Cedar');
 const before=await db.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='tool'").first('n');expect(before).toBe(1);
 db=await start('continuity');
 expect((await prompt('wa-chat-A','And what source supports that?')).body.text).toContain('synthetic-original-1');
 expect((await prompt('wa-chat-B','Who leads Cedar?')).body.text).toContain('Nora leads Cedar');
 const rows=await db.prepare('SELECT kind,detail FROM proof_events ORDER BY id').all<{kind:string;detail:string}>();
 const events=rows.results;expect(events.filter(e=>e.kind==='tool')).toHaveLength(3);
 expect(events.filter(e=>e.kind==='transport').some(e=>JSON.parse(e.detail).toolResult)).toBe(true);
 let reservations=0,transports=0;for(const e of events){if(e.kind==='reserved')reservations++;if(e.kind==='transport'){transports++;expect(transports).toBeLessThanOrEqual(reservations);}}expect(transports).toBe(6);
 const inputs=events.filter(e=>e.kind==='reserved').map(e=>JSON.parse(e.detail).inputs);expect(inputs[2]).toBeGreaterThan(inputs[0]);expect(inputs[4]).toBe(inputs[0]);
});
test('native provider cannot transport when the asynchronous reservation rejects',async()=>{
 const db=await start('denied');await db.prepare("INSERT INTO proof_events(kind,detail) VALUES('deny','test')").run();
 expect((await prompt('denied-chat','Who leads Cedar?')).status).toBe(409);
 expect(await db.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='transport'").first('n')).toBe(0);
});
test('native provider disables automatic retries after a transport becomes uncertain',async()=>{
 const db=await start('uncertain');await db.prepare("INSERT INTO proof_events(kind,detail) VALUES('timeout','test')").run();
 const admitted=await call({id:'uncertain-chat',message:'Who leads Cedar?'});
 expect((await call({id:'uncertain-chat',receipt:admitted.body})).status).toBe(409);
 expect((await call({id:'uncertain-chat',receipt:admitted.body})).status).toBe(409);
 expect(await db.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='transport'").first('n')).toBe(1);
 expect(await db.prepare("SELECT count(*) AS n FROM proof_events WHERE kind='uncertain'").first('n')).toBe(1);
});

test('native compaction uses the same asynchronous reservation and protected transport',async()=>{
 const db=await start('compaction');
 await prompt('compact-chat','Who leads Cedar?');
 const reply=await prompt('compact-chat','Review the same evidence. '+ 'synthetic background '.repeat(600));
 expect(reply.status).toBe(200);await prompt('compact-chat','What is still known?');
 const rows=await db.prepare("SELECT kind,detail FROM proof_events WHERE kind IN ('reserved','transport') ORDER BY id").all<{kind:string;detail:string}>();
 const transports=rows.results.filter(e=>e.kind==='transport');
 expect(transports.some(e=>!JSON.stringify(JSON.parse(e.detail).tools||[]).includes('lookup_relation'))).toBe(true);
 expect(rows.results.filter(e=>e.kind==='reserved')).toHaveLength(transports.length);
 for(let index=0;index<rows.results.length;index+=2){expect(rows.results[index].kind).toBe('reserved');expect(rows.results[index+1].kind).toBe('transport');}
});

test('supported per-conversation destroy clears native history and host tombstone denies stale callbacks',async()=>{
 await start('purge');
 const admitted=await call({id:'purged-chat',message:'Who leads Cedar?'});
 expect((await call({id:'purged-chat',receipt:admitted.body})).status).toBe(200);
 await prompt('preserved-chat','Who leads Cedar?');
 const retained=(await call({id:'preserved-chat',action:'inspect'})).body.instance;
 const original=(await call({id:'purged-chat',action:'inspect'})).body.instance;expect(original).not.toBeNull();
 expect((await call({id:'purged-chat',action:'purge',grant:'wrong'})).status).toBe(403);
 expect((await call({id:'purged-chat',action:'inspect'})).body.instance).toEqual(original);
 expect((await call({id:'purged-chat',action:'purge',grant:'synthetic-owner-grant'})).status).toBe(200);
 await start('purge');
 expect((await call({id:'purged-chat',action:'inspect'})).body.instance).toBeNull();
 expect((await call({id:'preserved-chat',action:'inspect'})).body.instance).toEqual(retained);
 expect((await prompt('preserved-chat','Which source?')).body.text).toContain('synthetic-original-1');
 expect((await call({id:'purged-chat',receipt:admitted.body})).status).toBe(403);
 expect((await call({id:'purged-chat',message:'stale callback'})).status).toBe(403);
 expect((await prompt('purged-chat-epoch-2','Who leads Cedar?')).body.text).toContain('Nora leads Cedar');
});
