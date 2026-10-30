import {z} from 'zod';
import type {SourceFence} from './access';
/** Frozen host selection only; this never grants source access or send authority. */
export const groupScopeSchema=z.object({chatId:z.string().min(1).max(256),startAfterSequence:z.number().int().nonnegative().safe()}).strict();
export type GroupScope=z.infer<typeof groupScopeSchema>;
export function groupManifestAllowed(scope:GroupScope|undefined,actor:{kind:string;conversationKind?:string;conversationId?:string},fence:SourceFence,subject?:{kind:string;chatId?:string;sequence?:number}){
 return !!scope&&groupScopeSchema.safeParse(scope).success&&actor.kind==='interlocutor'&&actor.conversationKind==='group'&&actor.conversationId===scope.chatId&&fence.source.origin==='whatsapp'&&fence.source.conversationId===scope.chatId&&fence.policy?.kind==='group'&&fence.policy.mode==='respond'&&(!subject||subject.kind==='capture_event'&&subject.chatId===scope.chatId&&typeof subject.sequence==='number'&&subject.sequence>scope.startAfterSequence);
}
