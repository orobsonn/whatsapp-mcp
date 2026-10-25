import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {Relations,type ExtractionBatch,type CandidateClaim} from '../assistant/relations';
import {SourceController,sourceTextHash} from '../assistant/sources';
// @ts-expect-error raw SQL fixture.
import sources from '../assistant/migrations/0001_sources.sql?raw';
// @ts-expect-error raw SQL fixture.
import identities from '../assistant/migrations/0002_identity_policy.sql?raw';
// @ts-expect-error raw SQL fixture.
import work from '../assistant/migrations/0003_work.sql?raw';
// @ts-expect-error raw SQL fixture.
import controls from '../assistant/migrations/0007_source_controls.sql?raw';
// @ts-expect-error raw SQL fixture.
import relationSchema from '../assistant/migrations/0009_relations.sql?raw';
let relations:Relations,owner:SourceController,scope:{installationId:string;generation:string},batch:ExtractionBatch;
const text='Marina A sugeriu sexta. Marina B decidiu segunda.';
const claim:CandidateClaim={kind:'suggestion',subject:{kind:'person',id:'a'},predicate:'prazo',quote:'Marina A sugeriu sexta.'};
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:'g'};
 for(const schema of [sources,identities,work,controls,relationSchema]){
  const statements=schema.replace(/^--.*$/gm,'').trim().split(/;\s*(?=CREATE|$)/).filter((s:string)=>s.trim());
  await env.DB.batch(statements.map((s:string)=>env.DB.prepare(s)));
 }
 owner=new SourceController(env.DB,scope,{kind:'owner'});relations=new Relations(env.DB,scope);
 for(const id of ['a','b'])await env.DB.prepare('INSERT INTO assistant_people VALUES(?,?,?,?)').bind(scope.installationId,scope.generation,id,'Marina').run();
 const source=await owner.create({originKey:'note',text,authorId:'author',authorLabel:'Dono',occurredAt:100});
 batch={key:'extract',sourceId:source.id,revision:1,version:1,hash:await sourceTextHash(text),claims:[{...claim,subject:{...claim.subject}}]};
});
it('keeps attributed candidates distinct without merging homonyms',async()=>{
 batch.claims.push({kind:'decision',subject:{kind:'person',id:'b'},predicate:'prazo',quote:'Marina B decidiu segunda.'});
 await relations.publish(batch);
 const rows=await relations.read({kind:'owner'},batch.sourceId);
 expect(rows).toMatchObject([{authorId:'author',claims:[{kind:'suggestion',subject:{id:'a'}},{kind:'decision',subject:{id:'b'}}]}]);
 expect((await env.DB.prepare('SELECT id FROM assistant_people WHERE installation_id=?').bind(scope.installationId).all()).results).toHaveLength(2);
});
it('rejects unknown and cross-namespace identifiers and unsupported quotes',async()=>{
 await env.DB.prepare('INSERT INTO assistant_people VALUES(?,?,?,?)').bind('another-installation',scope.generation,'elsewhere','Marina').run();
 for(const change of [{subject:{kind:'person',id:'invented'}},{subject:{kind:'person',id:'elsewhere'}},{quote:'Prazo confirmado para sexta.'},{object:{kind:'project',id:'absent'}}]){
  await expect(relations.publish({...batch,claims:[{...claim,...change} as CandidateClaim]})).rejects.toThrow();
 }
 expect(await relations.read({kind:'owner'},batch.sourceId)).toEqual([]);
});
it('does not partially publish a mixed valid and invalid batch or accept administrative fields',async()=>{
 await expect(relations.publish({...batch,claims:[claim,{...claim,subject:{kind:'person',id:'missing'}}]})).rejects.toThrow('extraction_rejected');
 expect(await relations.read({kind:'owner'},batch.sourceId)).toEqual([]);
 await expect(relations.publish({...batch,withdraw:true} as ExtractionBatch)).rejects.toThrow();
 await expect(relations.publish({...batch,claims:[{...claim,quote:''}]})).rejects.toThrow();
});
it('snapshots input before hashing',async()=>{
 const call=relations.publish(batch);batch.claims[0].predicate='mutated';await call;
 const result=await relations.read({kind:'owner'},batch.sourceId);
 expect(result).toMatchObject([{claims:[{predicate:'prazo'}]}]);
});
it('rejects stale extraction and hides earlier candidates after correction',async()=>{
 await relations.publish(batch);
 await owner.correct(batch.sourceId,1,{text:'A decisão mudou.',occurredAt:200});
 await expect(relations.publish({...batch,key:'late'})).rejects.toThrow('extraction_rejected');
 expect(await relations.read({kind:'owner'},batch.sourceId)).toEqual([]);
});
it('replays exactly but rejects conflicting extraction under the same key',async()=>{
 await Promise.all([relations.publish(batch),relations.publish(batch)]);
 expect(await relations.read({kind:'owner'},batch.sourceId)).toHaveLength(1);
 await expect(relations.publish({...batch,claims:[{...claim,kind:'decision'}]})).rejects.toThrow('extraction_conflict');
});
it('reports too many candidates explicitly instead of silently truncating retrieval',async()=>{
 for(let i=0;i<17;i++)await relations.publish({...batch,key:'batch'+i});
 await expect(relations.read({kind:'owner'},batch.sourceId)).rejects.toThrow('relation_scope_too_large');
});
it('never discloses private candidate relations to an interlocutor or extractor',async()=>{
 await relations.publish(batch);
 expect(await relations.read({kind:'extractor'},batch.sourceId)).toEqual([]);
 expect(await relations.read({kind:'interlocutor',provider:'whatsapp',address:'unknown',conversationId:'c',conversationKind:'private',action:'reply_text'},batch.sourceId)).toEqual([]);
 await owner.withdraw(batch.sourceId,1);
 expect(await relations.read({kind:'owner'},batch.sourceId)).toEqual([]);
});
