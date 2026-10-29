import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import type {Provider} from '@earendil-works/pi-ai/models';
import type {SimpleStreamOptions,StreamOptions} from '@earendil-works/pi-ai';
import {InferenceBudget,type BudgetScope} from '../budget';
import type {AccessGuard} from '../access';
import {retentionExecutionGuard} from '../retention-execution';

export const NATIVE_MODEL_PRICE_VERSION='pi-ai-1.1.0-gpt-6-luna-upper-input025-output075-v1';
const ENDPOINT='https://api.openai.com/v1/responses',MODEL='gpt-6-luna';
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
export type ConversationProviderOptions={db:D1Database;apiKey:string;resolveHost:()=>Promise<ConversationProviderHost>|ConversationProviderHost;
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
 if(!await db.prepare(`SELECT 1 WHERE ${g.sql}`).bind(...g.values).first())throw Error('native_model_authority_denied');
}
function usage(sse:string){
 let found:{input:number;output:number}|undefined;
 for(const frame of sse.split(/\r?\n\r?\n/)){
  const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')continue;
  const e=JSON.parse(data);
  if(e.type==='error'||e.type==='response.failed'||e.type==='response.incomplete')throw Error('native_model_response_invalid');
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
async function buffered(response:Response,limit:number,signal:AbortSignal){
 if(response.status!==200||response.redirected||!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')||!response.body)throw Error('native_model_response_invalid');
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
export function createConversationProvider(config:ConversationProviderOptions):Provider<'openai-responses'>{
 if(!config.apiKey)throw Error('native_model_key_missing');
 const native=openaiProvider(),catalog=native.getModels().find(m=>m.id===MODEL);
 if(!catalog||catalog.baseUrl!=='https://api.openai.com/v1')throw Error('native_model_catalog_missing');
 // The installed catalog and consumer model views are mutable. Keep a private
 // deep snapshot and close monetary ceilings over validated numeric values.
 const model=structuredClone(catalog),contextWindow=model.contextWindow,maxTokens=model.maxTokens;
 positive(contextWindow);positive(maxTokens);
 function options(original:StreamOptions|SimpleStreamOptions|undefined){
  // Calling the resolver now captures the instrument's async-local operation.
  const hostPromise=Promise.resolve(config.resolveHost());
  // Lazy Pi loading may postpone onPayload; consume rejection immediately.
  void hostPromise.catch(()=>{});
  let admitted:{host:ConversationProviderHost;body:string;requestHash:string;operationKey:string;ceiling:number}|undefined;
  return {...original,apiKey:config.apiKey,env:{},headers:{},maxRetries:0,transport:'sse' as const,
   onResponse:undefined,onProviderStreamEvent:undefined,
   async onPayload(payload:unknown){
    const host=await hostPromise;
    if(![...keys(host),host.scope.period].every(validId))throw Error('native_model_identity_invalid');
    for(const n of [host.maxOutputTokens,host.maxRequestBytes,host.maxResponseBytes,host.timeoutMs])positive(n);
    if(host.maxOutputTokens<16||host.maxOutputTokens>maxTokens)throw Error('native_model_invalid_limit');
    const p=payload as Record<string,unknown>;
    if(!p||p.model!==MODEL||p.stream!==true||p.store===true||p.background===true||(p.service_tier!==undefined&&p.service_tier!=='default')||(p.tools!==undefined&&(!Array.isArray(p.tools)||p.tools.some(t=>!t||t.type!=='function'))))throw Error('native_model_payload_denied');
    // The default tier is required for the pinned conservative tariff.
    p.service_tier='default';
    // Host owns output spend, including native compaction. All other native
    // declarations and history remain byte-for-byte JSON values.
    p.max_output_tokens=Math.min(typeof p.max_output_tokens==='number'?p.max_output_tokens:host.maxOutputTokens,host.maxOutputTokens);
    positive(p.max_output_tokens as number);
    const body=stable(p);
    if(new TextEncoder().encode(body).byteLength>host.maxRequestBytes||body.includes(config.apiKey))throw Error('native_model_payload_denied');
    const requestHash=await hash(stable({payload:p,priceVersion:NATIVE_MODEL_PRICE_VERSION}));
    const operationKey='native:'+await hash(stable(keys(host)));
    // Full installed context is a conservative input ceiling (also images,
    // tool declarations and protocol overhead); no reduced history/corpus cap.
    const ceiling=Math.ceil(contextWindow*.25+(p.max_output_tokens as number)*.75);
    await current(config.db,host);
    const reservation=await host.budget.reserve(operationKey,requestHash,ceiling);
    const existing=await conversationModelReceipt(config.db,host);
    if(existing){if(existing.request_hash!==requestHash||existing.price_version!==NATIVE_MODEL_PRICE_VERSION||existing.ceiling_units!==ceiling)throw Error('native_model_request_conflict');throw Error('native_model_'+existing.state);}
    if(reservation.state!=='reserved')throw Error('native_model_'+reservation.state);
    admitted={host,body,requestHash,operationKey,ceiling};return p;
   },
   async fetch(input:RequestInfo|URL,init?:RequestInit){
    const a=admitted;admitted=undefined;if(!a)throw Error('native_model_not_admitted');
    const {host,requestHash,operationKey,ceiling}=a;let claimed=false;
    try{
     const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
     const method=init?.method??(input instanceof Request?input.method:'GET');
     const body=init?.body??(input instanceof Request?await input.text():undefined);
     if(url!==ENDPOINT||method!=='POST'||typeof body!=='string'||stable(JSON.parse(body))!==a.body)throw Error('native_model_transport_denied');
     await current(config.db,host);const g=guard(host);
     const claim=await config.db.prepare(`INSERT INTO assistant_native_model_receipts
      (installation_id,generation,session_id,context_epoch,turn_id,operation_key,period,request_hash,price_version,ceiling_units,state)
      SELECT ?,?,?,?,?,?,?,?,?,?,'attempting' WHERE ${g.sql} ON CONFLICT DO NOTHING RETURNING state`)
      .bind(...keys(host),operationKey,host.scope.period,requestHash,NATIVE_MODEL_PRICE_VERSION,ceiling,...g.values).first();
     if(!claim)throw Error('native_model_claim_denied');claimed=true;
     // Repeat runtime authority immediately at the irreversible boundary. The
     // SQL claim also closes owner restore/hold and global-budget races.
     await current(config.db,host);
     const signal=AbortSignal.any([AbortSignal.timeout(host.timeoutMs),...(original?.signal?[original.signal]:[]),...(init?.signal?[init.signal]:[])]);
     signal.throwIfAborted();
     const response=await (config.fetch??globalThis.fetch)(ENDPOINT,{method:'POST',body,headers:{'Content-Type':'application/json',Accept:'text/event-stream',Authorization:'Bearer '+config.apiKey},redirect:'manual',signal});
     const text=await buffered(response,host.maxResponseBytes,signal);
     if(text.includes(config.apiKey))throw Error('native_model_response_denied');
     const u=usage(text);
     const actual=Math.ceil(u.input*.25+u.output*.75);
     await host.budget.settle(operationKey,requestHash,actual);
     await config.db.prepare(`UPDATE assistant_native_model_receipts SET state='complete',input_tokens=?,output_tokens=?,actual_units=? WHERE ${ns} AND state='attempting' AND request_hash=?`)
      .bind(u.input,u.output,actual,...keys(host),requestHash).run();
     if(actual>ceiling||u.output>host.maxOutputTokens)throw Error('native_model_ceiling_exceeded');
     await current(config.db,host);signal.throwIfAborted();
     return new Response(text,{status:200,headers:{'Content-Type':'text/event-stream'}});
    }catch{
     await host.budget.uncertain(operationKey);
     if(claimed)await config.db.prepare(`UPDATE assistant_native_model_receipts SET state='uncertain' WHERE ${ns} AND state='attempting' AND request_hash=?`).bind(...keys(host),requestHash).run();
     throw Error('native_model_uncertain');
    }
   },
  };
 }
 return {id:native.id,name:native.name,baseUrl:native.baseUrl,
  auth:{apiKey:{name:'Host admission',resolve:async()=>({auth:{}})}},getModels:()=>[structuredClone(model)],
  stream:(requested,context,opts)=>{
   if(requested.id!==MODEL||requested.provider!==native.id||requested.api!==model.api||requested.baseUrl!==model.baseUrl)throw Error('native_model_denied');
   return native.stream(model,context,options(opts));
  },
  streamSimple:(requested,context,opts)=>{
   if(requested.id!==MODEL||requested.provider!==native.id||requested.api!==model.api||requested.baseUrl!==model.baseUrl)throw Error('native_model_denied');
   return native.streamSimple(model,context,options(opts));
  },
 };
}
