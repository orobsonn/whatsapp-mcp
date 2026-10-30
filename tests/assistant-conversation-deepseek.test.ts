import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {createConversationProvider,conversationModelReceipt,type ConversationProviderHost} from '../assistant/agent-runtime/conversation-provider';
import {nativeModelSelection} from '../assistant/agent-runtime/conversation-model';
import {InferenceBudget} from '../assistant/budget';
import type {TranscriptContext} from '@earendil-works/pi-ai';

const key='sk-synthetic-deepseek-never-a-real-key';
let host:ConversationProviderHost,budget:InferenceBudget,bodies:any[],calls:number,tool:boolean,withdrawn:boolean;
let failure:'normal'|'timeout'|'noUsage'|'length'|'usage'|'redirect'|'429';
let terminalUsage=false;
const context=():TranscriptContext=>({messages:[{role:'system',content:'Host instruction: use the evidence tool; never send.',timestamp:1,toolsAdded:[{name:'lookup_relation',description:'Read authorized evidence',parameters:{type:'object',properties:{project:{type:'string'}},required:['project'],additionalProperties:false}} as any]},{role:'user',content:'Who leads Cedar?',timestamp:2}]} as TranscriptContext);
function sse(){
 const base={id:'synthetic-chat',object:'chat.completion.chunk',created:1,model:'deepseek-flash'};
 const chunk=(delta:any,finish_reason:string|null=null)=>({...base,choices:[{index:0,delta,finish_reason}]});
 const usage=failure==='noUsage'?{}:{usage:{prompt_tokens:100,completion_tokens:20,total_tokens:failure==='usage'?121:120,prompt_cache_hit_tokens:64,prompt_cache_miss_tokens:36,completion_tokens_details:{reasoning_tokens:10}}};
 const events=[chunk({role:'assistant',reasoning_content:'Use the evidence, not a guess.'}),chunk(tool?{tool_calls:[{index:0,id:'call_synthetic',type:'function',function:{name:'lookup_relation',arguments:'{"project":"Cedar"}'}}]}:{content:'Nora leads Cedar.'}),{...chunk({},failure==='length'?'length':tool?'tool_calls':'stop'),...(terminalUsage?usage:{})},
  ...(!terminalUsage?[{...base,choices:[],...usage}]:[])];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
function provider(){return createConversationProvider({db:env.DB,apiKey:key,provider:'deepseek',resolveHost:()=>({...host}),fetch:async(input,init)=>{
 calls++;bodies.push(JSON.parse(String(init?.body)));expect(String(input)).toBe('https://api.deepseek.com/chat/completions');
 expect(init?.redirect).toBe('manual');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+key);
 expect((await conversationModelReceipt(env.DB,host))?.state).toBe('attempting');
 if(failure==='timeout')throw Error(key);if(failure==='redirect')return new Response(null,{status:302});if(failure==='429')return new Response(null,{status:429});return sse();
}});}
async function run(p=provider(),c=context()){const stream=p.streamSimple(p.getModels()[0],c,{maxTokens:64,reasoning:'high'});const events=[];for await(const e of stream)events.push(e);return {result:await stream.result(),events};}
beforeEach(async()=>{
 bodies=[];calls=0;tool=false;withdrawn=false;terminalUsage=false;failure='normal';const scope={installationId:crypto.randomUUID(),generation:'g',period:'synthetic'};
 budget=new InferenceBudget(env.DB,scope);await budget.configure(1_000_000);
 host={scope,sessionId:'existing-conversation',contextEpoch:'existing-epoch',turnId:'turn-1',budget,assertAuthority:async()=>{if(withdrawn)throw Error('stale');},authorityGuard:()=>({sql:withdrawn?'0':'1',values:[]}),globalBudgetGuard:()=>({sql:'1',values:[]}),maxOutputTokens:128,maxRequestBytes:1_000_000,maxResponseBytes:1_000_000,timeoutMs:2000};
});
it('selects only an explicitly configured provider and never falls back when its key is absent',()=>{
 expect(nativeModelSelection({})).toMatchObject({provider:'openai',model:'openai/gpt-6-luna'});
 expect(nativeModelSelection({NATIVE_MODEL_PROVIDER:'deepseek',DEEPSEEK_API_KEY:key})).toMatchObject({provider:'deepseek',model:'deepseek/deepseek-flash',apiKey:key});
 expect(()=>nativeModelSelection({NATIVE_MODEL_PROVIDER:'unknown'})).toThrow();
 expect(()=>nativeModelSelection({NATIVE_MODEL_PROVIDER:'deepseek',OPENAI_API_KEY:key})).toThrow();
});
it('native DeepSeek tool loop preserves instructions, reasoning, results and its own tariff',async()=>{
 tool=true;const p=provider(),first=await run(p);expect(first.result.stopReason,first.result.errorMessage).toBe('toolUse');
 expect(bodies[0]).toMatchObject({model:'deepseek-flash',thinking:{type:'enabled'},reasoning_effort:'high',stream_options:{include_usage:true},max_tokens:64});
 expect(bodies[0].messages[0]).toMatchObject({role:'system',content:expect.stringContaining('Host instruction')});
 expect(bodies[0].tools).toContainEqual(expect.objectContaining({type:'function',function:expect.objectContaining({name:'lookup_relation'})}));
 expect(await conversationModelReceipt(env.DB,host)).toMatchObject({state:'complete',actual_units:54,ceiling_units:300077,price_version:expect.stringContaining('deepseek')});
 const c=context(),call=first.result.content.find(x=>x.type==='toolCall')!;c.messages.push(first.result,{role:'toolResult',toolCallId:call.id,toolName:'lookup_relation',content:[{type:'text',text:'Nora leads Cedar; source-1'}],isError:false,timestamp:3});
 host.turnId='turn-2';tool=false;const second=await run(p,c);expect(second.result.stopReason,second.result.errorMessage).toBe('stop');
 expect(bodies[1].messages).toContainEqual(expect.objectContaining({role:'assistant',reasoning_content:'Use the evidence, not a guess.',tool_calls:expect.arrayContaining([expect.objectContaining({id:call.id})])}));
 expect(bodies[1].messages).toContainEqual(expect.objectContaining({role:'tool',tool_call_id:call.id,content:expect.stringContaining('source-1')}));
 expect((await budget.status()).committed).toBe(108);
});
it('retains old native history across providers without forwarding opaque OpenAI reasoning',async()=>{
 const c=context();c.messages.push({role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6-luna',content:[{type:'thinking',thinking:'',thinkingSignature:JSON.stringify({type:'reasoning',encrypted_content:'OPENAI_OPAQUE_SENTINEL'})},{type:'text',text:'Earlier agreement: Nora owns Cedar.'},{type:'toolCall',id:'call_old|fc_old',name:'lookup_relation',arguments:{project:'Cedar'}}],usage:{input:100,output:20,cacheRead:0,cacheWrite:0,totalTokens:120,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:3} as any,{role:'toolResult',toolCallId:'call_old|fc_old',toolName:'lookup_relation',content:[{type:'text',text:'Old source-0 supports Nora'}],isError:false,timestamp:4},{role:'user',content:'Continue the same conversation',timestamp:5});
 const result=await run(provider(),c);expect(result.result.stopReason,result.result.errorMessage).toBe('stop');expect(JSON.stringify(bodies[0])).toContain('Earlier agreement');expect(JSON.stringify(bodies[0])).not.toContain('OPENAI_OPAQUE_SENTINEL');
 const assistant=bodies[0].messages.find((m:any)=>m.tool_calls?.length),out=bodies[0].messages.find((m:any)=>m.role==='tool');expect(assistant.tool_calls[0].id).toBe(out.tool_call_id);expect(out.content).toContain('source-0');
});
it('accepts DeepSeek terminal-choice usage without requiring an OpenAI usage-only chunk',async()=>{
 terminalUsage=true;expect((await run()).result.stopReason).toBe('stop');expect((await conversationModelReceipt(env.DB,host))?.actual_units).toBe(54);
});
it('compaction shares the same provider, authority, receipt and monetary custody',async()=>{
 const c=context();delete(c.messages[0] as any).toolsAdded;(c.messages[0] as any).content='Summarize retained native conversation';host.turnId='compaction-turn';
 expect((await run(provider(),c)).result.stopReason).toBe('stop');expect(bodies[0].tools??[]).toHaveLength(0);expect((await conversationModelReceipt(env.DB,host))?.actual_units).toBe(54);
});
it.each(['timeout','noUsage','length','usage','redirect','429'] as const)('%s retains the ceiling and forbids a second paid attempt',async mode=>{
 failure=mode;expect((await run()).result.stopReason).toBe('error');expect((await conversationModelReceipt(env.DB,host))?.state).toBe('uncertain');
 const held=(await budget.status()).committed;expect(held).toBeGreaterThan(300000);failure='normal';expect((await run()).result.stopReason).toBe('error');expect(calls).toBe(1);expect((await budget.status()).committed).toBe(held);
});
it('prevents unsupported hosted tools, stale authority and caller mutation from reaching the network',async()=>{
 const p=provider();expect(()=>p.streamSimple({...p.getModels()[0],baseUrl:'https://untrusted.invalid'},context())).toThrow();
 for(const samplingParams of [{tools:[{type:'web_search'}]},{store:true},{n:2},{model:'deepseek-v4-pro'}])expect((await p.streamSimple(p.getModels()[0],context(),{samplingParams} as any).result()).stopReason).toBe('error');
 withdrawn=true;expect((await run(p)).result.stopReason).toBe('error');expect(calls).toBe(0);expect((await budget.status()).committed).toBe(0);
});
