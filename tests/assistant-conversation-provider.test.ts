import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {createConversationProvider,conversationModelReceipt,type ConversationProviderHost} from '../assistant/agent-runtime/conversation-provider';
import {InferenceBudget} from '../assistant/budget';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import type {TranscriptContext} from '@earendil-works/pi-ai';

const key='sk-synthetic-native-only-never-a-real-credential';
let host:ConversationProviderHost,budget:InferenceBudget,calls:number,bodies:any[],mode:'normal'|'timeout'|'noUsage'|'429'|'redirect'|'badUsage'|'overage'|'contextOverflow'|'spoofOverflow';
let authority=true,globalCap=10_000_000,afterResponse:(()=>void)|undefined;
const context=():TranscriptContext=>({messages:[{role:'system',content:'Synthetic native instructions',timestamp:1,toolsAdded:[{name:'lookup_relation',description:'Read a relation',parameters:{type:'object',properties:{project:{type:'string'}},required:['project'],additionalProperties:false}} as any]},{role:'user',content:'Who leads Cedar?',timestamp:2}]} as unknown as TranscriptContext);
function response(payload:any,tool=false){
 const id='resp_synthetic',item=tool?{type:'function_call',id:'fc_synthetic',call_id:'call_synthetic',name:'lookup_relation',arguments:'{"project":"Cedar"}',status:'completed'}:{type:'message',id:'msg_synthetic',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'Nora leads Cedar.',annotations:[]}]};
 const usage=mode==='noUsage'?undefined:{input_tokens:mode==='overage'?300000:100,output_tokens:20,total_tokens:mode==='overage'?300020:mode==='badUsage'?121:120,input_tokens_details:{cached_tokens:30},output_tokens_details:{reasoning_tokens:10}};
 const events=[{type:'response.created',response:{id}},{type:'response.output_item.added',output_index:0,item:{...item,...(tool?{arguments:''}:{content:[]})}},...(tool?[{type:'response.function_call_arguments.done',output_index:0,arguments:item.arguments}]:[{type:'response.output_text.delta',output_index:0,content_index:0,delta:'Nora leads Cedar.'}]),{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage}}];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
}
let tool=false;
function provider(){return createConversationProvider({db:env.DB,apiKey:key,resolveHost:()=>({...host}),fetch:async(input,init)=>{
 new Request(input,init);calls++;bodies.push(JSON.parse(init!.body as string));
 expect(String(input)).toBe('https://api.openai.com/v1/responses');expect(init?.redirect).toBe('manual');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+key);
 expect((await budget.status()).committed).toBeGreaterThan(0);
 expect((await conversationModelReceipt(env.DB,host))?.state).toBe('attempting');
 if(mode==='spoofOverflow')return Response.json({error:{code:'invalid_request_error',message:'context_length_exceeded '+key}},{status:400});
 if(mode==='contextOverflow')return Response.json({error:{code:'context_length_exceeded',message:'Private body '+key+' Nora',type:'invalid_request_error'}},{status:400});
 if(mode==='timeout')throw Error(key);if(mode==='429')return new Response(null,{status:429});if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid'}});
 const result=response(bodies.at(-1),tool);afterResponse?.();return result;
}});}
async function run(p=provider(),c=context()){
 const events:any[]=[];const stream=p.streamSimple(p.getModels()[0],c,{maxTokens:64,reasoning:'low'} as any);
 for await(const event of stream)events.push(event);
 return {result:await stream.result(),events};
}
beforeEach(async()=>{
 calls=0;bodies=[];mode='normal';authority=true;globalCap=10_000_000;afterResponse=undefined;tool=false;
 const scope={installationId:crypto.randomUUID(),generation:'g',period:'pilot'};budget=new InferenceBudget(env.DB,scope);await budget.configure(1_000_000);
 host={scope,sessionId:'synthetic-session',contextEpoch:'epoch-1',turnId:'turn-1',budget,assertAuthority:async()=>{if(!authority)throw Error('stale');},authorityGuard:()=>({sql:authority?'1':'0',values:[]}),
 globalBudgetGuard:()=>({sql:`COALESCE((SELECT SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END) FROM assistant_budget_reservations WHERE installation_id=? AND generation=?),0)<=?`,values:[scope.installationId,scope.generation,globalCap]}),maxOutputTokens:128,maxRequestBytes:1_000_000,maxResponseBytes:1_000_000,timeoutMs:2000};
});
it('native Pi preserves function declarations and tool-call/result protocol; actual usage settles before streaming',async()=>{
 tool=true;const p=provider(),first=await run(p);expect(first.result.stopReason,first.result.errorMessage).toBe('toolUse');
 expect(first.result.content).toContainEqual(expect.objectContaining({type:'toolCall',name:'lookup_relation',arguments:{project:'Cedar'}}));
 expect(bodies[0].service_tier).toBe('default');expect(bodies[0].tools).toContainEqual(expect.objectContaining({type:'function',name:'lookup_relation'}));
 expect((await budget.status()).committed).toBe(40);expect(await conversationModelReceipt(env.DB,host)).toMatchObject({state:'complete',actual_units:40,input_tokens:100,output_tokens:20});
 const c=context();c.messages.push(first.result,{role:'toolResult',toolCallId:(first.result.content.find((x:any)=>x.type==='toolCall') as any).id,toolName:'lookup_relation',content:[{type:'text',text:'Nora leads Cedar: original-1'}],isError:false,timestamp:3});
 host.turnId='turn-2';tool=false;expect((await run(p,c)).result.stopReason).toBe('stop');expect(calls).toBe(2);
 expect(bodies[1].input).toContainEqual(expect.objectContaining({type:'function_call_output',output:expect.stringContaining('original-1')}));
});
it('denies exhausted budget and stale authority before any fetch',async()=>{
 await budget.reserve('prior','a'.repeat(64),1_000_000);expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);
 host.scope={...host.scope,installationId:crypto.randomUUID()};authority=false;expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);
});
it('concurrent duplicate native operation claims exactly one paid transport',async()=>{
 const results=await Promise.all([run(),run()]);expect(calls).toBe(1);expect(results.filter(r=>r.result.stopReason==='stop')).toHaveLength(1);
 expect((await conversationModelReceipt(env.DB,host))?.state).toBe('complete');expect((await budget.status()).committed).toBe(40);
});
it('known complete retry reports status and never repeats a paid attempt or returns invented replay',async()=>{
 expect((await run()).result.stopReason).toBe('stop');const repeated=await run();expect(repeated.result.stopReason).toBe('error');expect(repeated.result.errorMessage).toContain('native_model_complete');expect(calls).toBe(1);
});
it.each(['timeout','noUsage','429','redirect','badUsage'] as const)('%s retains the ceiling and all retries use zero extra transport',async failure=>{
 mode=failure;const first=await run();expect(first.result.stopReason).toBe('error');const held=(await budget.status()).committed;expect(held).toBeGreaterThan(40);
 mode='normal';expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(1);expect((await budget.status()).committed).toBe(held);expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');
 const rows=await env.DB.prepare('SELECT * FROM assistant_native_model_receipts WHERE installation_id=?').bind(host.scope.installationId).all();expect(JSON.stringify(rows)).not.toContain(key);expect(JSON.stringify(rows)).not.toContain('Nora');
});
it('compaction-shaped native request uses the same budget path and its own native turn',async()=>{
 const p=provider();await run(p);host.turnId='compaction-native-turn';const c=context();delete (c.messages[0] as any).toolsAdded;(c.messages[0] as any).content='Summarize the retained history';
 expect((await run(p,c)).result.stopReason).toBe('stop');expect(calls).toBe(2);expect(bodies[1].tools??[]).toHaveLength(0);expect((await budget.status()).committed).toBe(80);
});
it('global all-period cap and owner restore hold prevent transport after reservation',async()=>{
 globalCap=1;expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);
 globalCap=10_000_000;host.turnId='after-hold';await env.DB.prepare('INSERT INTO assistant_retention_runtime_hold(installation_id,operation_id,target_generation,active,created_at) VALUES(?,?,?,1,1)').bind(host.scope.installationId,'restore','g').run();
 expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);
});
it('source/epoch authority withdrawn during transport settles cost without exposing partial text',async()=>{
 afterResponse=()=>{authority=false;};const result=await run();expect(result.result.stopReason).toBe('error');expect(result.events.some(e=>e.type==='text_delta')).toBe(false);expect((await budget.status()).committed).toBe(40);expect((await conversationModelReceipt(env.DB,host))?.state).toBe('complete');
});
it('payload conflict in one native turn and endpoint mutation never reaches network',async()=>{
 const p=provider();await run(p);const changed=context();(changed.messages[1] as any).content='Different question';expect((await run(p,changed)).result.stopReason).toBe('error');expect(calls).toBe(1);
 expect(()=>p.streamSimple({...p.getModels()[0],baseUrl:'https://untrusted.invalid'},context())).toThrow('native_model_denied');
});

