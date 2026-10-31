import type {AssistantEnv} from '../env';
import {activeOrigin,type OriginScope} from '../origin-guard';
import {telegramLinkGuard,type TelegramLinkFence} from '../telegram-auth';
import {retentionExecutionGuard} from '../retention-execution';
import type {AccessGuard} from '../access';
import {bridgeHash} from '../ingress';
import {conversationAddress,type ConversationAuthority,type ConversationIdentity} from './conversation';
import {isCuratorPrincipal,curatorSampleRequest,type CuratorSampleRequest} from '../knowledge/curator';
import {z} from 'zod';

export type NativeMode='off'|'shadow'|'approval'|'autonomous';
export const nativeCuratorResumeRequest=z.object({runId:z.string().min(1).max(256),previousSubmissionId:z.string().min(1).max(256)}).strict();
/** Select the host's curation request before allocating any native identity or
 * admitting a daily window. A sample cannot silently disable a daily schedule. */
export function nativeCuratorDispatchRequest(env:AssistantEnv):{kind:'disabled'}|{kind:'daily'}|{kind:'sample';request:CuratorSampleRequest}|{kind:'resume';request:z.infer<typeof nativeCuratorResumeRequest>}{
 const schedule=env.NATIVE_CURATOR_SCHEDULE_ENABLED??'false',sample=env.NATIVE_CURATOR_SAMPLE_REQUEST,resume=env.NATIVE_CURATOR_RESUME_REQUEST;
 if(!['true','false'].includes(schedule))throw Error('native_curator_configuration_invalid');
 if(sample!==undefined&&schedule==='true')throw Error('native_curator_configuration_conflict');
 if(resume!==undefined&&sample!==undefined)throw Error('native_curator_configuration_conflict');
 if(resume!==undefined){if(env.NATIVE_CURATOR_ENABLED!=='true')return {kind:'disabled'};try{return {kind:'resume',request:nativeCuratorResumeRequest.parse(JSON.parse(resume))};}catch{throw Error('native_curator_resume_invalid');}}
 if(env.NATIVE_CURATOR_ENABLED!=='true'||schedule==='false'&&sample===undefined)return {kind:'disabled'};
 if(sample!==undefined){try{return {kind:'sample',request:curatorSampleRequest.parse(JSON.parse(sample))};}catch{throw Error('native_curator_sample_invalid');}}
 return {kind:'daily'};
}
export function nativeMode(env:AssistantEnv):NativeMode {
 const mode=env.NATIVE_CONVERSATIONS_MODE??'off';
 if(!['off','shadow','approval','autonomous'].includes(mode))throw Error('native_configuration_invalid');
 if(mode==='autonomous'&&env.ASSISTANT_NATIVE_AUTONOMOUS_ENABLED!=='true')throw Error('native_autonomous_disabled');
 return mode as NativeMode;
}
export const joinGuards=(...guards:AccessGuard[]):AccessGuard=>({sql:guards.map(g=>`(${g.sql})`).join(' AND '),values:guards.flatMap(g=>g.values)});
export function nativeScope(env:AssistantEnv){return activeOrigin(()=>({installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!}));}
export async function nativeOwnerFence(env:AssistantEnv,scope:OriginScope):Promise<TelegramLinkFence>{
 const row=await env.DB!.prepare(`SELECT revision,user_id,chat_id FROM assistant_telegram_links WHERE installation_id=? AND generation=? AND bot_instance=? AND source_epoch=? AND source_generation=? AND state='active'`)
  .bind(scope.installationId,scope.generation,env.TELEGRAM_BOT_INSTANCE!,scope.sourceEpoch,scope.sourceGeneration).first<{revision:number;user_id:string;chat_id:string}>();
 if(!row)throw Error('native_owner_unlinked');
 return {...scope,botInstance:env.TELEGRAM_BOT_INSTANCE!,linkRevision:row.revision,userId:row.user_id,chatId:row.chat_id};
}
const activationSchema=z.object({version:z.literal(1),sourceEpoch:z.string(),sourceGeneration:z.string(),botInstance:z.string(),linkRevision:z.number().int().positive(),userId:z.string(),chatId:z.string(),activatedAt:z.number().int().positive().safe()}).strict();
/** A one-time migration boundary, not an age limit on normal conversations.
 * Persist and replace only under the operational execution hold. Telegram
 * update IDs can restart after inactivity; message dates and receipt time are
 * therefore both checked. The ambiguous boundary second is never admitted. */
export async function nativeTelegramActivation(env:AssistantEnv,scope:OriginScope,fence:TelegramLinkFence){
 const raw=await env.DB!.prepare('SELECT telegram_activation_json FROM assistant_native_host_state WHERE installation_id=? AND generation=?')
  .bind(scope.installationId,scope.generation).first<string>('telegram_activation_json');
 if(!raw)throw Error('native_telegram_cut_unconfigured');
 let cut:z.infer<typeof activationSchema>;try{cut=activationSchema.parse(JSON.parse(raw));}catch{throw Error('native_telegram_cut_unconfigured');}
 for(const key of ['sourceEpoch','sourceGeneration','botInstance','linkRevision','userId','chatId'] as const)if(cut[key]!==fence[key])throw Error('native_telegram_cut_denied');
 const guard:AccessGuard={sql:'EXISTS(SELECT 1 FROM assistant_native_host_state WHERE installation_id=? AND generation=? AND telegram_activation_json=?)',values:[scope.installationId,scope.generation,raw]};
 return {key:await bridgeHash(['native-telegram-activation-v1',scope,cut]),json:raw,guard,activatedAt:cut.activatedAt,cutSecond:Math.floor(cut.activatedAt/1000)};
}
/** Current host authority has no dependency on transcript claims, mentions or
 * owner-looking message signatures. A readable group is not a reply grant. */
