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
const recipientProof=outgoingInput.extend({observation:recipientObservation}).strict();
const ownPolicy=z.discriminatedUnion('kind',[z.object({kind:z.literal('absent'),revision:z.literal(0)}).strict(),z.object({kind:z.literal('private'),revision:z.number().int().positive(),mode:id}).strict()]);
export const outgoingProof=recipientProof.extend({policy:ownPolicy}).strict();
export type OutgoingProof=z.infer<typeof outgoingProof>;
export type OutgoingPort={prepare(input:z.infer<typeof outgoingInput>):Promise<z.infer<typeof recipientProof>>;check(proof:OutgoingProof):Promise<boolean>};
/** Only a nominal read capability. No URL, action ID, provider or send port. */
export function outgoingPort(env:AssistantEnv):OutgoingPort{
 const reader=env.CAPTURE_READER,secret=env.BRIDGE_SECRET,epoch=env.BRIDGE_SOURCE_EPOCH,generation=env.BRIDGE_SOURCE_GENERATION,installation=env.INSTALLATION_ID,operational=env.OPERATIONAL_GENERATION;
 const current=()=>{if(!reader?.readRecipientEnvelope||!secret||!epoch||!generation||env.CAPTURE_READER!==reader||env.BRIDGE_SECRET!==secret||env.BRIDGE_SOURCE_EPOCH!==epoch||env.BRIDGE_SOURCE_GENERATION!==generation||env.INSTALLATION_ID!==installation||env.OPERATIONAL_GENERATION!==operational||env.FLUE_EPISODES_ENABLED!=='shadow')throw Error('outgoing_unavailable');};
 const observe=async(envelope:z.infer<typeof sendEnvelopeSchema>)=>{current();let timer:ReturnType<typeof setTimeout>|undefined;try{const raw=await Promise.race([reader!.readRecipientEnvelope!({secret,sourceEpoch:epoch!,sourceGeneration:generation!,envelope}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('outgoing_timeout')),2000);})]);current();const result=recipientObservation.parse(raw);if(result.sourceEpoch!==epoch||result.sourceGeneration!==generation||result.recipient.chatId!==envelope.chatId||await actionDigest(result.envelope)!==result.envelopeHash)throw Error('outgoing_changed');current();return result;}finally{clearTimeout(timer);}};
 return {prepare:async raw=>{const input=outgoingInput.parse(raw),observation=await observe(input.envelope),expected={...input.envelope};if(expected.kind==='pdf'&&expected.fileName===undefined&&observation.envelope.kind==='pdf')expected.fileName=observation.envelope.fileName;
  if(canonicalEnvelope(expected)!==canonicalEnvelope(observation.envelope))throw Error('outgoing_changed');return recipientProof.parse({...input,envelope:observation.envelope,observation});},
  check:async raw=>{try{const proof=outgoingProof.parse(raw),now=await observe(proof.envelope);return canonicalEnvelope(proof.envelope)===canonicalEnvelope(proof.observation.envelope)&&JSON.stringify(now)===JSON.stringify(proof.observation);}catch{return false;}}};
}
/** Re-evaluated in the same transaction as each admitted effect/publication. */
export function outgoingGuard(scope:SourceScope,ref:{id:string;version:number},proof:OutgoingProof,now:number,sourceId:string):AccessGuard{
 const sql=`EXISTS(SELECT 1 FROM assistant_fup_provenance p JOIN assistant_follow_ups f ON f.installation_id=p.installation_id AND f.generation=p.generation AND f.id=p.fup_id AND f.version=p.version WHERE p.installation_id=? AND p.generation=? AND p.fup_id=? AND p.version=? AND json_extract(p.body_json,'$.outgoing')=json(?) AND f.conversation_id=? AND f.source_id=?)`;
 const values:(string|number|null)[]=[scope.installationId,scope.generation,ref.id,ref.version,JSON.stringify(proof),proof.envelope.chatId,sourceId];
 const authority=outgoingAuthorityGuard(scope,proof.authorization,sourceId,proof.envelope.chatId,now),policy=outgoingPolicyGuard(scope,proof);return {sql:`${sql} AND (${authority.sql}) AND (${policy.sql})`,values:[...values,...authority.values,...policy.values]};
}
export function outgoingPolicyGuard(scope:SourceScope,proof:OutgoingProof):AccessGuard{
 const key=[scope.installationId,scope.generation,proof.envelope.chatId],p=proof.policy;
 if(!p)return {sql:'0',values:[]};
 const policy=p.kind==='absent'?{sql:`NOT EXISTS(SELECT 1 FROM assistant_conversation_policies WHERE installation_id=? AND generation=? AND conversation_id=?) AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines WHERE installation_id=? AND generation=? AND kind='policy' AND conversation_id=? AND active=1)`,values:[...key,...key]}:{sql:`EXISTS(SELECT 1 FROM assistant_conversation_modes WHERE installation_id=? AND generation=? AND conversation_id=? AND kind='private' AND revision=? AND effective_mode=? AND effective_mode<>'ignore') AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines WHERE installation_id=? AND generation=? AND kind='policy' AND conversation_id=? AND version=? AND active=1)`,values:[...key,p.revision,p.mode,...key,p.revision]};
 return {sql:`(${policy.sql}) AND NOT EXISTS(SELECT 1 FROM assistant_conversations WHERE installation_id=? AND generation=? AND chat_id=? AND source_epoch=? AND source_generation=? AND paused=1)`,values:[...policy.values,...key,proof.observation.sourceEpoch,proof.observation.sourceGeneration]};
}
export function outgoingAuthorityGuard(scope:SourceScope,a:OutgoingProof['authorization'],sourceId:string,chatId:string,now:number):AccessGuard{
 if(a.kind==='owner_exact')return {sql:'1',values:[]};
 return {sql:`EXISTS(SELECT 1 FROM assistant_mandates m WHERE m.installation_id=? AND m.generation=? AND m.id=? AND m.version=? AND m.status='active' AND m.issued_at<=? AND m.expires_at>? AND m.conversation_id=?
 AND m.version=(SELECT MAX(version) FROM assistant_mandates v WHERE v.installation_id=m.installation_id AND v.generation=m.generation AND v.id=m.id)
 AND EXISTS(SELECT 1 FROM assistant_mandate_actions x WHERE x.installation_id=m.installation_id AND x.generation=m.generation AND x.mandate_id=m.id AND x.mandate_version=m.version AND x.action='future_contact')
 AND EXISTS(SELECT 1 FROM assistant_mandate_sources x WHERE x.installation_id=m.installation_id AND x.generation=m.generation AND x.source_id=? AND x.mandate_id=m.id AND x.mandate_version=m.version)
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=m.installation_id AND q.generation=m.generation AND q.kind='mandate' AND q.mandate_id=m.id AND q.active=1))`,values:[scope.installationId,scope.generation,a.id,a.version,now,now,chatId,sourceId]};
}
