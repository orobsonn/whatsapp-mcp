import {z} from 'zod';
import {assistantExportLink} from './assistant-export';
import {ownerToolProvenance,emptyOwnerToolProvenance} from './owner-tool-provenance';
import type {Env} from './env';
import {AppError,assertActive,currentFence,safeEqual,sha256} from './core';
import {resolveRuntimeEnv,runtimeConnectionGuard} from './connection';
import {createMcpServer,type McpToolDefinition} from './mcp';
import {OWNER_TOOL_NAMES,ownerToolCatalogInput,ownerToolExecuteInput,type OwnerToolAuthorizationRequest,type OwnerToolAuthorization} from './owner-tool-contract';
import type {ApprovedSendScope} from './approved-send-contract';
const allowed=new Set<string>(OWNER_TOOL_NAMES);
/** Stable object-key order for replay identity; strings and arrays remain exact. */
function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
type Context={secret:string;scope:ApprovedSendScope;sessionId:string;taskRef:string};
const ns='installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND session_id=? AND task_ref=? AND tool=? AND input_hash=?';
const keys=(q:Context,tool:string,inputHash:string)=>[q.scope.installationId,q.scope.generation,q.scope.sourceEpoch,q.scope.sourceGeneration,q.sessionId,q.taskRef,tool,inputHash];
async function authenticate(raw:Env,q:Context){
 if(!raw.ASSISTANT_APPROVED_SEND_SECRET||!await safeEqual(raw.ASSISTANT_APPROVED_SEND_SECRET,q.secret))throw new AppError('owner_tool_denied',403);
 const env=await resolveRuntimeEnv(raw);assertActive(env);const fence=currentFence(env);
 if(q.scope.installationId!==env.ASSISTANT_INSTALLATION_ID||q.scope.generation!==env.ASSISTANT_GENERATION||q.scope.sourceEpoch!==fence.epoch||q.scope.sourceGeneration!==fence.generation)throw new AppError('owner_tool_denied',403);
 return env;
}
async function authorize(raw:Env,q:Context,tool:string,inputHash:string){
 const env=await authenticate(raw,q),owner=env.ASSISTANT_OWNER as typeof env.ASSISTANT_OWNER & {ownerToolAuthorization?(scope:ApprovedSendScope,input:OwnerToolAuthorizationRequest):Promise<OwnerToolAuthorization>};
 if(!owner?.ownerToolAuthorization)throw new AppError('owner_tool_unconfigured',503);
 const proof=await owner.ownerToolAuthorization(q.scope,{secret:q.secret,sessionId:q.sessionId,taskRef:q.taskRef,tool:tool as OwnerToolAuthorizationRequest['tool'],inputHash});
 const now=Date.now();if(!proof?.authorized||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=now||proof.expiresAt>now+10000)throw new AppError('owner_tool_denied',403);
 return {env,expiresAt:proof.expiresAt};
}
function definitions(env:Env,beforeTool:()=>Promise<void>,beforeClaim:()=>Promise<{sql:string;values:(string|number|null)[]}>){
 const list=new Map<string,McpToolDefinition>();
 createMcpServer(env,{sub:env.OWNER_SUB,epoch:env.INSTALLATION_EPOCH},{register:tool=>{if(allowed.has(tool.name))list.set(tool.name,tool);},beforeTool,beforeClaim});
 return list;
}
export async function ownerToolCatalog(raw:Env,input:unknown){
 const q=ownerToolCatalogInput.parse(input),inputHash=await sha256(canonical({name:q.name??null,after:q.after??null,limit:q.limit}));
 const {env}=await authorize(raw,q,'__catalog__',inputHash),list=definitions(env,async()=>{},async()=>({sql:'1',values:[]}));
 const all=[...list.values()].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const selected=q.name?all.filter(t=>t.name===q.name):all.filter(t=>!q.after||t.name>q.after).slice(0,q.limit);
 await authorize(raw,q,'__catalog__',inputHash);
 return {tools:selected.map(t=>({name:t.name,description:t.description,readOnly:t.readOnly,...(q.name?{inputSchema:z.toJSONSchema(t.inputSchema,{io:'input',unrepresentable:'any'})}:{})})),...(!q.name&&selected.length===q.limit&&all.some(t=>t.name>selected.at(-1)!.name)?{nextCursor:selected.at(-1)!.name}:{})};
}
export async function ownerToolExecute(raw:Env,input:unknown){
 const q=ownerToolExecuteInput.parse(input);let serialized=canonical(q.input);
 if(typeof serialized!=='string'||new TextEncoder().encode(serialized).length>65536)throw new AppError('owner_tool_input_size',400);
 let inputHash=await sha256(serialized);const initial=await authorize(raw,q,q.tool,inputHash),env=initial.env;
 const check=async()=>{await authorize(raw,q,q.tool,inputHash);};
 const claimGuard=async()=>{const {expiresAt}=await authorize(raw,q,q.tool,inputHash),connection=await runtimeConnectionGuard(env);return {sql:`(${connection.sql}) AND ?>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`,values:[...connection.values,expiresAt]};};
 const tool=definitions(env,check,claimGuard).get(q.tool);if(!tool)throw new AppError('owner_tool_unavailable',404);
 q.input=tool.inputSchema.parse(q.input); // Defaults and canonical object keys share replay identity.
 serialized=canonical(q.input);inputHash=await sha256(serialized);await check();
 if(q.tool==='assistente_consultar'&&(q.input as {query?:{kind?:string}})?.query?.kind==='assistant.export'){
  const link=assistantExportLink(env,(q.input as {query:unknown}).query);await check();
  return {result:{content:[{type:'text',text:JSON.stringify(link)}]},provenance:emptyOwnerToolProvenance()};
 }
 // Read-only tools retain no duplicate content in the command ledger.
 if(tool.readOnly){const result=bounded(await tool.invoke(q.input),env,q.tool),provenance=await ownerToolProvenance(env,q.scope,q.tool,result);await check();return {result,provenance};}
 const now=Date.now(),receiptKeys=keys(q,q.tool,inputHash);
 // Results are short lived like prepared actions; uncertain claims never expire/retry.
 await env.DB.prepare('UPDATE owner_tool_receipts SET result_json=NULL WHERE expires_at<=? AND result_json IS NOT NULL').bind(now).run();
 const guard=await claimGuard();
 const claimed=await env.DB.prepare(`INSERT INTO owner_tool_receipts(installation_id,generation,source_epoch,source_generation,session_id,task_ref,tool,input_hash,state,created_at,expires_at)
 SELECT ?,?,?,?,?,?,?,?,'attempting',?,? WHERE (${guard.sql}) ON CONFLICT DO NOTHING`).bind(...receiptKeys,now,now+600000,...guard.values).run();
 if(claimed.meta.changes!==1){
  const old=await env.DB.prepare(`SELECT state,result_json,expires_at FROM owner_tool_receipts WHERE ${ns}`).bind(...receiptKeys).first<{state:string;result_json:string|null;expires_at:number}>();
  if(!old)throw new AppError('owner_tool_denied',403);
  if(old.state==='complete'&&old.result_json&&old.expires_at>Date.now()){await check();return {result:JSON.parse(old.result_json),provenance:emptyOwnerToolProvenance()};}
  return {result:{state:old.state==='complete'?'expired':'uncertain',tool:q.tool,inputHash},provenance:emptyOwnerToolProvenance()};
 }
 try{
  const result=bounded(await tool.invoke(q.input),env,q.tool),provenance=await ownerToolProvenance(env,q.scope,q.tool,result);await check();
  await env.DB.prepare(`UPDATE owner_tool_receipts SET state='complete',result_json=? WHERE ${ns} AND state='attempting'`).bind(JSON.stringify(receiptResult(result)),...receiptKeys).run();
  return {result,provenance};
 }catch{
  await env.DB.prepare(`UPDATE owner_tool_receipts SET state='uncertain' WHERE ${ns} AND state='attempting'`).bind(...receiptKeys).run();
  return {result:{state:'uncertain',tool:q.tool,inputHash},provenance:emptyOwnerToolProvenance()};
 }
}
/** Flue receives bounded text and private browser links, never base64 blobs. */
function bounded(result:unknown,env:Env,tool:string):unknown{
 if(tool==='consultar_audio_gerado'||tool==='consultar_envio'){
  const response=result as {content?:{type:string;text?:string}[]};
  if(response.content)result={...response,content:response.content.map(c=>{if(c.type!=='text'||!c.text)return c;try{const value=JSON.parse(c.text);delete value.text;delete value.envelope;return {...c,text:JSON.stringify(value)};}catch{return c;}})};
 }
 const r=result as {content?:{type:string;[key:string]:unknown}[]};
 let mediaId:string|undefined;
 for(const c of r?.content??[])if(c.type==='text'&&typeof c.text==='string'){try{const v=JSON.parse(c.text);if(typeof v.metadata?.id==='string')mediaId=v.metadata.id;}catch{}}
 const output=r?.content?{...r,content:r.content.map(c=>c.type==='text'?c:{type:'text',text:JSON.stringify({media:'private_binary',instruction:'Open the original through the authenticated browser link.',...(mediaId?{browserUrl:env.PUBLIC_ORIGIN+'/media/'+encodeURIComponent(mediaId)}:{})})})}:result;
 if(new TextEncoder().encode(JSON.stringify(output)).length>262144)throw new AppError('owner_tool_result_size',413);
 return output;
}

/** Keep only operational identifiers in replay receipts, never another copy of
 * messages, captions, source text or generated speech. Original action records
 * remain the authoritative content store and their normal retention applies. */
function receiptResult(result:unknown):unknown{
 const allowed=new Set(['id','actionId','operationId','mediaId','audioId','hash','sha256','status','state','error','code','expiresAt','createdAt','confirmationMode','confirmationUrl','browserUrl','previewUrl','version','revision','externalAttempted','accepted','ready','kind','completion','nextCursor']);
 function metadata(value:unknown):unknown{
  if(Array.isArray(value))return value.map(metadata);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key,val])=>allowed.has(key)?[[key,val]]:val&&typeof val==='object'?[[key,metadata(val)]]:[]));
 }
 const r=result as {content?:{type:string;text?:string}[];isError?:boolean};
 if(r.content)return {...(r.isError?{isError:true}:{}),content:r.content.filter(c=>c.type==='text').map(c=>{try{return {type:'text',text:JSON.stringify(metadata(JSON.parse(c.text!)))};}catch{return {type:'text',text:JSON.stringify({state:'recorded'})};}})};
 return metadata(result);
}