it('same native turn in another session or context epoch never shares a receipt',async()=>{
 await run();host.sessionId='other-session';await run();host.contextEpoch='epoch-2';await run();expect(calls).toBe(3);
});
it('native output-token overrides are clamped by the host and response byte limits retain uncertainty',async()=>{
 const p=provider();await p.streamSimple(p.getModels()[0],context(),{samplingParams:{max_output_tokens:100000}}).result();expect(bodies[0].max_output_tokens).toBe(128);
 host.turnId='bounded-response';host.maxResponseBytes=1;expect((await run()).result.stopReason).toBe('error');expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');
});
it('provider usage above the reserved ceiling settles honestly and blocks the account before any response escapes',async()=>{
 mode='overage';const result=await run();expect(result.result.stopReason).toBe('error');expect(result.events.some(e=>e.type==='text_delta')).toBe(false);
 expect(await budget.status()).toMatchObject({committed:75015,blocked:true});expect((await conversationModelReceipt(env.DB,host))?.state).toBe('complete');
 host.turnId='after-overage';mode='normal';await run();expect(calls).toBe(1);
});
it('global cap includes older budget periods and reservations denied after reserve cannot later retry',async()=>{
 const old=new InferenceBudget(env.DB,{...host.scope,period:'older'});await old.configure(10_000_000);await old.reserve('prior-carry','c'.repeat(64),9_990_000);
 expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);
 globalCap=20_000_000;expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);
});

