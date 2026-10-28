import { z } from "zod";
const id = z.string().min(1).max(256);
export const approvedSendScope = z.object({ installationId: id, generation: id, sourceEpoch: id, sourceGeneration: id }).strict();
export type ApprovedSendScope = z.infer<typeof approvedSendScope>;
export const approvedSendEnvelope = z.object({ kind: z.literal("text"), chatId: id, text: z.string().min(1).max(8000).refine(value => value.trim().length > 0) }).strict();
const authenticated = z.object({ secret: z.string().max(256), scope: approvedSendScope }).strict();
export const approvedSendActivityFence = z.object({ triggerSequence: z.number().int().positive().safe(), relationshipRevision: z.number().int().nonnegative().safe(), relationshipProof: z.string().regex(/^[a-f0-9]{64}$/), members: z.array(id).min(1).max(2) }).strict();
export type ApprovedSendActivityFence = z.infer<typeof approvedSendActivityFence>;
export const captureConversationActivity = z.discriminatedUnion("state", [z.object({ observation:z.literal("capture_conversation_activity"),state:z.literal("available"),sourceEpoch:id,sourceGeneration:id,chatId:id,relationshipRevision:z.number().int().nonnegative().safe(),relationshipProof:z.string().regex(/^[a-f0-9]{64}$/),members:z.array(z.object({chatId:id,captureEnabled:z.boolean(),watermark:z.number().int().nonnegative().safe()}).strict()).min(1).max(2),watermark:z.number().int().nonnegative().safe(),lastOwnerOriginalSequence:z.number().int().nonnegative().safe() }).strict(),z.object({observation:z.literal("capture_conversation_activity"),state:z.literal("blocked"),reason:id}).strict()]);
export type ConversationActivity = z.infer<typeof captureConversationActivity>;
export const approvedSendPrepareInput = authenticated.extend({ operationId: id, envelope: approvedSendEnvelope, activity: approvedSendActivityFence }).strict();
export const approvedSendExecuteInput = authenticated.extend({ actionId: z.string().uuid(), approvalId: id }).strict();
export const approvedSendStatusInput = authenticated.extend({ actionId: z.string().uuid() }).strict();
export interface ApprovedSendPrepared {
  actionId: string; hash: string; envelope: z.infer<typeof approvedSendEnvelope>;
  target: { chatId: string; name: string; address: string; kind: "individual" | "group" }; expiresAt: number;
  activity: ApprovedSendActivityFence;
}
export interface ApprovedSendReceipt {
  actionId: string; hash: string; status: string; providerMessageId: string | null;
  providerZaapId: string | null; error: string | null; expiresAt: number;
}
export type ApprovedSendAuthorization = { authorized: false } | {
  authorized: true; actionId: string; hash: string; approvalId: string; expiresAt: number;
};
export interface ApprovedSendActuatorRPC {
  prepare(input: z.infer<typeof approvedSendPrepareInput>): Promise<ApprovedSendPrepared>;
  execute(input: z.infer<typeof approvedSendExecuteInput>): Promise<ApprovedSendReceipt>;
  status(input: z.infer<typeof approvedSendStatusInput>): Promise<ApprovedSendReceipt>;
}
