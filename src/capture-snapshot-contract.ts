import {z} from 'zod';

export const SNAPSHOT_BYTES=32768,PROOF_PAGE_SIZE=64,PROOF_PAGE_BYTES=65536;
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),label=z.string().max(512),id=z.string().min(1).max(256);
export const captureReference=z.object({sourceKind:z.enum(['message','media','derivative','conversation']),sourceId:id,chatId:id}).strict().refine(r=>r.sourceKind!=='conversation'||r.sourceId===r.chatId);
export type CaptureReference=z.infer<typeof captureReference>;
export type CaptureIdentity=CaptureReference&{sourceEpoch:string;sourceGeneration:string};
const content=z.object({kind:label,text:z.string().nullable().optional(),name:label.optional(),authorId:label.nullable().optional(),
 authorName:label.nullable().optional(),fromMe:z.boolean().optional(),occurredAt:integer.optional(),receivedAt:integer.optional(),
 messageId:label.optional(),messageVersion:integer.optional(),mediaVersion:integer.optional(),
 media:z.object({id:label,version:integer,hash:z.string().regex(/^[a-f0-9]{64}$/),size:integer.nullable(),mime:label.nullable()}).optional()});
// Field order is the existing wire digest order. Do not alphabetize it.
const snapshot=z.object({observation:z.literal('capture_snapshot'),state:z.enum(['available','withdrawn','blocked']),reason:label.optional(),
 sourceEpoch:label.optional(),sourceGeneration:label.optional(),sourceKind:z.enum(['message','media','derivative','conversation']).optional(),
 sourceId:label.optional(),chatId:label.optional(),sourceVersion:integer.nullable().optional(),watermark:integer.nullable().optional(),
 conversationKind:z.enum(['private','group']).optional(),
 access:z.object({captureEnabled:z.boolean(),captureSince:integer.nullable(),discontinuous:z.boolean()}).optional(),content:content.optional()});
export type CaptureObservation={state:'available'|'withdrawn'|'blocked';reason:string|null;watermark:number|null;kind:'private'|'group'|null;
 conversationWithdrawn?:boolean;hash:string|null;sourceVersion:number|null;content:z.infer<typeof content>|null};
export const blockedObservation=(reason:string):CaptureObservation=>({state:'blocked',reason,watermark:null,kind:null,hash:null,sourceVersion:null,content:null});
export type SnapshotFailure={phase:'reader_rpc'|'snapshot_parse';reason:string};
/** Synchronous ownership/normalization before any hash yields. The serialized
 * digest input remains private to Source/Origin; it is never a proof field. */
export function snapshotFields(raw:unknown,expected:CaptureIdentity,report?:(event:SnapshotFailure)=>void):{observation:CaptureObservation;digestInput?:string}{
 const blocked=(reason:string,phase:SnapshotFailure['phase']='snapshot_parse')=>{try{report?.({phase,reason});}catch{}return {observation:blockedObservation(reason)};};
 let parsed:z.infer<typeof snapshot>;
 try{const serialized=JSON.stringify(raw);if(new TextEncoder().encode(serialized).length>SNAPSHOT_BYTES)return blocked('snapshot_too_large');parsed=snapshot.parse(JSON.parse(serialized));}
 catch{return blocked('reader_unavailable');}
 if(parsed.sourceEpoch!==expected.sourceEpoch||parsed.sourceGeneration!==expected.sourceGeneration||parsed.chatId!==expected.chatId||parsed.sourceId!==expected.sourceId||parsed.sourceKind!==expected.sourceKind)return blocked('snapshot_identity_mismatch');
 if(parsed.state==='blocked'){
  const known=['reader_unavailable','source_unavailable','snapshot_too_large','version_mismatch','media_unavailable','message_unavailable','derivative_unavailable','derivative_without_text'];
  return blocked(known.includes(parsed.reason??'')?parsed.reason!:'source_unavailable','reader_rpc');
 }
 if(!Number.isSafeInteger(parsed.watermark)||!parsed.conversationKind||!parsed.access)return blocked('snapshot_incomplete');
 const observation:CaptureObservation={state:parsed.state,reason:null,watermark:parsed.watermark!,kind:parsed.conversationKind,hash:null,
  conversationWithdrawn:!parsed.access.captureEnabled,sourceVersion:parsed.sourceVersion??null,content:parsed.content??null};
 if(parsed.state==='withdrawn'||!parsed.access.captureEnabled)return {observation:{...observation,state:'withdrawn',content:null}};
 if(!parsed.content||(expected.sourceKind!=='conversation'&&(!parsed.content.messageId||!parsed.content.messageVersion)))return blocked('snapshot_incomplete');
 return {observation,digestInput:JSON.stringify([parsed.sourceVersion??null,parsed.access,parsed.content])};
}
/** Input is ALREADY serialized. Applying JSON.stringify again changes hashes. */
export async function snapshotDigest(input:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
export async function observeSnapshot(raw:unknown,expected:CaptureIdentity,report?:(event:SnapshotFailure)=>void):Promise<CaptureObservation>{
 const fields=snapshotFields(raw,expected,report);return fields.digestInput===undefined?fields.observation:{...fields.observation,hash:await snapshotDigest(fields.digestInput)};
}
export const snapshotProofRequest=z.object({secret:z.string().max(256),sourceEpoch:id,sourceGeneration:id,refs:z.array(captureReference).min(1).max(PROOF_PAGE_SIZE)}).strict()
 .refine(q=>new Set(q.refs.map(r=>JSON.stringify([r.sourceKind,r.sourceId,r.chatId]))).size===q.refs.length);
const proofItem=z.object({sourceKind:z.enum(['message','media','derivative','conversation']),sourceId:id,chatId:id,
 state:z.enum(['available','withdrawn','blocked']),reason:label.nullable(),watermark:integer.nullable(),kind:z.enum(['private','group']).nullable(),
 conversationWithdrawn:z.boolean().optional(),hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),sourceVersion:integer.nullable()}).strict()
 .refine(p=>p.sourceKind!=='conversation'||p.sourceId===p.chatId)
 .refine(p=>p.state==='available'?p.hash!==null&&p.kind!==null&&p.watermark!==null:p.hash===null);
export const snapshotProofPage=z.discriminatedUnion('state',[
 z.object({observation:z.literal('capture_snapshot_proofs'),state:z.literal('available'),sourceEpoch:id,sourceGeneration:id,items:z.array(proofItem).min(1).max(PROOF_PAGE_SIZE)}).strict(),
 z.object({observation:z.literal('capture_snapshot_proofs'),state:z.literal('blocked'),reason:z.enum(['reader_unavailable','reader_changed','source_unavailable'])}).strict(),
]);
export type SnapshotProofPage=z.infer<typeof snapshotProofPage>;
