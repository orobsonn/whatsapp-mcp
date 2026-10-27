import { z } from "zod";
const id = z.string().min(1).max(256), integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationId = z.string().trim().min(1).max(128);
export const onceCommand = z.union([
  z.object({ kind: z.literal("owner_once.plan"), operationId, sourceId: id, expectedRevision: integer, projectId: id,
    query: z.string().min(1).refine(text => new TextEncoder().encode(text).length <= 2048), deadlineAt: integer,
    maxCostMicroUsd: integer.max(600000) }).strict(),
  z.object({ kind: z.literal("owner_once.recovery_plan"), operationId, previousOperationId: operationId,
    deadlineAt: integer, maxCostMicroUsd: integer.max(600000) }).strict(),
  z.object({ kind: z.literal("owner_once.status"), operationId }).strict(),
  z.object({ kind: z.literal("owner_once.inspect"), operationId }).strict(),
  z.object({ kind: z.literal("owner_once.advance"), operationId }).strict(),
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const onceExecutionMetadata = z.object({
  state: z.literal("observed"), imageConfigured: z.boolean(), activePresent: z.boolean(), quarantine: z.boolean(),
  index: z.discriminatedUnion("state", [z.object({state:z.literal("absent")}).strict(),z.object({state:z.literal("invalid")}).strict(),
    z.object({state:z.literal("present"),epoch:z.uuid(),revision:z.union([hash,z.literal("empty")]),sourceCount:z.number().int().nonnegative().safe(),lost:z.boolean()}).strict()]),
  initial: z.discriminatedUnion("state", [z.object({state:z.literal("absent")}).strict(),z.object({state:z.literal("invalid")}).strict(),
    z.object({state:z.literal("present"),itemId:hash,admissionState:z.enum(["reserved","attempting","uncertain","complete"]),indexEpoch:z.uuid(),operationId:hash,hasAccess:z.boolean(),hasReceipt:z.boolean()}).strict()]),
}).strict();
/** Metadata-only local operator result. Never forward a source, query, grant,
 * model body or unexpected field from a remote RPC response. */
export const onceOperatorResult = z.object({
  state: z.enum(["planned", "admitted", "pending", "blocked", "uncertain", "complete", "unavailable"]),
  id: z.string().regex(/^[a-f0-9]{64}$/).optional(), jobId: id.optional(), episodeId: id.optional(), decisionId: z.string().min(1).max(2048).optional(),
  phase: z.string().regex(/^[a-z_]{1,64}$/).optional(), reason: z.string().regex(/^[a-z_]{1,128}$/).optional(),
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), deadlineAt: integer.optional(), maxCostMicroUsd: integer.max(600000).optional(),
  corpus: z.object({ sourceCount: integer.max(24), utf8Bytes: z.number().int().nonnegative().max(24000) }).strict().optional(),
  observation: z.literal("historical_shadow_completion").optional(),
  executionMetadata: onceExecutionMetadata.optional(),
}).strict();
