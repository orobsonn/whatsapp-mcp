import {z} from 'zod';
import {SourceAccess,normalizeSourceRefs,type SourceRead,type SourceSelectionRef} from './access';
import type {AssistantEnv} from './env';
import {activeOrigin,originScopeSql,scopeKeys,type OriginScope} from './origin-guard';
import type {DecisionSubject} from './agent/contracts';
import {Conversations} from './conversations';
import {bridgeHash} from './ingress';

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
