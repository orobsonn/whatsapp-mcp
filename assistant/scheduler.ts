import type { AssistantEnv } from "./env";
import { Routines,type RoutineCycle } from "./routines";
import { CaptureMaterializer } from "./materialize";
import { Conversations } from "./conversations";
import { SourceAccess,type TrustedActor } from "./access";
import { activeOrigin,originScopeSql,scopeKeys,type OriginScope } from "./origin-guard";
import { bridgeHash } from "./ingress";
import { FollowUps } from "./followups";
import { hostConfiguredSearch } from "./configured-search";
import { EpisodeController,type EpisodeDriver } from "./agent/controller";
import { episodeDriver } from "./agent-runtime/driver";
import { jobRequest,type DecisionSubject } from "./agent/contracts";
import { JobQueue } from "./queue";
import { InferenceBudget } from "./budget";
import { DEFAULT_BROKER_CONFIG } from "./model-transport";
import { runtimeHost } from "./agent-runtime/runtime";
import { assertRestoredGeneration } from "./retention-runtime";
import { retentionExecutionGuard } from "./retention-execution";
import type { ModelAdapter } from "./model-broker";
import { MediaContext } from "./media";
import { createMediaModelPort } from "./media-model";
import { createTelegramReview } from "./telegram";
import { engineName } from "./container";
import type { CogneeContainer, IndexPreflight } from "./container";
type Binding={subject:DecisionSubject;actor:TrustedActor;profile:"owner"|"interlocutor";source:{id:string;revision:number;version:number;hash:string};query:string;projectId?:string;configuration:string};
type Item={id:string;subject_json:string;binding_hash:string;binding_json:string;actor_json:string;profile:"owner"|"interlocutor";source_id:string;source_revision:number;state:string;phase:string;index_sources_json:string|null;run_id:string|null;search_checkpoint:number;search_state:string|null;job_id:string|null;episode_id:string|null;last_gap:string|null;created_at:number};
type Event={sequence:number;chat_id:string;source_kind:string;metadata_hash:string;state:string;canonical_id:string|null;observed_revision:number|null;observed_version:number|null;observed_watermark:number|null;coalesced:number};
/** One bounded host pipeline. Production uses the existing concrete controllers;
 * only model/Flue transports can be replaced by controlled test adapters. */
