import {sourceRef,sourceFence,conversationFence} from '../source-proof-contract';
export {sourceRef,sourceFence,conversationFence} from '../source-proof-contract';
import { z } from "zod";
import {outgoingProof} from '../outgoing';
import { semanticRankingSchema } from "../retrieval-runs";
import { mediaEvidenceSchema } from "../media-evidence";
import type { Episode } from "./episodes";
import {groupScopeSchema,groupManifestAllowed} from '../group-scope';
export const label = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().safe(), version = time.refine(value => value > 0);
const scope = { installationId: label, generation: label };
const originScope = { sourceEpoch: label.optional(), sourceGeneration: label.optional() };
const purpose = z.enum(["automation", "owner_read"]);
const action = z.enum(["reply_text", "reply_audio", "ask_clarification", "future_contact", "read_github", "read_calendar", "propose_calendar_change"]);
const actor = z.discriminatedUnion("kind", [z.object({ kind: z.literal("owner") }).strict(), z.object({ kind: z.literal("interlocutor"),
  provider: label, address: label, conversationId: label, conversationKind: z.enum(["private", "group"]), action, mandateId: label.optional() }).strict()]);

const origin = z.object({ ...scope, sourceEpoch: label, sourceGeneration: label, sourceKind: z.enum(["message", "media", "derivative", "conversation"]),
  sourceId: label, chatId: label, canonicalId: label, revision: version, version, watermark: time, hash,
  conversationKind: z.enum(["private", "group"]), policyRevision: time, policyMode: label }).strict();
export { origin as originFence };
const source = z.object({ id: label, text: z.string().max(32768).nullable(), authorId: label.nullable(), authorLabel: label.nullable(), occurredAt: time,
  fence: sourceFence, origin: origin.optional(), mediaEvidence: mediaEvidenceSchema.optional() }).strict();
const lease = z.object({ id: label, kind: z.enum(["extraction", "reasoning", "follow_up", "review", "maintenance"]), state: z.literal("processing"),
  attempts: version, max_attempts: version, lease_generation: version, lease_until: time, source_id: label, source_revision: version, last_error: z.string().nullable() });
const search = z.object({ ...scope, ...originScope, runId: hash, runToken: label, requestHash: hash, checkpoint: time,
  actor: z.string().max(2048), selected: z.array(sourceRef).max(10), allowedPackHash: hash, purpose, ranking:semanticRankingSchema.optional() }).strict();
const config = z.object({ extractionConfig: label, priceVersion: label, chatModel: label, embeddingModel: label,
  maxOutputTokens: version.max(6000), chatCeiling: version, embeddingCeiling: version }).strict();
const work = z.object({ ...scope, kind: z.literal("follow_up"), jobId: label, occurrenceId: label, occurrenceState: label, followUpId: label,
  version, state: label, sourceId: label, sourceRevision: version, missionId: label.nullable(), missionRevision: version.nullable(), mandateId: label.nullable(), mandateVersion: version.nullable() }).strict();
const target = z.object({ fence: conversationFence.nullable(), policy: z.object({ kind: z.enum(["private", "group"]), revision: time, mode: label }).strict() }).strict();

export const decisionSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("capture_event"), sourceEpoch: label, sourceGeneration: label, chatId: label, sequence: version, metadataHash: hash }).strict(),
  z.object({ kind: z.literal("owner_request"), sourceId: label, sourceRevision: version, requestKey: label }).strict(),
  z.object({ kind: z.literal("fup_occurrence"), occurrenceId: label, followUpId: label, followUpVersion: version }).strict(),
]);
export type DecisionSubject = z.infer<typeof decisionSubject>;
export const jobRequest = z.object({ kind: label, sourceId: label, sourceRevision: version, input: z.string().max(32768), actor,outgoing:outgoingProof.optional(),contextMode:z.literal('conversation_manifest').optional(),sourceRefs:z.array(sourceRef).min(1).max(3).optional(),groupScope:groupScopeSchema.optional(),
  fence: sourceFence, conversation: conversationFence.nullable(), runtime: z.literal("flue"), subject: decisionSubject }).strict().superRefine((value,ctx)=>{if(value.contextMode?(!value.sourceRefs||value.actor.kind!=='interlocutor'||!(value.actor.conversationKind==='private'&&!value.groupScope||groupManifestAllowed(value.groupScope,value.actor,value.fence,value.subject))||value.subject.kind!=='capture_event'||value.fence.source.origin!=='whatsapp'):value.sourceRefs!==undefined||value.groupScope!==undefined)ctx.addIssue({code:'custom',message:'context_mode_denied'});});
