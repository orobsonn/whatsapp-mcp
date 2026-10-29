/** Synthetic-only CF probe, imported solely by the disposable test application. */
import { SourceAccess } from '../../assistant/access';
import { sourceFence } from '../../assistant/source-proof-contract';
export async function runKnowledgePolicyProof(db: D1Database) {
 const scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'e1',sourceGeneration:'sg1'};
 const q=(sql:string,...values:(string|number|null)[])=>db.prepare(sql).bind(scope.installationId,scope.generation,...values);
 const owner={kind:'owner'} as const;
 const knowledge=new SourceAccess(db,scope,Date.now,'knowledge'),archive=new SourceAccess(db,scope);
 const text='Synthetic Cedar evidence',hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
 for(const [chat,kind] of [['direct','private'],['group','group']] as const){
  await db.batch([
   q("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,conversation_id,audience) VALUES(?,?,?,'whatsapp',?,?,'restricted')",chat+'-source',chat+'-message',chat),
   q("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,?,1,?,?,1)",chat+'-source',text,hash),
   q("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,?,'available')",scope.sourceEpoch,scope.sourceGeneration,chat,kind),
   q("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,tombstoned) VALUES(?,?,?,?,'message',?,?,?,1,0)",scope.sourceEpoch,scope.sourceGeneration,chat+'-message',chat,chat+'-source')
  ]);
 }
 const privateBefore=await knowledge.read(owner,'direct-source');
 const typedFenceRoundtrip=await knowledge.revalidate(owner,sourceFence.parse(privateBefore!.fence));
 const privateDefault=!!privateBefore,groupDefaultDenied=(await knowledge.read(owner,'group-source'))===null;
 await q("INSERT INTO assistant_conversation_policies VALUES(?,?,'group','group',0,'observe',1)").run();
 const groupIncluded=!!await knowledge.read(owner,'group-source');
 await q("INSERT INTO assistant_conversation_policies VALUES(?,?,'direct','private',1,'ignore',1)").run();
 const excludedDenied=(await knowledge.read(owner,'direct-source'))===null;
 const oldFenceDenied=!await knowledge.revalidate(owner,privateBefore!.fence);
 const capturedOriginalPreserved=!!await archive.read(owner,'direct-source');
 await q("UPDATE assistant_conversation_policies SET excluded=0,revision=2 WHERE installation_id=? AND generation=? AND conversation_id='direct'").run();
 const oldFenceNotRevived=!await knowledge.revalidate(owner,privateBefore!.fence);
 await q("UPDATE assistant_conversation_policies SET excluded=1,revision=3 WHERE installation_id=? AND generation=? AND conversation_id='direct'").run();
 await db.batch([
  q("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,audience) VALUES(?,?,'restored-note','owner_note','restored','restricted')"),
  q("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,'restored-note',1,?,?,1)",text,hash),
  q("INSERT INTO assistant_retention_quarantines(installation_id,generation,kind,record_key,source_id,version,active,reason,snapshot_seal) VALUES(?,?,'source_authorization','restored','restored-note',1,1,'snapshot_reproof_required','synthetic')")
 ]);
 const restored=(await knowledge.read(owner,'restored-note'))!;
 const restoredSharingMarked=restored.fence.knowledge?.sharingQuarantined===true;
 const knowledgeFenceNotLegacyAuthority=!await archive.revalidate(owner,restored.fence);
 const inventory=knowledge.inventory(owner,undefined,Date.now(),{includePaused:true});
 const candidates=(await db.prepare(inventory.sql).bind(...inventory.values).all<{id:string}>()).results;
 const excludedBeforeRanking=!candidates.some(c=>c.id==='direct-source')&&candidates.some(c=>c.id==='group-source');
 await q("UPDATE assistant_origin_conversations SET source_generation='old' WHERE installation_id=? AND generation=? AND chat_id='group'").run();
 const oldOriginDenied=(await knowledge.read(owner,'group-source'))===null;
 return {privateDefault,groupDefaultDenied,groupIncluded,excludedDenied,oldFenceDenied,capturedOriginalPreserved,excludedBeforeRanking,oldOriginDenied,oldFenceNotRevived,restoredSharingMarked,knowledgeFenceNotLegacyAuthority,typedFenceRoundtrip};
}
