import { env } from "cloudflare:test";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
import { TelegramLink } from "../assistant/telegram-auth";
import { TelegramReview,type TelegramApi } from "../assistant/telegram";
import type { DecisionJournal } from "../assistant/decisions";
import { Routines } from "../assistant/routines";
import { AssistantScheduler } from "../assistant/scheduler";
import { receiveCapture } from "../assistant/ingress";
import { hostConfiguredSearch } from "../assistant/configured-search";
import { EpisodeController,type EpisodeDriver } from "../assistant/agent/controller";
import { boundEpisode } from "../assistant/agent/contracts";
import { DEFAULT_BROKER_CONFIG } from "../assistant/model-transport";
import { InferenceBudget } from "../assistant/budget";
import { JobQueue } from "../assistant/queue";
import { SourceController } from "../assistant/sources";
import type { AssistantEnv } from "../assistant/env";
import type { ModelAdapter } from "../assistant/model-broker";
import type { OriginScope,ReaderQuery } from "../assistant/origin-guard";
// @ts-expect-error Vite raw SQL imports.
const migrations=import.meta.glob("../assistant/migrations/*.sql",{query:"?raw",import:"default",eager:true}) as Record<string,string>;
const secret="synthetic-routines-private-capture-secret";let scope:OriginScope,settings:AssistantEnv,now:number,modelCalls:number,dispatches:number,modelFailure:boolean,author:string|null,fromMe:boolean;
let snapshots:Map<string,unknown>,model:ModelAdapter,driver:EpisodeDriver;
const keys=()=>[scope.installationId,scope.generation],query=(sql:string,...values:(string|number|null)[])=>env.DB.prepare(sql).bind(...values);
const scheduler=()=>new AssistantScheduler(settings,{clock:()=>now,driver,model});
beforeEach(async()=>{
 for(const [name,sql]of Object.entries(migrations).sort(([a],[b])=>a.localeCompare(b))){const parts=sql.replace(/^--.*$/gm,"").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(p=>p.trim());if(parts.length)await env.DB.batch(parts.map(p=>env.DB.prepare(p)));}
 scope={installationId:crypto.randomUUID(),generation:"g1",sourceEpoch:"capture-epoch",sourceGeneration:"capture-generation"};now=Date.parse("2026-10-26T12:00:00Z");modelCalls=0;dispatches=0;modelFailure=false;author="a".repeat(64);fromMe=false;snapshots=new Map();
 const reader={async readSnapshot(input:ReaderQuery){if(input.secret!==secret)throw new Error("synthetic secret mismatch");const found=snapshots.get(input.sourceKind+":"+input.sourceId);if(!found)throw new Error("synthetic offline");return found;}};
 settings={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret,CAPTURE_READER:reader,OPENAI_API_KEY:"synthetic-not-a-provider-key",FLUE_EPISODES_ENABLED:"shadow",ROUTINES_ENABLED:"shadow"};
 await new InferenceBudget(env.DB,{...scope,period:"2026-10-26"}).configure(1000000);
 model=async request=>{modelCalls++;if(modelFailure)throw new Error("synthetic accepted but ACK lost");const payload=JSON.parse(request.body),prompt=JSON.parse(payload.messages.at(-1).content),source=prompt.sources[0];return {status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:"proposed",text:"Synthetic shadow proposal",citations:[{id:source.id,revision:source.revision,version:source.version,hash:source.hash,quote:source.text}]})}}]})};};
 driver=(profile,runtimeId)=>({dispatch:async()=>{dispatches++;return {submissionId:"submission-"+runtimeId.slice(-12),uid:"uid-"+runtimeId.slice(-12),acceptedAt:new Date(now).toISOString()};},read:async receipt=>{
  const {search}=hostConfiguredSearch(settings,"automation",()=>now),host=new EpisodeController(env.DB,{...scope,period:new Date(now).toISOString().slice(0,10)},search,model,DEFAULT_BROKER_CONFIG,{purpose:"automation",clock:()=>now});
  const found=await query("SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=? AND runtime_id=?",...keys(),runtimeId).first<{id:string}>();if(!found)throw new Error("missing synthetic episode");const episode=boundEpisode((await host.episodes.get(found.id))!);
  const text=await host.model(episode.id,{profile,runtimeId,submissionId:receipt.submissionId},{messages:[{role:"user",content:host.message(episode)}]});return {...receipt,text,data:{}};
 }});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function event(sequence=1,previousSequence=0,id="message",text="Synthetic request",kind:"private"|"group"="private"){
 snapshots.set("message:"+id,{observation:"capture_snapshot",state:"available",sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:"message",sourceId:id,chatId:"chat",sourceVersion:1,watermark:sequence,conversationKind:kind,access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:"text",text,authorId:author,authorName:"Synthetic author",fromMe,occurredAt:now,messageId:id,messageVersion:1}});
 const response=await receiveCapture(new Request("https://synthetic.invalid/internal/capture",{method:"POST",headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({protocol:1,...scope,sequence,previousSequence,chatId:"chat",sourceId:id,sourceKind:"message",operation:"upsert",recordedAt:now})}),settings);expect(response.status).toBe(200);
}
it("runs the concrete capture-to-presearch-to-Flue-to-journal pipeline once for two cron calls",async()=>{
 await event();const results=await Promise.all([scheduler().tick(),scheduler().tick()]);
 expect(results.some(r=>r.state==="complete")).toBe(true);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND outcome='proposed'",...keys()).first("n")).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_cycles WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(1);
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
it("keeps budget exhaustion visible without configuring a replacement account or calling a model",async()=>{
 await query("UPDATE assistant_budget_accounts SET cap_units=0 WHERE installation_id=? AND generation=?",...keys()).run();await event();await scheduler().tick();expect(modelCalls).toBe(0);
 expect(await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("last_gap")).toBe("budget_blocked");
 const review=JSON.parse((await query("SELECT payload_json FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first<string>("payload_json"))!);expect(review.budget.state).toBe("exhausted");
});
it("late cron makes only the current daily metadata review and does not replay missing days",async()=>{
 const routines=new Routines(env.DB,scope,()=>now);await routines.daily(false);now+=7*86400000;const a=await routines.daily(true),b=await routines.daily(true);expect(a.id).toBe(b.id);
 expect(await query("SELECT COUNT(*) n FROM assistant_routine_reviews WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(2);
 expect(a.summary.reportingScope).toBe("current_generation_cumulative");expect(a.summary.snapshotAt).toBe(now);expect(a.summary.budget.state).toBe("unconfigured");expect(a.summary.pipelineGaps).toContain("canonical_relations_unpublished");
});
it("reconciles the same uncertain episode after restart without new job, alias or model charge",async()=>{
 await event();modelFailure=true;await scheduler().tick();const initial=await query("SELECT id,job_id,episode_id,run_id FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first();expect(modelCalls).toBe(1);
 now+=60001;await scheduler().tick();expect(await query("SELECT id,job_id,episode_id,run_id FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first()).toEqual(initial);expect(modelCalls).toBe(1);expect(dispatches).toBe(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(1);
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
 const engine={lifecycleState:vi.fn(async()=>structuredClone(state)),restoreCheckpoint:vi.fn(async()=>{state.running=true;return {state:"checkpoint_confirmed"};}),checkpoint:vi.fn(async()=>{state.index.state="checkpoint_confirmed";state.checkpoint.revision=state.index.revision;return {state:"checkpoint_confirmed"};}),
 ingest:vi.fn(async(value:import("../assistant/engine").EngineIngest)=>{const ref=value.source.fence.source;state.index.sources.push({id:ref.id,revision:ref.revision,version:ref.version,hash:ref.hash});state.index.revision="c".repeat(64);state.index.state="needs_checkpoint";return {state:"complete"};}),ingestReceipt:vi.fn(async()=>({state:"uncertain"})),
 prepare:vi.fn(async(alias:string,request:import("../assistant/engine").EngineSearch)=>{input=request;ticket={alias,requestHash:await import("../assistant/ingress").then(m=>m.bridgeHash(request)),operationId:"b".repeat(64),indexEpoch:state.index.epoch,indexRevision:state.index.revision};return {state:"prepared",ticket};}),submit:vi.fn(async()=>{submitted=true;return outcome();}),lookupTicket:vi.fn(async()=>submitted?outcome():{state:"uncertain",reason:"not_submitted",operationId:ticket.operationId})};
 settings.COGNEE={idFromName:()=>({}),get:()=>engine} as unknown as NonNullable<AssistantEnv["COGNEE"]>;return engine;
}
it("warms the exact checkpoint, indexes once, then performs semantic presearch before claiming a nominal episode",async()=>{
 const engine=semanticEngine(true);await event();expect((await scheduler().tick()).state).toBe("pending");
 expect(engine.restoreCheckpoint).toHaveBeenCalledWith({checkpointId:"checkpoint-1",indexEpoch:"index-e",indexRevision:"a".repeat(64)});expect(engine.ingest).toHaveBeenCalledTimes(1);expect(engine.checkpoint).toHaveBeenCalledWith({indexEpoch:"index-e",indexRevision:"c".repeat(64)});
 expect(await query("SELECT COUNT(*) n FROM assistant_episodes WHERE installation_id=? AND generation=?",...keys()).first("n")).toBe(0);expect(modelCalls).toBe(0);
 now+=60001;expect((await scheduler().tick()).state).toBe("complete");expect(engine.submit).toHaveBeenCalledTimes(1);expect(modelCalls).toBe(1);expect(engine.ingest).toHaveBeenCalledTimes(1);
});
it("never restores an older checkpoint over a dirty lost index or starts an empty replacement",async()=>{
 const engine=semanticEngine(false,true);await event();await scheduler().tick();expect(engine.restoreCheckpoint).not.toHaveBeenCalled();expect(engine.ingest).not.toHaveBeenCalled();expect(engine.submit).not.toHaveBeenCalled();expect(modelCalls).toBe(0);
 expect(await query("SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?",...keys()).first("last_gap")).toBe("index_rebuild_required");
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
