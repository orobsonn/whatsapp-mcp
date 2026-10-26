import {z} from 'zod';
import {sendEnvelopeSchema,actionDigest,canonicalEnvelope} from '../src/send-envelope';
import type {AssistantEnv} from './env';
import type {AccessGuard} from './access';
import type {SourceScope} from './sources';
const id=z.string().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const outgoingInput=z.object({envelope:sendEnvelopeSchema,authorization:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('owner_exact')}).strict(),z.object({kind:z.literal('mandate'),id,version:z.number().int().positive()}).strict(),
])}).strict();
export const recipientObservation=z.object({observation:z.literal('recipient_envelope'),state:z.literal('available'),sourceEpoch:id,sourceGeneration:id,
 recipient:z.object({chatId:id,kind:z.literal('individual'),validated_format:z.literal(true),registeredOnWhatsApp:z.literal('unknown'),fingerprint:hash}).strict(),envelope:sendEnvelopeSchema,envelopeHash:hash}).strict();
export const outgoingProof=outgoingInput.extend({observation:recipientObservation}).strict();
export type OutgoingProof=z.infer<typeof outgoingProof>;
export type OutgoingPort={prepare(input:z.infer<typeof outgoingInput>):Promise<OutgoingProof>;check(proof:OutgoingProof):Promise<boolean>};
/** Only a nominal read capability. No URL, action ID, provider or send port. */
export function outgoingPort(env:AssistantEnv):OutgoingPort{
 const reader=env.CAPTURE_READER,secret=env.BRIDGE_SECRET,epoch=env.BRIDGE_SOURCE_EPOCH,generation=env.BRIDGE_SOURCE_GENERATION,installation=env.INSTALLATION_ID,operational=env.OPERATIONAL_GENERATION;
 const current=()=>{if(!reader?.readRecipientEnvelope||!secret||!epoch||!generation||env.CAPTURE_READER!==reader||env.BRIDGE_SECRET!==secret||env.BRIDGE_SOURCE_EPOCH!==epoch||env.BRIDGE_SOURCE_GENERATION!==generation||env.INSTALLATION_ID!==installation||env.OPERATIONAL_GENERATION!==operational||env.FLUE_EPISODES_ENABLED!=='shadow')throw Error('outgoing_unavailable');};
 const observe=async(envelope:z.infer<typeof sendEnvelopeSchema>)=>{current();let timer:ReturnType<typeof setTimeout>|undefined;try{const raw=await Promise.race([reader!.readRecipientEnvelope!({secret,sourceEpoch:epoch!,sourceGeneration:generation!,envelope}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('outgoing_timeout')),2000);})]);current();const result=recipientObservation.parse(raw);if(result.sourceEpoch!==epoch||result.sourceGeneration!==generation||result.recipient.chatId!==envelope.chatId||await actionDigest(result.envelope)!==result.envelopeHash)throw Error('outgoing_changed');current();return result;}finally{clearTimeout(timer);}};
 return {prepare:async raw=>{const input=outgoingInput.parse(raw),observation=await observe(input.envelope),expected={...input.envelope};if(expected.kind==='pdf'&&expected.fileName===undefined&&observation.envelope.kind==='pdf')expected.fileName=observation.envelope.fileName;
  if(canonicalEnvelope(expected)!==canonicalEnvelope(observation.envelope))throw Error('outgoing_changed');return outgoingProof.parse({...input,envelope:observation.envelope,observation});},
  check:async raw=>{try{const proof=outgoingProof.parse(raw),now=await observe(proof.envelope);return canonicalEnvelope(proof.envelope)===canonicalEnvelope(proof.observation.envelope)&&JSON.stringify(now)===JSON.stringify(proof.observation);}catch{return false;}}};
}
/** Re-evaluated in the same transaction as each admitted effect/publication. */
export function outgoingGuard(scope:SourceScope,ref:{id:string;version:number},proof:OutgoingProof,now:number,sourceId:string):AccessGuard{
 const sql=`EXISTS(SELECT 1 FROM assistant_fup_provenance p WHERE p.installation_id=? AND p.generation=? AND p.fup_id=? AND p.version=? AND json_extract(p.body_json,'$.outgoing')=json(?))`;
 const values:(string|number|null)[]=[scope.installationId,scope.generation,ref.id,ref.version,JSON.stringify(proof)];
 const authority=outgoingAuthorityGuard(scope,proof.authorization,sourceId,proof.envelope.chatId,now);return {sql:`${sql} AND (${authority.sql})`,values:[...values,...authority.values]};
}
export function outgoingAuthorityGuard(scope:SourceScope,a:OutgoingProof['authorization'],sourceId:string,chatId:string,now:number):AccessGuard{
 if(a.kind==='owner_exact')return {sql:'1',values:[]};
 return {sql:`EXISTS(SELECT 1 FROM assistant_mandates m WHERE m.installation_id=? AND m.generation=? AND m.id=? AND m.version=? AND m.status='active' AND m.issued_at<=? AND m.expires_at>? AND m.conversation_id=?
 AND m.version=(SELECT MAX(version) FROM assistant_mandates v WHERE v.installation_id=m.installation_id AND v.generation=m.generation AND v.id=m.id)
 AND EXISTS(SELECT 1 FROM assistant_mandate_actions x WHERE x.installation_id=m.installation_id AND x.generation=m.generation AND x.mandate_id=m.id AND x.mandate_version=m.version AND x.action='future_contact')
 AND EXISTS(SELECT 1 FROM assistant_mandate_sources x WHERE x.installation_id=m.installation_id AND x.generation=m.generation AND x.source_id=? AND x.mandate_id=m.id AND x.mandate_version=m.version)
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=m.installation_id AND q.generation=m.generation AND q.kind='mandate' AND q.mandate_id=m.id AND q.active=1))`,values:[scope.installationId,scope.generation,a.id,a.version,now,now,chatId,sourceId]};
}
