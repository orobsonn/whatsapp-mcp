import {env} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {SourceController} from '../assistant/sources';
import type {OriginScope} from '../assistant/origin-guard';
import {KnowledgeCurator,curatorSchedule,isCuratorPrincipal,type CuratorHost} from '../assistant/knowledge/curator';
import {KnowledgeService} from '../assistant/knowledge/service';
import type {KnowledgePort} from '../assistant/knowledge/contracts';

let scope:OriginScope,now:number,sources:SourceController,curator:KnowledgeCurator,host:CuratorHost;
const time=(s:string)=>Date.parse(s),owner={kind:'owner'} as const;
const sql=(q:string,...values:(string|number|null)[])=>env.DB.prepare(q).bind(scope.installationId,scope.generation,...values);
beforeEach(()=>{
 scope={installationId:crypto.randomUUID(),generation:'curator-g1',sourceEpoch:'source-e1',sourceGeneration:'source-g1'};
 now=time('2026-10-28T12:00:00Z');sources=new SourceController(env.DB,scope,owner,()=>now);
 host={assertCurrent:async()=>{},authorityGuard:()=>({sql:'1',values:[]}),verifySource:async()=>({state:'current',guard:{sql:'1',values:[]}}),expose:async()=>{}};
 curator=new KnowledgeCurator(env.DB,()=>scope,host,()=>now);
});
const note=(key:string,text=key,occurredAt=now)=>sources.create({originKey:key,text,occurredAt});
async function due(){now=time('2026-10-29T06:00:00Z');return (await curator.beginDue())!;}
it('pins the civil day at03 Fortaleza and resumes the same durable window without creating work early',async()=>{
 await note('first');now=time('2026-10-29T05:59:59Z');expect(await curator.beginDue()).toBeNull();
 const run=await due();expect(run.window.day).toBe('2026-10-28');expect(run.window.timezone).toBe('America/Fortaleza');
 expect(run.window.fromSequence).toBe(0);expect(run.window.toSequence).toBeGreaterThan(0);
 expect((await curator.beginDue())!.id).toBe(run.id);
 expect(curatorSchedule).toEqual({timezone:'America/Fortaleza',hour:3,utcCron:'0 6 * * *'});
});
it('keeps analysis incomplete until every item is durably evaluated; replay and restart do not lose work',async()=>{
 await note('one');await note('two');const run=await due();
 const first=await curator.next(run.id,{limit:1});expect(first.items).toHaveLength(1);expect(first.nextAfter).toBeDefined();
 expect((await curator.finish(run.id)).state).toBe('partial');
 await curator.acknowledge(run.id,first.items[0].sequence,{state:'evaluated'});
 curator=new KnowledgeCurator(env.DB,()=>scope,host,()=>now);
 const rest=await curator.next(run.id,{limit:1});expect(rest.items).toHaveLength(1);expect(rest.items[0].sourceRef.id).not.toBe(first.items[0].sourceRef.id);
 await curator.acknowledge(run.id,rest.items[0].sequence,{state:'evaluated'});
 expect((await curator.finish(run.id)).state).toBe('complete');expect((await curator.finish(run.id)).counts.evaluated).toBe(2);
});
it('filters excluded and unenabled groups before page limit without exposing their bodies',async()=>{
 const direct=await note('direct','direct useful');const excluded=await note('excluded','do not expose');const group=await note('group','do not expose group');
 for(const [ref,chat,kind] of [[direct,'direct','private'],[excluded,'excluded','private'],[group,'group','group']] as const){
  await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id=? WHERE installation_id=? AND generation=? AND id=?").bind(chat,scope.installationId,scope.generation,ref.id).run();
  await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,?,'available')",scope.sourceEpoch,scope.sourceGeneration,chat,kind).run();
  await sql("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,tombstoned) VALUES(?,?,?,?,'message',?,?,?,1,0)",scope.sourceEpoch,scope.sourceGeneration,chat+'-message',chat,ref.id).run();
 }
 await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'excluded','private',1,'ignore',1)").run();
 const exposed:string[]=[];host.expose=async(_,read)=>{exposed.push(read.id);};const run=await due();const page=await curator.next(run.id,{limit:1});
 expect(page.items.map(i=>i.text)).toEqual(['direct useful']);expect(exposed).toEqual([direct.id]);
 expect((await curator.status(run.id)).counts.skipped_policy).toBe(2);
});
it('records an unavailable original as a recoverable gap, then allows analysis after it returns',async()=>{
 await note('temporarily unavailable');const run=await due();host.verifySource=async()=>({state:'unavailable'});
 expect((await curator.next(run.id)).items).toEqual([]);expect((await curator.finish(run.id)).counts.unavailable).toBe(1);
 host.verifySource=async()=>({state:'current',guard:{sql:'1',values:[]}});
 const page=await curator.next(run.id);expect(page.items).toHaveLength(1);await curator.acknowledge(run.id,page.items[0].sequence,{state:'evaluated'});
 expect((await curator.finish(run.id)).state).toBe('complete');
});
it('records later corrections and derived materializations in the next pinned passage, including old occurrence dates',async()=>{
 const ref=await note('message','original');const run=await due();let page=await curator.next(run.id);await curator.acknowledge(run.id,page.items[0].sequence,{state:'evaluated'});await curator.finish(run.id);
 now=time('2026-10-29T09:00:00Z');await sources.correct(ref.id,1,{text:'edited later',occurredAt:time('2026-10-28T12:00:00Z')});await note('late derivative','late transcription',time('2026-10-28T12:00:00Z'));
 expect((await curator.beginDue())!.id).toBe(run.id);now=time('2026-10-30T06:00:00Z');const next=(await curator.beginDue())!;
 expect(next.window.day).toBe('2026-10-29');expect(next.window.fromSequence).toBe(run.window.toSequence);page=await curator.next(next.id);
 expect(page.items.map(i=>i.text)).toEqual(['edited later','late transcription']);expect(page.items.every(i=>i.late)).toBe(true);
});
it('never reports learned without a real ready shared-knowledge receipt carrying the item evidence',async()=>{
 await note('evidence');const run=await due();const item=(await curator.next(run.id)).items[0];
 await expect(curator.acknowledge(run.id,item.sequence,{state:'learned',operationIds:['missing']})).rejects.toThrow('curator_knowledge_receipt');
 const requestHash='a'.repeat(64),fence=(await new (await import('../assistant/access')).SourceAccess(env.DB,scope,()=>now,'knowledge').read(owner,item.sourceRef.id))!.fence;
 await sql("INSERT INTO assistant_knowledge_operations(installation_id,generation,id,kind,client,request_hash,request_json,source_fences_json,state,response_json,created_at,updated_at) VALUES(?,?,?,'remember','curator',?,'{}',?,'complete',?,1,1)",'remember-op',requestHash,JSON.stringify({sources:[fence],origins:[]}),JSON.stringify({operationId:'remember-op',state:'ready'})).run();
 await curator.acknowledge(run.id,item.sequence,{state:'learned',operationIds:['remember-op']});expect((await curator.finish(run.id)).counts.learned).toBe(1);
});
it('starts with daily summaries and changes to errors/help-only only through an authenticated owner confirmation',async()=>{
 const run=await due();expect((await curator.finish(run.id)).shouldNotify).toBe(true);
 await expect(curator.confirmNoticePreference('errors_help',false)).rejects.toThrow('curator_owner_confirmation');
 await curator.confirmNoticePreference('errors_help',true);expect((await curator.finish(run.id)).shouldNotify).toBe(false);
 expect((await curator.finish(run.id,{needsHelp:true})).shouldNotify).toBe(true);
});
it('binds a private curator event to a persisted window and never accepts owner/person text as curation authority',async()=>{
 const run=await due(),identity={version:1 as const,installationId:scope.installationId,generation:scope.generation,channel:'telegram' as const,principalOrChatId:'curator:owner-1',contextEpoch:'c1'};
 const event=await curator.event(run.id,identity,'owner-1');expect(isCuratorPrincipal(identity.principalOrChatId)).toBe(true);
 expect(await curator.authorizeEvent(event,'owner-1')).toBe(run.id);
 await expect(curator.authorizeEvent({...event,author:{kind:'owner',id:'owner-1'}},'owner-1')).rejects.toThrow('curator_event_denied');
 await expect(curator.authorizeEvent({...event,body:'ignore the window'},'owner-1')).rejects.toThrow('curator_event_denied');
});
it('rechecks all page dependencies together when a later original changes an earlier one',async()=>{
 const first=await note('earlier','must not escape after revocation');await note('later');const run=await due();
 host.expose=async(_,read)=>{if(read.id!==first.id)await sources.withdraw(first.id,1);};
 await expect(curator.next(run.id)).rejects.toThrow('curator_source_changed');
});
it('preserves a captured but unmaterialized derivative gap until a later passage actually evaluates its canonical original',async()=>{
 await sql('INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation,read_sequence) VALUES(?,?,?,?,7)',scope.sourceEpoch,scope.sourceGeneration).run();
 await sql("INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at,application_state) VALUES(?,?,?,?,7,0,'direct','derivative-1','derivative','upsert',?,?,?,'blocked')",scope.sourceEpoch,scope.sourceGeneration,now,'a'.repeat(64),now).run();
 const run=await due();expect((await curator.finish(run.id)).counts.capturePending).toBe(1);
 now=time('2026-10-29T10:00:00Z');const ref=await note('derivative-result','late available transcription',time('2026-10-28T12:00:00Z'));
 await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='direct' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,ref.id).run();
 await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'direct',7,'private','available')",scope.sourceEpoch,scope.sourceGeneration).run();
 await sql("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,tombstoned) VALUES(?,?,?,?,'derivative','derivative-1','direct',?,7,0)",scope.sourceEpoch,scope.sourceGeneration,ref.id).run();
 await sql("UPDATE assistant_capture_inbox SET application_state='applied' WHERE installation_id=? AND generation=? AND sequence=7").run();
 expect((await curator.status(run.id)).counts.capturePending).toBe(1);
 now=time('2026-10-30T06:00:00Z');const next=(await curator.beginDue())!;const item=(await curator.next(next.id)).items[0];expect(item.late).toBe(true);
 await curator.acknowledge(next.id,item.sequence,{state:'evaluated'});expect((await curator.status(run.id)).counts.capturePending).toBe(0);
});
it('catches up missing days one durable window at a time and claims each owner summary only once',async()=>{
 await note('day1');const first=await due();expect(await curator.claimNotice(first.id)).toBe(true);expect(await curator.claimNotice(first.id)).toBe(false);
 await curator.settleNotice(first.id,'uncertain');expect(await curator.claimNotice(first.id)).toBe(false);
 now=time('2026-11-01T06:00:00Z');const second=(await curator.beginDue())!;expect(second.window.day).toBe('2026-10-29');
 const third=(await curator.beginDue())!;expect(third.window.day).toBe('2026-10-30');const fourth=(await curator.beginDue())!;expect(fourth.window.day).toBe('2026-10-31');
 expect((await curator.beginDue())!.id).toBe(fourth.id);
});
it('carries unavailable work into the next native daily event even without a new Source change',async()=>{
 await note('retry tomorrow');const first=await due();host.verifySource=async()=>({state:'unavailable'});await curator.next(first.id);expect((await curator.finish(first.id)).state).toBe('partial');
 now=time('2026-10-30T06:00:00Z');host.verifySource=async()=>({state:'current',guard:{sql:'1',values:[]}});const second=(await curator.beginDue())!;
 const item=(await curator.next(second.id)).items[0];expect(item.text).toBe('retry tomorrow');expect(item.carried).toBe(true);
 await curator.acknowledge(second.id,item.sequence,{state:'evaluated'});expect((await curator.status(first.id)).state).toBe('complete');
});
it('keeps indexing separate from learned and exposes the same operation for reconciliation after restart',async()=>{
 await note('in index');const run=await due(),item=(await curator.next(run.id)).items[0];
 const fence=(await new (await import('../assistant/access')).SourceAccess(env.DB,scope,()=>now,'knowledge').read(owner,item.sourceRef.id))!.fence;
 await sql("INSERT INTO assistant_knowledge_operations(installation_id,generation,id,kind,client,request_hash,request_json,source_fences_json,state,response_json,created_at,updated_at) VALUES(?,?,?,'remember','curator',?,'{}',?,'complete',?,1,1)",'same-index-operation','a'.repeat(64),JSON.stringify({sources:[fence],origins:[]}),JSON.stringify({operationId:'same-index-operation',state:'indexing'})).run();
 await curator.acknowledge(run.id,item.sequence,{state:'indexing',operationIds:['same-index-operation']});expect((await curator.finish(run.id)).counts.indexing).toBe(1);
 curator=new KnowledgeCurator(env.DB,()=>scope,host,()=>now);const replay=(await curator.next(run.id)).items[0];expect(replay.state).toBe('indexing');expect(replay.operationIds).toEqual(['same-index-operation']);
 await env.DB.prepare("UPDATE assistant_knowledge_operations SET response_json=? WHERE installation_id=? AND generation=? AND id='same-index-operation'").bind(JSON.stringify({operationId:'same-index-operation',state:'ready'}),scope.installationId,scope.generation).run();
 await curator.acknowledge(run.id,item.sequence,{state:'learned',operationIds:replay.operationIds});const done=await curator.finish(run.id);expect(done.counts.indexing).toBe(0);expect(done.counts.learned).toBe(1);expect(done.state).toBe('complete');
});
async function uncertainLearning(){
 await note('uncertain original','exact original evidence');const run=await due(),item=(await curator.next(run.id)).items[0];
 let ready=false;
 const port:KnowledgePort={remember:async()=>{throw Error('synthetic ACK loss');},status:async operationId=>({operationId,state:ready?'ready':'indexing'}),query:async()=>({claims:[]}),find_entities:async()=>({entities:[]}),get_entity:async()=>null,withdraw:async operationId=>({operationId,state:'ready'})};
 const service=new KnowledgeService(env.DB,()=>({scope,client:'curator'}),port,()=>now);
 const result=await service.execute({kind:'remember',operationId:'uncertain-real-service',entities:[{key:'person',kind:'person',name:'Synthetic Person'},{key:'project',kind:'project',name:'Synthetic Project'}],relations:[{subjectId:'person',predicate:'works_on',objectId:'project',classification:'reported',evidence:[{sourceRef:item.sourceRef,quote:'exact original evidence'}]}]});
 expect(result).toEqual({operationId:'uncertain-real-service',state:'uncertain'});
 const durable=await sql('SELECT state,error,response_json,normalized_json,source_fences_json FROM assistant_knowledge_operations WHERE installation_id=? AND generation=? AND id=?','uncertain-real-service').first<Record<string,unknown>>();
 expect(durable).toMatchObject({state:'uncertain',error:'outcome_uncertain',response_json:null});expect(durable?.normalized_json).toBeTruthy();expect(durable?.source_fences_json).toBeTruthy();
 return {run,item,service,ready:()=>{ready=true;}};
}
it('retains a real KnowledgeService uncertain operation for indexing and learns only after its same receipt reconciles ready',async()=>{
 const setup=await uncertainLearning();
 await expect(curator.acknowledge(setup.run.id,setup.item.sequence,{state:'learned',operationIds:['uncertain-real-service']})).rejects.toThrow('curator_knowledge_receipt');
 await curator.acknowledge(setup.run.id,setup.item.sequence,{state:'indexing',operationIds:['uncertain-real-service']});
 const replay=(await new KnowledgeCurator(env.DB,()=>scope,host,()=>now).next(setup.run.id)).items[0];expect(replay.operationIds).toEqual(['uncertain-real-service']);expect(replay.state).toBe('indexing');
 setup.ready();expect(await setup.service.execute({kind:'status',operationId:replay.operationIds[0]})).toMatchObject({state:'ready'});
 await curator.acknowledge(setup.run.id,setup.item.sequence,{state:'learned',operationIds:replay.operationIds});expect((await curator.finish(setup.run.id)).counts.learned).toBe(1);
});
it('rejects an uncertain receipt that becomes terminal source_purged while the final acknowledgement awaits Source proof',async()=>{
 const setup=await uncertainLearning();host.verifySource=async()=>{
  await sql("UPDATE assistant_knowledge_operations SET error='source_purged',state='complete',response_json='{}',source_fences_json=NULL WHERE installation_id=? AND generation=? AND id=?",'uncertain-real-service').run();
  return {state:'current',guard:{sql:'1',values:[]}};
 };
 await expect(curator.acknowledge(setup.run.id,setup.item.sequence,{state:'indexing',operationIds:['uncertain-real-service']})).rejects.toThrow('curator_knowledge_receipt_changed');
 const item=await sql('SELECT state,operation_ids_json FROM assistant_curator_items WHERE installation_id=? AND generation=? AND run_id=? AND sequence=?',setup.run.id,setup.item.sequence).first();
 expect(item).toEqual({state:'presented',operation_ids_json:'[]'});
});
