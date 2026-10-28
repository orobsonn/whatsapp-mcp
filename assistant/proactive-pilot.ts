import {z} from 'zod';
import {SourceAccess,normalizeSourceRefs,type AccessGuard,type SourceRead,type SourceSelectionRef} from './access';
import type {AssistantEnv} from './env';
import {activeOrigin,originScopeSql,scopeKeys,type OriginScope} from './origin-guard';
import type {DecisionSubject} from './agent/contracts';
import {Conversations} from './conversations';
import {bridgeHash} from './ingress';
import {captureConversationActivity,approvedSendActivityFence,type ApprovedSendActivityFence} from '../src/approved-send-contract';

const label=z.string().min(1).max(256);
const pilotSchema=z.object({id:label,revision:z.number().int().positive().max(2147483647),startAfterSequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),chatIds:z.array(label).min(1).max(8)}).strict();
export type ProactivePilot=z.infer<typeof pilotSchema>;
export type PilotBinding=ProactivePilot & {chatId:string};
type PilotEnv={PROACTIVE_PILOT_JSON?:string};
export function readProactivePilot(env:PilotEnv):ProactivePilot|null{
 if(env.PROACTIVE_PILOT_JSON===undefined)return null;
 try{const pilot=pilotSchema.parse(JSON.parse(env.PROACTIVE_PILOT_JSON));if(new Set(pilot.chatIds).size!==pilot.chatIds.length)throw Error();return {...pilot,chatIds:[...pilot.chatIds].sort()};}catch{throw Error('proactive_pilot_configuration');}
}
export function pilotAllowsSubject(env:PilotEnv,subject:DecisionSubject):boolean{
 const pilot=readProactivePilot(env);return !!pilot&&subject.kind==='capture_event'&&subject.sequence>pilot.startAfterSequence&&pilot.chatIds.includes(subject.chatId);
}
export function pilotSelection(pilot:ProactivePilot){return {sql:`json_extract(binding_json,'$.pilot.id')=? AND json_extract(binding_json,'$.pilot.revision')=? AND json_extract(binding_json,'$.pilot.startAfterSequence')=? AND json_extract(binding_json,'$.pilot.chatIds')=? AND json_extract(subject_json,'$.kind')='capture_event' AND json_extract(subject_json,'$.sequence')>? AND json_extract(subject_json,'$.chatId') IN (SELECT value FROM json_each(?))`,values:[pilot.id,pilot.revision,pilot.startAfterSequence,JSON.stringify(pilot.chatIds),pilot.startAfterSequence,JSON.stringify(pilot.chatIds)]};}

