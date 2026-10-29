import {z} from 'zod';
import {SourceAccess,type AccessRow,type SourceFence,type SourceRead} from '../access';
import {sourceRef} from '../source-proof-contract';
import {bridgeHash} from '../ingress';
import {decodeCursor,encodeCursor} from '../connectors/read-only';
import type {OriginFence,OriginGuard,OriginScope} from '../origin-guard';

export type ReadExposure={sources:SourceFence[];origins:OriginFence[]};
export type ContextOriginReader=Pick<OriginGuard,'fence'|'checkContext'>;
const searchInput=z.object({query:z.string().min(1).max(512),cursor:z.string().max(4096).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
const rangeInput=z.object({sourceRef,offset:z.number().int().nonnegative().safe().default(0),limit:z.number().int().min(1).max(8192).default(8192)}).strict();
const owner={kind:'owner'} as const;
const ref=(read:SourceRead)=>({id:read.id,revision:read.fence.source.revision,version:read.fence.source.version,hash:read.fence.source.hash});
/** Host-scoped authorized original search, distinct from graph retrieval. The
 * index is derived: its matches always join current knowledge eligibility.
 * Recency ranking uses only eligible rows, never global FTS corpus statistics. */
export class ConversationArchive {
 private readonly access:SourceAccess;
 constructor(private readonly db:D1Database,private readonly scope:OriginScope,private readonly origin:ContextOriginReader,
  private readonly assertCurrent:()=>Promise<void>,private readonly expose:(proof:ReadExposure)=>Promise<void>,private readonly clock=Date.now){
  this.scope=Object.freeze({...scope});this.access=new SourceAccess(db,this.scope,clock,'knowledge');
 }
 private async release(reads:SourceRead[]){
  const proof:ReadExposure={sources:reads.map(read=>read.fence),origins:[]};
  for(const read of reads){
   if(read.fence.source.origin!=='whatsapp')continue;
   const fence=await this.origin.fence(read.id);
   if(!fence||fence.revision!==read.fence.source.revision||fence.version!==read.fence.source.version)throw Error('archive_source_changed');
   if((await this.origin.checkContext(fence)).state!=='current')throw Error('archive_origin_unavailable');
   proof.origins.push(fence);
  }
  await this.assertCurrent();await this.expose(proof);
  // Host callback may await a registry write. Recheck after it before releasing
  // any selected body, including empty/error exposure of a read result.
  for(const read of reads)if(!await this.access.revalidate(owner,read.fence))throw Error('archive_source_changed');
  for(const fence of proof.origins)if((await this.origin.checkContext(fence)).state!=='current')throw Error('archive_origin_unavailable');
  await this.assertCurrent();
 }
 async search(raw:unknown){
  const input=searchInput.parse(raw);await this.assertCurrent();
  // All terms are literal tokens. No model-supplied FTS operators or SQL.
  const terms=input.query.match(/[\p{L}\p{N}_]+/gu)??[];
  const match=terms.map(term=>'"'+term.replace(/"/g,'""')+'"').join(' AND ');
  const fingerprint=await bridgeHash([this.scope,match]);
  const cursor=input.cursor?z.object({fingerprint:z.literal(fingerprint),at:z.number().int().nonnegative().safe(),id:z.string().min(1).max(256)}).strict().parse(decodeCursor(input.cursor)):null;
  const eligible=this.access.ownerRows(this.clock());
  const rows=match?(await this.db.prepare(`WITH visible AS (${eligible.sql})
   SELECT visible.* FROM assistant_archive_text JOIN visible ON visible.id=assistant_archive_text.source_id
    AND visible.version=assistant_archive_text.version
   WHERE assistant_archive_text MATCH ? AND assistant_archive_text.installation_id=? AND assistant_archive_text.generation=?
    AND (? IS NULL OR visible.occurred_at<? OR (visible.occurred_at=? AND visible.id>?))
   ORDER BY visible.occurred_at DESC,visible.id ASC LIMIT ?`)
   .bind(...eligible.values,match,this.scope.installationId,this.scope.generation,cursor?.at??null,cursor?.at??null,cursor?.at??null,cursor?.id??null,input.limit+1).all<AccessRow>()).results:[];
  const more=rows.length>input.limit,selected=rows.slice(0,input.limit),reads:SourceRead[]=[];
  for(const row of selected){
   const read=await this.access.read(owner,row.id,row.revision,this.clock());
   if(!read||read.fence.source.version!==row.version||read.fence.source.hash!==row.content_hash)throw Error('archive_source_changed');
   reads.push(read);
  }
  const items=reads.map(read=>{
   const text=read.text??'',first=terms.length?text.toLocaleLowerCase().indexOf(terms[0]!.toLocaleLowerCase()):-1;
   const offset=Math.max(0,first-160),snippet=text.slice(offset,offset+640);
   return {sourceRef:ref(read),snippet,snippetOffset:offset,authorId:read.authorId,authorLabel:read.authorLabel,occurredAt:read.occurredAt,
    coverage:{kind:'snippet',complete:offset===0&&snippet.length===text.length,totalCharacters:text.length},origin:read.fence.source.origin,conversationId:read.fence.source.conversationId};
  });
  const last=selected.at(-1);const output={state:'available' as const,items,coverage:{kind:'search_page',complete:!more,returned:items.length,ranking:'authorized_recency',consistency:'live_paginated'},
   ...(more&&last?{nextCursor:encodeCursor({fingerprint,at:last.occurred_at,id:last.id})}:{})};
  await this.release(reads);return output;
 }
 async read(raw:unknown){
  const input=rangeInput.parse(raw);await this.assertCurrent();
  const read=await this.access.read(owner,input.sourceRef.id,input.sourceRef.revision,this.clock());
  if(!read||JSON.stringify(ref(read))!==JSON.stringify(input.sourceRef))throw Error('archive_source_changed');
  if(read.text===null)throw Error('archive_text_unavailable');
  if(input.offset>read.text.length)throw Error('archive_range');
  const text=read.text.slice(input.offset,input.offset+input.limit),next=input.offset+text.length,complete=next===read.text.length;
  const output={state:'available' as const,sourceRef:ref(read),text,offset:input.offset,authorId:read.authorId,authorLabel:read.authorLabel,occurredAt:read.occurredAt,
   coverage:{kind:'original_range',complete,totalCharacters:read.text.length},...(!complete?{nextOffset:next}:{})};
  await this.release([read]);return output;
 }
}
