import {z} from 'zod';
import {bridgeHash} from '../ingress';
import {sourceRef} from '../source-proof-contract';
import {knowledgeEntity,knowledgeEntityQuery,knowledgeQuery,type KnowledgeContext,type KnowledgePort,type KnowledgeReceipt,type NativeKnowledgeWrite} from './contracts';

const id=z.string().min(1).max(256);
const namespaceSchema=z.object({installationId:id,generation:id}).strict();
const origin=z.enum(['owner_report','agent_derived']);
const evidence=z.object({id,sourceRef,quote:z.string().optional(),origins:z.array(origin).optional()}).strict();
const receipt=z.object({operationId:id,state:z.enum(['not_found','accepted','indexing','ready','partial','uncertain','conflict']),
 origin:origin.optional(),sourceKey:id.optional(),claimIds:z.array(id).optional(),evidenceIds:z.array(id).optional(),
 supportGroupIds:z.array(id).optional(),error:z.string().max(256).optional()}).strict();
const claim=z.object({id,subject:knowledgeEntity,predicate:z.string().min(1).max(512),object:knowledgeEntity,
 classification:z.enum(['reported','inferred']),validFrom:z.string().nullable().optional(),validUntil:z.string().nullable().optional(),
 origins:z.array(origin).optional(),evidence:z.array(evidence),supportGroups:z.array(z.object({id,evidence:z.array(evidence)}).strict())}).strict();
const coverage=z.object({scope:z.literal('native_candidate_page'),state:z.enum(['complete','partial']),candidates:z.number().int().nonnegative(),returned:z.number().int().nonnegative()}).strict();
const claimsPage=z.object({claims:z.array(claim),nextCursor:id.optional(),coverage}).strict();
const entitiesPage=z.object({entities:z.array(knowledgeEntity),nextCursor:id.optional(),coverage}).strict();
export type KnowledgeNamespace=z.infer<typeof namespaceSchema>;
export type KnowledgeHttpOptions={endpoint:string;token:string;namespace:KnowledgeNamespace;operationalGeneration:string;client:KnowledgeContext['client'];timeoutMs?:number;fetch?:typeof fetch};

/** Host-only transport. Namespace is a stable knowledge space; receipt IDs are
 * separated by operational generation. No model argument chooses either one.
 * Network failure never retries a mutation. Its caller reconciles the same ID. */
export class HttpKnowledgePort implements KnowledgePort {
 private readonly endpoint:string;
 private readonly token:string;
 private readonly namespace:KnowledgeNamespace;
 private readonly generation:string;
 private readonly client:KnowledgeContext['client'];
 private readonly timeoutMs:number;
 private readonly transport:typeof fetch;
 constructor(options:KnowledgeHttpOptions){
  const url=new URL(options.endpoint);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.pathname!=='/knowledge')throw Error('knowledge_endpoint_configuration');
  if(typeof options.token!=='string'||options.token.length<32||!/^[\x21-\x7e]+$/.test(options.token))throw Error('knowledge_token_configuration');
  this.namespace=Object.freeze(namespaceSchema.parse(options.namespace));
  this.generation=id.parse(options.operationalGeneration);
  this.client=z.enum(['owner_mcp','owner_telegram','conversation_agent','curator']).parse(options.client);
  this.timeoutMs=options.timeoutMs??30000;
  if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>60000)throw Error('knowledge_timeout_configuration');
  this.endpoint=url.href;this.token=options.token;this.transport=options.fetch??fetch;
 }
 private wireId(operationId:string){return bridgeHash(['knowledge-wire-operation-v1',this.namespace,this.generation,this.client,id.parse(operationId)]);}
 private async call<T>(method:string,input:unknown,schema:z.ZodType<T>):Promise<T>{
  const body=JSON.stringify({namespace:this.namespace,method,input});
  if(new TextEncoder().encode(body).length>262144)throw Error('knowledge_request_size');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{
   const response=await this.transport(this.endpoint,{method:'POST',redirect:'error',signal:controller.signal,
    headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json',Accept:'application/json'},body});
   if(!response.ok||!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw Error('response');
   const reader=response.body?.getReader();if(!reader)throw Error('response');
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    // Per-response allocation guard, not a limit on stored knowledge. Continue
    // through returned cursors for larger result sets.
    if(size>4*1024*1024){await reader.cancel();throw Error('response');}chunks.push(value);}}
   finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const envelope=z.object({ok:z.literal(true),namespace:namespaceSchema,result:schema}).strict().parse(JSON.parse(new TextDecoder().decode(bytes)));
   if(envelope.namespace.installationId!==this.namespace.installationId||envelope.namespace.generation!==this.namespace.generation)throw Error('response');
   return envelope.result;
  }catch{throw Error('knowledge_transport_unavailable');}
  finally{clearTimeout(timer);}
 }
 private async operation(method:'remember'|'withdraw'|'status',operationId:string,input:Record<string,unknown>={}):Promise<KnowledgeReceipt>{
  const wireId=await this.wireId(operationId),result=await this.call(method,{operationId:wireId,...input},receipt);
  if(result.operationId!==wireId)throw Error('knowledge_receipt_mismatch');
  return {...result,operationId};
 }
 remember(operationId:string,input:NativeKnowledgeWrite){return this.operation('remember',operationId,{input});}
 withdraw(operationId:string,ref:z.infer<typeof sourceRef>){return this.operation('withdraw',operationId,{sourceRef:sourceRef.parse(ref)});}
 status(operationId:string){return this.operation('status',operationId);}
 query(input:z.infer<typeof knowledgeQuery>){return this.call('query',knowledgeQuery.parse(input),claimsPage);}
 get_entity(entityId:string){return this.call('get_entity',{id:id.parse(entityId)},knowledgeEntity.nullable());}
 find_entities(input:z.infer<typeof knowledgeEntityQuery>){return this.call('find_entities',knowledgeEntityQuery.parse(input),entitiesPage);}
}