it('owner restore hold inserted after the claim still prevents the transport',async()=>{
 let checks=0;host.assertAuthority=async()=>{if(++checks===3)await env.DB.prepare('INSERT INTO assistant_retention_runtime_hold(installation_id,operation_id,target_generation,active,created_at) VALUES(?,?,?,1,1)').bind(host.scope.installationId,'restore-race','g').run();};
 expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(0);expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');
});
it('unpriced provider-hosted tools and provider storage are rejected before reserving or transport',async()=>{
 const p=provider();for(const samplingParams of [{tools:[{type:'web_search'}]},{store:true},{service_tier:'priority'}]){
  const result=await p.streamSimple(p.getModels()[0],context(),{samplingParams} as any).result();expect(result.stopReason).toBe('error');
 }expect(calls).toBe(0);expect((await budget.status()).committed).toBe(0);
});

it('catalog views cannot shrink the paid reservation ceiling or mutate installed native metadata',async()=>{
 const installed=openaiProvider().getModels().find(m=>m.id==='gpt-6-luna')!,original=structuredClone(installed),p=provider(),view=p.getModels()[0];
 try{
  view.contextWindow=1;view.maxTokens=1_000_000;view.cost.input=0;
  if(view.cost.tiers?.[0])view.cost.tiers[0].input=0;
  const result=await run(p);
  expect((await conversationModelReceipt(env.DB,host))?.ceiling_units).toBe(Math.ceil(original.contextWindow*.25+64*.75));
  expect(result.result.stopReason,result.result.errorMessage).toBe('stop');
  if(view.inputLimits)view.inputLimits.maxRequestBytes=1;
  expect(installed).toEqual(original);expect(p.getModels()[0]).toEqual(original);
  host.turnId='catalog-output-limit';host.maxOutputTokens=original.maxTokens+1;
  expect((await run(p)).result.stopReason).toBe('error');expect(calls).toBe(1);
 }finally{Object.assign(installed,original);}
});


