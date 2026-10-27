import type {SourceScope} from './sources';
import {SourceAccess,type TrustedActor,type AccessGuard} from './access';
import {z} from 'zod';
import {bridgeHash} from './ingress';
import {sourceRelationAudience} from './relation-visibility';
export type EntityRef={kind:'person'|'project'|'mission';id:string};
export type CandidateClaim={kind:'assertion'|'suggestion'|'decision'|'observation';subject:EntityRef;object?:EntityRef;predicate:string;quote:string};
export type ExtractionBatch={key:string;sourceId:string;revision:number;version:number;hash:string;claims:CandidateClaim[]};
/** Only the host constructs SQL/whitelist/final statements, never a model or
 * request body. All statements commit together with the candidate batch. */
export type RelationPublication={before:()=>Promise<boolean>;guard:()=>AccessGuard;whitelist:EntityRef[];after:(hash:string,guard:AccessGuard)=>D1PreparedStatement[]};
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
 constructor(private readonly db:D1Database,scope:SourceScope){this.scope=Object.freeze({...scope});}
 async publish(input:ExtractionBatch,host?:RelationPublication):Promise<void>{
  // parse creates an owned deep snapshot before any await.
  const batch=schema.parse(input),json=JSON.stringify(batch.claims),hash=await bridgeHash(batch);
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
  if(host)await this.db.batch([statement,...host.after(hash,guard!)]);else await statement.run();
  const stored=await this.db.prepare('SELECT request_hash FROM assistant_relation_batches WHERE installation_id=? AND generation=? AND operation_key=?')
   .bind(...keys,batch.key).first<{request_hash:string}>();
  if(!stored)throw new Error('extraction_rejected');
  if(stored.request_hash!==hash)throw new Error('extraction_conflict');
 }
 async read(actor:TrustedActor,sourceId:string):Promise<unknown[]>{
  const access=new SourceAccess(this.db,this.scope),source=await access.read(actor,sourceId);
  if(!source)return [];
  const rows=await this.db.prepare(`SELECT author_id,author_label,claims_json FROM assistant_relation_batches b
   WHERE installation_id=? AND generation=? AND source_id=? AND source_revision=? AND source_version=? AND source_hash=? AND (${sourceRelationAudience('b')}) ORDER BY operation_key LIMIT 17`)
   .bind(this.scope.installationId,this.scope.generation,sourceId,source.fence.source.revision,source.fence.source.version,source.fence.source.hash)
   .all<{author_id:string|null;author_label:string|null;claims_json:string}>();
  if(rows.results.length>16 || rows.results.reduce((n,row)=>n+new TextEncoder().encode(row.claims_json).length,0)>65536)
   throw new Error('relation_scope_too_large');
  if(!await access.revalidate(actor,source.fence))return [];
  // These are candidates plus a fence, not permission to invoke or publish.
  return rows.results.map(row=>({authorId:row.author_id,authorLabel:row.author_label,claims:JSON.parse(row.claims_json),fence:source.fence}));
 }
}
