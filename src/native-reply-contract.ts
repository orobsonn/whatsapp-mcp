import { z } from 'zod';
import { approvedSendScope, type ApprovedSendPrepared, type ApprovedSendReceipt, type ApprovedSendActuatorRPC } from './approved-send-contract';
const id=z.string().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/);
/** Distinct authority, never a fabricated human approval for autonomous work. */
export const nativeReplyAuthority=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('human_approval'),intentId:id,approvalId:id}).strict(),
 z.object({kind:z.literal('autonomous_policy'),intentId:id,policyRevision:z.number().int().nonnegative().safe(),grantRef:id}).strict(),
]);
export type NativeReplyExecutionAuthority=z.infer<typeof nativeReplyAuthority>;
export const nativeReplyAuthorizationRequest=z.object({secret:z.string().max(256),actionId:z.string().uuid(),hash,authority:nativeReplyAuthority}).strict();
export type NativeReplyAuthorizationRequest=z.infer<typeof nativeReplyAuthorizationRequest>;
export const nativeReplyAuthorization=z.union([
 z.object({authorized:z.literal(false)}).strict(),
 z.object({authorized:z.literal(true),actionId:z.string().uuid(),hash,authority:nativeReplyAuthority,expiresAt:z.number().int().positive().safe()}).strict(),
]);
export type NativeReplyAuthorization=z.infer<typeof nativeReplyAuthorization>;
export const nativeReplyExecuteInput=z.object({secret:z.string().max(256),scope:approvedSendScope,actionId:z.string().uuid(),authority:nativeReplyAuthority}).strict();
export interface NativeReplyActuatorRPC {
 prepare:ApprovedSendActuatorRPC['prepare'];
 status:ApprovedSendActuatorRPC['status'];
 executeNative(input:z.infer<typeof nativeReplyExecuteInput>):Promise<ApprovedSendReceipt>;
}
export type NativeReplyPrepared=ApprovedSendPrepared;
