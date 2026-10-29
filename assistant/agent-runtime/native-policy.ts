import type {AssistantEnv} from '../env';
import {activeOrigin,type OriginScope} from '../origin-guard';
import {telegramLinkGuard,type TelegramLinkFence} from '../telegram-auth';
import {retentionExecutionGuard} from '../retention-execution';
import type {AccessGuard} from '../access';
import {bridgeHash} from '../ingress';
import type {ConversationAuthority,ConversationIdentity} from './conversation';

export type NativeMode='off'|'shadow'|'approval'|'autonomous';
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
/** Current host authority has no dependency on transcript claims, mentions or
 * owner-looking message signatures. A readable group is not a reply grant. */
export async function nativeAuthority(env:AssistantEnv,identity:ConversationIdentity):Promise<{authority:ConversationAuthority;guard:AccessGuard}>{
 const scope=nativeScope(env),mode=nativeMode(env);
 if(!env.DB||mode==='off'||env.ROUTINES_PAUSED==='true'||identity.installationId!==scope.installationId||identity.generation!==scope.generation)throw Error('native_disabled');
 const fence=await nativeOwnerFence(env,scope),owner=telegramLinkGuard(fence),restore=retentionExecutionGuard(scope);
 let revision=fence.linkRevision,policy='owner',replyMode=mode;let channel:AccessGuard;
 if(identity.channel==='telegram'){
  if(identity.principalOrChatId!==fence.userId)throw Error('native_principal_denied');
  channel={sql:'1',values:[]};
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
 const grantRef=await bridgeHash(['native-authority-v1',scope,identity.channel,identity.principalOrChatId,fence.userId,fence.linkRevision,revision,policy]);
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
