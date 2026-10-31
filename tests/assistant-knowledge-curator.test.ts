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
 host={assertCurrent:async()=>{},authorityGuard:()=>({sql:'1',values:[]}),verifySource:async()=>({state:'current',guard:{sql:'1',values:[]}}),exposePage:async()=>{}};
 curator=new KnowledgeCurator(env.DB,()=>scope,host,()=>now);
});
const note=(key:string,text=key,occurredAt=now)=>sources.create({originKey:key,text,occurredAt});
async function due(){now=time('2026-10-29T06:00:00Z');return (await curator.beginDue())!;}
const head=async()=>await sql('SELECT COALESCE(MAX(sequence),0) head FROM assistant_source_changes WHERE installation_id=? AND generation=?').first<number>('head')??0;
const sampleWindow=(fromSequence:number,toSequence:number,day='2026-10-28')=>({fromSequence,toSequence,day,timezone:'America/Fortaleza' as const});
it('acknowledges a page with constant context checks and explicit per-item refusals',async()=>{
 for(let i=0;i<50;i++)await note('ack page '+i);
 const run=await due(),page=await curator.next(run.id,{limit:100});let checks=0;host.assertCurrent=async()=>{checks++;};
 const items=page.items.map((item,i)=>({sequence:item.sequence,state:i===20?'learned' as const:'evaluated' as const,operationIds:i===20?['missing-receipt']:[]}));
 const result=await curator.acknowledgePage(run.id,items);
 expect(checks).toBe(2);expect(result.items.filter(i=>i.outcome==='recorded')).toHaveLength(49);
 expect(result.items[20]).toMatchObject({sequence:page.items[20].sequence,outcome:'refused',reason:'curator_knowledge_receipt'});
 expect((await curator.status(run.id)).counts).toMatchObject({evaluated:49,presented:1,learned:0});
 checks=0;await expect(curator.acknowledgePage(run.id,[items[0],items[0]])).rejects.toThrow('curator_acknowledgement_page');expect(checks).toBe(0);
 await expect(curator.acknowledge(run.id,items[0].sequence,{sequence:items[1].sequence,state:'evaluated'} as never)).rejects.toThrow();
});
it('does not let a page acknowledgement overwrite a concurrently reflected learning receipt',async()=>{
 await note('concurrent learned evidence');const run=await due(),item=(await curator.next(run.id)).items[0];
 const fence=(await new (await import('../assistant/access')).SourceAccess(env.DB,scope,()=>now,'knowledge').read(owner,item.sourceRef.id))!.fence;
 await sql("INSERT INTO assistant_knowledge_operations(installation_id,generation,id,kind,client,request_hash,request_json,source_fences_json,state,response_json,created_at,updated_at) VALUES(?,?,?,'remember','curator',?,'{}',?,'complete',?,1,1)",'page-learn-op','a'.repeat(64),JSON.stringify({sources:[fence],origins:[]}),JSON.stringify({operationId:'page-learn-op',state:'ready'})).run();
 let reflected=false;host.verifySource=async()=>{if(!reflected){reflected=true;expect((await curator.reflectReady(run.id,'page-learn-op')).learned).toBe(1);}return {state:'current',guard:{sql:'1',values:[]}};};
 const result=await curator.acknowledgePage(run.id,[{sequence:item.sequence,state:'evaluated'}]);
 expect(result.items[0].outcome).toBe('refused');expect((await curator.status(run.id)).counts.learned).toBe(1);
});
it('cancels a page acknowledgement before any item is recorded',async()=>{
 await note('cancel first');await note('cancel last');const run=await due(),page=await curator.next(run.id),controller=new AbortController();let checks=0;
 host.verifySource=async()=>{if(++checks===2)controller.abort(new Error('ack_page_cancelled'));return {state:'current',guard:{sql:'1',values:[]}};};
 await expect(curator.acknowledgePage(run.id,page.items.map(item=>({sequence:item.sequence,state:'evaluated'})),controller.signal)).rejects.toThrow('ack_page_cancelled');
 expect((await curator.status(run.id)).counts).toMatchObject({presented:2,evaluated:0});
});
it('checks the global authority for every acknowledgement when the first source is revoked during the last proof',async()=>{
 const first=await note('first page authority');await note('last page authority');const run=await due(),page=await curator.next(run.id);
 const access=new (await import('../assistant/access')).SourceAccess(env.DB,scope,()=>now,'knowledge'),fence=(await access.read(owner,first.id))!.fence;
 host.authorityGuard=()=>access.guard(owner,fence,now);
 host.verifySource=async read=>{if(read.id!==first.id)await sources.withdraw(first.id,1);return {state:'current',guard:{sql:'1',values:[]}};};
 const result=await curator.acknowledgePage(run.id,page.items.map(item=>({sequence:item.sequence,state:'evaluated'})));
 expect(result.items.every(item=>item.outcome==='refused')).toBe(true);
 expect(await sql("SELECT count(*) n FROM assistant_curator_items WHERE installation_id=? AND generation=? AND run_id=? AND state='evaluated'",run.id).first('n')).toBe(0);
});
it('registers an authorized page once before publication without rechecking the entire context per original',async()=>{
 for(let i=0;i<100;i++)await note('page evidence '+i);
 const run=await due();let pages=0,assertions=0;
 host.assertCurrent=async()=>{assertions++;};
 Object.assign(host,{exposePage:async(_runId:string,reads:{id:string}[])=>{
  pages++;expect(reads).toHaveLength(100);
  expect(await sql("SELECT count(*) n FROM assistant_curator_items WHERE installation_id=? AND generation=? AND run_id=? AND state='presented'",run.id).first('n')).toBe(0);
 }});
 const page=await curator.next(run.id,{limit:100});
 expect(page.items).toHaveLength(100);expect(pages).toBe(1);expect(assertions).toBe(2);
});
it('stops a cancelled curator page before exposing further originals or marking them presented',async()=>{
 await note('first cancellation evidence');await note('second cancellation evidence');const run=await due(),controller=new AbortController();
 const exposed:string[]=[];let verified=0;
 host.verifySource=async()=>{verified++;controller.abort(new Error('curator_cancelled'));return {state:'current',guard:{sql:'1',values:[]}};};
 host.exposePage=async(_,reads)=>{exposed.push(...reads.map(read=>read.id));};
 await expect(curator.next(run.id,{limit:100},controller.signal)).rejects.toThrow('curator_cancelled');
 expect(verified).toBe(1);expect(exposed).toHaveLength(0);
 expect((await curator.status(run.id)).counts).toMatchObject({pending:2,presented:0,evaluated:0});
 const alreadyAborted=AbortSignal.abort(new Error('cancelled_before_page'));
 await expect(curator.next(run.id,{},alreadyAborted)).rejects.toThrow('cancelled_before_page');
 expect(verified).toBe(1);expect(exposed).toHaveLength(0);
 // A later explicit call may still read the unacknowledged originals.
 host.verifySource=async()=>({state:'current',guard:{sql:'1',values:[]}});host.exposePage=async()=>{};expect((await curator.next(run.id)).items).toHaveLength(2);
});
it('samples only the requested canonical range without touching the daily cursor, backlog or capture gaps',async()=>{
 await note('outside before');const from=await head();await note('inside','explicit sample evidence');const to=await head();await note('outside after');
 const run=await curator.beginSample({operationId:'sample-explicit-range',window:sampleWindow(from,to)});
 expect(run).toMatchObject({kind:'sample',window:sampleWindow(from,to),coverage:{scope:'sample_window',archive:'not_exhaustive'}});
 expect((await curator.next(run.id)).items.map(i=>i.text)).toEqual(['explicit sample evidence']);
 expect(await sql('SELECT COUNT(*) n FROM assistant_curator_state WHERE installation_id=? AND generation=?').first('n')).toBe(0);
 expect(await sql('SELECT COUNT(*) n FROM assistant_curator_capture_gaps WHERE installation_id=? AND generation=?').first('n')).toBe(0);
 const daily=await due();expect(daily.kind).toBe('daily');expect(daily.window.fromSequence).toBe(0);expect((await curator.next(daily.id)).items).toHaveLength(3);
});
it('replays the same sample operation and actual creation instant, rejects changed arguments and invalid day/head before mutation',async()=>{
 const from=await head();await note('one');const to=await head(),request={operationId:'sample-stable-operation',window:sampleWindow(from,to)},created=now;
 const first=await curator.beginSample(request),identity={version:1 as const,installationId:scope.installationId,generation:scope.generation,channel:'telegram' as const,principalOrChatId:'curator:owner',contextEpoch:'epoch'};
 await curator.bindSampleIdentity(first.id,identity);const event=await curator.event(first.id,identity,'owner');expect(event.occurredAt).toBe(created);expect(JSON.parse(event.body)).toMatchObject({type:'sample_curator',run:{kind:'sample'}});
 now+=9000;expect(await curator.beginSample(request)).toEqual(first);expect(await curator.event(first.id,identity,'owner')).toEqual(event);
 await expect(curator.beginSample({...request,window:sampleWindow(to,to)})).rejects.toThrow('curator_sample_conflict');
 await expect(curator.beginSample({operationId:'future-head',window:sampleWindow(from,to+1)})).rejects.toThrow('curator_sample_window');
 await expect(curator.beginSample({operationId:'invalid-day',window:sampleWindow(from,to,'2026-02-30')})).rejects.toThrow();
 expect(await sql('SELECT COUNT(*) n FROM assistant_curator_runs WHERE installation_id=? AND generation=?').first('n')).toBe(1);
 const foreignScope={...scope,installationId:crypto.randomUUID()},foreign=new KnowledgeCurator(env.DB,()=>foreignScope,host,()=>now);
 await expect(foreign.beginSample({operationId:'foreign-head',window:sampleWindow(from,to)})).rejects.toThrow('curator_sample_window');
 scope={...scope,sourceGeneration:'replaced'};await expect(curator.beginSample(request)).rejects.toThrow('curator_run_denied');
});
it('never lets sample evaluation finish a daily pending item or suppress its next-day carry',async()=>{
 const from=await head();await note('daily pending');const to=await head(),daily=await due();host.verifySource=async()=>({state:'unavailable'});await curator.next(daily.id);
 host.verifySource=async()=>({state:'current',guard:{sql:'1',values:[]}});const sample=await curator.beginSample({operationId:'sample-not-daily',window:sampleWindow(from,to)}),item=(await curator.next(sample.id)).items[0];
 await curator.acknowledge(sample.id,item.sequence,{state:'evaluated'});expect((await curator.status(daily.id)).counts.unavailable).toBe(1);
 now=time('2026-10-30T06:00:00Z');const later=(await curator.beginDue())!;expect((await curator.next(later.id)).items.map(i=>i.text)).toEqual(['daily pending']);
});
it('never lets a daily evaluation finish sample pending work and never carries sample-only pending work into a later daily run',async()=>{
 const from=await head();await note('sample pending');const to=await head(),sample=await curator.beginSample({operationId:'sample-private-pending',window:sampleWindow(from,to)});
 host.verifySource=async()=>({state:'unavailable'});await curator.next(sample.id);host.verifySource=async()=>({state:'current',guard:{sql:'1',values:[]}});
 const daily=await due(),item=(await curator.next(daily.id)).items[0];await curator.acknowledge(daily.id,item.sequence,{state:'evaluated'});
 expect((await curator.status(sample.id)).counts.unavailable).toBe(1);now=time('2026-10-30T06:00:00Z');const later=(await curator.beginDue())!;expect((await curator.next(later.id)).items).toEqual([]);
});
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
 const exposed:string[]=[];host.exposePage=async(_,reads)=>{exposed.push(...reads.map(read=>read.id));};const run=await due();const page=await curator.next(run.id,{limit:1});
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
 expect((await curator.finish(run.id,{needsHelp:true,helpRequest:'Qual identidade corresponde a Nora?'})).shouldNotify).toBe(true);
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
 host.exposePage=async(_,reads)=>{if(reads.some(read=>read.id!==first.id))await sources.withdraw(first.id,1);};
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
 const input={entities:[{key:'person',kind:'person',name:'Synthetic Person'},{key:'project',kind:'project',name:'Synthetic Project'}],relations:[{subjectId:'person',predicate:'works_on',objectId:'project',classification:'reported',evidence:[{sourceRef:item.sourceRef,quote:'exact original evidence'}]}]};
 await curator.recordLearning(run.id,'uncertain-real-service',input as Parameters<KnowledgeCurator['recordLearning']>[2]);
 const result=await service.execute({kind:'remember',operationId:'uncertain-real-service',...input} as Parameters<KnowledgeService['execute']>[0]);
 expect((await curator.decisions(run.id)).items[0]).toMatchObject({state:'presented',operationIds:['uncertain-real-service'],decision:{category:'learn'}});
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
async function readyLearning(client:'curator'|'owner_mcp'='curator',outsideWindow=false){
 await note('reflect source','Original evidence for learning.');const run=await due(),item=(await curator.next(run.id)).items[0];
 let ref=item.sourceRef;
 if(outsideWindow){const other=await note('outside reflection','Original evidence for learning.');const read=(await new (await import('../assistant/access')).SourceAccess(env.DB,scope,()=>now,'knowledge').read(owner,other.id))!;ref={id:read.id,revision:read.fence.source.revision,version:read.fence.source.version,hash:read.fence.source.hash};}
 const operationId='conversation-knowledge-v1-'+ 'a'.repeat(30)+'596'+'b'.repeat(31),calls:{id:string}[]=[];
 const port:KnowledgePort={remember:async id=>{calls.push({id});return {operationId:id,state:'ready'};},status:async id=>({operationId:id,state:'ready'}),query:async()=>({claims:[]}),find_entities:async()=>({entities:[]}),get_entity:async()=>null,withdraw:async id=>({operationId:id,state:'ready'})};
 const service=new KnowledgeService(env.DB,()=>({scope,client}),port,()=>now);
 expect(await service.execute({kind:'remember',operationId,entities:[{key:'person',kind:'person',name:'Synthetic Person'},{key:'project',kind:'project',name:'Synthetic Project'}],relations:[{subjectId:'person',predicate:'works_on',objectId:'project',classification:'reported',evidence:[{sourceRef:ref,quote:'Original evidence for learning.'}]}]})).toMatchObject({state:'ready',operationId});
 return {run,item,operationId,calls};
}
it('reflects the original host ready receipt after a model mangles its opaque id, without another knowledge write',async()=>{
 const setup=await readyLearning(),mangled=setup.operationId.replace('596','');
 const operation=await sql('SELECT request_json FROM assistant_knowledge_operations WHERE installation_id=? AND generation=? AND id=?',setup.operationId).first<string>('request_json');
 const {kind:_,operationId:__,...input}=JSON.parse(operation!);await curator.recordLearning(setup.run.id,setup.operationId,input);
 await expect(curator.acknowledge(setup.run.id,setup.item.sequence,{state:'learned',operationIds:[mangled]})).rejects.toThrow('curator_knowledge_receipt');
 expect(await curator.reflectReady(setup.run.id,setup.operationId)).toMatchObject({state:'reflected',learned:1,pending:0});
 expect((await curator.status(setup.run.id)).counts.learned).toBe(1);expect(setup.calls).toHaveLength(1);
 const second='second-real-operation';const port:KnowledgePort={remember:async id=>({operationId:id,state:'ready'}),status:async id=>({operationId:id,state:'ready'}),query:async()=>({claims:[]}),find_entities:async()=>({entities:[]}),get_entity:async()=>null,withdraw:async id=>({operationId:id,state:'ready'})};
 await curator.recordLearning(setup.run.id,second,input);
 const service=new KnowledgeService(env.DB,()=>({scope,client:'curator'}),port,()=>now);await service.execute({...input,kind:'remember',operationId:second});
 await curator.reflectReady(setup.run.id,second);
 expect((await curator.decisions(setup.run.id)).items[0].operationIds.sort()).toEqual([setup.operationId,second].sort());
 expect(await sql('SELECT operation_ids_json FROM assistant_curator_items WHERE installation_id=? AND generation=? AND run_id=?',setup.run.id).first('operation_ids_json')).toBe(JSON.stringify([setup.operationId,'second-real-operation']));
});
it('does not reflect a different client receipt',async()=>{
 const wrong=await readyLearning('owner_mcp');await expect(curator.reflectReady(wrong.run.id,wrong.operationId)).rejects.toThrow('curator_knowledge_receipt');
 expect((await curator.status(wrong.run.id)).counts.presented).toBe(1);
});
it('does not reflect an original outside the pinned window',async()=>{
 const outside=await readyLearning('curator',true);expect(await curator.reflectReady(outside.run.id,outside.operationId)).toMatchObject({learned:0,pending:0});
 expect((await curator.status(outside.run.id)).counts.presented).toBeGreaterThan(0);
});
it('reflects indexing to ready only after genuine reconciliation',async()=>{
 const setup=await uncertainLearning();await curator.acknowledge(setup.run.id,setup.item.sequence,{state:'indexing',operationIds:['uncertain-real-service']});
 await expect(curator.reflectReady(setup.run.id,'uncertain-real-service')).rejects.toThrow('curator_knowledge_receipt');
 setup.ready();await setup.service.execute({kind:'status',operationId:'uncertain-real-service'});
 expect(await curator.reflectReady(setup.run.id,'uncertain-real-service')).toMatchObject({state:'reflected',learned:1,pending:0});
 expect((await curator.decisions(setup.run.id)).items[0]).toMatchObject({state:'learned',operationIds:['uncertain-real-service'],decision:{category:'learn'}});
});
it('keeps reflection pending after original evidence is revoked',async()=>{
 const revoked=await readyLearning();await sources.withdraw(revoked.item.sourceRef.id,revoked.item.sourceRef.revision);
 expect(await curator.reflectReady(revoked.run.id,revoked.operationId)).toMatchObject({state:'pending',learned:0,pending:1});
 expect((await sql('SELECT state FROM assistant_knowledge_operations WHERE installation_id=? AND generation=? AND id=?',revoked.operationId).first('state'))).toBe('complete');
});
it('reconciles an existing ready write after a mangled bookkeeping id without another memory write or daily cursor change',async()=>{
 const from=await head();await note('recover sample','Original evidence for learning.');const to=await head(),run=await curator.beginSample({operationId:'recover-existing-ready',window:sampleWindow(from,to)}),item=(await curator.next(run.id)).items[0];
 let writes=0;const operationId='conversation-knowledge-v1-'+ 'a'.repeat(30)+'596'+'b'.repeat(31),service=new KnowledgeService(env.DB,()=>({scope,client:'curator'}),{remember:async id=>{writes++;return {operationId:id,state:'ready'};},status:async id=>({operationId:id,state:'ready'}),query:async()=>({claims:[]}),find_entities:async()=>({entities:[]}),get_entity:async()=>null,withdraw:async id=>({operationId:id,state:'ready'})},()=>now);
 await service.execute({kind:'remember',operationId,entities:[{key:'person',kind:'person',name:'Synthetic Person'},{key:'project',kind:'project',name:'Synthetic Project'}],relations:[{subjectId:'person',predicate:'works_on',objectId:'project',classification:'reported',evidence:[{sourceRef:item.sourceRef,quote:'Original evidence for learning.'}]}]});
 await expect(curator.acknowledge(run.id,item.sequence,{state:'learned',operationIds:[operationId.replace('596','')]})).rejects.toThrow('curator_knowledge_receipt');
 expect(await curator.reconcileReady(run.id)).toMatchObject({state:'reflected',learned:1,pending:0});expect(await curator.reconcileReady(run.id)).toMatchObject({state:'reflected',learned:0,pending:0});
 expect((await curator.finish(run.id)).state).toBe('complete');expect(writes).toBe(1);expect(await sql('SELECT COUNT(*) n FROM assistant_curator_state WHERE installation_id=? AND generation=?').first('n')).toBe(0);
});
it('does not recover a ready receipt which predates the current passage',async()=>{
 const source=await note('older learning','Original evidence for learning.'),read=(await new (await import('../assistant/access')).SourceAccess(env.DB,scope,()=>now,'knowledge').read(owner,source.id))!,ref={id:read.id,revision:read.fence.source.revision,version:read.fence.source.version,hash:read.fence.source.hash};
 const service=new KnowledgeService(env.DB,()=>({scope,client:'curator'}),{remember:async operationId=>({operationId,state:'ready'}),status:async operationId=>({operationId,state:'ready'}),query:async()=>({claims:[]}),find_entities:async()=>({entities:[]}),get_entity:async()=>null,withdraw:async operationId=>({operationId,state:'ready'})},()=>now);
 await service.execute({kind:'remember',operationId:'before-current-passage',entities:[{key:'person',kind:'person',name:'Synthetic Person'},{key:'project',kind:'project',name:'Synthetic Project'}],relations:[{subjectId:'person',predicate:'works_on',objectId:'project',classification:'reported',evidence:[{sourceRef:ref,quote:'Original evidence for learning.'}]}]});
 const run=await due();await curator.next(run.id);expect(await curator.reconcileReady(run.id)).toMatchObject({learned:0,pending:0});expect((await curator.status(run.id)).counts.presented).toBe(1);
});

