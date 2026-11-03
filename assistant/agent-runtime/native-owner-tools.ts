import {z} from 'zod';
import {githubQuery} from '../connectors/github';
import {calendarQuery} from '../connectors/calendar';
import {safeEqual} from '../../src/core';
import {ownerToolAuthorizationRequest,ownerToolName,type OwnerToolRPC} from '../../src/owner-tool-contract';
import type {AssistantEnv} from '../env';
import {configuredKnowledgeService} from '../knowledge/configured';
import {knowledgeCommand} from '../knowledge/contracts';
import {releaseOwnerToolResult,ownerToolPublication} from './native-owner-tool-release';
import {administrativeToolReferences} from './native-owner-tool-admin';
import type {ReadExposure} from '../knowledge/read-exposure';
import type {TaskContext} from './conversation';
import type {NativeApplicationHost} from './native-host';

export type NativeOwnerToolCapabilities={catalog(input:{name?:string;after?:string;limit?:number}):Promise<unknown>;execute(input:{tool:string;input:unknown}):Promise<unknown>};

/** This capability is captured per authenticated owner task, never inherited
 * from a schedule, a WhatsApp delivery or a curator run. Source owns the closed
 * catalog, schema validation, effect receipts and final authorization callback. */
export function nativeOwnerTools(host:NativeApplicationHost,env:AssistantEnv,task:TaskContext):NativeOwnerToolCapabilities{
 const binding=env.WHATSAPP_APPROVED_SEND,rpc=binding as unknown as OwnerToolRPC|undefined,secret=env.WHATSAPP_APPROVED_SEND_SECRET;
 async function base(){
  await host.tasks().ownerRequest(task);
  if(!secret||secret.length<32||env.WHATSAPP_APPROVED_SEND_SECRET!==secret||env.WHATSAPP_APPROVED_SEND!==binding||!rpc?.ownerToolCatalog||!rpc.ownerToolExecute)throw Error('native_owner_tools_unconfigured');
  return {secret,scope:host.currentScope(),sessionId:task.sessionId,taskRef:task.taskRef};
 }
 return {
  async catalog(input){const authority=await base();const result=await rpc!.ownerToolCatalog({...authority,...input,name:input.name===undefined?undefined:ownerToolName.parse(input.name)});await host.tasks().ownerRequest(task);return result;},
  async execute(input){const authority=await base();
   if(input.tool==='assistente_memoria'){
    const command=knowledgeCommand.parse((input.input as {command?:unknown})?.command);
    const proofs:ReadExposure[]=[];
    const service=configuredKnowledgeService(env,authority.scope,'owner_mcp').withExposure(async proof=>{proofs.push(proof);await host.retention.expose(task.identity,proof);});
    const result=await service.execute(command);
    return releaseOwnerToolResult(host,env,task,{result:{content:[{type:'text',text:JSON.stringify(result)}]},provenance:{origins:[],canonicalRefs:proofs.flatMap(proof=>proof.sources.map(fence=>({id:fence.source.id,revision:fence.source.revision,version:fence.source.version,hash:fence.source.hash})))}});
   }
   const query=input.tool==='assistente_consultar'?(input.input as {query?:{kind?:unknown}})?.query:undefined;
   if(query&&['github.list','github.read','calendar.availability','calendar.propose'].includes(String(query.kind))){
    const parsed=z.object({query:z.union([githubQuery,calendarQuery])}).strict().parse(input.input).query;
    const reads=(await host.frame(task)).reads;
    let result:unknown;
    if(parsed.kind==='github.list'||parsed.kind==='github.read'){
     const {kind,...rest}=parsed;result=kind==='github.list'?await reads.github.list(rest):await reads.github.read(rest);
    }else if(parsed.kind==='calendar.availability'){
     const {kind:_,...rest}=parsed;result=await reads.calendar.availability(rest);
    }else result=await reads.calendar.propose(parsed);
    // The native reader registered all source/grant dependencies. Recheck the
    // latest owner command and the retained context before publication; its
    // final ownerContext SQL includes the context's exposure authority guard.
    await host.tasks().ownerRequest(task);
    return {content:[{type:'text',text:JSON.stringify(result)}]};
   }
   const result=ownerToolPublication.parse(await rpc!.ownerToolExecute({...authority,...input,tool:ownerToolName.parse(input.tool)}));
   result.provenance.canonicalRefs.push(...await administrativeToolReferences(host,env,input.tool,input.input,result.result));
   return releaseOwnerToolResult(host,env,task,result);},
 };
}

/** Called only over Source's named owner binding; no model chooses its actor,
 * identity, command body or expiry. Invalid/revoked commands fail closed. */
export async function authorizeNativeOwnerTool(host:NativeApplicationHost,env:AssistantEnv,raw:unknown){
 const input=ownerToolAuthorizationRequest.parse(raw),secret=env.WHATSAPP_APPROVED_SEND_SECRET;
 if(!secret||secret.length<32||!await safeEqual(secret,input.secret))return {authorized:false as const};
 try{
  const identity=await host.registered(input.sessionId),task=await host.runtime.resolveStoredTask(identity,input.taskRef);
  if(task.sessionId!==input.sessionId)throw Error('native_owner_tool_session_denied');
  await host.tasks().ownerRequest(task);host.currentScope();
  if(secret!==env.WHATSAPP_APPROVED_SEND_SECRET)throw Error('native_owner_tool_configuration_changed');
  return {authorized:true as const,expiresAt:Date.now()+5000};
 }catch{return {authorized:false as const};}
}
