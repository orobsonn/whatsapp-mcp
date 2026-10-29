import {SourceAccess,type AccessGuard,type SourceFence,type SourceSelectionRef} from '../access';
import {activeOrigin,type OriginFence,type OriginGuard,type OriginScope} from '../origin-guard';
import {sourceFence} from '../source-proof-contract';
import {bridgeHash} from '../ingress';
import {conversationAddress,conversationIdentity,type ConversationIdentity} from './conversation';
export type ContextExposure={sources:SourceFence[];origins:OriginFence[]};
/** Private host port, implemented by the native extension's supported destroy().
 * abort is scoped to this session; quiesce must wait for its old work to finish.
 * Never expose this port as a model tool or unauthenticated callable. */
export interface NativeContextDestroyPort {
 abort(sessionId:string):Promise<void>;
 quiesce(sessionId:string):Promise<void>;
 destroy(sessionId:string):Promise<void>;
}
const owner={kind:'owner'} as const;
const equalScope=(a:OriginScope,b:OriginScope)=>a.installationId===b.installationId&&a.generation===b.generation&&a.sourceEpoch===b.sourceEpoch&&a.sourceGeneration===b.sourceGeneration;
/** Dependency trace for the complete native epoch, including compacted history.
 * Remote evidence is checked again before each host/model frame; the relational
 * latch is embedded in effect transactions. Neither check is head-only. */