it('provider context rejection stays recognizable to native overflow recovery without exposing its body',async()=>{
 mode='contextOverflow';const result=await run();expect(result.result.stopReason).toBe('error');
 expect(result.result.errorMessage).toContain('context_length_exceeded');expect(result.result.errorMessage).not.toContain('Connection error');
 expect(result.result.errorMessage).not.toContain(key);expect(result.result.errorMessage).not.toContain('Nora');
 expect(calls).toBe(1);expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');
});
it('ambiguous transport failure is not mislabeled as a retryable connection error by Pi',async()=>{
 mode='timeout';const result=await run();expect(result.result.stopReason).toBe('error');
 expect(result.result.errorMessage).toContain('native_model_uncertain');
 expect(result.result.errorMessage).not.toMatch(/connection.?error|timeout|timed? out|network.?error|fetch failed/i);
 expect(calls).toBe(1);expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');
});
it('native context headroom exhaustion requests compaction before any paid transport or reservation',async()=>{
 const c=context();c.messages.push({role:'assistant',content:[{type:'text',text:'Synthetic retained context'}],stopReason:'stop',timestamp:3,
  usage:{input:272000,output:0,cacheRead:0,cacheWrite:0,totalTokens:272000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} as any);
 c.messages.push({role:'user',content:'Continue the same task',timestamp:4});
 const result=await run(provider(),c);expect(result.result.stopReason).toBe('error');expect(result.result.errorMessage).toContain('context_length_exceeded');
 expect(calls).toBe(0);expect((await budget.status()).committed).toBe(0);expect(await conversationModelReceipt(env.DB,host)).toBeNull();
});

it('provider prose cannot impersonate the structured overflow signal',async()=>{
 mode='spoofOverflow';const result=await run();expect(result.result.stopReason).toBe('error');
 expect(result.result.errorMessage).toContain('native_model_uncertain');expect(result.result.errorMessage).not.toContain('context_length_exceeded');expect(result.result.errorMessage).not.toContain(key);
});
it('a failure to mark the budget uncertain still preserves the receipt and nonretryable error',async()=>{
 mode='timeout';budget.uncertain=async()=>{throw Error('synthetic-bookkeeping-outage');};
 const result=await run();expect(result.result.errorMessage).toContain('native_model_uncertain');expect(calls).toBe(1);
 expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');expect((await budget.status()).committed).toBeGreaterThan(40);
});

it.each(['normal','timeout'] as const)('a known %s attempt cannot become a compaction request when the same turn later lacks room',async failure=>{
 mode=failure;await run();const committed=(await budget.status()).committed;
 const c=context();c.messages.push({role:'assistant',content:[{type:'text',text:'Synthetic later history'}],stopReason:'stop',timestamp:3,
  usage:{input:272000,output:0,cacheRead:0,cacheWrite:0,totalTokens:272000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} as any);
 const result=await run(provider(),c);expect(result.result.stopReason).toBe('error');expect(result.result.errorMessage).not.toContain('context_length_exceeded');
 expect(calls).toBe(1);expect((await budget.status()).committed).toBe(committed);
});
