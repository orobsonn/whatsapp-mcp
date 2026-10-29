import {z} from 'zod';
const label=z.string().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/),time=z.number().int().nonnegative().safe(),version=time.refine(n=>n>0);
const scope={installationId:label,generation:label},originScope={sourceEpoch:label.optional(),sourceGeneration:label.optional()},action=z.enum(['reply_text','reply_audio','ask_clarification','future_contact','read_github','read_calendar','propose_calendar_change']);
export const sourceRef = z.object({ id: label, revision: version, version, hash }).strict();
export const sourceFence = z.object({ ...scope, ...originScope, actor: z.string().max(2048),
  source: sourceRef.extend({ audience: z.enum(["owner", "restricted", "public"]), origin: label, conversationId: label.nullable(), projectId: label.nullable() }).strict(),
  knowledge: z.object({sourceEpoch:label,sourceGeneration:label,policyRevision:time,sharingQuarantined:z.boolean()}).strict().optional(),
  policy: z.object({ conversationId: label, kind: label, revision: time, mode: label }).strict().nullable(),
  identity: z.object({ personId: label, proofId: label, proofRevision: version }).strict().nullable(),
  mandate: z.object({ id: label, version, expiresAt: time, action: label }).strict().nullable(),
}).strict();
export const conversationFence = z.object({ ...scope, chatId: label, sourceEpoch: label.nullable(), sourceGeneration: label.nullable(),
  revision: time, policyRevision: time, mode: label, applied: time, received: time, coverageFrom: time }).strict();
