'use agent';
import {extend,type CloudflareAgentLike} from '@flue/runtime/cloudflare';
import {OwnerRuntime as Owner,InterlocutorRuntime as Interlocutor,OwnerDialogueRuntime as Dialogue} from './profiles';
import {ConversationRuntimeAgent as Conversation} from './conversation-profiles';
import type {AssistantEnv} from '../env';
import {safeEqual} from '../../src/core';

// Flue's compiler discovers declarations in its entry file, not re-exports.
// These shims retain the existing public runtime class names and exact hooks.
export function OwnerRuntime(){return Owner();}
OwnerRuntime.agentName='owner-runtime';OwnerRuntime.initialData=Owner.initialData;OwnerRuntime.durability=Owner.durability;
export function InterlocutorRuntime(){return Interlocutor();}
InterlocutorRuntime.agentName='interlocutor-runtime';InterlocutorRuntime.initialData=Interlocutor.initialData;InterlocutorRuntime.durability=Interlocutor.durability;
export function OwnerDialogueRuntime(){return Dialogue();}
OwnerDialogueRuntime.agentName='owner-dialogue-runtime';OwnerDialogueRuntime.initialData=Dialogue.initialData;OwnerDialogueRuntime.durability=Dialogue.durability;
export function ConversationRuntimeAgent(){return Conversation();}
ConversationRuntimeAgent.agentName='conversation-runtime';ConversationRuntimeAgent.initialData=Conversation.initialData;ConversationRuntimeAgent.durability=Conversation.durability;

interface NativeAdminAgent extends CloudflareAgentLike {destroy():Promise<void>}
/** Private named DO capability, never a model tool, @callable method or route.
 * Logical tombstone and actual DO name must match before supported destruction. */
export const cloudflare=extend<NativeAdminAgent,AssistantEnv>({base:Base=>class extends Base {
 async eraseNativeContext(secret:string,sessionId:string){
  const key=this.env.NATIVE_CONTEXT_ADMIN_SECRET;
  if(typeof key!=='string'||key.length<32||typeof secret!=='string'||!await safeEqual(key,secret)||
   !this.env.DB||this.ctx.id.name!==sessionId||!sessionId.startsWith('conversation-v1-'))throw Error('native_admin_denied');
  const row=await this.env.DB.prepare(`SELECT 1 FROM assistant_native_conversations WHERE id=? AND installation_id=? AND generation=? AND tombstoned_at IS NOT NULL`)
   .bind(sessionId,this.env.INSTALLATION_ID!,this.env.OPERATIONAL_GENERATION!).first();
  if(!row)throw Error('native_admin_denied');
  await this.destroy();
 }
}});
