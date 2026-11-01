import type {Provider} from '@earendil-works/pi-ai/models';
import type {SimpleStreamOptions,StreamOptions} from '@earendil-works/pi-ai';
import type {TranscriptContext} from '@earendil-works/pi-ai';
import {clampMaxTokensToContext} from '@earendil-works/pi-ai/api/simple-options';
import {InferenceBudget,type BudgetScope} from '../budget';
import type {AccessGuard} from '../access';
import {retentionExecutionGuard} from '../retention-execution';
import {jsonStatement} from '../d1-statement';
import {nativeModelCatalog,type NativeModelProvider,type NativeModelApi} from './conversation-model';

export const NATIVE_MODEL_PRICE_VERSION='pi-ai-1.1.0-gpt-6-luna-upper-input025-output075-v1';
export type ConversationModelIdentity={scope:BudgetScope;sessionId:string;contextEpoch:string;turnId:string};
export type ConversationProviderHost=ConversationModelIdentity&{
 /** Capture from the native instrument model operation, including compaction.
  * Never resolve an ambient "active task" after awaiting. Each native model
  * operation has its own stable turnId; retries must keep that identity. */
 budget:InferenceBudget;
 assertAuthority:()=>Promise<void>;
 /** Mandatory GLOBAL cap, including all periods and prior carry. Evaluated
  * after reserve and atomically in the single-attempt claim. A daily cap is
  * insufficient. Its SQL and values are trusted host configuration only. */
 globalBudgetGuard:()=>AccessGuard;
 /** Current session/epoch/turn authority, also repeated in claim SQL. */
 authorityGuard:()=>AccessGuard;
 maxOutputTokens:number;maxRequestBytes:number;maxResponseBytes:number;timeoutMs:number;
};
export type ConversationProviderOptions={db:D1Database;apiKey:string;provider?:NativeModelProvider;resolveHost:()=>Promise<ConversationProviderHost>|ConversationProviderHost;
 /** Host transport injection for synthetic tests. Never supplied by the model. */
 fetch?:typeof globalThis.fetch};