export async function nativeAuthority(env:AssistantEnv,identity:ConversationIdentity):Promise<{authority:ConversationAuthority;guard:AccessGuard}>{
 const scope=nativeScope(env),mode=nativeMode(env);
 if(!env.DB||mode==='off'||env.ROUTINES_PAUSED==='true'||identity.installationId!==scope.installationId||identity.generation!==scope.generation)throw Error('native_disabled');
 const fence=await nativeOwnerFence(env,scope),owner=telegramLinkGuard(fence),restore=retentionExecutionGuard(scope);
 let revision=fence.linkRevision,policy='owner',replyMode=mode,activationKey:string|null=null;let channel:AccessGuard;
 if(identity.channel==='telegram'){
  if(isCuratorPrincipal(identity.principalOrChatId)){
   if(env.NATIVE_CURATOR_ENABLED!=='true'||identity.principalOrChatId!=='curator:'+fence.userId)throw Error('native_principal_denied');
   replyMode='shadow';policy='private_curator';
  }else if(identity.principalOrChatId!==fence.userId)throw Error('native_principal_denied');
  if(isCuratorPrincipal(identity.principalOrChatId))channel={sql:'1',values:[]};
  else{
   const activation=await nativeTelegramActivation(env,scope,fence),sessionId=await conversationAddress(identity,identity.channel,identity.principalOrChatId,identity.contextEpoch);
   // Also fence an event admitted while the operator's cut changes: a later
   // authority read cannot relabel its old host receipt with the new grant.
   channel=joinGuards(activation.guard,{sql:`NOT EXISTS(SELECT 1 FROM assistant_native_conversation_events e
    LEFT JOIN assistant_native_host_events h ON h.conversation_id=e.conversation_id AND h.event_id=e.event_id AND h.event_revision=e.revision
    WHERE e.conversation_id=? AND e.sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=e.conversation_id)
    AND (h.telegram_activation_key IS NULL OR h.telegram_activation_key<>?))`,values:[sessionId,activation.key]});activationKey=activation.key;
  }
 }else{
  const row=await env.DB.prepare(`SELECT o.kind,o.access_state,COALESCE(p.revision,0) revision,
   CASE WHEN p.kind IS NOT NULL AND p.kind<>o.kind THEN 'ignore' ELSE COALESCE(p.effective_mode,CASE WHEN o.kind='private' THEN 'attend' ELSE 'ignore' END) END mode
   FROM assistant_origin_conversations o LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
   WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=?`)
   .bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,identity.principalOrChatId).first<{kind:string;access_state:string;revision:number;mode:string}>();
  if(!row||row.access_state!=='available'||row.mode==='ignore')throw Error('native_conversation_denied');
  if(row.kind==='group'&&row.mode!=='respond')replyMode='shadow';
  revision=row.revision;policy=row.mode;
  channel={sql:`EXISTS(SELECT 1 FROM assistant_origin_conversations o LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
   WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=? AND o.kind=? AND o.access_state='available'
   AND COALESCE(p.revision,0)=? AND (p.kind IS NULL OR p.kind=o.kind) AND COALESCE(p.effective_mode,CASE WHEN o.kind='private' THEN 'attend' ELSE 'ignore' END)=?
   AND NOT EXISTS(SELECT 1 FROM assistant_conversations c WHERE c.installation_id=o.installation_id AND c.generation=o.generation AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id AND c.paused=1))`,
   values:[scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,identity.principalOrChatId,row.kind,revision,policy]};
 }
 const guard=joinGuards(owner,restore,channel);
 if(!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first())throw Error('native_authority_denied');
 const grantRef=await bridgeHash(['native-authority-v1',scope,identity.channel,identity.principalOrChatId,fence.userId,fence.linkRevision,revision,policy,...(activationKey?[activationKey]:[])]);
 return {authority:{ownerId:fence.userId,sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,policyRevision:revision,grantRef,mode:replyMode},guard};
}
/** Existing period accounts must be configured operationally beforehand. The
 * external carry is a reconciled amount OUTSIDE this DB; never initialize it
 * from zero, a new generation, or an empty daily account automatically. */
export function nativeGlobalBudgetGuard(env:AssistantEnv):AccessGuard {
 const raw=env.NATIVE_BUDGET_EXTERNAL_CARRY_MICROUSD;
 if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw Error('native_budget_carry_unconfigured');
 const carry=Number(raw),cap=10000000;
 if(carry>cap)throw Error('native_budget_exhausted');
 // A different installation's blocked account is not a global prohibition.
 // InferenceBudget enforces this operation's own account/namespace block.
 return {sql:`?+COALESCE((SELECT SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END) FROM assistant_budget_reservations),0)<=?`,values:[carry,cap]};
}
