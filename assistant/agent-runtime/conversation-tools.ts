import { useTool } from '@flue/runtime';
import * as v from 'valibot';
import { bridgeHash } from '../ingress';
import { knowledgeCommand, knowledgeQuery, knowledgeRemember } from '../knowledge/contracts';
import type { ConversationRuntime, TaskContext } from './conversation';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const name=v.pipe(v.string(),v.minLength(1),v.maxLength(512));
const integer=v.pipe(v.number(),v.integer(),v.minValue(1),v.safeInteger());
const entityKind=v.picklist(['person','project','group','conversation','repository','decision']);
const classification=v.picklist(['reported','inferred']);
const pagination={after:v.optional(id),limit:v.optional(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(100)))};
const evidence=v.strictObject({sourceRef:v.strictObject({id,revision:integer,version:integer,hash:v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/))}),quote:v.optional(v.pipe(v.string(),v.minLength(1)))});
const relation=v.strictObject({subjectId:id,predicate:name,objectId:id,classification,
 validFrom:v.optional(v.string()),validUntil:v.optional(v.string()),evidence:v.pipe(v.array(evidence),v.minLength(1))});
export type ConversationToolBinding={runtime:ConversationRuntime;task:TaskContext};
/** The resolver closes over this native render's delivery. It may resolve a
 * host-recorded consumed cohort, but must never read a mutable "active task". */
export function useConversationKnowledgeTools(resolve:()=>Promise<ConversationToolBinding>){
 async function execute(command:Parameters<Awaited<ReturnType<ConversationRuntime['knowledge']>>['execute']>[0]){
  const {runtime,task}=await resolve(),knowledge=await runtime.knowledge(task);
  const result=await knowledge.execute(command);await runtime.assertTaskCurrent(task);return {output:result};
 }
 useTool({name:'knowledge_query',description:'Find authorized relationships and their exact original evidence. Follow nextCursor when useful; a page is not the whole archive.',
  input:v.strictObject({entityId:v.optional(id),predicate:v.optional(name),classification:v.optional(classification),...pagination}),
  async run({data}){return execute({kind:'query',...knowledgeQuery.parse(data)});}});
 useTool({name:'knowledge_entities',description:'Find people, projects and other entities in the shared authorized knowledge space. A matching name does not prove identity.',
  input:v.strictObject({query:v.optional(v.pipe(v.string(),v.maxLength(512))),entityKind:v.optional(entityKind),...pagination}),
  async run({data}){return execute(knowledgeCommand.parse({kind:'entities',...data}));}});
 useTool({name:'knowledge_remember',description:'Learn useful relationships from exact accessible source references. Preserve reported versus inferred and temporal limits. Origin and operation identity are supplied by the host. If uncertain, query knowledge_status using the returned operationId.',
  input:v.strictObject({entities:v.pipe(v.array(v.union([v.strictObject({key:id,ref:id}),v.strictObject({key:id,kind:entityKind,name})])),v.minLength(1)),relations:v.pipe(v.array(relation),v.minLength(1))}),
  async run({data}){
   const {runtime,task}=await resolve();await runtime.assertTaskCurrent(task);
   // Content-addressed within this immutable task: repeating an uncertain call
   // with another native toolCallId still reconciles the SAME P1 operation.
   const {operationId:_,...input}=knowledgeRemember.parse({...data,operationId:'host-normalization'});
   const operationId='conversation-knowledge-v1-'+await bridgeHash([task.contextRef,input]);
   const command={...input,operationId},knowledge=await runtime.knowledge(task);
   const result=await knowledge.execute({kind:'remember',...command});await runtime.assertTaskCurrent(task);return {output:result};
  }});
 useTool({name:'knowledge_status',description:'Reconcile an existing knowledge operation by its exact operationId. accepted and indexing do not mean ready; uncertainty does not authorize another operation.',
  input:v.strictObject({operationId:id}),async run({data}){return execute({kind:'status',operationId:data.operationId});}});
}
