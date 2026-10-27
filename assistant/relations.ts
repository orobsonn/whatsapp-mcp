import {readOwnerCanonical} from './owner-canonical-context';
import type {OriginGuard} from './origin-guard';
import type {SourceScope} from './sources';
import {SourceAccess,type TrustedActor,type AccessGuard} from './access';
import {z} from 'zod';
import {bridgeHash} from './ingress';
import {sourceRelationAudience,relationAudience,ownerRelationKey} from './relation-visibility';
export type EntityRef={kind:'person'|'project'|'mission';id:string};
export type CandidateClaim={kind:'assertion'|'suggestion'|'decision'|'observation';subject:EntityRef;object?:EntityRef;predicate:string;quote:string};
export type ExtractionBatch={key:string;sourceId:string;revision:number;version:number;hash:string;claims:CandidateClaim[]};
/** Only the host constructs SQL/whitelist/final statements, never a model or
 * request body. All statements commit together with the candidate batch. */
export type RelationPublication={before:()=>Promise<boolean>;guard:()=>AccessGuard;whitelist:EntityRef[];after:(hash:string,guard:AccessGuard)=>D1PreparedStatement[];owner?:{pinHash:string;catalogHash:string;payloadHash:string;supportHash:string;configHash:string}};
const id=z.string().min(1).max(256);
const entity=z.object({kind:z.enum(['person','project','mission']),id}).strict();
const schema=z.object({key:id,sourceId:id,revision:z.number().int().positive(),version:z.number().int().positive(),
 hash:z.string().regex(/^[a-f0-9]{64}$/),claims:z.array(z.object({kind:z.enum(['assertion','suggestion','decision','observation']),
  subject:entity,object:entity.optional(),predicate:z.string().min(1).max(256),quote:z.string().min(1).max(4096)}).strict()).min(1).max(32)}).strict();