export const modelPayload = z.object({ messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(60000) }).strict()).min(1).max(64) }).strict();
const binding = z.object({ lease, actor, purpose, search, subject: decisionSubject, runId: hash, query: z.string().min(1).max(2048), config,outgoing:outgoingProof.optional(),contextMode:z.literal('conversation_manifest').optional(),sourceRefs:z.array(sourceRef).min(1).max(3).optional(),groupScope:groupScopeSchema.optional(),
  coverage: z.object({ inventoryComplete: z.boolean(), engine: label, gaps: z.array(label).max(32) }).strict(),
  context: z.object({ state: z.literal("ready"), mode: z.enum(["model", "fallback", "originals"]), sources: z.array(source).min(1).max(10),
    focus: z.array(z.object({ id: label, spans: z.array(z.object({ start: time, end: time, quote: z.string().max(4096) }).strict()).max(4) }).strict()).max(10),
    gaps: z.array(label).max(32), receipt: z.object({ state: label, operationKey: label }).strict().optional() }).strict(),
  work: z.discriminatedUnion("kind", [z.object({ kind: z.literal("not_follow_up") }).strict(), z.object({ kind: z.literal("follow_up"), fence: work, target }).strict()]),
}).strict().superRefine((value,ctx)=>{if(value.work.kind==='follow_up'&&(!value.work.target.fence||value.work.target.policy.revision===0)&&!value.outgoing)ctx.addIssue({code:'custom',message:'recipient_proof_required'});if(value.outgoing&&(value.work.kind!=='follow_up'||value.work.target.policy.kind!=='private'||value.work.target.policy.revision!==value.outgoing.policy.revision))ctx.addIssue({code:'custom',message:'outgoing_target_policy'});}).superRefine((value,ctx)=>{const anchor=value.context.sources.find(source=>source.id===value.lease.source_id);if(value.contextMode?(!value.sourceRefs||value.actor.kind!=='interlocutor'||value.subject.kind!=='capture_event'||!(value.actor.conversationKind==='private'&&!value.groupScope||!!anchor&&groupManifestAllowed(value.groupScope,value.actor,anchor.fence,value.subject))):value.groupScope!==undefined)ctx.addIssue({code:'custom',message:'context_mode_denied'});});
export const nativeReceipt = z.object({ submissionId: label, uid: label, acceptedAt: z.string().min(1).max(64), deduplicated: z.literal(true).optional() }).strict();
const receipt = z.object({ profile: z.enum(["owner", "interlocutor"]), runtimeId: label, bindingHash: hash, envelopeHash: hash, receipt: nativeReceipt }).strict();
const envelope = z.object({ message: z.string().max(60000), initialData: z.object({ bindingId: hash }).strict(), idempotencyKey: label }).strict();
export const proposal = z.object({ decision: z.enum(["proposed", "no_reply", "waiting_context"]), text: z.string().max(8192), contextSummary: z.string().max(600).nullable().optional(),
  citations: z.array(sourceRef.extend({ quote: z.string().min(1).max(4096), media: z.object({ id: hash, hash, configHash: hash }).strict().nullable().optional(), attribution: z.literal("model_extraction").optional() }).strict().refine(row => !row.attribution || !!row.media)).max(10) }).strict();
export type Binding = z.infer<typeof binding>;
export const parseBinding = (value: unknown): Binding => binding.parse(value);
export type BoundEpisode = Omit<Episode, "binding" | "receipt" | "envelope"> & { binding: Binding; receipt: z.infer<typeof receipt> | null; envelope: z.infer<typeof envelope> | null };
/** Stored JSON stays unknown until this host contract validates its shape. */
export function boundEpisode(row: Episode): BoundEpisode {
  return { ...row, binding: binding.parse(row.binding), receipt: row.receipt === null ? null : receipt.parse(row.receipt), envelope: row.envelope === null ? null : envelope.parse(row.envelope) };
}

export const validatedProposal = proposal.extend({ schema: z.literal(1), kind: z.literal("shadow_proposal"), execution: z.literal("unconfirmed"), semanticValidation: z.literal("structure_and_attribution_only"),mode:z.literal('shadow').optional(),externalAttempted:z.literal(false).optional(),outgoing:outgoingProof.optional(),
  coverage: z.object({ inventoryComplete: z.boolean(), engine: label, gaps: z.array(label).max(32) }).strict(),
  binding: z.object({ episodeId: hash, bindingHash: hash, jobId: label, requestHash: hash, runId: hash, allowedPackHash: hash, profile: z.enum(["owner", "interlocutor"]), purpose }).strict(),
}).strict();