export class NativeConversationRetention {
 constructor(private readonly db:D1Database,private readonly getScope:()=>OriginScope,private readonly origin:OriginGuard,
  private readonly native?:NativeContextDestroyPort,private readonly clock=Date.now){}
 private scope(){return activeOrigin(this.getScope);}
 private async id(identity:ConversationIdentity){const parsed=conversationIdentity.parse(identity),scope=this.scope();if(parsed.installationId!==scope.installationId||parsed.generation!==scope.generation)throw Error('conversation_context_withdrawn');return conversationAddress(parsed,parsed.channel,parsed.principalOrChatId,parsed.contextEpoch);}
 private access(){return new SourceAccess(this.db,this.scope(),this.clock,'knowledge');}
 private activeGuard(sessionId:string):AccessGuard {const scope=this.scope();return {sql:`EXISTS(SELECT 1 FROM assistant_native_conversations c JOIN assistant_native_context_channels ch ON ch.conversation_id=c.id
  WHERE c.id=? AND c.installation_id=? AND c.generation=? AND c.tombstoned_at IS NULL)`,values:[sessionId,scope.installationId,scope.generation]};}
 async currentIdentity(channel:ConversationIdentity['channel'],principalId:string):Promise<ConversationIdentity|null>{const scope=this.scope();const row=await this.db.prepare(`SELECT c.identity_json FROM assistant_native_context_channels ch JOIN assistant_native_conversations c ON c.id=ch.conversation_id
  WHERE ch.installation_id=? AND ch.generation=? AND ch.channel=? AND ch.principal_id=? AND c.tombstoned_at IS NULL`).bind(scope.installationId,scope.generation,channel,principalId).first<{identity_json:string}>();return row?conversationIdentity.parse(JSON.parse(row.identity_json)):null;}
 /** Explicit host registration, never inferred from model/native initialData. A
  * different live epoch cannot be replaced without first being tombstoned. */
 async register(identity:ConversationIdentity){identity=conversationIdentity.parse(identity);const id=await this.id(identity),now=this.clock();
  await this.db.batch([
   this.db.prepare(`INSERT INTO assistant_native_conversations(id,installation_id,generation,identity_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(id,identity.installationId,identity.generation,JSON.stringify(identity),now),
   this.db.prepare(`INSERT INTO assistant_native_context_channels(installation_id,generation,channel,principal_id,conversation_id)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_native_conversations WHERE id=? AND tombstoned_at IS NULL)
    ON CONFLICT(installation_id,generation,channel,principal_id) DO UPDATE SET conversation_id=excluded.conversation_id
    WHERE assistant_native_context_channels.conversation_id=excluded.conversation_id OR EXISTS(SELECT 1 FROM assistant_native_conversations old WHERE old.id=assistant_native_context_channels.conversation_id AND old.tombstoned_at IS NOT NULL)`)
    .bind(identity.installationId,identity.generation,identity.channel,identity.principalOrChatId,id,id),
  ]);
  const guard=this.activeGuard(id);if(!(await this.db.prepare(`SELECT 1 WHERE (${guard.sql})`).bind(...guard.values).first()))throw Error('conversation_context_withdrawn');
 }
 /** Constant-size binds regardless of dependency count. Compares every stored
  * source and origin fence to current source/permission rows in one snapshot. */
 authorityGuard(sessionId:string):AccessGuard {
  const active=this.activeGuard(sessionId),scope=this.scope(),visible=this.access().ownerRows(this.clock());
  const fields=[['id','id'],['revision','revision'],['version','version'],['content_hash','hash'],['audience','audience'],['origin','origin'],['conversation_id','conversationId'],['project_id','projectId']];
  const sourceMatch=fields.map(([col,key])=>`v.${col} IS json_extract(e.source_fence_json,'$.source.${key}')`).join(' AND ');
  const originMatch=[['source_kind','sourceKind'],['source_id','sourceId'],['chat_id','chatId'],['observation_hash','hash']].map(([col,key])=>`o.${col} IS json_extract(e.origin_fence_json,'$.${key}')`).join(' AND ');
  return {sql:`(${active.sql}) AND NOT EXISTS(SELECT 1 FROM assistant_native_context_exposures e WHERE e.conversation_id=? AND (
   json_extract(e.source_fence_json,'$.knowledge.sourceEpoch') IS NOT ?
   OR json_extract(e.source_fence_json,'$.knowledge.sourceGeneration') IS NOT ?
   OR NOT EXISTS(SELECT 1 FROM (${visible.sql}) v WHERE ${sourceMatch}
    AND v.analysis_policy_revision IS json_extract(e.source_fence_json,'$.knowledge.policyRevision')
    AND v.sharing_quarantined IS json_extract(e.source_fence_json,'$.knowledge.sharingQuarantined'))
   OR (json_extract(e.source_fence_json,'$.source.origin')='whatsapp' AND e.origin_fence_json IS NULL)
   OR (e.origin_fence_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistant_source_origins o
    JOIN assistant_origin_conversations oc ON oc.installation_id=o.installation_id AND oc.generation=o.generation AND oc.source_epoch=o.source_epoch AND oc.source_generation=o.source_generation AND oc.chat_id=o.chat_id
    LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
    WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.canonical_id=e.source_id AND o.tombstoned=0 AND oc.access_state='available'
     AND ${originMatch} AND oc.kind IS json_extract(e.origin_fence_json,'$.conversationKind') AND (p.kind IS NULL OR p.kind=oc.kind)
     AND COALESCE(p.revision,0) IS json_extract(e.origin_fence_json,'$.policyRevision')
     AND COALESCE(p.effective_mode,CASE WHEN oc.kind='private' THEN 'attend' ELSE 'ignore' END) IS json_extract(e.origin_fence_json,'$.policyMode')))
  ))`,values:[...active.values,sessionId,scope.sourceEpoch,scope.sourceGeneration,...visible.values,scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration]};
 }
 private async isCurrent(sessionId:string){const guard=this.authorityGuard(sessionId);return !!await this.db.prepare(`SELECT 1 WHERE (${guard.sql})`).bind(...guard.values).first();}
 async assertCurrent(identity:ConversationIdentity,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const id=await this.id(identity);signal?.throwIfAborted();let valid:boolean;
  const began=Date.now(),report=(data:Record<string,unknown>)=>{try{console.warn('native_context_proof_diagnostic',data);}catch{/* No authority depends on logging. */}};
  try{valid=await this.isCurrent(id);}catch{report({phase:'initial_context_sql',reason:'exception',elapsedMs:Date.now()-began});throw Error('conversation_context_unavailable');}
  signal?.throwIfAborted();
  if(!valid){await this.purge(identity);throw Error('conversation_context_withdrawn');}
  // Keyset paging bounds each database call, never the retained corpus. A source
  // seen through multiple tools is observed once per assertion.
  let after='',pageNumber=0,started=0,completed=0;const seen=new Set<string>();
  for(;;){signal?.throwIfAborted();const page=await this.db.prepare(`SELECT id,origin_fence_json FROM assistant_native_context_exposures WHERE conversation_id=? AND id>? ORDER BY id LIMIT 64`).bind(id,after).all<{id:string;origin_fence_json:string|null}>();signal?.throwIfAborted();if(!page.results.length)break;
   pageNumber++;
   const fences:OriginFence[]=[];for(const row of page.results){after=row.id;if(!row.origin_fence_json)continue;const fence=JSON.parse(row.origin_fence_json) as OriginFence,key=JSON.stringify([fence.canonicalId,fence.revision,fence.version,fence.hash,fence.policyRevision]);if(!seen.has(key)){seen.add(key);fences.push(fence);}}
   for(let start=0;start<fences.length;start+=8){signal?.throwIfAborted();const results=await Promise.all(fences.slice(start,start+8).map(async(f,index)=>{started++;const result=await this.origin.checkContext(f,()=>!signal?.aborted,event=>report({...event,sourceKind:f.sourceKind,page:pageNumber,ordinal:start+index,started,completed,cancelled:signal?.aborted===true}));completed++;return result;}));signal?.throwIfAborted();
    if(results.some(r=>r.state==='changed')){await this.purge(identity);throw Error('conversation_context_withdrawn');}
    if(results.some(r=>r.state==='unavailable'))throw Error('conversation_context_unavailable');
   }
  }
  let final:boolean;try{final=await this.isCurrent(id);}catch(error){report({phase:'final_context_sql',reason:'exception',elapsedMs:Date.now()-began,started,completed});throw error;}
  if(!final){await this.purge(identity);throw Error('conversation_context_withdrawn');}signal?.throwIfAborted();
 }
 async exposeSource(identity:ConversationIdentity,ref:SourceSelectionRef){
  const source=await this.access().read(owner,ref.id,ref.revision);if(!source||source.fence.source.version!==ref.version||source.fence.source.hash!==ref.hash)throw Error('conversation_exposure_proof');
  const origins:OriginFence[]=[];if(source.fence.source.origin==='whatsapp'){const fence=await this.origin.fence(ref.id);if(!fence)throw Error('conversation_exposure_proof');origins.push(fence);}
  return this.expose(identity,{sources:[source.fence],origins});
 }
 /** Host callback invoked BEFORE returning any body or native dispatch. Source
  * refs in text/tool claims never become authority by themselves. */
 async expose(identity:ConversationIdentity,raw:ContextExposure,signal?:AbortSignal){
  signal?.throwIfAborted();const proof:ContextExposure=JSON.parse(JSON.stringify(raw)),id=await this.id(identity);signal?.throwIfAborted();await this.assertCurrent(identity,signal);
  for(const fence of proof.sources){sourceFence.parse(fence);if(fence.actor!=='knowledge:owner'||!fence.knowledge||!equalScope({...fence,...fence.knowledge},this.scope()))throw Error('conversation_exposure_proof');}
  if(proof.origins.some(o=>!proof.sources.some(f=>f.source.id===o.canonicalId&&f.source.revision===o.revision&&f.source.version===o.version&&f.source.origin==='whatsapp'))||proof.sources.some(f=>f.source.origin==='whatsapp'&&!proof.origins.some(o=>o.canonicalId===f.source.id&&o.revision===f.source.revision&&o.version===f.source.version)))throw Error('conversation_exposure_proof');
  for(const fence of proof.origins){signal?.throwIfAborted();const result=await this.origin.checkContext(fence);signal?.throwIfAborted();if(result.state==='unavailable')throw Error('conversation_context_unavailable');if(result.state!=='current')throw Error('conversation_exposure_changed');}
  for(const fence of proof.sources){signal?.throwIfAborted();const origin=proof.origins.find(o=>o.canonicalId===fence.source.id)??null,guards=[this.authorityGuard(id),this.access().guard(owner,fence,this.clock()),...(origin?[this.origin.localContextGuard(origin)]:[])];
   const key=await bridgeHash([id,fence,origin]);signal?.throwIfAborted();
   const result=await this.db.prepare(`INSERT INTO assistant_native_context_exposures(id,installation_id,generation,conversation_id,source_id,source_fence_json,origin_fence_json,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${guards.map(g=>`(${g.sql})`).join(' AND ')} ON CONFLICT DO NOTHING RETURNING id`)
    .bind(key,identity.installationId,identity.generation,id,fence.source.id,JSON.stringify(fence),origin?JSON.stringify(origin):null,this.clock(),...guards.flatMap(g=>g.values)).first();
   signal?.throwIfAborted();if(!result){
    const saved=await this.db.prepare('SELECT 1 FROM assistant_native_context_exposures WHERE id=?').bind(key).first();signal?.throwIfAborted();
    // A repeated exact exposure needs no per-item remote context traversal.
    // The unchanged final assertion still fences the entire page before use.
    if(!saved){await this.assertCurrent(identity,signal);throw Error('conversation_exposure_changed');}
   }
  }
  await this.assertCurrent(identity,signal);
 }
 /** Logical tombstone commits BEFORE abort/quiesce/physical native destruction.
  * A missing/failing port leaves explicit pending purge, never a deletion claim. */
 async purge(identity:ConversationIdentity):Promise<{state:'tombstoned'|'purged';sessionId:string}>{identity=conversationIdentity.parse(identity);const id=await this.id(identity),now=this.clock();
  await this.db.batch([
   this.db.prepare(`INSERT INTO assistant_native_conversations(id,installation_id,generation,identity_json,created_at,tombstoned_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tombstoned_at=COALESCE(assistant_native_conversations.tombstoned_at,excluded.tombstoned_at)`).bind(id,identity.installationId,identity.generation,JSON.stringify(identity),now,now),
   this.db.prepare("UPDATE assistant_native_conversation_events SET state='withdrawn',event_json=NULL WHERE conversation_id=?").bind(id),
   this.db.prepare("UPDATE assistant_native_reply_intents SET state='superseded' WHERE conversation_id=? AND state IN ('proposed','approved')").bind(id),
   this.db.prepare("INSERT INTO assistant_native_context_purges(installation_id,generation,conversation_id,state,updated_at) VALUES(?,?,?,'tombstoned',?) ON CONFLICT DO NOTHING").bind(identity.installationId,identity.generation,id,now),
  ]);
  const previous=await this.db.prepare('SELECT state FROM assistant_native_context_purges WHERE conversation_id=?').bind(id).first<{state:'tombstoned'|'purged'}>();
  if(previous?.state==='purged'||!this.native)return {state:previous!.state,sessionId:id};
  try{await this.native.abort(id);await this.native.quiesce(id);await this.native.destroy(id);}catch{return {state:'tombstoned',sessionId:id};}
  await this.db.prepare("UPDATE assistant_native_context_purges SET state='purged',updated_at=? WHERE conversation_id=?").bind(this.clock(),id).run();return {state:'purged',sessionId:id};
 }
}