it('records semantic decisions only with an accepted exact-source acknowledgement and hides withdrawn details',async()=>{
 const source=await note('decision-log-source','Conversa passageira');const run=await due(),item=(await curator.next(run.id)).items[0];
 const decision={category:'not_useful' as const,summary:'Cumprimento de Nora',reason:'Não contém informação duradoura.'};
 const result=await curator.acknowledgePage(run.id,[{sequence:item.sequence,state:'evaluated',decision},{sequence:item.sequence+99,state:'evaluated',decision}]);
 expect(result).toMatchObject({recorded:1,refused:1});
 let log=await curator.decisions(run.id);expect(log.items).toHaveLength(1);expect(log.items[0]).toMatchObject({sequence:item.sequence,state:'evaluated',decision,sourceRef:item.sourceRef});
 await sources.withdraw(source.id,1);log=await curator.decisions(run.id);expect(log.items).toHaveLength(0);
 expect(await sql('SELECT COUNT(*) n FROM assistant_curator_decisions WHERE installation_id=? AND generation=? AND run_id=?',run.id).first('n')).toBe(0);
});
it('requires an actionable owner request when marking human help and keeps it separate from technical pending work',async()=>{
 await note('help');const run=await due();await expect(curator.finish(run.id,{needsHelp:true})).rejects.toThrow('curator_help_request');
 const receipt=await curator.finish(run.id,{needsHelp:true,helpRequest:'Nora é a mesma pessoa do projeto Cedar?'});
 expect(receipt).toMatchObject({needsHelp:true,helpRequest:'Nora é a mesma pessoa do projeto Cedar?'});
});
