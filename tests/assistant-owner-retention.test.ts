import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import { SourceController } from '../assistant/sources';
import { SourceAccess } from '../assistant/access';
import { RetentionPurge } from '../assistant/retention-purge';
import { InferenceBudget } from '../assistant/budget';
import { AssistantExport } from '../assistant/retention';
import { installationHealth } from '../assistant/installation-health';
import { JobQueue } from '../assistant/queue';
const owner={kind:'owner'} as const, hash='a'.repeat(64), key='canonical-owner-v2:'+'b'.repeat(64), guard={allow:async()=>{},withdraw:async()=>{}};
let scope:{installationId:string;generation:string;period:string}, sources:SourceController, a:string,b:string;
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:'g1',period:'2026-10-27'};sources=new SourceController(env.DB,scope,owner,()=>100,guard);
 a=(await sources.create({originKey:'anchor',audience:'public',text:'Independent original.',occurredAt:1})).id;b=(await sources.create({originKey:'support',text:'Private support BODY.',occurredAt:1})).id;
 const anchor=(await new SourceAccess(env.DB,scope).read(owner,a))!,support=(await new SourceAccess(env.DB,scope).read(owner,b))!;
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO assistant_canonical_extractions(installation_id,generation,source_id,source_revision,source_version,source_hash,slot_key,pin_hash,config_hash,actor_json,fence_json,catalog_json,payload_json,period,state,operation_key,request_hash,claims_count,created_at) VALUES(?,?,?,1,1,?,?,?,?,'{"kind":"owner"}',?,?,?,?, 'published','owner-paid',?,1,100)`).bind(scope.installationId,scope.generation,a,anchor.fence.source.hash,key,hash,hash,JSON.stringify(anchor.fence),JSON.stringify([{kind:'project',id:'p',supports:[{id:b,text:'Private support BODY.'}]}]),'{"prompt":"Private support BODY."}',scope.period,hash),
  env.DB.prepare('INSERT INTO assistant_owner_canonical_supports VALUES(?,?,?,1,?,?,?,?)').bind(scope.installationId,scope.generation,a,key,hash,hash,JSON.stringify({schema:'owner-canonical-supports-v1',notes:[{fence:support.fence,conversation:null}]})),
  env.DB.prepare(`INSERT INTO assistant_relation_batches VALUES(?,?,?,?,?,1,1,?,'author',NULL,?)`).bind(scope.installationId,scope.generation,key,hash,a,anchor.fence.source.hash,JSON.stringify([{quote:'Private derived BODY.'}])),
  env.DB.prepare(`INSERT INTO assistant_owner_relation_proofs VALUES(?,?,?, ?,1,1,?,?,?,?,?,?,?,'owner')`).bind(scope.installationId,scope.generation,key,a,anchor.fence.source.hash,key,hash,hash,hash,hash,hash),
  env.DB.prepare(`INSERT INTO assistant_model_receipts VALUES(?,?,'owner-paid',?,?,1,?,'complete','{"private":"BODY"}',3,100)`).bind(scope.installationId,scope.generation,hash,a,hash),
 ]);
 const budget=new InferenceBudget(env.DB,scope);await budget.configure(100);await budget.reserve('owner-paid',hash,8);await budget.settle('owner-paid',hash,3);
 for(const profile of ['owner','interlocutor']){
  const id=(profile==='owner'?'c':'d').repeat(64);
  await env.DB.prepare(`INSERT INTO assistant_retrieval_runs(installation_id,generation,id,actor_json,request_json,request_hash,run_token,page_size,max_steps,max_evaluations,pack_json) VALUES(?,?,?,?, '{}',?,'token',1,1,1,?)`).bind(scope.installationId,scope.generation,id,JSON.stringify({kind:profile}),hash,JSON.stringify([{id:a}])).run();
  await env.DB.prepare(`INSERT INTO assistant_retrieval_items VALUES(?,?,?,?,?,1,1,'ready',NULL,NULL)`).bind(scope.installationId,scope.generation,id,a,hash).run();
  await env.DB.prepare(`INSERT INTO assistant_routine_items(installation_id,generation,source_epoch,source_generation,id,subject_json,binding_hash,binding_json,observation_key,actor_json,profile,source_id,source_revision,state,run_id,created_at,updated_at) VALUES(?,?,'epoch','capture',?,'{}',?,'{}',?,?,?, ?,1,'complete',?,100,100)`).bind(scope.installationId,scope.generation,profile,hash,profile,JSON.stringify({kind:profile}),profile,a,id).run();
  await env.DB.prepare(`INSERT INTO assistant_owner_canonical_status VALUES(?,?,'epoch','capture',?,?,1,?)`).bind(scope.installationId,scope.generation,profile,a,'{"private":"BODY"}').run();
 }
});
const rows=(table:string)=>env.DB.prepare(`SELECT * FROM ${table} WHERE installation_id=? AND generation=? ORDER BY rowid`).bind(scope.installationId,scope.generation).all().then(r=>r.results);
async function purge(id:string){await sources.withdraw(id,1);const service=new RetentionPurge(env.DB,scope,owner,()=>100,guard);for(let i=0;i<20;i++){const r=await service.advance({kind:'source.purge',operationId:'purge',sourceId:id});if(r.state!=='pending')return r;}throw Error('no_progress');}
test('support purge scrubs private copies but preserves active anchor latch, guest rows and paid truth',async()=>{
 const guestBefore=(await rows('assistant_retrieval_runs')).filter(r=>r.id==='d'.repeat(64)),money=await rows('assistant_budget_reservations');
 expect(await purge(b)).toMatchObject({state:'complete'});
 expect(await new SourceAccess(env.DB,scope).read(owner,a)).not.toBeNull();
 expect(await rows('assistant_canonical_extractions')).toMatchObject([{source_id:a,slot_key:key,pin_hash:hash,operation_key:'owner-paid',request_hash:hash,state:'rejected',gap:'canonical_context_purged',catalog_json:'[]',payload_json:'{}'}]);
 for(const t of ['assistant_owner_canonical_supports','assistant_owner_relation_proofs','assistant_relation_batches','assistant_model_receipts'])expect(await rows(t)).toEqual([]);
 expect(await rows('assistant_retrieval_runs')).toEqual(guestBefore);expect(await rows('assistant_routine_items')).toMatchObject([{id:'interlocutor',state:'complete',last_gap:null}]);
 expect(await rows('assistant_owner_canonical_status')).toMatchObject([{item_id:'interlocutor',body_json:'{"state":"blocked","gap":"canonical_context_purged"}'}]);
 expect(await rows('assistant_budget_reservations')).toEqual(money);
 await expect(env.DB.prepare(`INSERT INTO assistant_canonical_extractions SELECT * FROM assistant_canonical_extractions WHERE installation_id=?`).bind(scope.installationId).run()).rejects.toThrow();
});
test('support purge remains complete after proof loss and scrubs the retained catalog fallback',async()=>{
 await env.DB.prepare('DELETE FROM assistant_owner_relation_proofs WHERE installation_id=?').bind(scope.installationId).run();await env.DB.prepare('DELETE FROM assistant_owner_canonical_supports WHERE installation_id=?').bind(scope.installationId).run();
 expect(await purge(b)).toMatchObject({state:'complete'});expect(await rows('assistant_canonical_extractions')).toMatchObject([{state:'rejected',catalog_json:'[]',payload_json:'{}'}]);expect(await rows('assistant_relation_batches')).toEqual([]);
});
test('anchor purge removes sidecars before FK parents without touching independent support',async()=>{
 expect(await purge(a)).toMatchObject({state:'complete'});for(const t of ['assistant_owner_canonical_supports','assistant_owner_relation_proofs','assistant_owner_canonical_status','assistant_canonical_extractions'])expect(await rows(t)).toEqual([]);expect(await new SourceAccess(env.DB,scope).read(owner,b)).not.toBeNull();
});
test('zero-claim support purge keeps the terminal latch and removes response and private status without a relation batch',async()=>{
 await env.DB.prepare('DELETE FROM assistant_owner_relation_proofs WHERE installation_id=?').bind(scope.installationId).run();await env.DB.prepare('DELETE FROM assistant_relation_batches WHERE installation_id=?').bind(scope.installationId).run();
 await env.DB.prepare('UPDATE assistant_canonical_extractions SET claims_count=0 WHERE installation_id=?').bind(scope.installationId).run();
 expect(await purge(b)).toMatchObject({state:'complete'});expect(await rows('assistant_canonical_extractions')).toMatchObject([{source_id:a,slot_key:key,state:'rejected',gap:'canonical_context_purged'}]);expect(await rows('assistant_model_receipts')).toEqual([]);
});
test('support closure removes downstream Owner episode, decisions and secondary paid response while guest data survives',async()=>{
 const queue=new JobQueue(env.DB,scope),job=await queue.enqueue({kind:'reasoning',dedupeKey:'owner-context',sourceId:a,sourceRevision:1,request:'Private derived BODY.',runtime:'flue',subject:{kind:'owner_request',sourceId:a,sourceRevision:1,requestKey:'owner-context'}},100),ledger=(await queue.ledger(job.id))!;
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO assistant_episodes(installation_id,generation,id,job_id,episode_generation,request_hash,binding_hash,binding_json,profile,runtime_id,deadline,max_calls) VALUES(?,?,?, ?,1,?,?,?,'owner','runtime',1000,1)`).bind(scope.installationId,scope.generation,hash,job.id,ledger.request_hash,hash,JSON.stringify({runId:'c'.repeat(64),context:{sources:[{id:a}]}})),
  env.DB.prepare(`INSERT INTO assistant_episode_calls(installation_id,generation,episode_id,ordinal,payload_hash,token,operation_key,state) VALUES(?,?,?,1,?,'token','downstream-paid','complete')`).bind(scope.installationId,scope.generation,hash,hash),
  env.DB.prepare(`INSERT INTO assistant_model_receipts VALUES(?,?,'downstream-paid',?,?,1,?,'complete','{"private":"BODY"}',2,100)`).bind(scope.installationId,scope.generation,hash,a,hash),
  env.DB.prepare(`INSERT INTO assistant_shadow_decisions(installation_id,generation,id,job_id,request_hash,lease_generation,episode_id,outcome,dependencies_json,receipts_json,recorded_at) VALUES(?,?,?,?,?,1,?,'silence',?,'[]',100)`).bind(scope.installationId,scope.generation,hash,job.id,ledger.request_hash,hash,JSON.stringify([{id:a}])),
 ]);
 const budget=new InferenceBudget(env.DB,scope);await budget.reserve('downstream-paid',hash,8);await budget.settle('downstream-paid',hash,2);const money=await rows('assistant_budget_reservations');
 expect(await purge(b)).toMatchObject({state:'complete'});for(const t of ['assistant_episodes','assistant_episode_calls','assistant_jobs','assistant_job_ledger','assistant_decision_jobs','assistant_shadow_decisions','assistant_model_receipts'])expect(await rows(t)).toEqual([]);expect(await rows('assistant_budget_reservations')).toEqual(money);expect(await rows('assistant_retrieval_runs')).toMatchObject([{id:'d'.repeat(64)}]);
});
test('snapshot freeze prevents sidecar deletion and unauthorized scrub',async()=>{
 await env.DB.prepare(`INSERT INTO assistant_retention_installation_gate(installation_id,generation,state,token,operation_id,request_hash,started_at) VALUES(?,'g1','quiescing','token','snapshot','hash',100)`).bind(scope.installationId).run();
 await expect(env.DB.prepare('DELETE FROM assistant_owner_canonical_supports WHERE installation_id=?').bind(scope.installationId).run()).rejects.toThrow('canonical_writers_quiesced');
 await expect(env.DB.prepare(`UPDATE assistant_canonical_extractions SET state='rejected',gap='canonical_context_purged',catalog_json='[]',payload_json='{}' WHERE installation_id=?`).bind(scope.installationId).run()).rejects.toThrow('owner_context_slot_immutable');
});
test('missing all27 sidecars cannot masquerade as a legacy schema while private Owner slots remain',async()=>{
 await sources.withdraw(b,1);
 const db={prepare(query:string){const statement=env.DB.prepare(query);if(!query.includes("name GLOB 'assistant_*' LIMIT 129"))return statement;return {all:async()=>{const result=await statement.all<{name:string}>();return {...result,results:result.results.filter(r=>!['assistant_owner_canonical_supports','assistant_owner_relation_proofs','assistant_owner_canonical_status'].includes(r.name))};}} as D1PreparedStatement;},batch:env.DB.batch.bind(env.DB)} as D1Database;
 expect(await new RetentionPurge(db,scope,owner,()=>100,guard).advance({kind:'source.purge',operationId:'missing-schema',sourceId:b})).toMatchObject({state:'blocked',reason:'owner_context_schema_incomplete'});
 expect(await rows('assistant_canonical_extractions')).toMatchObject([{state:'published'}]);expect(await rows('assistant_source_versions')).toHaveLength(2);
});
test('full export retains Owner operational proofs while canonical restore catalog excludes them and health requires27',async()=>{
 const metadata=await new AssistantExport(env.DB,scope,owner,'canonical_snapshot_candidate').snapshotMetadata();
 for(const t of ['assistant_relation_batches','assistant_canonical_extractions','assistant_owner_canonical_supports','assistant_owner_relation_proofs','assistant_owner_canonical_status'])expect(metadata.tables).not.toContain(t);
 const parts=[];let cursor: string|undefined;do{const page=await new AssistantExport(env.DB,scope,owner).page(cursor?{cursor}:{});parts.push(...page.parts);cursor=page.nextCursor;}while(cursor);
 for(const t of ['assistant_owner_canonical_supports','assistant_owner_relation_proofs','assistant_owner_canonical_status'])expect(parts.some(p=>p.table===t)).toBe(true);
 const health=await installationHealth({DB:env.DB} as never);for(const feature of ['ownerContextSupports','ownerContextProofs','ownerContextStatus'])expect(health.schema.missingFeatures).not.toContain(feature);
});