/** A relationship is only an activity veto. It grants no source or conversation access. */
export function activityPolicyGuard(scope:OriginScope,members:string[]):AccessGuard{
 if(!Array.isArray(members)||!members.length||members.length>2||new Set(members).size!==members.length||members.some(id=>typeof id!=='string'||!id.length||id.length>256))return {sql:'0',values:[]};
 const kind="COALESCE(o.kind,'private')",permitted=members.length===2?`${kind}='private' AND COALESCE(p.kind,'private')='private' AND COALESCE(p.effective_mode,'attend')='attend'`:`COALESCE(p.kind,'private')=${kind} AND COALESCE(p.effective_mode,'attend')=CASE WHEN ${kind}='group' THEN 'respond' ELSE 'attend' END`;
 return {sql:`NOT EXISTS(SELECT 1 FROM json_each(?) member LEFT JOIN assistant_conversation_modes p ON p.installation_id=? AND p.generation=? AND p.conversation_id=member.value LEFT JOIN assistant_origin_conversations o ON o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=member.value WHERE NOT (${permitted})) AND NOT EXISTS(SELECT 1 FROM assistant_conversations c WHERE c.installation_id=? AND c.generation=? AND c.source_epoch=? AND c.source_generation=? AND c.chat_id IN(SELECT value FROM json_each(?)) AND c.paused=1)`,values:[JSON.stringify(members),scope.installationId,scope.generation,...scopeKeys(scope),...scopeKeys(scope),JSON.stringify(members)]};
}
export async function readPilotConversationActivity(env:AssistantEnv,subject:DecisionSubject):Promise<{state:'current';activity:ApprovedSendActivityFence}|{state:'blocked';reason:string}|{state:'superseded_owner_reply'}>{
 if(subject.kind!=='capture_event'||!env.DB||!env.CAPTURE_READER?.readConversationActivity||!env.BRIDGE_SECRET)return {state:'blocked',reason:'conversation_activity_unavailable'};
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const scope=activeOrigin(()=>({installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!}));
  if(subject.sourceEpoch!==scope.sourceEpoch||subject.sourceGeneration!==scope.sourceGeneration)return {state:'blocked',reason:'conversation_activity_scope'};
  const raw=await Promise.race([env.CAPTURE_READER.readConversationActivity({secret:env.BRIDGE_SECRET,sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,chatId:subject.chatId}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('conversation_activity_timeout')),2000);})]);
  const parsed=captureConversationActivity.safeParse(raw);if(!parsed.success||parsed.data.state!=='available')return {state:'blocked',reason:'conversation_activity_unavailable'};
  const observation=parsed.data,members=observation.members.map(member=>member.chatId).sort();
  if(observation.sourceEpoch!==scope.sourceEpoch||observation.sourceGeneration!==scope.sourceGeneration||observation.chatId!==subject.chatId||!members.includes(subject.chatId)||new Set(members).size!==members.length||observation.members.some(member=>!member.captureEnabled||member.watermark>observation.watermark)||observation.lastOwnerOriginalSequence>observation.watermark)return {state:'blocked',reason:'conversation_activity_scope'};
  if(observation.lastOwnerOriginalSequence>subject.sequence)return {state:'superseded_owner_reply'};
  const guard=activityPolicyGuard(scope,members);if(!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first())return {state:'blocked',reason:'conversation_activity_policy'};
  return {state:'current',activity:approvedSendActivityFence.parse({triggerSequence:subject.sequence,relationshipRevision:observation.relationshipRevision,relationshipProof:observation.relationshipProof,members})};
 }catch{return {state:'blocked',reason:'conversation_activity_unavailable'};}finally{if(timer!==undefined)clearTimeout(timer);}
}

/** Recent conversation evidence is a frozen restriction; old rows are never rewritten. */
export async function selectPilotSourceRefs(db:D1Database,scope:OriginScope,trigger:SourceRead,now:number):Promise<SourceSelectionRef[]>{
 const access=new SourceAccess(db,scope),guard=access.ownerRows(now),chatId=trigger.fence.source.conversationId;
 if(!chatId||!trigger.text?.trim()||new TextEncoder().encode(trigger.text).length>8192)throw Error('pilot_context_unavailable');
 const rows=await db.prepare(`WITH visible AS (${guard.sql}) SELECT v.id,v.revision,v.version,v.content_hash,v.original_text FROM visible v JOIN assistant_source_origins o ON o.installation_id=? AND o.generation=? AND o.canonical_id=v.id AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=? AND o.source_kind='message' AND o.tombstoned=0 JOIN assistant_origin_versions ov ON ov.installation_id=o.installation_id AND ov.generation=o.generation AND ov.canonical_id=v.id AND ov.version=v.version WHERE v.conversation_id=? AND v.origin='whatsapp' AND v.occurred_at<=? AND json_extract(ov.dependencies_json,'$.kind')='text' AND v.id<>? AND length(CAST(v.original_text AS BLOB)) BETWEEN 1 AND 8192 ORDER BY v.occurred_at DESC,v.id DESC LIMIT 3`).bind(...guard.values,...scopeKeys(scope),chatId,chatId,trigger.occurredAt,trigger.id).all<{id:string;revision:number;version:number;content_hash:string;original_text:string}>();
 let bytes=new TextEncoder().encode(trigger.text).length;const refs:SourceSelectionRef[]=[{id:trigger.id,revision:trigger.fence.source.revision,version:trigger.fence.source.version,hash:trigger.fence.source.hash}];
 for(const row of rows.results){const size=new TextEncoder().encode(row.original_text).length;if(refs.length===3)break;if(bytes+size>8192)continue;bytes+=size;refs.push({id:row.id,revision:row.revision,version:row.version,hash:row.content_hash});}
 return normalizeSourceRefs(refs);
}