// Entity references are checked against canonical IDs, never display names.
function known(ref:string){
 return `((json_extract(${ref},'$.kind')='person' AND EXISTS(SELECT 1 FROM assistant_people e WHERE e.installation_id=s.installation_id AND e.generation=s.generation AND e.id=json_extract(${ref},'$.id')))
 OR (json_extract(${ref},'$.kind')='project' AND EXISTS(SELECT 1 FROM assistant_projects e WHERE e.installation_id=s.installation_id AND e.generation=s.generation AND e.id=json_extract(${ref},'$.id')))
 OR (json_extract(${ref},'$.kind')='mission' AND EXISTS(SELECT 1 FROM assistant_missions e WHERE e.installation_id=s.installation_id AND e.generation=s.generation AND e.id=json_extract(${ref},'$.id'))))`;
}
export class Relations {
 private readonly scope:SourceScope;
 constructor(private readonly db:D1Database,scope:SourceScope,private readonly options:{origin?:Pick<OriginGuard,'fence'|'check'> & Partial<Pick<OriginGuard,'localGuard'>>;clock?:()=>number}={}){this.scope=Object.freeze({...scope});}
 async publish(input:ExtractionBatch,host?:RelationPublication):Promise<void>{
  // parse creates an owned deep snapshot before any await.
  const batch=schema.parse(input),json=JSON.stringify(batch.claims),owned=host?.owner?z.object({pinHash:z.string().regex(/^[a-f0-9]{64}$/),catalogHash:z.string().regex(/^[a-f0-9]{64}$/),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),supportHash:z.string().regex(/^[a-f0-9]{64}$/),configHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(host.owner):undefined;
  if(owned&&!ownerRelationKey(batch.key))throw Error('owner_relation_key');const hash=await bridgeHash(owned?{...batch,visibility:'owner',context:owned}:batch);
  const whitelist=host?JSON.stringify(z.array(entity).min(1).max(16).parse(host.whitelist)):null;
  if(new TextEncoder().encode(json).length>32768)throw new Error('extraction_too_large');
  const keys=[this.scope.installationId,this.scope.generation];
  // Remote observation follows hashing; the local ACL/lease/time predicates are
  // then rebuilt synchronously immediately before the one D1 transaction.
  if(host&&!await host.before())throw new Error('extraction_rejected');
  const guard=host?.guard();
  const statement=this.db.prepare(`INSERT INTO assistant_relation_batches
   SELECT s.installation_id,s.generation,?,?,s.id,s.revision,s.current_version,v.content_hash,v.author_id,v.author_label,?
   FROM assistant_sources s JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation
    AND v.source_id=s.id AND v.version=s.current_version
   WHERE s.installation_id=? AND s.generation=? AND s.id=? AND s.status='active' AND s.revision=? AND s.current_version=? AND v.content_hash=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) c WHERE v.original_text IS NULL OR instr(v.original_text,json_extract(c.value,'$.quote'))=0
      OR NOT ${known("json_extract(c.value,'$.subject')")}
      OR (json_type(c.value,'$.object') IS NOT NULL AND NOT ${known("json_extract(c.value,'$.object')")}))
    ${guard?`AND (${guard.sql}) AND NOT EXISTS(SELECT 1 FROM json_each(?) c WHERE
      NOT EXISTS(SELECT 1 FROM json_each(?) a WHERE json_extract(a.value,'$.kind')=json_extract(c.value,'$.subject.kind') AND json_extract(a.value,'$.id')=json_extract(c.value,'$.subject.id'))
      OR (json_type(c.value,'$.object') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM json_each(?) a WHERE json_extract(a.value,'$.kind')=json_extract(c.value,'$.object.kind') AND json_extract(a.value,'$.id')=json_extract(c.value,'$.object.id'))))`:''}
   ON CONFLICT DO NOTHING`).bind(batch.key,hash,json,...keys,batch.sourceId,batch.revision,batch.version,batch.hash,json,...(guard?[...guard.values,json,whitelist,whitelist]:[]));
  const ownerProof=owned?this.db.prepare(`INSERT INTO assistant_owner_relation_proofs SELECT x.installation_id,x.generation,?,x.source_id,x.source_revision,x.source_version,x.source_hash,x.slot_key,x.pin_hash,x.config_hash,?,?,?,'owner' FROM assistant_canonical_extractions x JOIN assistant_owner_canonical_supports s ON s.installation_id=x.installation_id AND s.generation=x.generation AND s.source_id=x.source_id AND s.source_revision=x.source_revision AND s.slot_key=x.slot_key AND s.pin_hash=x.pin_hash WHERE x.installation_id=? AND x.generation=? AND x.source_id=? AND x.source_revision=? AND x.source_version=? AND x.source_hash=? AND x.slot_key=? AND x.pin_hash=? AND x.config_hash=? AND x.actor_json='{"kind":"owner"}' AND x.state IN ('attempting','uncertain') AND s.proof_hash=? AND json_extract(s.proof_json,'$.binding.catalogHash')=? AND json_extract(s.proof_json,'$.binding.payloadHash')=? AND json_extract(s.proof_json,'$.binding.configHash')=? ON CONFLICT DO NOTHING`).bind(batch.key,owned.catalogHash,owned.payloadHash,owned.supportHash,...keys,batch.sourceId,batch.revision,batch.version,batch.hash,batch.key,owned.pinHash,owned.configHash,owned.supportHash,owned.catalogHash,owned.payloadHash,owned.configHash):null;
  if(host)await this.db.batch([statement,...(ownerProof?[ownerProof]:[]),...host.after(hash,guard!)]);else await statement.run();
  const stored=await this.db.prepare('SELECT request_hash FROM assistant_relation_batches WHERE installation_id=? AND generation=? AND operation_key=?')
   .bind(...keys,batch.key).first<{request_hash:string}>();
  if(!stored)throw new Error('extraction_rejected');
  if(stored.request_hash!==hash)throw new Error('extraction_conflict');
 }
 async read(actor:TrustedActor,sourceId:string):Promise<unknown[]>{
  const access=new SourceAccess(this.db,this.scope),source=await access.read(actor,sourceId);
  if(!source)return [];
  const visible={sql:sourceRelationAudience('b'),values:[]};
  const rows=await this.db.prepare(`SELECT author_id,author_label,claims_json FROM assistant_relation_batches b
   WHERE installation_id=? AND generation=? AND source_id=? AND source_revision=? AND source_version=? AND source_hash=? AND (${visible.sql}) ORDER BY operation_key LIMIT 17`)
   .bind(this.scope.installationId,this.scope.generation,sourceId,source.fence.source.revision,source.fence.source.version,source.fence.source.hash,...visible.values)
   .all<{author_id:string|null;author_label:string|null;claims_json:string}>();
  if(rows.results.length>16 || rows.results.reduce((n,row)=>n+new TextEncoder().encode(row.claims_json).length,0)>65536)
   throw new Error('relation_scope_too_large');
  if(!await access.revalidate(actor,source.fence))return [];
  // These are candidates plus a fence, not permission to invoke or publish.
  const result=rows.results.map(row=>({authorId:row.author_id,authorLabel:row.author_label,claims:JSON.parse(row.claims_json),fence:source.fence}));
  if(actor.kind==='owner'){const current=await readOwnerCanonical(this.db,this.scope,source,this.options);if(current.state==='available'){if(current.claims.length){if(result.length>=16)throw Error('relation_scope_too_large');result.push({authorId:source.authorId,authorLabel:source.authorLabel,claims:current.claims,fence:source.fence});}}else{if(source.fence.source.origin==='whatsapp'){const ref=await this.options.origin?.fence(source.id);if(!ref||!await this.options.origin!.check(ref))return [];}if(!await access.revalidate(actor,source.fence))return [];}}
  return result;
 }
}
