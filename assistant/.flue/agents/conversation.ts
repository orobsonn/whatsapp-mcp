'use agent';
import { init, useAgentStart, useDelivery, useInitialData, useModel, useSkill, type DeliveredMessage } from '@flue/runtime';
import robsonWriting from '../skills/escrever-como-robson/SKILL.md';
import { getCloudflareContext, getDurableObjectIdentity } from '@flue/runtime/cloudflare';
import * as v from 'valibot';
import type { ConversationIdentity, ConversationRuntime } from '../../agent-runtime/conversation';
import { useConversationKnowledgeTools } from '../tools/knowledge';
import { useConversationCohort } from '../../agent-runtime/conversation-cohorts';
import type {ConversationReadCapabilities} from '../tools/read';
import type {TaskContext} from '../../agent-runtime/conversation';
import {curatorInstructions,isCuratorPrincipal,type KnowledgeCurator} from '../../knowledge/curator';
import type {NativeTaskCapabilities} from '../tools/tasks';
import type {NativeOwnerToolCapabilities} from '../../agent-runtime/native-owner-tools';
import {useConversationActionTools} from '../tools/actions';
import {conversationInstructions} from '../instructions/conversation';
import {nativeModelSelection} from '../providers/model-selection';

const seedSchema=v.strictObject({version:v.literal(1),installationId:v.string(),generation:v.string(),
 channel:v.picklist(['whatsapp','telegram']),principalOrChatId:v.string(),contextEpoch:v.string()});
export type ConversationApplicationFrame={reads:ConversationReadCapabilities;
 media:{read(ref:unknown):Promise<unknown>};
 tasks?:NativeTaskCapabilities;
 ownerTools?:NativeOwnerToolCapabilities;
 curator?:{curator:KnowledgeCurator;runId:string;finish(input:{needsHelp?:boolean;helpRequest?:string},signal?:AbortSignal):Promise<unknown>};
 effects:{reply(input:unknown):Promise<unknown>;respondOwner(text:string):Promise<unknown>;askOwner(question:string):Promise<unknown>;calendarChange(mutation:unknown):Promise<unknown>;reassessWhatsApp?(ref:unknown):Promise<unknown>}};
export type ConversationResolver=(env:Record<string,unknown>,sessionId:string,delivery:DeliveredMessage)=>Promise<{
 runtime:ConversationRuntime;
 frame?:(task:TaskContext)=>Promise<ConversationApplicationFrame>;
 consumed?:(task:TaskContext)=>Promise<void>;
 /** Optional additional host assertion. It must match the ordered events
  * observed by the native hooks; pending deliveries cannot extend it. */
 consumedTaskRefs?:readonly string[];
}>;
// Application configuration only, installed once at Worker startup. No task,
// actor, grant, transcript or event is retained in module-level state.
let configuredResolver:ConversationResolver|undefined;
export function configureConversationResolver(resolve:ConversationResolver){
 if(configuredResolver&&configuredResolver!==resolve)throw Error('conversation_resolver_already_configured');configuredResolver=resolve;
}
export function ConversationRuntimeAgent(){
 const seed=useInitialData<ConversationIdentity>(),delivery=useDelivery();
 const privateCurator=seed.channel==='telegram'&&isCuratorPrincipal(seed.principalOrChatId);
 if(!privateCurator)useSkill(robsonWriting);
 const cohort=useConversationCohort();
 // Provider registration and its pre-transport budget authorization remain the
 // host's responsibility. This is the real native Pi model/tool loop from P0.
 // Use Flue's model-aware compaction defaults. The provider still owns the
 // effective output/spend ceiling, including its summarization turns.
 const selectedModel=nativeModelSelection(getCloudflareContext().env);
 useModel(selectedModel.model,{thinkingLevel:selectedModel.thinkingLevel});
 async function host(){
  const resolver=configuredResolver;if(!resolver)throw Error('conversation_resolver_unconfigured');
  const {env}=getCloudflareContext(),identity=getDurableObjectIdentity();
  if(identity.className!=='FlueConversationRuntimeAgent')throw Error('conversation_profile_denied');
  const resolved=await resolver(env,identity.name,delivery);
  return {...resolved,sessionId:identity.name};
 }
 function assertObserved(actual:readonly string[],expected?:readonly string[]){
  if(expected&&(expected.length!==actual.length||expected.some((ref,index)=>ref!==actual[index])))throw Error('conversation_cohort_denied');
 }
 async function bound(){
  if(delivery.kind!=='signal'||!delivery.attributes?.taskRef)throw Error('conversation_delivery_denied');
  const refs=cohort.refsFor(delivery.attributes.taskRef);
  const {runtime,consumedTaskRefs,sessionId,frame}=await host();assertObserved(refs,consumedTaskRefs);
  const task=await runtime.resolveTask(seed,delivery,refs);
  if(task.sessionId!==sessionId)throw Error('conversation_profile_denied');
  return {runtime,task,frame};
 }
 // Runs for every actually consumed delivery, including a join. Invalid
 // epochs/metadata fail before the model reads the next message.
 useAgentStart(async()=>{
  const {runtime,consumedTaskRefs,sessionId,consumed}=await host();
  // Authenticate this delivery alone before recording it as consumed. Other
  // callbacks cannot race this validation with an append in a sibling hook.
  const task=await runtime.resolveTask(seed,delivery);if(task.sessionId!==sessionId)throw Error('conversation_profile_denied');
  await runtime.assertTaskCurrent(task);cohort.observe(task.taskRef);
  await consumed?.(task);
  assertObserved(cohort.refsFor(task.taskRef),consumedTaskRefs);
 });
 useConversationKnowledgeTools(async()=>{
  const binding=await bound();
  if(seed.channel!=='telegram'||!isCuratorPrincipal(seed.principalOrChatId)||!binding.frame)return binding;
  // Capture the exact authenticated frame BEFORE the knowledge operation. A
  // later join must not rebind an already committed write to a different run.
  const frame=await binding.frame(binding.task),curator=frame.curator;
  return {...binding,...(curator?{onKnowledgeIntent:(operationId:string,input:Parameters<KnowledgeCurator['recordLearning']>[2])=>curator.curator.recordLearning(curator.runId,operationId,input),onKnowledgeReady:(operationId:string)=>curator.curator.reflectReady(curator.runId,operationId)}:{})};
 });
 useConversationActionTools(seed,delivery,bound);
 if(privateCurator)return curatorInstructions;
 return conversationInstructions(seed.channel);
}
ConversationRuntimeAgent.agentName='conversation-runtime';
ConversationRuntimeAgent.initialData=seedSchema;
// Research and daily curation may legitimately take more than two minutes.
// Keep the SDK's native deadline and recovery policy. Every new generation
// still passes the budget/receipt adapter; external authority is unchanged.

/** Explicit opt-in driver. Existing legacy install/profiles/provider are
 * untouched; do not expose this agent until budget and P5 guards are wired. */
export const conversationDriver=(sessionId:string)=>init(ConversationRuntimeAgent,{id:sessionId});