export class AssistantScheduler {
 readonly routines:Routines;private readonly scope:OriginScope;private readonly clock:()=>number;private readonly access:SourceAccess;
 constructor(private env:AssistantEnv,private options:{clock?:()=>number;driver?:EpisodeDriver;model?:ModelAdapter}={}){
  this.scope=activeOrigin(()=>({installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!}));
  if(!env.DB||!env.CAPTURE_READER||!env.BRIDGE_SECRET)throw new Error("routines_unconfigured");this.clock=options.clock??Date.now;this.routines=new Routines(env.DB,this.scope,this.clock);this.access=new SourceAccess(env.DB,this.scope,this.clock);
 }
 private sql(query:string,...values:(string|number|null)[]){return this.env.DB!.prepare(query).bind(...values);}
 private keys(){return scopeKeys(this.scope);}
 private owned(cycle:RoutineCycle){const execution=retentionExecutionGuard(this.scope);return {sql:`EXISTS(SELECT 1 FROM assistant_routine_state WHERE ${originScopeSql} AND owner_token=? AND state='running' AND lease_until>?) AND (${execution.sql})`,values:[...this.keys(),cycle.owner,this.clock(),...execution.values]};}
 private item(id:string){return this.sql(`SELECT * FROM assistant_routine_items WHERE ${originScopeSql} AND id=?`,...this.keys(),id).first<Item>();}
 private async update(cycle:RoutineCycle,id:string,sql:string,values:(string|number|null)[]=[]){const owner=this.owned(cycle);await this.sql(`UPDATE assistant_routine_items SET ${sql},updated_at=? WHERE ${originScopeSql} AND id=? AND ${owner.sql}`,...values,this.clock(),...this.keys(),id,...owner.values).run();}
 private async gap(cycle:RoutineCycle,id:string,reason:string,uncertain=false){await this.update(cycle,id,"state=?,last_gap=?",[uncertain?"uncertain":["source_changed","inventory_changed"].includes(reason)?"blocked":"waiting_context",reason]);return uncertain?"uncertain":"waiting_context";}
 private async configuration(){return bridgeHash(["routines-v1",this.scope,DEFAULT_BROKER_CONFIG,this.env.SEMANTIC_SEARCH_MODE??(this.env.COGNEE?"required":"lexical")]);}
 async tick(){
  if(this.env.ROUTINES_ENABLED!=="shadow")return {state:"disabled"};const paused=this.env.ROUTINES_PAUSED==="true";
  try{await assertRestoredGeneration(this.env);}catch(error){const known=["restore_runtime_paused","restore_generation_inactive","restore_generation_seal_required","canonical_writers_quiesced"];return {state:"blocked",gap:error instanceof Error&&known.includes(error.message)?error.message:"restore_runtime_unavailable"};}
  let cycle=await this.routines.begin(paused),reconcileOnly=false;
  if(!cycle){cycle=await this.routines.reconcileBegin(paused);reconcileOnly=!!cycle;}
  if(!cycle){await this.routines.daily(paused);return {state:"busy_or_already_reviewed"};}
  let state="complete",gap:string|null=null;
  try{
   if(!reconcileOnly){
    await this.routines.phase(cycle,"capture");const materializer=new CaptureMaterializer(this.env.DB!,()=>this.scope,this.env.CAPTURE_READER!,this.env.BRIDGE_SECRET!,this.clock);
    await materializer.drain(10);if(!await this.routines.current(cycle))throw new Error("routine_stale");await materializer.retry(2);
    await this.discover(cycle);if(!paused)await this.due(cycle);
   }
   if(!paused){
    const row=reconcileOnly?await this.sql(`SELECT active_item_id id FROM assistant_routine_state WHERE ${originScopeSql}`,...this.keys()).first<{id:string}>():await this.sql(`SELECT id FROM assistant_routine_items WHERE ${originScopeSql} AND (state IN ('pending','waiting_context','ready','processing','uncertain') OR (state='complete' AND phase='review')) ORDER BY updated_at,id LIMIT 1`,...this.keys()).first<{id:string}>();
    if(row?.id){const item=await this.item(row.id);if(item){await this.routines.phase(cycle,"work",item.id);state=await this.process(cycle,item,reconcileOnly);gap=(await this.item(item.id))?.last_gap??null;}}
   }
   const daily=await this.routines.daily(paused);
   if(!paused&&state!=="uncertain"&&this.env.TELEGRAM_SUMMARIES_ENABLED==="true"&&await this.routines.current(cycle)){
    await this.routines.phase(cycle,"daily_review");try{await(await createTelegramReview(this.env,this.scope,()=>this.owned(cycle))).publishDailySummary(daily.id);}catch{gap=gap??"telegram_review_unavailable";}
   }
  }catch{state="uncertain";gap="routine_operation_uncertain";}
  await this.routines.finish(cycle,gap,state==="uncertain");return {state,gap,reconcileOnly};
 }
 private async discover(cycle:RoutineCycle){
  const cursor=await this.sql(`SELECT cursor_chat FROM assistant_routine_state WHERE ${originScopeSql}`,...this.keys()).first<string>("cursor_chat")??"";
  const chats=await this.sql(`SELECT chat_id,kind FROM assistant_origin_conversations WHERE ${originScopeSql} AND chat_id>? ORDER BY chat_id LIMIT 5`,...this.keys(),cursor).all<{chat_id:string;kind:"private"|"group"}>();
  const conversations=new Conversations(this.env.DB!,()=>this.scope);
  for(const chat of chats.results){
   if(!await this.routines.current(cycle))throw new Error("routine_stale");await conversations.ensure(chat.chat_id);await conversations.replay(chat.chat_id,32);await conversations.retryGaps(chat.chat_id,4);
   const frame=await conversations.state(chat.chat_id);if(frame.state==="paused"||frame.state==="ignored")continue;
   const events=await this.sql(`SELECT i.sequence,i.chat_id,i.source_kind,i.metadata_hash,r.state,r.canonical_id,r.observed_revision,r.observed_version,r.observed_watermark,r.coalesced
    FROM assistant_capture_inbox i JOIN assistant_conversation_replay r USING(installation_id,generation,source_epoch,source_generation,chat_id,sequence)
    LEFT JOIN assistant_routine_event_items m ON m.installation_id=i.installation_id AND m.generation=i.generation AND m.source_epoch=i.source_epoch AND m.source_generation=i.source_generation AND m.chat_id=i.chat_id AND m.sequence=i.sequence
    WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=? AND i.chat_id=? AND (m.sequence IS NULL OR (m.outcome='gap' AND r.state<>'gap')) ORDER BY i.sequence LIMIT 32`,...this.keys(),chat.chat_id).all<Event>();
   // Coalescence is an exact canonical observation, never a conversation-wide
   // substitution of one author/source for another, and never a gap.
   const groups=new Map<string,Event[]>(),unresolved:Event[]=[];
   for(const event of events.results){
    if(event.state!=="applied"||!event.canonical_id||!event.observed_revision||!event.observed_version||event.observed_watermark===null||event.source_kind==="conversation"){unresolved.push(event);continue;}
    const key=JSON.stringify([event.canonical_id,event.observed_revision,event.observed_version,event.observed_watermark]),group=groups.get(key)??[];group.push(event);groups.set(key,group);
   }
   const map=async(event:Event,itemId:string|null,outcome:string,representative:number|null)=>{
    const owner=this.owned(cycle);await this.sql(`INSERT INTO assistant_routine_event_items SELECT ?,?,?,?,?,?,?,?,? WHERE ${owner.sql}
     ON CONFLICT(installation_id,generation,source_epoch,source_generation,chat_id,sequence) DO UPDATE SET item_id=excluded.item_id,outcome=excluded.outcome,coalesced=excluded.coalesced WHERE assistant_routine_event_items.outcome='gap'`,...this.keys(),chat.chat_id,event.sequence,itemId,outcome,event.coalesced||!!itemId&&event.sequence!==representative?1:0,...owner.values).run();
   };
   for(const group of groups.values()){
    const event=group.at(-1)!,observation=await bridgeHash([...this.keys(),chat.chat_id,event.canonical_id,event.observed_revision,event.observed_version,event.observed_watermark]);
    // Reencounter the original subject/binding before looking at fresh fences.
    const prior=await this.sql(`SELECT id,subject_json FROM assistant_routine_items WHERE ${originScopeSql} AND observation_key=?`,...this.keys(),observation).first<{id:string;subject_json:string}>();
    let itemId:string|null=prior?.id??null,representative=prior?JSON.parse(prior.subject_json).sequence as number:event.sequence;
    if(!prior){
     const subject:DecisionSubject={kind:"capture_event",sourceEpoch:this.scope.sourceEpoch,sourceGeneration:this.scope.sourceGeneration,chatId:chat.chat_id,sequence:event.sequence,metadataHash:event.metadata_hash};
     const id=await bridgeHash(["routine-item-v1",...this.keys(),subject]),source=await this.access.read({kind:"owner"},event.canonical_id!,event.observed_revision!);
     const dependencies=source?await this.sql(`SELECT dependencies_json FROM assistant_origin_versions WHERE installation_id=? AND generation=? AND canonical_id=? AND version=?`,this.scope.installationId,this.scope.generation,source.id,source.fence.source.version).first<string>("dependencies_json"):null;
     const metadata=dependencies?JSON.parse(dependencies) as {authorId?:string|null;fromMe?:boolean}:{};
     let actor:TrustedActor|null=frame.mode==="observe"?{kind:"owner"}:null;
     if(!actor&&source&&metadata.authorId===source.authorId&&typeof metadata.authorId==="string"&&/^[a-f0-9]{64}$/.test(metadata.authorId)&&metadata.fromMe!==true)actor={kind:"interlocutor",provider:"wa_archive:"+await bridgeHash([this.scope.sourceEpoch,this.scope.sourceGeneration]),address:metadata.authorId,conversationId:chat.chat_id,conversationKind:chat.kind,action:"reply_text"};
     if(source&&actor&&typeof source.text==="string"&&source.text.trim()&&new TextEncoder().encode(source.text).length<=2048){
      const binding:Binding={subject,actor,profile:actor.kind==="owner"?"owner":"interlocutor",source:{...source.fence.source},query:source.text,...(source.fence.source.projectId?{projectId:source.fence.source.projectId}:{}),configuration:await this.configuration()},owner=this.owned(cycle);
      await this.sql(`INSERT INTO assistant_routine_items(installation_id,generation,source_epoch,source_generation,id,subject_json,binding_hash,binding_json,observation_key,actor_json,profile,source_id,source_revision,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE ${owner.sql} ON CONFLICT DO NOTHING`,...this.keys(),id,JSON.stringify(subject),await bridgeHash(binding),JSON.stringify(binding),observation,JSON.stringify(actor),binding.profile,source.id,source.fence.source.revision,this.clock(),this.clock(),...owner.values).run();
      const admitted=await this.sql(`SELECT id,subject_json FROM assistant_routine_items WHERE ${originScopeSql} AND observation_key=?`,...this.keys(),observation).first<{id:string;subject_json:string}>();itemId=admitted?.id??null;if(admitted)representative=JSON.parse(admitted.subject_json).sequence as number;
     }
    }
    for(const current of group)await map(current,itemId,itemId?"coalesced_observation":"not_evaluated_missing_actor_or_input",representative);
   }
   for(const event of unresolved)await map(event,null,event.state,null);
  }
  const owner=this.owned(cycle);await this.sql(`UPDATE assistant_routine_state SET cursor_chat=? WHERE ${originScopeSql} AND ${owner.sql}`,chats.results.length===5?chats.results.at(-1)!.chat_id:"",...this.keys(),...owner.values).run();
 }
 private async due(cycle:RoutineCycle){
  if(!await this.routines.current(cycle))throw new Error("routine_stale");const {origin}=hostConfiguredSearch(this.env,"automation",this.clock);
  const cursor=await this.sql(`SELECT fup_cursor FROM assistant_routine_state WHERE ${originScopeSql}`,...this.keys()).first<string|null>("fup_cursor"),result=await new FollowUps(this.env.DB!,this.scope,{origin,clock:this.clock}).admitDue({limit:5,...(cursor?{cursor}:{})});
  for(const value of result.items){
   const owner=this.owned(cycle);await this.sql(`INSERT INTO assistant_routine_fup_results SELECT ?,?,?,?,?,?,?,? WHERE ${owner.sql} ON CONFLICT(installation_id,generation,occurrence_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at`,this.scope.installationId,this.scope.generation,value.occurrenceId,value.id,value.version,value.state,value.reason??null,this.clock(),...owner.values).run();
   if(value.jobId){const queue=new JobQueue(this.env.DB!,this.scope),ledger=await queue.ledger(value.jobId);if(!ledger)continue;const request=jobRequest.parse(JSON.parse(ledger.request_json));const id=await bridgeHash(["routine-item-v1",...this.keys(),request.subject]);if(await this.item(id))continue;
    const binding:Binding={subject:request.subject,actor:request.actor,profile:request.actor.kind,source:{...request.fence.source},query:request.input,...(request.fence.source.projectId?{projectId:request.fence.source.projectId}:{}),configuration:await this.configuration()};
    await this.sql(`INSERT INTO assistant_routine_items(installation_id,generation,source_epoch,source_generation,id,subject_json,binding_hash,binding_json,observation_key,actor_json,profile,source_id,source_revision,state,job_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,? WHERE ${owner.sql} ON CONFLICT DO NOTHING`,...this.keys(),id,JSON.stringify(request.subject),await bridgeHash(binding),JSON.stringify(binding),await bridgeHash([...this.keys(),"fup",value.occurrenceId]),JSON.stringify(request.actor),binding.profile,request.sourceId,request.sourceRevision,value.jobId,this.clock(),this.clock(),...owner.values).run();
   }
  }
  const owner=this.owned(cycle);await this.sql(`UPDATE assistant_routine_state SET fup_cursor=? WHERE ${originScopeSql} AND ${owner.sql}`,result.nextCursor??null,...this.keys(),...owner.values).run();
 }
 private async ensureJob(cycle:RoutineCycle,item:Item,binding:Binding){
  const queue=new JobQueue(this.env.DB!,this.scope,binding.actor),dedupe="routine:"+item.id;
  // Recover the immutable admitted request before reconstructing any new fence.
  const prior=await this.sql(`SELECT j.id,l.request_json,l.request_hash FROM assistant_jobs j JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id WHERE j.installation_id=? AND j.generation=? AND (j.id=? OR j.dedupe_key=?) LIMIT 1`,this.scope.installationId,this.scope.generation,item.job_id,dedupe).first<{id:string;request_json:string;request_hash:string}>();
  if(prior){const request=jobRequest.parse(JSON.parse(prior.request_json));if(await bridgeHash(request)!==prior.request_hash||JSON.stringify(request.subject)!==item.subject_json||JSON.stringify(request.actor)!==item.actor_json||request.sourceId!==item.source_id||request.sourceRevision!==item.source_revision)throw new Error("routine_request_conflict");await this.update(cycle,item.id,"job_id=?",[prior.id]);return prior.id;}
  if(!await this.routines.current(cycle))throw new Error("routine_stale");
  const job=await queue.enqueue({kind:"reasoning",dedupeKey:dedupe,sourceId:item.source_id,sourceRevision:item.source_revision,request:binding.query,runtime:"flue",subject:binding.subject},this.clock());
  await this.update(cycle,item.id,"job_id=?",[job.id]);return job.id;
 }
 private async warm(cycle:RoutineCycle,item:Item){
  const engine=this.env.COGNEE!.get(this.env.COGNEE!.idFromName(engineName(this.scope.installationId,this.scope.generation)));
  let state=await engine.lifecycleState();if(!state.index)return {engine,ready:false,gap:"index_uninitialized"};
  const initial=await this.preflight(cycle,engine,state.index,false);if(initial)return {engine,ready:false,gap:initial};
  if(state.running&&!state.maintenance&&!state.quarantine&&!state.index.lost)return {engine,ready:true,state};
  const checkpoint=state.checkpoint;
  if(!checkpoint||checkpoint.epoch!==state.index.epoch||checkpoint.revision!==state.index.revision)return {engine,ready:false,gap:"index_rebuild_required"};
  await this.routines.phase(cycle,"restore_checkpoint",item.id);
  const last=await this.preflight(cycle,engine,state.index,false);if(last)return {engine,ready:false,gap:last};
  const restored=await engine.restoreCheckpoint({checkpointId:checkpoint.id,indexEpoch:state.index.epoch,indexRevision:state.index.revision});
  if(restored.state!=="checkpoint_confirmed")return {engine,ready:false,gap:"checkpoint_restore_uncertain"};
  state=await engine.lifecycleState();if(!state.index)return {engine,ready:false,gap:"index_unavailable"};
  const restoredCheck=await this.preflight(cycle,engine,state.index,true);if(restoredCheck)return {engine,ready:false,gap:restoredCheck};
  return {engine,ready:state.running&&!state.maintenance&&!state.quarantine&&!state.index.lost,state,gap:"index_unavailable"};
 }
 private async preflight(cycle:RoutineCycle,engine:DurableObjectStub<CogneeContainer>,index:{epoch:string;revision:string},physical:boolean):Promise<string|null>{
  let result:IndexPreflight;try{result=await engine.indexPreflight({indexEpoch:index.epoch,indexRevision:index.revision});}catch{return "index_preflight_unavailable";}
  if(!await this.routines.current(cycle))throw new Error("routine_stale");
  if(result.state==="maintenance_required")return "index_maintenance_required";
  return result.state==="verified"||!physical&&result.state==="current_metadata"?null:"index_preflight_unavailable";
 }
 private async index(cycle:RoutineCycle,item:Item,binding:Binding,reconcileOnly:boolean):Promise<string>{
  if(!this.env.COGNEE)return "ready";const inventory=this.access.inventory(binding.actor,binding.projectId,this.clock(),this.scope);
  const rows=await this.sql(`SELECT id,revision,version,content_hash FROM (${inventory.sql}) ORDER BY id LIMIT 65`,...inventory.values).all<{id:string;revision:number;version:number;content_hash:string}>();
  if(rows.results.length>64)return "ready"; // #112 explicitly reports semantic capacity; never ingest a prefix.
  const refs=JSON.stringify(rows.results.map(row=>({id:row.id,revision:row.revision,version:row.version,hash:row.content_hash})));
  if(item.index_sources_json&&item.index_sources_json!==refs){await this.update(cycle,item.id,"state='blocked',last_gap='inventory_changed'");return "blocked";}
  if(!item.index_sources_json){if(reconcileOnly)return "uncertain";await this.update(cycle,item.id,"index_sources_json=?",[refs]);}
  const warm=await this.warm(cycle,item);if(!warm.ready||!warm.state?.index)return this.gap(cycle,item.id,warm.gap??"index_unavailable",reconcileOnly);
  let metadata=warm.state.index;const engine=warm.engine;
  for(const ref of JSON.parse(refs) as Binding["source"][]){
   const source=await this.access.read(binding.actor,ref.id,ref.revision);if(!source||source.fence.source.hash!==ref.hash)return this.gap(cycle,item.id,"source_changed");
   const {origin}=hostConfiguredSearch(this.env,"automation",this.clock),fence=source.fence.source.origin==="whatsapp"?await origin?.fence(source.id):undefined;
   if(source.fence.source.origin==="whatsapp"&&(!fence||!await origin!.check(fence)))return this.gap(cycle,item.id,"origin_unavailable");
   const input={actor:binding.actor,source,...(fence?{origin:fence}:{})};
   let work=await this.sql(`SELECT state,index_epoch FROM assistant_routine_ingestions WHERE ${originScopeSql} AND item_id=? AND source_id=?`,...this.keys(),item.id,ref.id).first<{state:string;index_epoch:string}>();
   if(work?.state==="attempting"||work?.state==="uncertain"){
    if((await engine.ingestReceipt(input,work.index_epoch)).state!=="complete")return this.gap(cycle,item.id,"ingestion_uncertain",true);
    await this.sql(`UPDATE assistant_routine_ingestions SET state='complete' WHERE ${originScopeSql} AND item_id=? AND source_id=?`,...this.keys(),item.id,ref.id).run();metadata=(await engine.lifecycleState()).index!;continue;
   }
   if(metadata.sources.some(row=>row.id===ref.id&&row.revision===ref.revision&&row.version===ref.version&&row.hash===ref.hash))continue;
   if(work?.state==="complete")return this.gap(cycle,item.id,"index_rebuild_required");
   if(reconcileOnly)return "uncertain";
   const beforeIngest=await this.preflight(cycle,engine,metadata,true);if(beforeIngest)return this.gap(cycle,item.id,beforeIngest);
   const owner=this.owned(cycle);await this.sql(`INSERT INTO assistant_routine_ingestions SELECT ?,?,?,?,?,?,?,?,'prepared' WHERE ${owner.sql} ON CONFLICT DO NOTHING`,...this.keys(),item.id,ref.id,JSON.stringify(ref),metadata.epoch,...owner.values).run();
   const claimed=await this.sql(`UPDATE assistant_routine_ingestions SET state='attempting' WHERE ${originScopeSql} AND item_id=? AND source_id=? AND state='prepared' AND index_epoch=? AND ${owner.sql} RETURNING source_id`,...this.keys(),item.id,ref.id,metadata.epoch,...owner.values).all();if(!claimed.results.length)return "uncertain";
   await this.routines.phase(cycle,"ingest",item.id);
   const result=await engine.ingest(input) as {state:string};
   if(result.state!=="complete"){await this.sql(`UPDATE assistant_routine_ingestions SET state='uncertain' WHERE ${originScopeSql} AND item_id=? AND source_id=? AND state='attempting'`,...this.keys(),item.id,ref.id).run();return this.gap(cycle,item.id,"ingestion_uncertain",true);}
   await this.sql(`UPDATE assistant_routine_ingestions SET state='complete' WHERE ${originScopeSql} AND item_id=? AND source_id=? AND state='attempting'`,...this.keys(),item.id,ref.id).run();
   const current=(await engine.lifecycleState()).index!;await this.routines.phase(cycle,"checkpoint",item.id);
   const beforeCheckpoint=await this.preflight(cycle,engine,current,true);if(beforeCheckpoint)return this.gap(cycle,item.id,beforeCheckpoint);
   const checkpoint=await engine.checkpoint({indexEpoch:current.epoch,indexRevision:current.revision});if(checkpoint.state!=="checkpoint_confirmed")return this.gap(cycle,item.id,"checkpoint_pending");
   await this.update(cycle,item.id,"state='pending',last_gap='indexing_pending'");return "pending"; // At most one new ingestion per cron.
  }
  const ready=await this.preflight(cycle,engine,metadata,true);if(ready)return this.gap(cycle,item.id,ready);
  if(metadata.state!=="checkpoint_confirmed"){
   if(reconcileOnly)return "ready";await this.routines.phase(cycle,"checkpoint",item.id);const last=await this.preflight(cycle,engine,metadata,true);if(last)return this.gap(cycle,item.id,last);if((await engine.checkpoint({indexEpoch:metadata.epoch,indexRevision:metadata.revision})).state!=="checkpoint_confirmed")return this.gap(cycle,item.id,"checkpoint_pending");
  }
  return "ready";
 }
 private async existingEpisode(cycle:RoutineCycle,item:Item,host:EpisodeController,reconcileOnly:boolean){
  const found=item.episode_id?await host.episodes.get(item.episode_id):item.job_id?await this.sql(`SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=? AND job_id=? ORDER BY episode_generation DESC LIMIT 1`,this.scope.installationId,this.scope.generation,item.job_id).first<{id:string}>():null;
  if(!found)return null;await this.update(cycle,item.id,"episode_id=?,phase='episode'",[found.id]);const episode=await host.episodes.get(found.id);if(!episode)return "uncertain";
  const driver=this.options.driver??episodeDriver;
  if(episode.state==="settled"){const result=await host.read(episode.id,driver);return result.state==="shadow_completed"?this.complete(cycle,item,host,episode.id):this.gap(cycle,item.id,"publication_rejected");}
  if(!episode.receipt){
   if(reconcileOnly||episode.state!=="prepared")await host.reconcile(episode.id,driver);
   else if(episode.deadline>this.clock()){await this.routines.phase(cycle,"dispatch",item.id);await host.dispatch(episode.id,driver);}
   else return this.gap(cycle,item.id,"episode_expired",true);
  }
  const current=await host.episodes.get(episode.id);if(!current?.receipt)return this.gap(cycle,item.id,"dispatch_uncertain",true);
  await this.routines.phase(cycle,"read_episode",item.id);const result=await host.read(episode.id,driver);
  return result.state==="shadow_completed"?this.complete(cycle,item,host,episode.id):this.gap(cycle,item.id,result.state==="uncertain"?"model_uncertain":"publication_rejected",result.state==="uncertain");
 }
 private async complete(cycle:RoutineCycle,item:Item,host:EpisodeController,episodeId:string){
  await this.update(cycle,item.id,"state='complete',phase='review',last_gap=NULL");
  if(this.env.TELEGRAM_SUMMARIES_ENABLED==="true"&&await this.routines.current(cycle)){
   const row=await this.sql(`SELECT id,recorded_at FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND episode_id=? AND proposal_json IS NOT NULL`,this.scope.installationId,this.scope.generation,episodeId).first<{id:string;recorded_at:number}>();
   if(row){try{const review=await createTelegramReview(this.env,this.scope,()=>this.owned(cycle)),notice=await review.execute({kind:"notification.prepare",operationId:"routine-review:"+item.id,topic:item.subject_json.includes('"fup_occurrence"')?"missions":"pending",decisionId:row.id,expiresAt:row.recorded_at+3600000}) as {id:string};if(!await this.routines.current(cycle))throw new Error("routine_stale");const delivery=await review.execute({kind:"notification.dispatch",id:notice.id}) as {state:string};if(["sent","uncertain","failed","cancelled"].includes(delivery.state))await this.update(cycle,item.id,"phase='done'");}catch{await this.update(cycle,item.id,"phase='done',last_gap='telegram_review_unavailable'");}}
  }else await this.update(cycle,item.id,"phase='done'");
  return "complete";
 }
 private async process(cycle:RoutineCycle,item:Item,reconcileOnly:boolean):Promise<string>{
  const binding=JSON.parse(item.binding_json) as Binding;if(await bridgeHash(binding)!==item.binding_hash||binding.configuration!==await this.configuration()){await this.update(cycle,item.id,"state='blocked',last_gap='configuration_or_binding_changed'");return "blocked";}
  if(!this.env.OPENAI_API_KEY||this.env.FLUE_EPISODES_ENABLED!=="shadow")return this.gap(cycle,item.id,"episode_unconfigured");
  const configured=hostConfiguredSearch(this.env,"automation",this.clock),host=runtimeHost(this.env,"automation",{clock:this.clock,model:this.options.model});
  // Lookup existing job/episode before considering a new source fence or lease.
  if(item.job_id){const existing=await this.existingEpisode(cycle,item,host,reconcileOnly);if(existing)return existing;}
  if(reconcileOnly&&item.run_id){
   const recovered=await configured.search.result(binding.actor,item.run_id);
   if(recovered.state==="ready"){await this.update(cycle,item.id,"state='ready',last_gap=NULL");return "pending";}
   return this.gap(cycle,item.id,"semantic_uncertain",true);
  }
  const source=await this.access.read(binding.actor,item.source_id,item.source_revision);if(!source||source.fence.source.version!==binding.source.version||source.fence.source.hash!==binding.source.hash)return this.gap(cycle,item.id,"source_changed");
  if(binding.subject.kind==="capture_event"&&!await new Conversations(this.env.DB!,()=>this.scope).fence(binding.subject.chatId))return this.gap(cycle,item.id,"conversation_pending");
  if(!item.job_id){if(reconcileOnly)return "uncertain";item.job_id=await this.ensureJob(cycle,item,binding);}else{const ledger=await host.queue.ledger(item.job_id);if(!ledger||ledger.state!=="prepared")return this.gap(cycle,item.id,"missing_or_uncertain_episode",true);}
  if(!reconcileOnly)try{const budget=await new InferenceBudget(this.env.DB!,{...this.scope,period:new Date(this.clock()).toISOString().slice(0,10)}).status();if(budget.blocked||budget.committed>=budget.cap)return this.gap(cycle,item.id,"budget_blocked");}catch{return this.gap(cycle,item.id,"budget_unconfigured");}
  if(configured.origin&&this.env.MEDIA_CONTEXT_ENABLED==="true"&&this.env.CAPTURE_MEDIA_READER){
   const origin=await configured.origin.fence(source.id);if(origin?.sourceKind==="media"){
    await this.routines.phase(cycle,"media",item.id);const model=createMediaModelPort(this.env.OPENAI_API_KEY),media=new MediaContext(this.env.DB!,{...this.scope,period:new Date(this.clock()).toISOString().slice(0,10)},{origin:configured.origin,reader:this.env.CAPTURE_MEDIA_READER,secret:this.env.BRIDGE_SECRET!,model:async request=>{await assertRestoredGeneration(this.env);return model(request);},pdfParser:this.env.MEDIA_PDF_PARSER},this.clock);
    if(reconcileOnly){if(!await media.read(binding.actor,{...source,origin}))return "uncertain";}
    else{const result=await media.interpret(binding.actor,source.id);if(result.state==="pending")return this.gap(cycle,item.id,result.reason,result.reason.includes("uncertain"));}
   }
  }
  const indexed=await this.index(cycle,item,binding,reconcileOnly);if(indexed!=="ready")return indexed;if(reconcileOnly){await this.update(cycle,item.id,"state='pending',last_gap=NULL");return "pending";}
  let progress=await configured.search.start(binding.actor,"routine-search:"+item.id,{query:binding.query,limit:10,...(binding.projectId?{projectId:binding.projectId}:{})});
  if(item.run_id&&item.run_id!==progress.runId)throw new Error("routine_run_conflict");await this.update(cycle,item.id,"run_id=?,search_checkpoint=?,search_state=?,phase='search'",[progress.runId,progress.checkpoint,progress.state]);
  if(progress.state==="pending"){
   await this.routines.phase(cycle,"search_inventory",item.id);progress=await configured.search.step(binding.actor,{runId:progress.runId,stepId:`routine-step:${item.id}:${progress.checkpoint}`,expectedCheckpoint:progress.checkpoint});
   await this.update(cycle,item.id,"search_checkpoint=?,search_state=?",[progress.checkpoint,progress.state]);if(progress.state==="pending")return "pending";
  }
  let result=await configured.search.result(binding.actor,progress.runId);
  if(result.state==="pending"&&configured.semantic){await this.routines.phase(cycle,"semantic_presearch",item.id);await configured.search.advanceSemantic(binding.actor,progress.runId);result=await configured.search.result(binding.actor,progress.runId);}
  if(result.state!=="ready")return this.gap(cycle,item.id,result.coverage.gaps[0]??"waiting_context",result.coverage.engine==="unavailable");
  await this.update(cycle,item.id,"state='ready',last_gap=NULL");await this.routines.phase(cycle,"claim_episode",item.id);
  const lease=await host.queue.claimId(item.job_id,this.clock(),90000);if(!lease)return this.gap(cycle,item.id,"job_not_claimable");
  const episode=await host.prepare(lease,binding.profile,progress.runId);await this.update(cycle,item.id,"episode_id=?,state='processing',phase='episode'",[episode.id]);
  return (await this.existingEpisode(cycle,{...item,episode_id:episode.id},host,false))??"uncertain";
 }
}
/** Cloudflare cron invokes the real product factory. Defaults remain inert. */
export async function runScheduledAssistant(env:AssistantEnv){
 if(env.ROUTINES_ENABLED!=="shadow")return {state:"disabled"};return new AssistantScheduler(env).tick();
}
