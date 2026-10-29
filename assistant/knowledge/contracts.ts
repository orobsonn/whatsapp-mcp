import { z } from 'zod';
import { sourceRef } from '../source-proof-contract';
import type { OriginScope } from '../origin-guard';
import type { SourceFence } from '../access';
const id=z.string().min(1).max(256),name=z.string().min(1).max(512);
export const knowledgeEntityKind=z.enum(['person','project','group','conversation','repository','decision']);
export const knowledgeEntity=z.object({id,kind:knowledgeEntityKind,name}).strict();
export type KnowledgeEntity=z.infer<typeof knowledgeEntity>;
export const knowledgeEvidence=z.object({sourceRef,quote:z.string().min(1).optional()}).strict();
export type KnowledgeEvidence=z.infer<typeof knowledgeEvidence>;
const temporal=z.union([z.iso.datetime({offset:true}),z.iso.date()]);
export const knowledgeRelation=z.object({subjectId:id,predicate:name,objectId:id,
 classification:z.enum(['reported','inferred']),validFrom:temporal.optional(),validUntil:temporal.optional(),
 // Every evidence entry is a jointly required premise; alternatives use separate relations/groups.
 evidence:z.array(knowledgeEvidence).min(1)}).strict();
export const knowledgeRemember=z.object({operationId:id,
 entities:z.array(z.union([
  z.object({key:id,ref:id}).strict(),
  z.object({key:id,kind:knowledgeEntityKind,name}).strict(),
 ])).min(1),relations:z.array(knowledgeRelation).min(1)}).strict();
// Entity keys in an agent request are local aliases. The host resolves existing
// refs and creates stable opaque IDs for new entities before calling the store.
export const knowledgeQuery=z.object({entityId:id.optional(),predicate:name.optional(),
 classification:z.enum(['reported','inferred']).optional(),after:id.optional(),limit:z.number().int().min(1).max(100).default(20)}).strict();
export const knowledgeEntityQuery=z.object({query:z.string().max(512).optional(),kind:knowledgeEntityKind.optional(),after:id.optional(),limit:z.number().int().min(1).max(100).default(20)}).strict();
export const knowledgeCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('context.report'),operationId:id,text:z.string().min(1),occurredAt:z.number().int().nonnegative().safe().optional(),title:name.optional()}).strict(),
 z.object({kind:z.literal('context.correct'),operationId:id,sourceId:id,expectedRevision:z.number().int().positive(),text:z.string().min(1),occurredAt:z.number().int().nonnegative().safe().optional()}).strict(),
 knowledgeRemember.extend({kind:z.literal('remember')}),
 knowledgeQuery.extend({kind:z.literal('query')}),
 knowledgeEntityQuery.extend({kind:z.literal('entities')}),
 z.object({kind:z.literal('status'),operationId:id}).strict(),
 z.object({kind:z.literal('withdraw'),operationId:id,sourceRef}).strict(),
]);
export type KnowledgeCommand=z.input<typeof knowledgeCommand>;
export type KnowledgeOrigin='owner_report'|'agent_derived';
export type KnowledgeReceipt={operationId:string;state:'not_found'|'accepted'|'indexing'|'ready'|'partial'|'uncertain'|'conflict';claimIds?:string[];evidenceIds?:string[];error?:string};
export type NativeKnowledgeWrite={entities:KnowledgeEntity[];relations:z.infer<typeof knowledgeRelation>[];origin:KnowledgeOrigin};
export type KnowledgeSupportEvidence=KnowledgeEvidence&{id:string;origins?:KnowledgeOrigin[]};
export type KnowledgeClaim={id:string;subject:KnowledgeEntity;predicate:string;object:KnowledgeEntity;
 classification:'reported'|'inferred';validFrom?:string|null;validUntil?:string|null;origins?:KnowledgeOrigin[];
 evidence:KnowledgeSupportEvidence[];supportGroups:{id:string;evidence:KnowledgeSupportEvidence[]}[]};
export interface KnowledgePort {
 remember(operationId:string,input:NativeKnowledgeWrite):Promise<KnowledgeReceipt>;
 status(operationId:string):Promise<KnowledgeReceipt>;
 query(input:z.infer<typeof knowledgeQuery>):Promise<{claims:KnowledgeClaim[];nextCursor?:string;coverage?:{state:'complete'|'partial';scope:string}}>;
 get_entity(id:string):Promise<KnowledgeEntity|null>;
 find_entities(input:z.infer<typeof knowledgeEntityQuery>):Promise<{entities:KnowledgeEntity[];nextCursor?:string;coverage?:{state:'complete'|'partial';scope:string}}>;
 withdraw(operationId:string,source:z.infer<typeof sourceRef>):Promise<KnowledgeReceipt>;
}
/** Constructed by the authenticated adapter. Never accepted as tool arguments. */
export type KnowledgeContext={scope:OriginScope;client:'owner_mcp'|'owner_telegram'|'conversation_agent'|'curator'};
export type VerifiedKnowledgeClaim=KnowledgeClaim&{sourceFences:SourceFence[]};
