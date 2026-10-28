import { env } from "cloudflare:test";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
import { TelegramLink } from "../assistant/telegram-auth";
import { TelegramReview,type TelegramApi } from "../assistant/telegram";
import { DecisionJournal } from "../assistant/decisions";
import { Routines } from "../assistant/routines";
import { AssistantScheduler } from "../assistant/scheduler";
import { Conversations } from "../assistant/conversations";
import { receiveCapture } from "../assistant/ingress";
import { hostConfiguredSearch } from "../assistant/configured-search";
import { EpisodeController,type EpisodeDriver } from "../assistant/agent/controller";
import { boundEpisode } from "../assistant/agent/contracts";
import { DEFAULT_BROKER_CONFIG } from "../assistant/model-transport";
import { InferenceBudget } from "../assistant/budget";
import { JobQueue } from "../assistant/queue";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import {OwnerControl} from '../assistant/control';
import { assistantHealth } from "../assistant/health";
import { CogneeContainer, CanonicalEngineGuard } from "../assistant/container";
import { CogneeEngine } from "../assistant/engine";
import { bridgeHash } from "../assistant/ingress";
import type { CheckpointManifest, IndexProof, SourceStamp } from "../assistant/checkpoints";
import type { AssistantEnv } from "../assistant/env";
import type { ModelAdapter } from "../assistant/model-broker";
import type { OriginScope,ReaderQuery } from "../assistant/origin-guard";
import { OriginGuard } from "../assistant/origin-guard";
import {runtimeHost} from '../assistant/agent-runtime/runtime';
import {readProactivePilot,pilotAllowsSubject,pilotBindingCurrent} from '../assistant/proactive-pilot';
import {CanonicalCandidateExtractor} from '../assistant/canonical-extraction';
import {OwnerRuntime,InterlocutorRuntime} from '../assistant/agent-runtime/profiles';
import {TelegramApprovedSendReview} from '../assistant/telegram-approved-send';
import {actionDigest} from '../src/send-envelope';
const secret="synthetic-routines-private-capture-secret";let scope:OriginScope,settings:AssistantEnv,now:number,modelCalls:number,dispatches:number,modelFailure:boolean,withoutCitations:boolean,author:string|null,fromMe:boolean;
let snapshots:Map<string,unknown>,model:ModelAdapter,driver:EpisodeDriver;
const keys=()=>[scope.installationId,scope.generation],query=(sql:string,...values:(string|number|null)[])=>env.DB.prepare(sql).bind(...values);
const scheduler=()=>new AssistantScheduler(settings,{clock:()=>now,driver,model});
let activityOwnerSequence:number,activityMembers:string[],activityLatestIncomingSequence:number|null;
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:"g1",sourceEpoch:"capture-epoch",sourceGeneration:"capture-generation"};now=Date.parse("2026-10-26T12:00:00Z");modelCalls=0;dispatches=0;modelFailure=false;withoutCitations=false;author="a".repeat(64);fromMe=false;snapshots=new Map();
 activityOwnerSequence=0;activityMembers=[];activityLatestIncomingSequence=null;
 const reader={async readConversationActivity(input:{secret:string;sourceEpoch:string;sourceGeneration:string;chatId:string}){if(input.secret!==secret)throw Error('reader_denied');const latestIncomingOriginalSequence=activityLatestIncomingSequence??Math.max(0,...[...snapshots.values()].filter(v=>(v as any).chatId===input.chatId&&(v as any).content?.fromMe===false).map(v=>(v as {watermark:number}).watermark)),watermark=Math.max(1,activityOwnerSequence,latestIncomingOriginalSequence,...[...snapshots.values()].map(v=>(v as {watermark:number}).watermark));return {observation:'capture_conversation_activity',state:'available',sourceEpoch:input.sourceEpoch,sourceGeneration:input.sourceGeneration,chatId:input.chatId,relationshipRevision:activityMembers.length?1:0,relationshipProof:'a'.repeat(64),members:(activityMembers.length?activityMembers:[input.chatId]).map(chatId=>({chatId,captureEnabled:true,watermark})),watermark,lastOwnerOriginalSequence:activityOwnerSequence,latestIncomingOriginalSequence};},async readSnapshot(input:ReaderQuery){if(input.secret!==secret)throw new Error("synthetic secret mismatch");const found=snapshots.get(input.sourceKind+":"+input.sourceId);if(!found)throw new Error("synthetic offline");return found;}};
 settings={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret,CAPTURE_READER:reader,OPENAI_API_KEY:"synthetic-not-a-provider-key",FLUE_EPISODES_ENABLED:"shadow",ROUTINES_ENABLED:"shadow"};
 await new InferenceBudget(env.DB,{...scope,period:"2026-10-26"}).configure(1000000);
 model=async request=>{modelCalls++;if(modelFailure)throw new Error("synthetic accepted but ACK lost");const payload=JSON.parse(request.body),prompt=JSON.parse(payload.messages.at(-1).content),source=prompt.sources[0];return {status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:"proposed",text:"Synthetic shadow proposal",contextSummary:"Synthetic brief conversation summary",citations:withoutCitations?[]:[{id:source.id,revision:source.revision,version:source.version,hash:source.hash,quote:source.text}]})}}]})};};
 driver=(profile,runtimeId)=>({dispatch:async()=>{dispatches++;return {submissionId:"submission-"+runtimeId.slice(-12),uid:"uid-"+runtimeId.slice(-12),acceptedAt:new Date(now).toISOString()};},read:async receipt=>{
  const found=await query("SELECT id,binding_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND runtime_id=?",...keys(),runtimeId).first<{id:string;binding_json:string}>();if(!found)throw new Error("missing synthetic episode");
  const {search}=hostConfiguredSearch(settings,"automation",()=>now,JSON.parse(found.binding_json).contextMode),host=new EpisodeController(env.DB,{...scope,period:new Date(now).toISOString().slice(0,10)},search,model,DEFAULT_BROKER_CONFIG,{purpose:"automation",clock:()=>now}),episode=boundEpisode((await host.episodes.get(found.id))!);
  const text=await host.model(episode.id,{profile,runtimeId,submissionId:receipt.submissionId},{messages:[{role:"user",content:host.message(episode)}]});return {...receipt,text,data:{}};
 }});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('answers a newly captured private outside the legacy eight without model citations and shows its host original and AI summary',async()=>{
 withoutCitations=true;
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'all-private',revision:1,startAfterSequence:0,selection:'captured_private',contextMode:'conversation_manifest'});
 await query("INSERT INTO assistant_origin_conversations(installation_id,generation,source_epoch,source_generation,chat_id,watermark,kind,access_state) SELECT ?,?,?,?,value,0,'private','available' FROM json_each(?)",...keys(),scope.sourceEpoch,scope.sourceGeneration,JSON.stringify(Array.from({length:20},(_,i)=>'a-idle-'+String(i).padStart(2,'0')))).run();
 const engine={search:vi.fn(async()=>{throw Error('must not use Cognee');})};settings.COGNEE={idFromName:()=>({}),get:()=>engine} as unknown as NonNullable<AssistantEnv['COGNEE']>;settings.SEMANTIC_SEARCH_MODE='required';
 await event(1,0,'outside','Synthetic text from another captured private','private','outside-eight');
 expect(await scheduler().tick()).toMatchObject({state:'complete'});expect(modelCalls).toBe(1);expect(dispatches).toBe(1);expect(engine.search).not.toHaveBeenCalled();
 const episode=await query('SELECT binding_json FROM assistant_episodes WHERE installation_id=? AND generation=?',...keys()).first<string>('binding_json');expect(JSON.parse(episode!).contextMode).toBe('conversation_manifest');expect(JSON.parse(episode!).context.sources).toHaveLength(1);
 const configured=hostConfiguredSearch(settings,'owner_read',()=>now),journal=new DecisionJournal(env.DB,scope,{kind:'owner'},{origin:configured.origin,semantic:configured.semantic,clock:()=>now});
 const decision=await query('SELECT id FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND proposal_json IS NOT NULL',...keys()).first<string>('id');
 const detail=await journal.get(decision!);expect(detail).toMatchObject({freshness:'current',proposal:{decision:'proposed'}});
 expect(await journal.admitReview(decision!,await bridgeHash((detail as any).proposal),guard=>[query(`SELECT 1 WHERE ${guard.sql}`,...guard.values)])).not.toBeNull();expect(engine.search).not.toHaveBeenCalled();
 const bot='manifest_review_bot',link={...scope,botInstance:bot,linkRevision:1,userId:'101',chatId:'101'};
 await query("INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',0)",...keys(),bot,scope.sourceEpoch,scope.sourceGeneration).run();
 await query("INSERT INTO assistant_telegram_topics(installation_id,generation,bot_instance,link_revision,slot,fence_json,state,thread_id) VALUES(?,?,?,1,'pending',?,'ready',42)",...keys(),bot,JSON.stringify(link)).run();
 const api:TelegramApi={inspect:vi.fn(async()=>true),createTopic:vi.fn(async()=>42),send:vi.fn(async()=>200),answer:vi.fn(async()=>{})},actionId=crypto.randomUUID();
 settings.WHATSAPP_APPROVED_SEND_ENABLED='true';settings.WHATSAPP_APPROVED_SEND_SECRET=secret;
 settings.WHATSAPP_APPROVED_SEND={prepare:vi.fn(async input=>({actionId,hash:await actionDigest(input.envelope),envelope:input.envelope,activity:input.activity,target:{chatId:input.envelope.chatId,name:'Synthetic private outside eight',address:'5511000000000',kind:'individual' as const},expiresAt:now+600000})),execute:vi.fn(async()=>{throw Error('preview never sends');}),status:vi.fn(async()=>{throw Error('preview never sends');})};
 const review=new TelegramApprovedSendReview(settings,scope,bot,'synthetic-manifest-callback-key',api,journal,()=>now);
 expect(await review.dispatchDecision(decision!,'manifest-default-context')).toMatchObject({state:'sent'});
 expect(vi.mocked(api.send).mock.calls[0][2]).toContain('Synthetic text from another captured private');expect(vi.mocked(api.send).mock.calls[0][2]).toContain('Synthetic brief conversation summary');expect(vi.mocked(api.send).mock.calls[0][2]).toContain((detail as any).proposal.text);expect(settings.WHATSAPP_APPROVED_SEND.execute).not.toHaveBeenCalled();expect(modelCalls).toBe(1);expect(engine.search).not.toHaveBeenCalled();
 const frozen=JSON.parse(episode!),queue=new JobQueue(env.DB,scope,frozen.actor),withoutRefs={kind:'reasoning' as const,dedupeKey:'manifest-missing-refs',sourceId:frozen.lease.source_id,sourceRevision:frozen.lease.source_revision,request:frozen.query,runtime:'flue' as const,subject:frozen.subject,contextMode:'conversation_manifest' as const};
 await expect(queue.enqueue(withoutRefs,now)).rejects.toThrow('retrieval_source_refs');expect(await query('SELECT COUNT(*) n FROM assistant_jobs WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(1);
 expect(()=>hostConfiguredSearch(settings,'automation',()=>now,'other' as never)).toThrow('context_mode_denied');
 expect(()=>hostConfiguredSearch(settings,'owner_read',()=>now,'conversation_manifest')).toThrow('context_mode_denied');
 await query("UPDATE assistant_retrieval_runs SET request_json=json_remove(request_json,'$.contextMode') WHERE installation_id=? AND generation=?",...keys()).run();
 expect((await journal.get(decision!)) as any).not.toHaveProperty('proposal');expect(await journal.admitReview(decision!,await bridgeHash((detail as any).proposal),guard=>[query(`SELECT 1 WHERE ${guard.sql}`,...guard.values)])).toBeNull();expect(modelCalls).toBe(1);
});
it('keeps the entire frozen conversation manifest when its short messages have no lexical matches',async()=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'all-private',revision:1,startAfterSequence:0,selection:'captured_private',contextMode:'conversation_manifest'});
 await event(1,0,'short-first','a','private','outside-eight');await event(2,1,'short-latest','e','private','outside-eight');for(const [key,value]of snapshots)snapshots.set(key,{...(value as object),watermark:2});
 await scheduler().tick();now+=60001;expect(await scheduler().tick()).toMatchObject({state:'complete'});expect(modelCalls).toBe(1);
 const binding=JSON.parse((await query('SELECT binding_json FROM assistant_episodes WHERE installation_id=? AND generation=?',...keys()).first<string>('binding_json'))!);expect(binding.context.sources.map((source:{text:string})=>source.text).sort()).toEqual(['a','e']);
});
it.each(['excluded','paused','before_cutoff','from_me'] as const)('captured_private does not infer for %s',async reason=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'all-private',revision:1,startAfterSequence:reason==='before_cutoff'?1:0,selection:'captured_private',contextMode:'conversation_manifest'});
 if(reason==='excluded')await query("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,?,'private',1,'ignore',1)",...keys(),'outside-eight').run();
 if(reason==='from_me')fromMe=true;
 if(reason==='paused')settings.ROUTINES_PAUSED='true';await event(1,0,'unavailable','Synthetic new private','private','outside-eight');await scheduler().tick();
 if(reason==='paused'){const conversation=new Conversations(env.DB,()=>scope),state=await conversation.state('outside-eight');await conversation.setPaused('outside-eight',state.revision,true);settings.ROUTINES_PAUSED='false';now+=60001;await scheduler().tick();}
 expect(modelCalls).toBe(0);expect(dispatches).toBe(0);expect(await query('SELECT COUNT(*) n FROM assistant_jobs WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(0);
});
it.each(['private','group'] as const)('does not infer a superseded %s trigger even when a later unsupported message supersedes it',async kind=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'all-private',revision:1,startAfterSequence:0,selection:'captured_private',contextMode:'conversation_manifest'});activityLatestIncomingSequence=2;
 await event(1,0,'old','Synthetic old text',kind,'outside-eight');await scheduler().tick();expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 if(kind==='private')expect(await query('SELECT state,phase,last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({state:'blocked',phase:'done',last_gap:'superseded_new_message'});
 else expect(await query('SELECT COUNT(*) n FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(0);
});
it('suppresses a phone trigger already answered through its proven LID without reading the other conversation or paying a model',async()=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'activity-pilot',revision:1,startAfterSequence:0,chatIds:['chat']});
 activityMembers=['chat','opaque-lid-chat'];activityOwnerSequence=2;await event();
 const snapshotsRead=vi.spyOn(settings.CAPTURE_READER!,'readSnapshot');
 expect(await scheduler().tick()).toMatchObject({state:'blocked',gap:'superseded_owner_reply'});
 expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 expect(await query('SELECT state,phase,last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({state:'blocked',phase:'done',last_gap:'superseded_owner_reply'});
 expect(await query('SELECT COUNT(*) n FROM assistant_episodes WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(0);
 expect(snapshotsRead.mock.calls.every(([input])=>input.chatId==='chat')).toBe(true);
});
it('rejects publication when the owner answers through a related LID after the paid model response',async()=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'activity-pilot',revision:1,startAfterSequence:0,chatIds:['chat']});activityMembers=['chat','opaque-lid-chat'];
 const native=driver;driver=(profile,id)=>{const port=native(profile,id);return {dispatch:port.dispatch,read:async(receipt,options)=>{const result=await port.read(receipt,options);activityOwnerSequence=2;return result;}};};
 await event();expect(await scheduler().tick()).toMatchObject({state:'blocked',gap:'superseded_owner_reply'});
 expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query('SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND proposal_json IS NOT NULL',...keys()).first('n')).toBe(0);
 expect(await query('SELECT state,phase,last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({state:'blocked',phase:'done',last_gap:'superseded_owner_reply'});
});
it('does not infer when a related activity member is excluded even though the trigger conversation is enabled',async()=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'activity-pilot',revision:1,startAfterSequence:0,chatIds:['chat']});activityMembers=['chat','opaque-lid-chat'];
 await query("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,?,'private',1,'ignore',1)",...keys(),'opaque-lid-chat').run();
 await event();await scheduler().tick();expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 expect(await query('SELECT COUNT(*) n FROM assistant_episodes WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(0);
});
it('admits only prospective received pilot messages and leaves old routines and unrelated owner context untouched', async () => {
 const extraction=vi.spyOn(CanonicalCandidateExtractor.prototype,'extract');
 settings.ROUTINES_PAUSED='true';await event(1,0,'old');await scheduler().tick();
 const old=await query('SELECT id,binding_json FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first<{id:string;binding_json:string}>();
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'pilot',revision:1,startAfterSequence:1,chatIds:['chat']});
 settings.ROUTINES_PAUSED='false';now+=60001;fromMe=true;await event(2,1,'outgoing');await scheduler().tick();
 expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 expect(await query('SELECT state,binding_json FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id=?',...keys(),old!.id).first()).toEqual({state:'pending',binding_json:old!.binding_json});
 fromMe=false;now+=60001;await event(3,2,'received','Synthetic received request');
 for(const [key,value] of snapshots)snapshots.set(key,{...(value as object),watermark:3});
 await scheduler().tick();
 expect(dispatches).toBe(1);expect(modelCalls).toBe(1);
 expect(extraction).not.toHaveBeenCalled();
 const canonical=JSON.parse((await query('SELECT body_json FROM assistant_owner_canonical_status WHERE installation_id=? AND generation=?',...keys()).first<string>('body_json'))!);
 expect(canonical).toMatchObject({state:'not_evaluated',gap:'pilot_context_only'});
 const item=await query("SELECT binding_json FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id<>?",...keys(),old!.id).first<string>('binding_json');
 const binding=JSON.parse(item!);expect(binding.pilot).toMatchObject({id:'pilot',revision:1,startAfterSequence:1,chatId:'chat'});
 expect(binding.sourceRefs.length).toBeGreaterThan(0);expect(binding.sourceRefs.length).toBeLessThanOrEqual(3);
 expect(await query('SELECT state FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id=?',...keys(),old!.id).first('state')).toBe('pending');
 expect(await pilotBindingCurrent(settings,binding)).toBe(true);
 const episodeId=await query('SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=?',...keys()).first<string>('id');
 settings.ROUTINES_PAUSED='true';expect(await pilotBindingCurrent(settings,binding)).toBe(false);
 await expect(runtimeHost(settings,'automation',{clock:()=>now,model}).model(episodeId!,{profile:'interlocutor',runtimeId:'stale',submissionId:'stale'},{messages:[]})).rejects.toThrow('proactive_pilot_ineligible');
 settings.ROUTINES_PAUSED='false';
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'pilot',revision:2,startAfterSequence:1,chatIds:['chat']});
 expect(await pilotBindingCurrent(settings,binding)).toBe(false);
 await expect(runtimeHost(settings,'automation',{clock:()=>now,model}).model(episodeId!,{profile:'interlocutor',runtimeId:'stale',submissionId:'stale'},{messages:[]})).rejects.toThrow('proactive_pilot_ineligible');
 expect(modelCalls).toBe(1);
});
it('fails closed for malformed pilot configuration and excludes a selected group until owner opt-in', async()=>{
 settings.PROACTIVE_PILOT_JSON='{}';expect(await scheduler().tick()).toMatchObject({state:'blocked',gap:'proactive_pilot_configuration'});
 expect(()=>readProactivePilot({PROACTIVE_PILOT_JSON:JSON.stringify({id:'p',revision:1,startAfterSequence:0,chatIds:['chat','chat']})})).toThrow('proactive_pilot_configuration');
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'pilot',revision:1,startAfterSequence:0,chatIds:['chat']});
 expect(pilotAllowsSubject(settings,{kind:'capture_event',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,chatId:'other',sequence:1,metadataHash:'a'.repeat(64)})).toBe(false);
 await event(1,0,'ignored','Synthetic group text','group');await scheduler().tick();expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 now+=60001;await event(2,1,'other-chat','Unselected private conversation','private','other');await scheduler().tick();expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 expect(await query('SELECT COUNT(*) n FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(0);
});
async function event(sequence=1,previousSequence=0,id="message",text="Synthetic request",kind:"private"|"group"="private",chatId="chat"){
 snapshots.set("message:"+id,{observation:"capture_snapshot",state:"available",sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:"message",sourceId:id,chatId,sourceVersion:1,watermark:sequence,conversationKind:kind,access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:"text",text,authorId:author,authorName:"Synthetic author",fromMe,occurredAt:now,messageId:id,messageVersion:1}});
 const response=await receiveCapture(new Request("https://synthetic.invalid/internal/capture",{method:"POST",headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({protocol:1,...scope,sequence,previousSequence,chatId,sourceId:id,sourceKind:"message",operation:"upsert",recordedAt:now})}),settings);expect(response.status).toBe(200);
}
it("restore hold stops the scheduler before capture processing, dispatch or inference while metadata ingress stays available",async()=>{
 await query("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,?)",scope.installationId,now).run(); await event();
 expect(await scheduler().tick()).toMatchObject({state:"blocked",gap:"restore_runtime_paused"}); expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
 expect(await query("SELECT application_state FROM assistant_capture_inbox WHERE installation_id=? AND generation=?",...keys()).first("application_state")).toBe("pending");
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_cycles WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(0);
});
it("restore hold arriving after scheduler episode preparation prevents native dispatch through the shared runtime host",async()=>{
 const prepare=EpisodeController.prototype.prepare;
 const prepared=vi.spyOn(EpisodeController.prototype,"prepare").mockImplementation(async function(this:EpisodeController,...args){const episode=await prepare.apply(this,args);await query("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,?)",scope.installationId,now).run();return episode;});
 await event();expect((await scheduler().tick()).state).toBe("uncertain");expect(prepared).toHaveBeenCalledTimes(1);expect(dispatches).toBe(0);expect(modelCalls).toBe(0);
});
it("runs the concrete capture-to-presearch-to-Flue-to-journal pipeline once for two cron calls",async()=>{
 await event();const results=await Promise.all([scheduler().tick(),scheduler().tick()]);
 expect(results.some(r=>r.state==="complete")).toBe(true);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND outcome='proposed'",...keys()).first("n")).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_cycles WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(1);
});
it('extracts canonical candidates before scheduler presearch and uses one source-bound receipt across repeated cron ticks',async()=>{
 settings.ROUTINES_PAUSED='true';await event(1,0,'canonical','Synthetic suggestion: consider Friday.');await scheduler().tick();expect(modelCalls).toBe(0);
 const source=await query("SELECT id FROM assistant_sources WHERE installation_id=? AND generation=? AND origin='whatsapp'",...keys()).first<string>('id'),control=new OwnerControl(env.DB,scope,{kind:'owner'},()=>now);expect(source).toBeTruthy();
 await control.execute({kind:'project.put',operationId:'canonical-project',id:'canonical-project',expectedVersion:0,name:'Synthetic project'});await control.execute({kind:'mission.put',operationId:'canonical-mission',id:'canonical-mission',expectedRevision:0,objective:'Explicit source-bound draft',source:{id:source!,revision:1},project:{id:'canonical-project',revision:1},state:'draft'});
 const base=model,order:string[]=[];model=async request=>{const payload=JSON.parse(request.body),prompt=JSON.parse(payload.messages.at(-1).content);if(prompt.extraction==='canonical-owner-context-v2'){order.push('canonical');expect(prompt.visibility).toBe('owner');expect(prompt.catalog.map((x:{kind:string})=>x.kind).sort()).toEqual(['mission','project']);expect(await query('SELECT phase FROM assistant_routine_cycles WHERE installation_id=? AND generation=? ORDER BY window_key DESC LIMIT 1',...keys()).first('phase')).toBe('work');return {status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({claims:[{kind:'suggestion',subject:{kind:'mission',id:'canonical-mission'},object:{kind:'project',id:'canonical-project'},predicate:'deadline',quote:'Synthetic suggestion: consider Friday.'}]})}}]})};}order.push('episode');return base(request);};
 settings.ROUTINES_PAUSED='false';now+=60001;expect(await scheduler().tick()).toMatchObject({state:'complete'});expect(order).toEqual(['canonical','episode']);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query('SELECT COUNT(*) n FROM assistant_relation_batches WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(1);expect(await query('SELECT COUNT(*) n FROM assistant_model_receipts WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(2);
 now+=60001;await scheduler().tick();expect(order).toEqual(['canonical','episode']);expect(await query('SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(1);
});
it("coalesces three callbacks of the same canonical source into one immutable observation and keeps the other events not evaluated",async()=>{
 await event(1,0,"one");await event(2,1,"one");await event(3,2,"one");
 // Snapshot watermark is the current conversation observation for every source.
 for(const [key,value]of snapshots)snapshots.set(key,{...(value as object),watermark:3});
 expect((await scheduler().tick()).state).toBe("complete");expect(modelCalls).toBe(1);
 const rows=(await query("SELECT sequence,coalesced,item_id FROM assistant_routine_event_items WHERE installation_id=? AND generation=? ORDER BY sequence",...keys()).all<{sequence:number;coalesced:number;item_id:string}>()).results;
 expect(rows.map(row=>row.coalesced)).toEqual([1,1,0]);expect(new Set(rows.map(row=>row.item_id)).size).toBe(1);
 const review=JSON.parse((await query("SELECT payload_json FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first<string>("payload_json"))!);expect(review.journal.not_evaluated).toBe(2);expect(review.journal.silence).toBe(0);
});
it.each(["missing_author","from_me"])("never invents a peer identity from %s",async kind=>{
 if(kind==="missing_author")author=null;else fromMe=true;await event();await scheduler().tick();expect(modelCalls).toBe(0);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(0);
});
it("uses an explicit opaque archive realm rather than treating authorId as WhatsApp phone identity",async()=>{
 await event();await scheduler().tick();const actor=JSON.parse((await query("SELECT actor_json FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first<string>("actor_json"))!);
 expect(actor.address).toBe(author);expect(actor.provider).toMatch(/^wa_archive:[a-f0-9]{64}$/);expect(actor.provider).not.toBe("whatsapp");
});
it("pause preserves canonical capture and visible metadata without inference",async()=>{
 settings.ROUTINES_PAUSED="true";await event();await scheduler().tick();expect(modelCalls).toBe(0);
 expect(await query("SELECT application_state FROM assistant_capture_inbox WHERE installation_id=? AND generation=?",...keys()).first("application_state")).toBe("applied");
 const review=JSON.parse((await query("SELECT payload_json FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first<string>("payload_json"))!);expect(review.paused).toBe(true);expect(review.journal.not_evaluated).toBe(1);
});
async function captureForChat(sequence:number,chatId:string,operation:'withdraw'|'upsert',available=false){
 const sourceId='source-'+chatId+'-'+sequence;
 if(available)snapshots.set('message:'+sourceId,{observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId,chatId,sourceVersion:1,watermark:sequence,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Synthetic current observation',authorId:author,authorName:'Synthetic author',fromMe:false,occurredAt:now,messageId:sourceId,messageVersion:1}});
 const response=await receiveCapture(new Request('https://synthetic.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({protocol:1,...scope,sequence,previousSequence:sequence-1,chatId,sourceId,sourceKind:'message',operation,recordedAt:now})}),settings);expect(response.status).toBe(200);
}
it('keeps withdraw-first kind unknown visible while completing paused capture and discovering another conversation',async()=>{
 settings.ROUTINES_PAUSED='true';await captureForChat(1,'a-unknown','withdraw');await captureForChat(2,'z-known','upsert',true);
 expect(await scheduler().tick()).toMatchObject({state:'complete',gap:'conversation_kind_unobserved'});
 expect(await query('SELECT kind,access_state FROM assistant_origin_conversations WHERE installation_id=? AND chat_id=?',scope.installationId,'a-unknown').first()).toEqual({kind:null,access_state:'unknown'});
 expect(await query('SELECT COUNT(*) n FROM assistant_conversations WHERE installation_id=? AND chat_id=?',scope.installationId,'a-unknown').first('n')).toBe(0);
 expect(await query('SELECT COUNT(*) n FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(1);
 const review=JSON.parse((await query('SELECT payload_json FROM assistant_routine_reviews WHERE installation_id=? AND generation=?',...keys()).first<string>('payload_json'))!);expect(review.pipelineGaps).toContain('conversation_kind_unobserved');expect(review.gaps).toBe(1);
 expect(await query('SELECT state,last_gap FROM assistant_routine_cycles WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({state:'completed',last_gap:'conversation_kind_unobserved'});expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
});
it('advances all five unknown rows, wraps its cursor, and reconsiders kind only after a real reader observation',async()=>{
 settings.ROUTINES_PAUSED='true';for(let i=0;i<5;i++)await captureForChat(i+1,'a-'+i,i===0?'upsert':'withdraw');await captureForChat(6,'z-known','upsert',true);
 expect(await scheduler().tick()).toMatchObject({state:'complete',gap:'conversation_kind_unobserved'});
 expect(await query('SELECT cursor_chat FROM assistant_routine_state WHERE installation_id=?',scope.installationId).first('cursor_chat')).toBe('a-4');
 expect(await query('SELECT state,last_gap_reason FROM assistant_materialization_results WHERE installation_id=? AND sequence=1',scope.installationId).first()).toEqual({state:'blocked',last_gap_reason:'reader_unavailable'});
 now+=60001;expect(await scheduler().tick()).toMatchObject({state:'complete',gap:'conversation_kind_unobserved'});expect(await query('SELECT cursor_chat FROM assistant_routine_state WHERE installation_id=?',scope.installationId).first('cursor_chat')).toBe('');expect(await query('SELECT COUNT(*) n FROM assistant_routine_items WHERE installation_id=?',scope.installationId).first('n')).toBe(1);
 await captureForChat(7,'a-0','upsert',true);now+=60001;expect(await scheduler().tick()).toMatchObject({state:'complete',gap:'conversation_kind_unobserved'});
 expect(await query('SELECT kind,access_state FROM assistant_origin_conversations WHERE installation_id=? AND chat_id=?',scope.installationId,'a-0').first()).toEqual({kind:'private',access_state:'available'});expect(await query('SELECT COUNT(*) n FROM assistant_conversations WHERE installation_id=? AND chat_id=?',scope.installationId,'a-0').first('n')).toBe(1);
 for(let i=1;i<5;i++)await captureForChat(7+i,'a-'+i,'upsert',true);now+=60001;expect(await scheduler().tick()).toMatchObject({state:'complete',gap:null});
 expect(modelCalls).toBe(0);expect(dispatches).toBe(0);expect(await query('SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=?',scope.installationId).first('n')).toBe(0);
});
it('does not hide an unrelated conversation replay failure behind the unknown-kind gap',async()=>{
 settings.ROUTINES_PAUSED='true';await captureForChat(1,'a-unknown','withdraw');await captureForChat(2,'z-known','upsert',true);vi.spyOn(Conversations.prototype,'replay').mockRejectedValue(new Error('synthetic unexpected replay failure'));
 expect(await scheduler().tick()).toMatchObject({state:'uncertain',gap:'routine_operation_uncertain'});expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
});
it('does not use a legacy frame to infer an unobserved conversation kind',async()=>{
 settings.ROUTINES_PAUSED='true';await query("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,0,NULL,'unknown')",...keys(),scope.sourceEpoch,scope.sourceGeneration,'legacy-unknown').run();
 await query("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,?,?,?,0,'observe')",...keys(),scope.sourceEpoch,scope.sourceGeneration,'legacy-unknown').run();const replay=vi.spyOn(Conversations.prototype,'replay');
 expect(await scheduler().tick()).toMatchObject({state:'complete',gap:'conversation_kind_unobserved'});expect(replay).not.toHaveBeenCalled();expect(await query('SELECT mode FROM assistant_conversations WHERE installation_id=?',scope.installationId).first('mode')).toBe('observe');expect(modelCalls).toBe(0);expect(dispatches).toBe(0);
});
it("keeps budget exhaustion visible without configuring a replacement account or calling a model",async()=>{
 await query("UPDATE assistant_budget_accounts SET cap_units=0 WHERE installation_id=? AND generation=?",...keys()).run();await event();await scheduler().tick();expect(modelCalls).toBe(0);
 expect(await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("last_gap")).toBe("budget_blocked");
 const review=JSON.parse((await query("SELECT payload_json FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first<string>("payload_json"))!);expect(review.budget.state).toBe("exhausted");
});
it("late cron makes only the current daily metadata review and does not replay missing days",async()=>{
 const routines=new Routines(env.DB,scope,()=>now);await routines.daily(false);now+=7*86400000;const a=await routines.daily(true),b=await routines.daily(true);expect(a.id).toBe(b.id);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(2);
 expect(a.summary.reportingScope).toBe("current_generation_cumulative");expect(a.summary.snapshotAt).toBe(now);expect(a.summary.budget.state).toBe("unconfigured");expect(a.summary.pipelineGaps).toContain("canonical_relations_not_observed");expect(a.summary.canonicalExtraction).toMatchObject({sources:0,published:0,pending:0,observation:'not_observed'});
});
it("reconciles the same uncertain episode after restart without new job, alias or model charge",async()=>{
 const timeout=vi.spyOn(AbortSignal,'timeout');await event();modelFailure=true;await scheduler().tick();const initial=await query("SELECT id,job_id,episode_id,run_id FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first();expect(modelCalls).toBe(1);
 const temporal=await query('SELECT e.deadline,j.lease_until,j.lease_generation FROM assistant_episodes e JOIN assistant_jobs j ON j.installation_id=e.installation_id AND j.generation=e.generation AND j.id=e.job_id WHERE e.installation_id=? AND e.generation=?',...keys()).first<{deadline:number;lease_until:number;lease_generation:number}>();
 now+=60001;await scheduler().tick();expect(await query("SELECT id,job_id,episode_id,run_id FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first()).toEqual(initial);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query('SELECT e.deadline,j.lease_until,j.lease_generation FROM assistant_episodes e JOIN assistant_jobs j ON j.installation_id=e.installation_id AND j.generation=e.generation AND j.id=e.job_id WHERE e.installation_id=? AND e.generation=?',...keys()).first()).toEqual(temporal);expect(timeout).toHaveBeenCalledWith(temporal!.deadline-now);
 expect(await query("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(1);
});
it('gives new scheduler episodes time for native preparation without renewing an existing paid attempt',async()=>{
 const timeout=vi.spyOn(AbortSignal,'timeout'),start=now;await event();await scheduler().tick();
 const episode=await query('SELECT deadline,binding_json FROM assistant_episodes WHERE installation_id=? AND generation=?',...keys()).first<{deadline:number;binding_json:string}>();
 const lease=JSON.parse(episode!.binding_json).lease.lease_until as number;
 expect(lease).toBe(start+180000);expect(episode!.deadline).toBe(start+120000);
 expect(episode!.deadline).toBeLessThan(lease!);
 expect(timeout).toHaveBeenCalledWith(120000);
 expect(OwnerRuntime.durability).toEqual({maxAttempts:1,timeoutMs:120000});expect(InterlocutorRuntime.durability).toEqual({maxAttempts:1,timeoutMs:120000});
});
it('holds an expired prepared pilot episode without dispatching or changing its immutable episode, job or costs',async()=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'expired-prepared-pilot',revision:1,startAfterSequence:0,chatIds:['chat']});
 const denied=vi.spyOn(EpisodeController.prototype,'dispatch').mockResolvedValue({state:'blocked'});
 await event();expect(await scheduler().tick()).toMatchObject({state:'uncertain'});expect(dispatches).toBe(0);expect(modelCalls).toBe(0);
 const item=await query('SELECT id,job_id,episode_id FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first<{id:string;job_id:string;episode_id:string}>();
 const temporal=await query('SELECT e.state,e.deadline,j.lease_until FROM assistant_episodes e JOIN assistant_jobs j ON j.installation_id=e.installation_id AND j.generation=e.generation AND j.id=e.job_id WHERE e.installation_id=? AND e.generation=? AND e.id=?',...keys(),item!.episode_id).first<{state:string;deadline:number;lease_until:number}>();expect(temporal!.state).toBe('prepared');
 const tables=['assistant_jobs','assistant_job_ledger','assistant_episodes','assistant_episode_calls','assistant_model_receipts','assistant_budget_accounts','assistant_budget_reservations','assistant_shadow_decisions'];
 const preserved=async()=>Promise.all(tables.map(async table=>({table,rows:(await query(`SELECT * FROM ${table} WHERE installation_id=? AND generation=? ORDER BY rowid`,...keys()).all()).results})));
 const before=await preserved();now=temporal!.deadline+1;
 expect((await scheduler().tick()).state).not.toBe('held');expect(await query('SELECT active_item_id FROM assistant_routine_state WHERE installation_id=? AND generation=?',...keys()).first('active_item_id')).toBe(item!.id);
 now=temporal!.lease_until+1;
 expect(await scheduler().tick()).toMatchObject({state:'held',gap:'expired_model_attempt_preserved',reconcileOnly:true});
 expect(await preserved()).toEqual(before);expect(modelCalls).toBe(0);expect(dispatches).toBe(0);expect(denied).toHaveBeenCalledTimes(1);
 expect(await query('SELECT state,phase,last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id=?',...keys(),item!.id).first()).toEqual({state:'uncertain',phase:'held_expired',last_gap:'expired_model_attempt_preserved'});
 expect(await query('SELECT state,active_item_id FROM assistant_routine_state WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({state:'idle',active_item_id:null});
});
it('holds an expired uncertain pilot attempt as metadata only and lets one new message advance',async()=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'expired-pilot',revision:1,startAfterSequence:0,chatIds:['chat']});
 const nativeDriver=driver;driver=(profile,runtimeId)=>{const port=nativeDriver(profile,runtimeId);return {dispatch:port.dispatch,read:async(receipt,options)=>{await port.read(receipt,options);throw Error('synthetic native ACK lost after a completed paid model response');}};};
 await event(1,0,'expired');expect(await scheduler().tick()).toMatchObject({state:'uncertain'});
 expect(await query("SELECT COUNT(*) n FROM assistant_model_receipts WHERE installation_id=? AND generation=? AND state='complete'",...keys()).first('n')).toBe(1);
 const item=await query('SELECT * FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first<{id:string;job_id:string;episode_id:string;binding_json:string}>();
 const lease=await query('SELECT lease_until FROM assistant_jobs WHERE installation_id=? AND generation=? AND id=?',...keys(),item!.job_id).first<number>('lease_until');
 const tables=['assistant_jobs','assistant_job_ledger','assistant_episodes','assistant_episode_calls','assistant_model_receipts','assistant_budget_accounts','assistant_budget_reservations','assistant_shadow_decisions'];
 const preserved=async()=>Promise.all(tables.map(async table=>({table,rows:(await query(`SELECT * FROM ${table} WHERE installation_id=? AND generation=? ORDER BY rowid`,...keys()).all()).results})));
 const before=await preserved();expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 now=lease!+1;await event(2,1,'next','Synthetic independent request');
 for(const [key,value]of snapshots)snapshots.set(key,{...(value as object),watermark:2});
 expect(await pilotBindingCurrent(settings,JSON.parse(item!.binding_json))).toBe(false);
 expect(await scheduler().tick()).toMatchObject({state:'held',gap:'expired_model_attempt_preserved',reconcileOnly:true});
 expect(await preserved()).toEqual(before);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query('SELECT state,phase,last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id=?',...keys(),item!.id).first()).toEqual({state:'uncertain',phase:'held_expired',last_gap:'expired_model_attempt_preserved'});
 expect(await query('SELECT state,active_item_id FROM assistant_routine_state WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({state:'idle',active_item_id:null});
 driver=nativeDriver;modelFailure=false;now+=60001;await scheduler().tick();expect(modelCalls).toBe(2);expect(dispatches).toBe(2);
 const current=await query('SELECT id,state FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id<>?',...keys(),item!.id).first<{id:string;state:string}>();expect(current!.state).toBe('complete');
 now+=60001;await scheduler().tick();expect(modelCalls).toBe(2);expect(dispatches).toBe(2);
 const {search}=hostConfiguredSearch(settings,'automation',()=>now),host=new EpisodeController(env.DB,{...scope,period:'2026-10-26'},search,model,DEFAULT_BROKER_CONFIG,{purpose:'automation',clock:()=>now});
 const old=boundEpisode((await host.episodes.get(item!.episode_id))!);
 await expect(host.model(old.id,{profile:old.profile,runtimeId:old.runtime_id,submissionId:old.submission_id!},{messages:[{role:'user',content:host.message(old)}]})).rejects.toThrow('episode_denied');
 expect(await host.publish(old.id,{...old.receipt!.receipt,text:'{}',data:{}})).toEqual({state:'blocked'});expect(modelCalls).toBe(2);
 expect((await host.episodes.get(old.id))!.deadline).toBe(old.deadline);
});
it.each(['different_lease','published_proposal'] as const)('does not detach an expired pilot attempt with %s',async reason=>{
 settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'expired-pilot',revision:1,startAfterSequence:0,chatIds:['chat']});
 modelFailure=true;await event();await scheduler().tick();
 const item=await query('SELECT id,job_id FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first<{id:string;job_id:string}>();
 const lease=await query('SELECT lease_until FROM assistant_jobs WHERE installation_id=? AND generation=? AND id=?',...keys(),item!.job_id).first<number>('lease_until');
 if(reason==='different_lease')await query('UPDATE assistant_jobs SET lease_generation=lease_generation+1 WHERE installation_id=? AND generation=? AND id=?',...keys(),item!.job_id).run();
 else await query("INSERT INTO assistant_shadow_decisions(installation_id,generation,id,job_id,request_hash,lease_generation,episode_id,outcome,binding_hash,pack_hash,proposal_hash,dependencies_json,receipts_json,proposal_json,recorded_at) SELECT d.installation_id,d.generation,?,d.job_id,d.request_hash,d.lease_generation,d.episode_id,'proposed',e.binding_hash,?,?,'[]','[]','{}',d.recorded_at FROM assistant_shadow_decisions d JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id WHERE d.installation_id=? AND d.generation=? AND d.job_id=? LIMIT 1",'d'.repeat(64),'e'.repeat(64),'f'.repeat(64),...keys(),item!.job_id).run();
 now=lease!+1;expect((await scheduler().tick()).state).not.toBe('held');
 expect(await query('SELECT phase FROM assistant_routine_items WHERE installation_id=? AND generation=? AND id=?',...keys(),item!.id).first('phase')).toBe('episode');expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
});
it("claimId never leases a different pending job or renews an old processing lease",async()=>{
 const source=await new SourceController(env.DB,scope,{kind:"owner"},()=>now).create({originKey:"owner",text:"Synthetic owner directive",occurredAt:now}),queue=new JobQueue(env.DB,scope);
 const create=(key:string)=>queue.enqueue({kind:"reasoning",dedupeKey:key,sourceId:source.id,sourceRevision:1,request:"Synthetic owner directive",runtime:"flue",subject:{kind:"owner_request",sourceId:source.id,sourceRevision:1,requestKey:key}},now);
 const first=await create("first"),second=await create("second");expect((await queue.claimId(second.id,now))?.id).toBe(second.id);expect((await queue.get(first.id))?.state).toBe("pending");now+=100000;expect(await queue.claimId(second.id,now)).toBeNull();
});
it("fences a late coordinator and permits only reconciliation of its exact active item",async()=>{
 const routines=new Routines(env.DB,scope,()=>now),first=(await routines.begin(false))!;await routines.phase(first,"ingest","existing-item");now+=840001;
 expect(await routines.begin(false)).toBeNull();const recovered=await routines.reconcileBegin(false);expect(recovered).not.toBeNull();expect(await routines.current(first)).toBe(false);
 await routines.finish(first);expect(await routines.current(recovered!)).toBe(true);
});

function semanticEngine(cold=false,dirtyLost=false){
 let input:import("../assistant/engine").EngineSearch,ticket:import("../assistant/engine").SearchTicket,submitted=false;
 const state={running:!cold,index:{epoch:"index-e",revision:"a".repeat(64),lost:false,state:"checkpoint_confirmed",sources:[] as {id:string;revision:number;version:number;hash:string}[]},maintenance:false,quarantine:false,checkpoint:{id:"checkpoint-1",epoch:"index-e",revision:"a".repeat(64),phase:"confirmed"}};
 if(dirtyLost){state.running=false;state.index.revision="b".repeat(64);state.index.state="needs_checkpoint";state.index.lost=true;}
 const outcome=()=>({state:"complete",operationId:ticket.operationId,indexRevision:ticket.indexRevision,indexState:"checkpoint_confirmed",result:{candidates:input.allowedSources.map(ref=>({...ref,via:["chunks"],relationCount:0})),missing:[]}});
 // CPserver stores every physical version, whereas Engine stamps keep latest
 // by source ID. The strict count is essential: an always-green CP hid #53.
 const physical=new Map<string,SourceStamp>(),key=(ref:SourceStamp)=>JSON.stringify([ref.id,ref.version,ref.hash]);
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])])):value;
 let beforeVerify:(()=>Promise<void>)|undefined;
 const port={get running(){return state.running;},verify:vi.fn(async(manifest:CheckpointManifest):Promise<IndexProof>=>{
   if(beforeVerify)await beforeVerify();
   if(physical.size!==manifest.sources.length||manifest.sources.some(ref=>!physical.has(key(ref))))throw new Error("strict_all_stored_versions_mismatch");
   const {imageRef:_,...identity}=manifest.identity;return {...identity,indexEpoch:manifest.indexEpoch,indexRevision:manifest.indexRevision,manifestHash:await bridgeHash(canonical(manifest)),closed:false,poisoned:false,pendingOperations:0,sources:manifest.sources.map(({id,version,hash})=>({id,version,hash,originalHash:hash,chunks:1}))};
 }),start:vi.fn(async()=>{throw new Error("unexpected preflight wake");}),request:vi.fn(async()=>{throw new Error("unexpected preflight request");}),deny:vi.fn(async()=>{}),destroy:vi.fn(async()=>{}),intercept:vi.fn(async()=>{})};
 const gates=new Map<string,unknown>();const read=async(key:string):Promise<unknown>=>gates.has(key)?gates.get(key):key==="index"?{...state.index,namespace:JSON.stringify({installationId:scope.installationId,generation:scope.generation}),indexState:state.index.state}:key==="checkpoint"?{phase:state.checkpoint.phase}:key==="maintenance"?state.maintenance:key==="quarantine"?state.quarantine:key==="active"?null:undefined;
 const noWrite=vi.fn(async()=>{throw new Error("preflight cannot write");}),storage={get:read,transaction:async(action:(tx:{get:typeof read})=>Promise<unknown>)=>action({get:read})};
 const host=new CogneeEngine({installationId:scope.installationId,generation:scope.generation},{get:read as never,put:noWrite},port,new CanonicalEngineGuard(settings),()=>now);
 const core=Object.assign(Object.create(CogneeContainer.prototype),{ctx:{storage,container:{images:{cognee:"synthetic-pinned-image"}}},env:settings,engine:host,port}) as CogneeContainer;
 const engine={_state:state,_physical:physical,_port:port,_noWrite:noWrite,_gates:gates,_beforeVerify:(action:()=>Promise<void>)=>{beforeVerify=action;},
 indexPreflight:vi.fn(async(expected:{indexEpoch:string;indexRevision:string})=>core.indexPreflight(expected)),lifecycleState:vi.fn(async()=>structuredClone(state)),restoreCheckpoint:vi.fn(async()=>{state.running=true;return {state:"checkpoint_confirmed"};}),checkpoint:vi.fn(async()=>{
   if(physical.size!==state.index.sources.length){state.checkpoint.phase="rebuild_required";state.maintenance=true;state.running=false;return {state:"rebuild_required"};}
   state.index.state="checkpoint_confirmed";state.checkpoint.revision=state.index.revision;return {state:"checkpoint_confirmed"};}),
 ingest:vi.fn(async(value:import("../assistant/engine").EngineIngest)=>{const ref=value.source.fence.source,stamp={id:ref.id,revision:ref.revision,version:ref.version,hash:ref.hash};physical.set(key(stamp),stamp);state.index.sources=state.index.sources.filter(row=>row.id!==ref.id);state.index.sources.push(stamp);state.index.revision="c".repeat(64);state.index.state="needs_checkpoint";return {state:"complete"};}),ingestReceipt:vi.fn(async()=>({state:"uncertain"})),
 prepare:vi.fn(async(alias:string,request:import("../assistant/engine").EngineSearch)=>{input=request;ticket={alias,requestHash:await import("../assistant/ingress").then(m=>m.bridgeHash(request)),operationId:"b".repeat(64),indexEpoch:state.index.epoch,indexRevision:state.index.revision};return {state:"prepared",ticket};}),submit:vi.fn(async()=>{submitted=true;return outcome();}),lookupTicket:vi.fn(async()=>submitted?outcome():{state:"uncertain",reason:"not_submitted",operationId:ticket.operationId})};
 settings.COGNEE={idFromName:()=>({}),get:()=>engine} as unknown as NonNullable<AssistantEnv["COGNEE"]>;return engine;
}
it("requires visible maintenance before warm/ingest when a current source replaces an indexed version",async()=>{
 const engine=semanticEngine();await event();await scheduler().tick();const original=structuredClone(engine._state.checkpoint);expect(engine.ingest).toHaveBeenCalledTimes(1);
 now+=60001;await event(2,1,"message","Corrected request");const value=snapshots.get("message:message") as {content:object};snapshots.set("message:message",{...value,sourceVersion:2,content:{...value.content,messageVersion:2}});await scheduler().tick();now+=60001;await scheduler().tick();
 expect(engine._state.checkpoint).toEqual(original);expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.checkpoint).toHaveBeenCalledTimes(1);expect(engine.restoreCheckpoint).not.toHaveBeenCalled();expect(modelCalls).toBe(0);
 expect((await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=? ORDER BY source_revision DESC",...keys()).all<{last_gap:string}>()).results.some(row=>row.last_gap==="index_maintenance_required")).toBe(true);
});
it("refuses an already populated multi-version index without moving or destroying its confirmed CP",async()=>{
 const engine=semanticEngine(),owner=new SourceController(env.DB,scope,{kind:"owner"},()=>now),first=await owner.create({originKey:"old",text:"Old private source",occurredAt:now}),old=(await new SourceAccess(env.DB,scope).read({kind:"owner"},first.id))!;
 await engine.ingest({actor:{kind:"owner"},source:old});await engine.checkpoint();const original=structuredClone(engine._state.checkpoint);await owner.correct(first.id,1,{text:"Corrected private source",occurredAt:now});const current=(await new SourceAccess(env.DB,scope).read({kind:"owner"},first.id))!;await engine.ingest({actor:{kind:"owner"},source:current});engine.ingest.mockClear();engine.checkpoint.mockClear();
 await event();await scheduler().tick();expect(engine._physical.size).toBe(2);expect(engine._state.checkpoint).toEqual(original);expect(engine.checkpoint).not.toHaveBeenCalled();expect(engine.ingest).not.toHaveBeenCalled();expect(engine.restoreCheckpoint).not.toHaveBeenCalled();expect(modelCalls).toBe(0);expect(engine._noWrite).not.toHaveBeenCalled();
});
async function populatedPrivate(engine:ReturnType<typeof semanticEngine>){
 const owner=new SourceController(env.DB,scope,{kind:"owner"},()=>now),first=await owner.create({originKey:"private-other-project",text:"Unrelated private owner source",occurredAt:now}),source=(await new SourceAccess(env.DB,scope).read({kind:"owner"},first.id))!;
 await engine.ingest({actor:{kind:"owner"},source});await engine.checkpoint();engine.ingest.mockClear();engine.checkpoint.mockClear();return {owner,source};
}
it("requires visible maintenance before restoring a cold global CP that contains a withdrawn source",async()=>{
 const engine=semanticEngine(),{owner,source}=await populatedPrivate(engine),original=structuredClone(engine._state.checkpoint);await owner.withdraw(source.id,1);engine._state.running=false;
 await event();await scheduler().tick();expect(engine.restoreCheckpoint).not.toHaveBeenCalled();expect(engine.ingest).not.toHaveBeenCalled();expect(engine.checkpoint).not.toHaveBeenCalled();expect(engine._port.verify).not.toHaveBeenCalled();expect(engine._state.checkpoint).toEqual(original);expect(modelCalls).toBe(0);
 expect(await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("last_gap")).toBe("index_maintenance_required");
});
it("keeps an active private source outside the guest pack valid in the global index",async()=>{
 const engine=semanticEngine(),{source}=await populatedPrivate(engine);await event();expect((await scheduler().tick()).state).toBe("pending");now+=60001;expect((await scheduler().tick()).state).toBe("complete");
 expect(modelCalls).toBe(1);expect(engine._physical.size).toBe(2);expect(engine._state.checkpoint.phase).toBe("confirmed");expect(engine._state.index.sources.some(row=>row.id===source.id)).toBe(true);expect(engine.submit.mock.calls[0]).toBeDefined();expect(engine._noWrite).not.toHaveBeenCalled();
 const item=await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("last_gap");expect(item).toBeNull();
});
it("reports an unavailable origin without inferring withdrawal or starting another ingestion",async()=>{
 const engine=semanticEngine();await event(1,0,"unavailable");await scheduler().tick();const original=structuredClone(engine._state.checkpoint);await query("UPDATE assistant_routine_items SET state='blocked' WHERE installation_id=? AND generation=?",...keys()).run();
 snapshots.delete("message:unavailable");now+=60001;await event(2,1,"current");await scheduler().tick();expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.checkpoint).toHaveBeenCalledTimes(1);expect(engine._state.checkpoint).toEqual(original);expect(modelCalls).toBe(0);
 expect(await query("SELECT COUNT(*) n FROM assistant_sources WHERE installation_id=? AND generation=? AND status<>'active'",...keys()).first("n")).toBe(0);
 expect((await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).all<{last_gap:string}>()).results.some(row=>row.last_gap==="index_preflight_unavailable")).toBe(true);
});
it("rechecks global source guards after native verification before permitting the next effect",async()=>{
 const engine=semanticEngine(),{owner,source}=await populatedPrivate(engine),original=structuredClone(engine._state.checkpoint);let changed=false;
 engine._beforeVerify(async()=>{if(!changed){changed=true;await owner.withdraw(source.id,1);}});await event();await scheduler().tick();expect(changed).toBe(true);expect(engine._port.verify).toHaveBeenCalledTimes(1);expect(engine.ingest).not.toHaveBeenCalled();expect(engine.checkpoint).not.toHaveBeenCalled();expect(engine._state.checkpoint).toEqual(original);expect(modelCalls).toBe(0);expect(engine._noWrite).not.toHaveBeenCalled();
});
it("verifies a clean appended physical inventory without lifecycle effects or receipt/ledger writes",async()=>{
 const engine=semanticEngine();await populatedPrivate(engine);const before=structuredClone(engine._state),budget=await new InferenceBudget(env.DB,{...scope,period:"2026-10-26"}).status();
 expect(await engine.indexPreflight({indexEpoch:before.index.epoch,indexRevision:before.index.revision})).toMatchObject({state:"verified",sourceCount:1});expect(engine._state).toEqual(before);expect(engine._port.start).not.toHaveBeenCalled();expect(engine._port.destroy).not.toHaveBeenCalled();expect(engine._port.deny).not.toHaveBeenCalled();expect(engine._noWrite).not.toHaveBeenCalled();expect(await new InferenceBudget(env.DB,{...scope,period:"2026-10-26"}).status()).toEqual(budget);
});
it.each([false,0,"",{operationId:"unresolved"}])("refuses persisted active marker %s without physical or financial effects",async active=>{
 const engine=semanticEngine();await populatedPrivate(engine);engine._gates.set("active",active);const before=structuredClone(engine._state);
 expect(await engine.indexPreflight({indexEpoch:before.index.epoch,indexRevision:before.index.revision})).toMatchObject({state:"unavailable"});expect(engine._port.verify).not.toHaveBeenCalled();expect(engine._noWrite).not.toHaveBeenCalled();expect(engine._state).toEqual(before);
});
it("keeps physical exclusion after the verification deadline until the real TCP promise settles",async()=>{
 const engine=semanticEngine();await populatedPrivate(engine);vi.useFakeTimers();let release!:()=>void;
 engine._beforeVerify(()=>new Promise<void>(resolve=>{release=resolve;}));const expected={indexEpoch:engine._state.index.epoch,indexRevision:engine._state.index.revision};
 const pending=engine.indexPreflight(expected);await vi.waitFor(()=>expect(engine._port.verify).toHaveBeenCalledTimes(1),{timeout:5000});await vi.advanceTimersByTimeAsync(60001);
 expect(await pending).toMatchObject({state:"unavailable",reason:"index_verification_unavailable"});expect(await engine.indexPreflight(expected)).toMatchObject({state:"unavailable"});expect(engine._port.verify).toHaveBeenCalledTimes(1);expect(engine._noWrite).not.toHaveBeenCalled();
 engine._beforeVerify(async()=>{});release();await vi.waitFor(async()=>expect(await engine.indexPreflight(expected)).toMatchObject({state:"verified"}),{timeout:5000});expect(engine._state.checkpoint.phase).toBe("confirmed");
});
it("restore hold denies Core preflight without remote verification or changing lifecycle metadata",async()=>{
 const engine=semanticEngine();await populatedPrivate(engine);const before=structuredClone(engine._state);
 await query("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,?)",scope.installationId,now).run();
 expect(await engine.indexPreflight({indexEpoch:before.index.epoch,indexRevision:before.index.revision})).toMatchObject({state:"unavailable",reason:"restore_execution_blocked"});
 expect(engine._port.verify).not.toHaveBeenCalled();expect(engine._noWrite).not.toHaveBeenCalled();expect(engine._state).toEqual(before);expect(modelCalls).toBe(0);
});
it("restore hold arriving during Core verification prevents publishing a ready preflight",async()=>{
 const engine=semanticEngine();await populatedPrivate(engine);const before=structuredClone(engine._state);
 engine._beforeVerify(async()=>{await query("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,?)",scope.installationId,now).run();});
 expect(await engine.indexPreflight({indexEpoch:before.index.epoch,indexRevision:before.index.revision})).toMatchObject({state:"unavailable"});
 expect(engine._port.verify).toHaveBeenCalledTimes(1);expect(engine._noWrite).not.toHaveBeenCalled();expect(engine._state).toEqual(before);expect(modelCalls).toBe(0);
});
it("bounds all global origin checks by one deadline and six in flight without queuing late work",async()=>{
 const engine=semanticEngine(),owner=new SourceController(env.DB,scope,{kind:"owner"},()=>now),access=new SourceAccess(env.DB,scope);
 for(let i=0;i<9;i++){const ref=await owner.create({originKey:"global-"+i,text:"Synthetic global source "+i,occurredAt:now});await query("UPDATE assistant_sources SET origin='whatsapp',conversation_id='chat' WHERE installation_id=? AND generation=? AND id=?",...keys(),ref.id).run();await engine.ingest({actor:{kind:"owner"},source:(await access.read({kind:"owner"},ref.id))!});}await engine.checkpoint();
 vi.spyOn(OriginGuard.prototype,"fences").mockImplementation(async ids=>ids.map(canonicalId=>({...scope,canonicalId,sourceKind:"message" as const,sourceId:canonicalId,chatId:"chat",revision:1,version:1,watermark:1,hash:"a".repeat(64),conversationKind:"private" as const,policyRevision:0,policyMode:"attend"})));
 const releases:(()=>void)[]=[],check=vi.spyOn(OriginGuard.prototype,"check").mockImplementation(()=>new Promise<boolean>(resolve=>{releases.push(()=>resolve(false));}));vi.useFakeTimers();
 const pending=engine.indexPreflight({indexEpoch:engine._state.index.epoch,indexRevision:engine._state.index.revision});await vi.waitFor(()=>expect(check).toHaveBeenCalledTimes(6),{timeout:1000});await vi.advanceTimersByTimeAsync(5001);
 expect(await pending).toMatchObject({state:"unavailable",reason:"origin_unavailable"});for(const release of releases)release();await Promise.resolve();await Promise.resolve();expect(check).toHaveBeenCalledTimes(6);expect(engine._port.verify).not.toHaveBeenCalled();expect(engine._noWrite).not.toHaveBeenCalled();
});
it("does not begin a late reader RPC when the preflight deadline expires during the local origin snapshot",async()=>{
 settings.ROUTINES_PAUSED="true";await event();await scheduler().tick();const source=await query("SELECT canonical_id FROM assistant_source_origins WHERE installation_id=? AND generation=?",...keys()).first<string>("canonical_id");
 const origin=new OriginGuard(env.DB,()=>scope,settings.CAPTURE_READER!,secret),fence=(await origin.fence(source!))!,snapshot=origin.fence.bind(origin),reader=vi.spyOn(settings.CAPTURE_READER!,"readSnapshot");let current=true;
 vi.spyOn(origin,"fence").mockImplementationOnce(async id=>{const result=await snapshot(id);current=false;return result;});
 expect(await origin.check(fence,()=>current)).toBe(false);expect(reader).not.toHaveBeenCalled();expect(modelCalls).toBe(0);
});
it("honors the elapsed preflight budget before its deadline timer has been dispatched",async()=>{
 settings.ROUTINES_PAUSED="true";await event();await scheduler().tick();const id=await query("SELECT canonical_id FROM assistant_source_origins WHERE installation_id=? AND generation=?",...keys()).first<string>("canonical_id");
 const source=(await new SourceAccess(env.DB,scope).read({kind:"owner"},id!))!,engine=semanticEngine();await engine.ingest({actor:{kind:"owner"},source});await engine.checkpoint();
 const reader=vi.spyOn(settings.CAPTURE_READER!,"readSnapshot"),read=SourceAccess.prototype.readMany;let elapsed=false,timerFired=false;vi.useFakeTimers();
 const marker=setTimeout(()=>{timerFired=true;},5000);
 vi.spyOn(SourceAccess.prototype,"readMany").mockImplementation(async function(this:SourceAccess,...args:Parameters<SourceAccess["readMany"]>){const value=await read.apply(this,args);if(!elapsed){elapsed=true;vi.setSystemTime(Date.now()+5001);}return value;});
 expect(await engine.indexPreflight({indexEpoch:engine._state.index.epoch,indexRevision:engine._state.index.revision})).toMatchObject({state:"unavailable",reason:"origin_unavailable"});
 expect(timerFired).toBe(false);clearTimeout(marker);expect(reader).not.toHaveBeenCalled();expect(engine._port.verify).not.toHaveBeenCalled();expect(engine._noWrite).not.toHaveBeenCalled();expect(modelCalls).toBe(0);
});
it("shows the current maintenance gap in owner health and cumulative review without bodies or foreign affinity",async()=>{
 const engine=semanticEngine(),{owner,source}=await populatedPrivate(engine);await owner.withdraw(source.id,1);engine._state.running=false;await event();await scheduler().tick();
 await query("INSERT INTO assistant_routine_state(installation_id,generation,source_epoch,source_generation,state,last_run_at,last_gap) VALUES(?,?,'foreign-epoch',?,'uncertain',?,'index_preflight_unavailable')",...keys(),scope.sourceGeneration,now+999).run();
 const health=await assistantHealth(settings,{kind:"owner"},now),review=(await new Routines(env.DB,scope,()=>now).daily(false)).summary;
 expect(health).toMatchObject({installation:{scheduler:{observation:"host_scheduler_receipt",state:"idle",lastRunAt:now,latestGap:"index_maintenance_required"}}});expect(review.indexGaps).toEqual([{reason:"index_maintenance_required",count:1}]);expect(review.reportingScope).toBe("current_generation_cumulative");expect(review.snapshotAt).toBe(now);expect(review.pipelineGaps).toContain("index_maintenance_required");expect(JSON.stringify(health)).not.toContain(source.id);expect(JSON.stringify(review)).not.toContain(source.text!);expect(modelCalls).toBe(0);
});
it("warms the exact checkpoint, indexes once, then performs semantic presearch before claiming a nominal episode",async()=>{
 const engine=semanticEngine(true);await event();expect((await scheduler().tick()).state).toBe("pending");
 expect(engine.restoreCheckpoint).toHaveBeenCalledWith({checkpointId:"checkpoint-1",indexEpoch:"index-e",indexRevision:"a".repeat(64)});expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.checkpoint).toHaveBeenCalledWith({indexEpoch:"index-e",indexRevision:"c".repeat(64)});
 expect(await query("SELECT COUNT(*) n FROM assistant_episodes WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(0);expect(modelCalls).toBe(0);
 now+=60001;expect((await scheduler().tick()).state).toBe("complete");expect(engine.submit).toHaveBeenCalledTimes(1);expect(modelCalls).toBe(1);expect(engine.ingest).toHaveBeenCalledTimes(1);
});
it("never restores an older checkpoint over a dirty lost index or starts an empty replacement",async()=>{
 const engine=semanticEngine(false,true);await event();await scheduler().tick();expect(engine.restoreCheckpoint).not.toHaveBeenCalled();expect(engine.ingest).not.toHaveBeenCalled();expect(engine.submit).not.toHaveBeenCalled();expect(modelCalls).toBe(0);
 expect(await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("last_gap")).toBe("index_maintenance_required");
});
it("lost ingest acknowledgement only looks up the existing exact receipt in the original epoch",async()=>{
 const engine=semanticEngine();engine.ingest.mockResolvedValue({state:"uncertain"});await event();await scheduler().tick();now+=60001;await scheduler().tick();expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.ingestReceipt).toHaveBeenCalledWith(expect.any(Object),"index-e");expect(modelCalls).toBe(0);expect(engine.submit).not.toHaveBeenCalled();
});

async function summarySurface(){
 const bot="synthetic_bot",link=new TelegramLink(env.DB,scope,bot,secret,()=>now),a=await link.execute({kind:"telegram_link.begin",operationId:"begin",expectedRevision:0}) as {link:string;pairingId:string};
 const start=(update_id:number,url:string)=>({update_id,message:{message_id:update_id,date:Math.floor(now/1000),from:{id:101,is_bot:false},chat:{id:101,type:"private"},text:`/start ${new URL(url).searchParams.get("start")}`}});
 await link.receive(start(1,a.link));const b=await link.execute({kind:"telegram_link.confirm",operationId:"confirm",pairingId:a.pairingId}) as {link:string};await link.receive(start(2,b.link));
 let thread=10;const api:TelegramApi={inspect:vi.fn(async()=>true),createTopic:vi.fn(async()=>thread++),send:vi.fn(async()=>200),answer:vi.fn(async()=>{})},journal={get:vi.fn(()=>{throw new Error("summary is not a proposal");}),admitReview:vi.fn(()=>{throw new Error("summary is not a proposal");})} as unknown as Pick<DecisionJournal,"get"|"admitReview">;
 const review=new TelegramReview(env.DB,scope,bot,secret,api,journal,()=>now);await review.execute({kind:"topics.ensure"});return {review,api,journal};
}
it("publishes one typed metadata summary to the authenticated private summaries thread without fabricating a proposal",async()=>{
 const {review,api,journal}=await summarySurface(),daily=await new Routines(env.DB,scope,()=>now).daily(false);
 expect(await review.publishDailySummary(daily.id)).toEqual({state:"sent"});expect(await review.publishDailySummary(daily.id)).toEqual({state:"sent"});expect(api.send).toHaveBeenCalledTimes(1);
 expect(vi.mocked(api.send).mock.calls[0].slice(0,2)).toEqual(["101",11]);expect(vi.mocked(api.send).mock.calls[0][2]).toContain("Silêncios registrados");expect(vi.mocked(api.send).mock.calls[0][3]).toEqual([]);expect(journal.get).not.toHaveBeenCalled();
});
it("keeps a summary uncertain after transport failure and never repeats it",async()=>{
 const {review,api}=await summarySurface(),daily=await new Routines(env.DB,scope,()=>now).daily(true);vi.mocked(api.send).mockRejectedValue(new Error("accepted unknown"));
 expect(await review.publishDailySummary(daily.id)).toEqual({state:"uncertain"});await review.publishDailySummary(daily.id);expect(api.send).toHaveBeenCalledTimes(1);
});
it("rejects summary admission if the owner link is revoked during preflight",async()=>{
 const {review,api}=await summarySurface(),daily=await new Routines(env.DB,scope,()=>now).daily(false);vi.mocked(api.inspect).mockImplementation(async()=>{await query("UPDATE assistant_telegram_links SET revision=2,state='revoked',user_id=NULL,chat_id=NULL,activation_cut=NULL WHERE installation_id=? AND generation=?",...keys()).run();return true;});
 expect(await review.publishDailySummary(daily.id)).toEqual({state:"blocked"});expect(api.send).not.toHaveBeenCalled();
});
it("daily metadata counts current blocked follow-ups without creating an evaluation or closing the commitment",async()=>{
 const source=await new SourceController(env.DB,scope,{kind:"owner"},()=>now).create({originKey:"condition",text:"Synthetic conditional commitment",occurredAt:now});
 await query("INSERT INTO assistant_follow_ups(installation_id,generation,id,version,source_id,source_revision,origin,conversation_id,purpose,timezone,condition_text,state,next_evaluation_at) VALUES(?,?,'fup',1,?,1,'owner_request','chat','Synthetic return','UTC','Pending condition','awaiting_condition',?)",...keys(),source.id,now).run();
 const daily=await new Routines(env.DB,scope,()=>now).daily(false);expect(daily.summary.blockedFollowUps).toBe(1);expect(await query("SELECT state FROM assistant_follow_ups WHERE installation_id=? AND generation=?",...keys()).first("state")).toBe("awaiting_condition");expect(modelCalls).toBe(0);
});

it.each(["observe","ignore"])("group %s policy keeps its own actor boundary",async mode=>{
 await query("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,revision,kind,excluded,group_mode) VALUES(?,?,'chat',1,'group',0,?)",...keys(),mode).run();
 await event(1,0,"group-message","Synthetic request","group");await scheduler().tick();
 expect(modelCalls).toBe(mode==="observe"?1:0);
 if(mode==="observe")expect(JSON.parse((await query("SELECT actor_json FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first<string>("actor_json"))!)).toEqual({kind:"owner"});
 else expect(await query("SELECT application_state FROM assistant_capture_inbox WHERE installation_id=? AND generation=?",...keys()).first("application_state")).toBe("applied");
});

it("lost semantic submit ACK reconciles the same receipt before a later nominal model lease",async()=>{
 const engine=semanticEngine();await event();await scheduler().tick();
 const submit=engine.submit.getMockImplementation()!;engine.submit.mockImplementationOnce(async()=>{await submit();throw new Error("submit ACK lost");});
 now+=60001;await scheduler().tick();expect(modelCalls).toBe(0);const initial=await query("SELECT id,job_id,run_id FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first();
 now+=60001;expect((await scheduler().tick()).state).toBe("pending");expect(modelCalls).toBe(0);
 now+=60001;expect((await scheduler().tick()).state).toBe("complete");expect(engine.submit).toHaveBeenCalledTimes(1);expect(modelCalls).toBe(1);
 expect(await query("SELECT id,job_id,run_id FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first()).toEqual(initial);
});
it("reconciles an exact completed ingest receipt without a second ingest or a replacement checkpoint",async()=>{
 const engine=semanticEngine(),ingest=engine.ingest.getMockImplementation()!;engine.ingest.mockImplementationOnce(async input=>{await ingest(input);throw new Error("ingest ACK lost");});engine.ingestReceipt.mockResolvedValue({state:"complete"});
 await event();await scheduler().tick();expect(engine.checkpoint).not.toHaveBeenCalled();now+=60001;
 expect((await scheduler().tick()).state).toBe("pending");expect(engine.ingestReceipt).toHaveBeenCalledTimes(1);expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.checkpoint).not.toHaveBeenCalled();
 now+=60001;expect((await scheduler().tick()).state).toBe("complete");expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.checkpoint).toHaveBeenCalledWith({indexEpoch:"index-e",indexRevision:"c".repeat(64)});expect(modelCalls).toBe(1);
});

it("keeps distinct canonical observations in separate items even inside one conversation window",async()=>{
 await event(1,0,"source-one");await event(2,1,"source-two");for(const [key,value]of snapshots)snapshots.set(key,{...(value as object),watermark:2});
 await scheduler().tick();const rows=(await query("SELECT sequence,item_id FROM assistant_routine_event_items WHERE installation_id=? AND generation=? ORDER BY sequence",...keys()).all<{sequence:number;item_id:string}>()).results;
 expect(rows).toHaveLength(2);expect(rows[0].item_id).not.toBe(rows[1].item_id);expect(await query("SELECT COUNT(*) n FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(2);expect(modelCalls).toBe(1);
});
it("never attributes a gap or null canonical source to another source's routine item",async()=>{
 await event(1,0,"source-one");await event(2,1,"missing");snapshots.delete("message:missing");snapshots.set("message:source-one",{...(snapshots.get("message:source-one") as object),watermark:2});
 await scheduler().tick();const rows=(await query("SELECT sequence,item_id,outcome FROM assistant_routine_event_items WHERE installation_id=? AND generation=? ORDER BY sequence",...keys()).all<{sequence:number;item_id:string|null;outcome:string}>()).results;
 expect(rows).toHaveLength(2);expect(rows[0].item_id).toEqual(expect.any(String));expect(rows[1]).toEqual({sequence:2,item_id:null,outcome:"gap"});expect(modelCalls).toBe(0);
});
it('keeps private Owner discovery uncertainty outside the interlocutor episode and preserves its one unknown receipt',async()=>{
 const controls=new OwnerControl(env.DB,scope,{kind:'owner'},()=>now);await controls.execute({kind:'project.put',operationId:'owner-context',id:'owner-context',expectedVersion:0,name:'Private owner context'});await new SourceController(env.DB,scope,{kind:'owner'},()=>now).create({originKey:'owner-context',projectId:'owner-context',text:'Private descriptor for Owner only.',occurredAt:now});const reply=model;let canonicalCalls=0;model=async request=>{const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);if(input.extraction==='canonical-owner-context-v2'){canonicalCalls++;throw Error('synthetic Owner ACK unknown');}return reply(request);};
 await event();expect((await scheduler().tick()).state).toBe('complete');expect(canonicalCalls).toBe(1);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);expect(await query('SELECT actor_json,profile,state,last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first()).toMatchObject({profile:'interlocutor',state:'complete',last_gap:null});
 const status=await query('SELECT body_json FROM assistant_owner_canonical_status WHERE installation_id=? AND generation=?',...keys()).first<string>('body_json');expect(JSON.parse(status!)).toMatchObject({schema:'owner-canonical-status-v1',state:'uncertain',gap:'canonical_model_uncertain'});expect(await query("SELECT COUNT(*) n FROM assistant_model_receipts WHERE installation_id=? AND generation=? AND state='uncertain'",...keys()).first('n')).toBe(1);expect((await new InferenceBudget(env.DB,{...scope,period:'2026-10-26'}).status()).committed).toBeGreaterThan(3);
 now+=60001;expect((await scheduler().tick()).state).toBe('complete');expect(canonicalCalls).toBe(1);expect(modelCalls).toBe(1);
});

it('keeps citation requirements outside the frozen private conversation manifest',async()=>{
 withoutCitations=true;settings.PROACTIVE_PILOT_JSON=JSON.stringify({id:'legacy',revision:1,startAfterSequence:0,chatIds:['chat']});
 await event(1,0,'legacy-uncited','Synthetic original');
 expect(await scheduler().tick()).toMatchObject({state:'uncertain'});expect(modelCalls).toBe(1);
 expect(await query('SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND proposal_json IS NOT NULL',...keys()).first('n')).toBe(0);
});
