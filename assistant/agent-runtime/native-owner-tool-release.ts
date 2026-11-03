import {z} from 'zod';
import {SourceAccess} from '../access';
import {sourceRef} from '../source-proof-contract';
import {assertReadExposureCurrent,type ReadExposure} from '../knowledge/read-exposure';
import type {AssistantEnv} from '../env';
import type {NativeApplicationHost} from './native-host';
import type {TaskContext} from './conversation';
const label=z.string().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ownerToolPublication=z.object({result:z.unknown(),provenance:z.object({
 origins:z.array(z.object({sourceKind:z.enum(['message','media','derivative']),sourceId:label,chatId:label,sourceVersion:z.number().int().nonnegative().safe().nullable(),observationHash:hash}).strict()).max(200),
 canonicalRefs:z.array(sourceRef).max(200),
}).strict()}).strict();

/** Only Source's named RPC constructs this provenance. A model argument or
 * reference found in message text is never interpreted as a publication grant. */
export async function releaseOwnerToolResult(host:NativeApplicationHost,env:AssistantEnv,task:TaskContext,raw:unknown){
 const output=ownerToolPublication.parse(raw),scope=host.currentScope(),access=new SourceAccess(env.DB!,scope,Date.now,'knowledge'),refs=new Map(output.provenance.canonicalRefs.map(ref=>[JSON.stringify(ref),ref]));
 for(const origin of output.provenance.origins){
  const row=await env.DB!.prepare(`SELECT o.canonical_id,s.revision,s.current_version version,v.content_hash hash
   FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
   JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation AND v.source_id=s.id AND v.version=s.current_version
   JOIN assistant_origin_versions ov ON ov.installation_id=s.installation_id AND ov.generation=s.generation AND ov.canonical_id=s.id AND ov.version=s.current_version
   WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.source_kind=? AND o.source_id=? AND o.chat_id=?
   AND o.tombstoned=0 AND o.observation_hash=? AND ov.observation_hash=? AND ov.source_version IS ?`)
   .bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,origin.sourceKind,origin.sourceId,origin.chatId,origin.observationHash,origin.observationHash,origin.sourceVersion)
   .first<{canonical_id:string;revision:number;version:number;hash:string}>();
  if(!row)throw Error('owner_tool_source_not_current');
  const ref={id:row.canonical_id,revision:row.revision,version:row.version,hash:row.hash};refs.set(JSON.stringify(ref),ref);
 }
 const proof:ReadExposure={sources:[],origins:[]};
 for(const ref of refs.values()){
  const read=await access.read({kind:'owner'},ref.id,ref.revision);
  if(!read||read.fence.source.version!==ref.version||read.fence.source.hash!==ref.hash)throw Error('owner_tool_source_not_current');
  proof.sources.push(read.fence);
  if(read.fence.source.origin==='whatsapp'){
   const origin=await host.origin.fence(ref.id);
   if(!origin||origin.revision!==ref.revision||origin.version!==ref.version||(await host.origin.checkContext(origin)).state!=='current')throw Error('owner_tool_source_not_current');
   proof.origins.push(origin);
  }
 }
 await host.tasks().ownerRequest(task);
 await host.retention.expose(task.identity,proof);
 for(const origin of proof.origins)if((await host.origin.checkContext(origin)).state!=='current')throw Error('owner_tool_source_not_current');
 await host.tasks().ownerRequest(task);
 // This database snapshot is the final await before returning any body.
 await assertReadExposureCurrent(env.DB!,scope,access,host.origin,proof,{getScope:()=>host.currentScope(),authorityGuard:()=>host.retention.authorityGuard(task.sessionId)},'owner_tool_source_not_current');
 return output.result;
}
