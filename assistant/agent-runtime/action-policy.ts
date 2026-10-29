import type { TaskContext } from './conversation';
import type { NativeReplyExecutionAuthority } from '../../src/native-reply-contract';
export type ReplyAuthority=
 | {kind:'shadow';intentId:string}
 | {kind:'human_approval';intentId:string;approvalId:null}
 | NativeReplyExecutionAuthority
 | {kind:'blocked';intentId:string;reason:'autonomous_disabled'};
/** Decisions/text are shared across modes; only the effect authority changes.
 * Configuration is supplied by the host, never by a model tool argument. */
export function authorizeReply(task:TaskContext,intent:{id:string},autonomousEnabled=false):ReplyAuthority{
 switch(task.authority.mode){
  case 'shadow':return {kind:'shadow',intentId:intent.id};
  case 'approval':return {kind:'human_approval',intentId:intent.id,approvalId:null};
  case 'autonomous':return autonomousEnabled
   ?{kind:'autonomous_policy',intentId:intent.id,policyRevision:task.authority.policyRevision,grantRef:task.authority.grantRef}
   :{kind:'blocked',intentId:intent.id,reason:'autonomous_disabled'};
 }
}