type Receipt={state:'attempting'|'uncertain'|'complete';request_hash:string;price_version:string;ceiling_units:number;actual_units:number|null;input_tokens:number|null;output_tokens:number|null};
const ns='installation_id=? AND generation=? AND session_id=? AND context_epoch=? AND turn_id=?';
const keys=(h:ConversationModelIdentity)=>[h.scope.installationId,h.scope.generation,h.sessionId,h.contextEpoch,h.turnId];
const validId=(x:string)=>typeof x==='string'&&x.length>0&&x.length<=256&&x.trim()===x&&!/[\x00-\x1f\x7f]/.test(x);
function positive(x:number){if(!Number.isSafeInteger(x)||x<=0)throw Error('native_model_invalid_limit');}
async function hash(x:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
function stable(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(x=>x===undefined?'null':stable(x)).join(',')+']';
 return '{'+Object.keys(value).filter(k=>(value as Record<string,unknown>)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';
}
export async function conversationModelReceipt(db:D1Database,identity:ConversationModelIdentity){
 return db.prepare(`SELECT state,request_hash,price_version,ceiling_units,actual_units,input_tokens,output_tokens FROM assistant_native_model_receipts WHERE ${ns}`).bind(...keys(identity)).first<Receipt>();
}
function guard(host:ConversationProviderHost):AccessGuard{
 const all=[retentionExecutionGuard(host.scope),host.authorityGuard(),host.globalBudgetGuard()];
 if(all.some(g=>!g||!g.sql||!Array.isArray(g.values)))throw Error('native_model_guard_missing');
 return {sql:all.map(g=>'('+g.sql+')').join(' AND '),values:all.flatMap(g=>g.values)};
}
async function current(db:D1Database,host:ConversationProviderHost){
 await host.assertAuthority();const g=guard(host);
 if(!await jsonStatement(db,`SELECT 1 WHERE ${g.sql}`,g.values).first())throw Error('native_model_authority_denied');
}
type FailureDetails={responseState?:'incomplete'|'failed'|'error';incompleteReason?:'max_output_tokens'|'content_filter'|'other'};
function usage(sse:string,failure:FailureDetails){
 let found:{input:number;output:number}|undefined;
 for(const frame of sse.split(/\r?\n\r?\n/)){
  const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')continue;
  const e=JSON.parse(data);
  if(e.type==='error'||e.type==='response.failed'||e.type==='response.incomplete'){
   failure.responseState=e.type==='response.incomplete'?'incomplete':e.type==='response.failed'?'failed':'error';
   if(e.type==='response.incomplete'){const reason=e.response?.incomplete_details?.reason;failure.incompleteReason=reason==='max_output_tokens'||reason==='content_filter'?reason:'other';}
   throw Error('native_model_response_invalid');
  }
  if(e.type!=='response.completed')continue;
  if(found||e.response?.status!=='completed')throw Error('native_model_response_invalid');
  const u=e.response.usage,input=u?.input_tokens,output=u?.output_tokens,total=u?.total_tokens;
  if(![input,output,total].every(n=>Number.isSafeInteger(n)&&n>=0)||input+output!==total)throw Error('native_model_usage_missing');
  for(const [n,upper] of [[u.input_tokens_details?.cached_tokens,input],[u.output_tokens_details?.reasoning_tokens,output]]){
   if(n!==undefined&&(!Number.isSafeInteger(n)||n<0||n>upper))throw Error('native_model_usage_invalid');
  }
  // Responses output_tokens already includes reasoning; do not add it twice.
  found={input,output};
 }
 if(!found)throw Error('native_model_usage_missing');return found;
}
/** DeepSeek may attach usage to the final choice or a separate trailing chunk.
 * Never infer usage from visible text or subtract cached tokens from custody.
 * A full valid terminal is required before Pi can expose text or run tools. */
function deepseekUsage(sse:string,failure:FailureDetails){
 let found:{input:number;output:number}|undefined,finished=false,done=false;
 for(const frame of sse.split(/\r?\n\r?\n/)){
  const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
  if(!data)continue;
  if(data==='[DONE]'){if(done)throw Error('native_model_response_invalid');done=true;continue;}
  if(done)throw Error('native_model_response_invalid');
  const e=JSON.parse(data);if(e.error||!Array.isArray(e.choices))throw Error('native_model_response_invalid');
  if(e.choices.length>1)throw Error('native_model_response_invalid');
  for(const c of e.choices){
   if(c.index!==0)throw Error('native_model_response_invalid');
   if(c.finish_reason!=null){
    if(finished||!['stop','tool_calls'].includes(c.finish_reason)){
     failure.responseState='incomplete';failure.incompleteReason=c.finish_reason==='length'?'max_output_tokens':c.finish_reason==='content_filter'?'content_filter':'other';
     throw Error('native_model_response_invalid');
    }finished=true;
   }
  }
  if(e.usage){
   const u=e.usage,input=u.prompt_tokens,output=u.completion_tokens;
   if(found||![input,output,u.total_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)||input+output!==u.total_tokens)throw Error('native_model_usage_invalid');
   for(const [n,upper] of [[u.prompt_cache_hit_tokens,input],[u.prompt_cache_miss_tokens,input],[u.completion_tokens_details?.reasoning_tokens,output]])if(n!==undefined&&(!Number.isSafeInteger(n)||n<0||n>upper))throw Error('native_model_usage_invalid');
   found={input,output};
  }
 }
 if(!found||!finished||!done)throw Error('native_model_usage_missing');return found;
}
function rejection(overflow=false){
 const code=overflow?'context_length_exceeded':'native_model_uncertain';
 return Response.json({error:{code,type:'invalid_request_error',message:overflow?'context_length_exceeded (request_too_large)':code}},{status:overflow?400:409});
}
async function buffered(response:Response,limit:number,signal:AbortSignal){
 if(!response.body)throw Error('native_model_response_invalid');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{while(true){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>limit)throw Error('native_model_response_limit');chunks.push(next.value);}}
 finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
 const result=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
 return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(result);
}
/** Narrow transport custody. Pi still owns the complete native Responses
 * protocol, tools, tool outputs, history, reasoning and compaction. No flattening.
 * Client/Flue retries see the same durable receipt and cannot pay twice.
 * No durable response replay: a known completed retry is explicit and blocked. */
export function createConversationProvider(config:ConversationProviderOptions):Provider<NativeModelApi>{
 if(!config.apiKey)throw Error('native_model_key_missing');
 const vendor=config.provider??'openai';
 if(vendor!=='openai'&&vendor!=='deepseek')throw Error('native_model_configuration_invalid');
 const {native,model:catalog,endpoint:ENDPOINT,priceVersion,inputMicroUSD,outputMicroUSD}=nativeModelCatalog(vendor),MODEL=catalog.id;
 // The installed catalog and consumer model views are mutable. Keep a private
 // deep snapshot and close monetary ceilings over validated numeric values.
 const model=structuredClone(catalog),contextWindow=model.contextWindow,maxTokens=model.maxTokens;
 positive(contextWindow);positive(maxTokens);
 function options(original:StreamOptions|SimpleStreamOptions|undefined,context:TranscriptContext){
  // Calling the resolver now captures the instrument's async-local operation.
  const hostPromise=Promise.resolve(config.resolveHost());
  // Lazy Pi loading may postpone onPayload; consume rejection immediately.
  void hostPromise.catch(()=>{});
  let admitted:{host:ConversationProviderHost;body:string;requestHash:string;operationKey:string;ceiling:number}|undefined;
  return {...original,...(vendor==='deepseek'?{reasoning:'high' as const,reasoningEffort:'high' as const}:{}),apiKey:config.apiKey,env:{},headers:{},maxRetries:0,transport:'sse' as const,
   onResponse:undefined,onProviderStreamEvent:undefined,
   async onPayload(payload:unknown){
    const host=await hostPromise;
    if(![...keys(host),host.scope.period].every(validId))throw Error('native_model_identity_invalid');
    for(const n of [host.maxOutputTokens,host.maxRequestBytes,host.maxResponseBytes,host.timeoutMs])positive(n);
    if(host.maxOutputTokens<16||host.maxOutputTokens>maxTokens)throw Error('native_model_invalid_limit');
    const p=payload as Record<string,unknown>;
    if(!p||p.model!==MODEL||p.stream!==true||p.store===true||p.background===true||(p.service_tier!==undefined&&p.service_tier!=='default')||(p.tools!==undefined&&(!Array.isArray(p.tools)||p.tools.some(t=>!t||t.type!=='function'))))throw Error('native_model_payload_denied');
    // The default tier is required for the pinned conservative tariff.
    if(vendor==='openai')p.service_tier='default';
    else if((p.n!==undefined&&p.n!==1)||(p.stream_options as any)?.include_usage!==true||p.max_completion_tokens!==undefined||!Array.isArray(p.messages)||p.messages.some((m:any)=>!['system','user','assistant','tool'].includes(m.role))||
     (p.tools as any[]|undefined)?.some(t=>t.function?.strict===true)||
     (p.thinking as any)?.type!=='enabled'||!['low','high','max'].includes(String(p.reasoning_effort))||
     (p.tool_choice!==undefined&&p.tool_choice!=='auto'&&p.tool_choice!=='none'))throw Error('native_model_payload_denied');
    // Host owns output spend, including native compaction. All other native
    // declarations and history remain byte-for-byte JSON values.
    const outputField=vendor==='deepseek'?'max_tokens':'max_output_tokens';
    p[outputField]=Math.min(typeof p[outputField]==='number'?p[outputField] as number:host.maxOutputTokens,host.maxOutputTokens);
    positive(p[outputField] as number);
    // Use Pi's own context estimator and its safety buffer. A tool loop can
    // cross the remaining headroom before Flue's idle compaction check. Ask
    // Flue for native overflow recovery BEFORE reserving/paying; do not infer
    // overflow from a legitimate explicitly small output-token request.
    const desired=Math.min(original?.maxTokens??maxTokens,host.maxOutputTokens);
    const body=stable(p);
    if(new TextEncoder().encode(body).byteLength>host.maxRequestBytes||body.includes(config.apiKey))throw Error('native_model_payload_denied');
    const requestHash=await hash(stable({payload:p,priceVersion}));
    const operationKey='native:'+await hash(stable(keys(host)));
    // Full installed context is a conservative input ceiling (also images,
    // tool declarations and protocol overhead); no reduced history/corpus cap.
    const ceiling=Math.ceil(contextWindow*inputMicroUSD+(p[outputField] as number)*outputMicroUSD);
    await current(config.db,host);
    // Known attempts must stop for reconciliation even if a later view of
    // this same turn is full. Overflow must never bypass their custody.
    const existing=await conversationModelReceipt(config.db,host);
    if(existing){if(existing.request_hash!==requestHash||existing.price_version!==priceVersion||existing.ceiling_units!==ceiling)throw Error('native_model_request_conflict');throw Error('native_model_'+existing.state);}
    const prior=await config.db.prepare('SELECT state,request_hash,ceiling_units FROM assistant_budget_reservations WHERE installation_id=? AND generation=? AND operation_key=?')
     .bind(host.scope.installationId,host.scope.generation,operationKey).first<{state:string;request_hash:string;ceiling_units:number}>();
    if(prior){if(prior.request_hash!==requestHash||prior.ceiling_units!==ceiling)throw Error('native_model_request_conflict');if(prior.state!=='reserved')throw Error('native_model_'+prior.state);}
    if(clampMaxTokensToContext(model,context,desired)<desired)throw Error('context_length_exceeded (request_too_large)');
    const reservation=await host.budget.reserve(operationKey,requestHash,ceiling);
    if(reservation.state!=='reserved')throw Error('native_model_'+reservation.state);
    admitted={host,body,requestHash,operationKey,ceiling};return p;
   },
   async fetch(input:RequestInfo|URL,init?:RequestInit){
    const a=admitted;admitted=undefined;if(!a)return rejection();
    const {host,requestHash,operationKey,ceiling}=a;let claimed=false;
    let overflow=false,httpStatus:number|undefined,stage='admission';const failure:FailureDetails={};
    try{
     const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
     const method=init?.method??(input instanceof Request?input.method:'GET');
     const body=init?.body??(input instanceof Request?await input.text():undefined);
     if(url!==ENDPOINT||method!=='POST'||typeof body!=='string'||stable(JSON.parse(body))!==a.body)throw Error('native_model_transport_denied');
     await current(config.db,host);const g=guard(host);
     const claim=await jsonStatement(config.db,`INSERT INTO assistant_native_model_receipts
      (installation_id,generation,session_id,context_epoch,turn_id,operation_key,period,request_hash,price_version,ceiling_units,state)
      SELECT ?,?,?,?,?,?,?,?,?,?,'attempting' WHERE ${g.sql} ON CONFLICT DO NOTHING RETURNING state`,
      [...keys(host),operationKey,host.scope.period,requestHash,priceVersion,ceiling,...g.values]).first();
     if(!claim)throw Error('native_model_claim_denied');claimed=true;
     // Repeat runtime authority immediately at the irreversible boundary. The
     // SQL claim also closes owner restore/hold and global-budget races.
     await current(config.db,host);
     const signal=AbortSignal.any([AbortSignal.timeout(host.timeoutMs),...(original?.signal?[original.signal]:[]),...(init?.signal?[init.signal]:[])]);
     signal.throwIfAborted();
     stage='transport';
     const response=await (config.fetch??globalThis.fetch)(ENDPOINT,{method:'POST',body,headers:{'Content-Type':'application/json',Accept:'text/event-stream',Authorization:'Bearer '+config.apiKey},redirect:'manual',signal});
     httpStatus=response.status;stage='response';
     if(response.status!==200){
      // Only a structured rejection from the fixed provider endpoint grants
      // the native SDK overflow signal. Never inspect untrusted prompt text,
      // provider messages or generated output for a matching phrase.
      if(response.status===400&&!response.redirected&&response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){
       const error=JSON.parse(await buffered(response,8192,signal));overflow=error?.error?.code==='context_length_exceeded';
      }
      throw Error('native_model_response_invalid');
     }
     if(response.redirected||!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream'))throw Error('native_model_response_invalid');
     const text=await buffered(response,host.maxResponseBytes,signal);
     if(text.includes(config.apiKey))throw Error('native_model_response_denied');
     const u=vendor==='deepseek'?deepseekUsage(text,failure):usage(text,failure);
     // Peak, noncached rates conservatively bound every native DeepSeek call.
     // Discounts need no guessed clock/cache attribution in the pilot ledger.
     const actual=Math.ceil(u.input*inputMicroUSD+u.output*outputMicroUSD);
     await host.budget.settle(operationKey,requestHash,actual);
     await config.db.prepare(`UPDATE assistant_native_model_receipts SET state='complete',input_tokens=?,output_tokens=?,actual_units=? WHERE ${ns} AND state='attempting' AND request_hash=?`)
      .bind(u.input,u.output,actual,...keys(host),requestHash).run();
     if((host.budget.mode==='capped'&&actual>ceiling)||u.output>host.maxOutputTokens)throw Error('native_model_ceiling_exceeded');
     await current(config.db,host);signal.throwIfAborted();
     return new Response(text,{status:200,headers:{'Content-Type':'text/event-stream'}});
    }catch{
     let pending=false;
     try{await host.budget.uncertain(operationKey);}catch{pending=true;}
     if(claimed)try{await config.db.prepare(`UPDATE assistant_native_model_receipts SET state='uncertain' WHERE ${ns} AND state='attempting' AND request_hash=?`).bind(...keys(host),requestHash).run();}catch{pending=true;}
     // A fetch throw is wrapped by the OpenAI client as "Connection error",
     // which Flue retries with NEW turn IDs. A fixed nonretryable response
     // keeps this paid attempt's custody, including when bookkeeping is down.
     // Logs carry only host metadata, never provider bodies or raw errors.
     console.warn('assistant_native_model_failure',{stage,httpStatus,...failure,overflow,ledgerPending:pending,turnId:host.turnId});
     return rejection(overflow);
    }
   },
  };
 }
 return {id:native.id,name:native.name,baseUrl:native.baseUrl,
  auth:{apiKey:{name:'Host admission',resolve:async()=>({auth:{}})}},getModels:()=>[structuredClone(model)],
  stream:(requested,context,opts)=>{
   if(requested.id!==MODEL||requested.provider!==native.id||requested.api!==model.api||requested.baseUrl!==model.baseUrl)throw Error('native_model_denied');
   return native.stream(model,context,options(opts,context));
  },
  streamSimple:(requested,context,opts)=>{
   if(requested.id!==MODEL||requested.provider!==native.id||requested.api!==model.api||requested.baseUrl!==model.baseUrl)throw Error('native_model_denied');
   return native.streamSimple(model,context,options(opts,context));
  },
 };
}