export async function pilotBindingCurrent(env:AssistantEnv,binding:{subject:DecisionSubject;source:{id:string;revision:number;version:number;hash:string};pilot?:PilotBinding;sourceRefs?:SourceSelectionRef[]}):Promise<boolean>{
 let pilot:ProactivePilot|null;try{pilot=readProactivePilot(env);}catch{return false;}
 if(!pilot)return !binding.pilot;
 if(env.ROUTINES_ENABLED!=='shadow'||env.ROUTINES_PAUSED==='true'||env.FLUE_EPISODES_ENABLED!=='shadow')return false;
 if(!binding.pilot||binding.subject.kind!=='capture_event'||!pilotAllowsSubject(env,binding.subject)||JSON.stringify(binding.pilot)!==JSON.stringify({...pilot,chatId:binding.subject.chatId})||!binding.sourceRefs)return false;
 const scope=activeOrigin(()=>({installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!}));
 if(binding.subject.sourceEpoch!==scope.sourceEpoch||binding.subject.sourceGeneration!==scope.sourceGeneration||!env.DB)return false;
 if((await readPilotConversationActivity(env,binding.subject)).state!=='current')return false;
 let refs:SourceSelectionRef[];try{refs=normalizeSourceRefs(binding.sourceRefs);}catch{return false;}
 if(!refs.some(ref=>ref.id===binding.source.id&&ref.revision===binding.source.revision&&ref.version===binding.source.version&&ref.hash===binding.source.hash))return false;
 const trigger=await env.DB.prepare(`SELECT ov.dependencies_json FROM assistant_origin_versions ov JOIN assistant_capture_inbox i ON i.installation_id=ov.installation_id AND i.generation=ov.generation WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=? AND i.sequence=? AND i.chat_id=? AND i.source_kind='message' AND i.operation='upsert' AND ov.canonical_id=? AND ov.version=? AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox old WHERE old.installation_id=i.installation_id AND old.generation=i.generation AND old.source_epoch=i.source_epoch AND old.source_generation=i.source_generation AND old.source_id=i.source_id AND old.source_kind=i.source_kind AND old.sequence<=?)`).bind(...scopeKeys(scope),binding.subject.sequence,binding.subject.chatId,binding.source.id,binding.source.version,pilot.startAfterSequence).first<string>('dependencies_json');
 if(!trigger)return false;const metadata=JSON.parse(trigger);if(metadata.fromMe!==false||metadata.kind!=='text')return false;
 if(!await new Conversations(env.DB,()=>scope).fence(binding.subject.chatId))return false;
 const access=new SourceAccess(env.DB,scope);let bytes=0;
 for(const ref of refs){const source=await access.read({kind:'owner'},ref.id,ref.revision);if(!source||source.fence.source.origin!=='whatsapp'||source.fence.source.conversationId!==binding.subject.chatId||source.fence.source.version!==ref.version||source.fence.source.hash!==ref.hash||!source.text?.trim())return false;bytes+=new TextEncoder().encode(source.text).length;}
 return bytes<=8192;
}

/** Flue callbacks rebuild their host; repeat the host pilot check at each boundary. */
export async function assertProactiveEpisode(env:AssistantEnv,episodeId:string){
 if(!env.DB)return;
 const row=await env.DB.prepare(`SELECT r.binding_json,r.binding_hash,j.dedupe_key FROM assistant_episodes e JOIN assistant_jobs j ON j.installation_id=e.installation_id AND j.generation=e.generation AND j.id=e.job_id LEFT JOIN assistant_routine_items r ON r.installation_id=j.installation_id AND r.generation=j.generation AND r.job_id=j.id WHERE e.installation_id=? AND e.generation=? AND e.id=?`).bind(env.INSTALLATION_ID!,env.OPERATIONAL_GENERATION!,episodeId).first<{binding_json:string|null;binding_hash:string|null;dedupe_key:string}>();
 if(!row||!row.dedupe_key.startsWith('routine:'))return;
 if(!row.binding_json){if(readProactivePilot(env))throw Error('proactive_pilot_ineligible');return;}
 const binding=JSON.parse(row.binding_json);if(await bridgeHash(binding)!==row.binding_hash||!await pilotBindingCurrent(env,binding))throw Error('proactive_pilot_ineligible');
}
