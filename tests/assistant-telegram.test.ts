import { env,createExecutionContext } from "cloudflare:test";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
import { TelegramReview,TelegramBotApi,type TelegramApi } from "../assistant/telegram";
import { receiveTelegram } from "../assistant/telegram-webhook";
import { TelegramLink } from "../assistant/telegram-auth";
import type { DecisionJournal } from "../assistant/decisions";
import { bridgeHash } from "../assistant/ingress";
import { OwnerAssistant } from "../assistant/mcp";
// @ts-expect-error SQL.
import linkSchema from "../assistant/migrations/0018_telegram_owner_link.sql?raw";
// @ts-expect-error SQL.
import reviewSchema from "../assistant/migrations/0021_telegram_review.sql?raw";
let scope:{installationId:string;generation:string;sourceEpoch:string;sourceGeneration:string},now:number,review:TelegramReview,api:TelegramApi;
let current:boolean,version:number,beforeAdmission:()=>Promise<void>;
const bot="synthetic_bot",secret="synthetic-private-telegram-review-secret",query=(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(scope.installationId,scope.generation,bot,...args);
const proposal=()=>({decision:"proposed",text:`Synthetic proposal ${version}`});
let journal:Pick<DecisionJournal,"get"|"admitReview">;
async function activate(){
 const link=new TelegramLink(env.DB,scope,bot,secret,()=>now);
 const a=await link.execute({kind:"telegram_link.begin",operationId:"begin",expectedRevision:0}) as {link:string;pairingId:string};
 const message=(update_id:number,url:string)=>({update_id,message:{message_id:update_id,date:Math.floor(now/1000),from:{id:101,is_bot:false},chat:{id:101,type:"private"},text:`/start ${new URL(url).searchParams.get("start")}`}});
 expect(await link.receive(message(1,a.link))).toBe("pairing_claimed");
 const b=await link.execute({kind:"telegram_link.confirm",operationId:"confirm",pairingId:a.pairingId}) as {link:string};
 expect(await link.receive(message(2,b.link))).toBe("linked");now+=1000;
}
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:"g1",sourceEpoch:"epoch",sourceGeneration:"capture"};now=2000000;current=true;version=1;beforeAdmission=async()=>{};
 await env.DB.exec("CREATE TABLE IF NOT EXISTS assistant_owner_commands (installation_id TEXT,generation TEXT,operation_id TEXT,request_hash TEXT,token TEXT,result_json TEXT,created_at INTEGER,PRIMARY KEY(installation_id,generation,operation_id));CREATE TABLE IF NOT EXISTS telegram_test_sources (installation_id TEXT PRIMARY KEY,revision INTEGER,active INTEGER);");
 for(const sql of [linkSchema,reviewSchema])await env.DB.batch(sql.replace(/^--.*$/gm,"").trim().split(/;\s*(?=CREATE|$)/).filter((s:string)=>s.trim()).map((s:string)=>env.DB.prepare(s)));
 await env.DB.prepare("INSERT INTO telegram_test_sources VALUES(?,1,1)").bind(scope.installationId).run();
 let thread=10;
 api={inspect:vi.fn(async()=>true),createTopic:vi.fn(async()=>thread++),send:vi.fn(async()=>200),answer:vi.fn(async()=>{})};
 journal={get:vi.fn(async()=>current?{freshness:"current",proposal:proposal()}:{freshness:"stale"}),admitReview:vi.fn(async(id:string,hash:string,build:Parameters<DecisionJournal["admitReview"]>[2])=>{
  await beforeAdmission();if(!current||hash!==await bridgeHash(proposal()))return null;
  return env.DB.batch(build({sql:"EXISTS(SELECT 1 FROM telegram_test_sources WHERE installation_id=? AND revision=1 AND active=1)",values:[scope.installationId]}));
 })} as unknown as Pick<DecisionJournal,"get"|"admitReview">;
 review=new TelegramReview(env.DB,scope,bot,secret,api,journal,()=>now);
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function setup(){await activate();await review.execute({kind:"topics.ensure"});}
async function notify(key="notice",topic="pending"){
 const result=await review.execute({kind:"notification.prepare",operationId:key,topic,decisionId:"decision-1",expiresAt:now+10000}) as {id:string};return result.id;
}
async function sent(){await setup();const id=await notify();expect(await review.execute({kind:"notification.dispatch",id})).toEqual({id,state:"sent"});return id;}
async function hold(){await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,100) ON CONFLICT DO NOTHING").bind(scope.installationId).run();}
function callback(action=0){const wire=vi.mocked(api.send).mock.calls[0];return {update_id:100,callback_query:{id:"query-100",from:{id:101,is_bot:false},chat_instance:"synthetic-private",data:wire[3][0][action].callback_data,message:{message_id:200,date:Math.floor(now/1000),message_thread_id:wire[1],chat:{id:101,type:"private"}}}};}
it("requires completed linking rather than an observed ID",async()=>{
 await expect(review.execute({kind:"topics.ensure"})).rejects.toThrow("telegram_unlinked");expect(api.createTopic).not.toHaveBeenCalled();
});
it("restore hold during topic inspection prevents every new topic effect",async()=>{
 await activate();vi.mocked(api.inspect).mockImplementation(async()=>{await hold();return true;});
 await review.execute({kind:"topics.ensure"});expect(api.createTopic).not.toHaveBeenCalled();
 expect(await query("SELECT COUNT(*) n FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=? AND state='attempting'").first("n")).toBe(0);
});
it("owner RPC Telegram factory rechecks restore after provider inspection without creating a remote topic",async()=>{
 await activate();const network=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{expect(String(url).endsWith("/getMe")).toBe(true);await hold();return Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}});});
 const rpc=new OwnerAssistant(createExecutionContext(),{DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,TELEGRAM_BOT_INSTANCE:bot,TELEGRAM_WEBHOOK_SECRET:secret,TELEGRAM_BOT_TOKEN:"123456789:synthetic_token_12345678901234567890"});
 expect(await rpc.telegramReview(scope,{kind:"topics.ensure"})).toMatchObject({mode:"shadow"});expect(network).toHaveBeenCalledTimes(1);
 expect(await query("SELECT COUNT(*) n FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=? AND state='ready'").first("n")).toBe(0);
});
it.each(["hold","generation"])("restore %s during notice admission prevents Telegram send",async kind=>{
 await setup();const id=await notify();beforeAdmission=async()=>{if(kind==="hold")await hold();else await env.DB.prepare("INSERT INTO assistant_retention_active_generation VALUES(?,'next',?,?,'activate',1)").bind(scope.installationId,"a".repeat(64),"b".repeat(64)).run();};
 expect(await review.execute({kind:"notification.dispatch",id})).toEqual({id,state:"blocked"});expect(api.send).not.toHaveBeenCalled();
});
it("restore hold after notice latch preserves uncertainty without calling or retrying the Telegram send",async()=>{
 await setup();const id=await notify(),admit=vi.mocked(journal.admitReview).getMockImplementation()!;
 vi.mocked(journal.admitReview).mockImplementation(async(...args)=>{const result=await admit(...args);await hold();return result;});
 expect(await review.execute({kind:"notification.dispatch",id})).toEqual({id,state:"uncertain"});expect(api.send).not.toHaveBeenCalled();
 await env.DB.prepare("DELETE FROM assistant_retention_runtime_hold WHERE installation_id=?").bind(scope.installationId).run();
 expect(await review.execute({kind:"notification.dispatch",id})).toEqual({id,state:"uncertain"});expect(api.send).not.toHaveBeenCalled();
});
it("restore hold after topic latch preserves its uncertainty without creating a topic",async()=>{
 await activate();const prepare=env.DB.prepare.bind(env.DB);let injected=false;
 const db={prepare:(sql:string)=>{const statement=prepare(sql);if(!sql.includes("UPDATE assistant_telegram_topics SET state='attempting'"))return statement;
  const wrap=(current:D1PreparedStatement):D1PreparedStatement=>new Proxy(current,{get(value,key){if(key==="bind")return(...args:unknown[])=>wrap(value.bind(...args));if(key==="all")return async()=>{const result=await value.all();if(result.results.length&&!injected){injected=true;await hold();}return result;};const item=Reflect.get(value,key,value);return typeof item==="function"?item.bind(value):item;}});return wrap(statement);},batch:env.DB.batch.bind(env.DB)} as D1Database;
 review=new TelegramReview(db,scope,bot,secret,api,journal,()=>now);await review.execute({kind:"topics.ensure"});expect(injected).toBe(true);expect(api.createTopic).not.toHaveBeenCalled();
 expect(await query("SELECT state FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=? AND slot='general'").first("state")).toBe("uncertain");
});
it("restore hold during callback admission denies a new acknowledgement without changing the review",async()=>{
 const id=await sent(),update=callback();beforeAdmission=hold;
 expect(await review.receiveCallback(update)).toBe("denied");expect(api.answer).not.toHaveBeenCalled();
 expect(await query("SELECT review_state FROM assistant_telegram_notifications WHERE installation_id=? AND generation=? AND bot_instance=? AND id=?",id).first("review_state")).toBe("pending");
});
it("persists exactly four private topic IDs across restart and never recreates them",async()=>{
 await setup();expect(vi.mocked(api.createTopic).mock.calls.map(call=>call[1])).toEqual(["Geral","Resumos","Pendências","Missões e retornos"]);
 review=new TelegramReview(env.DB,scope,bot,secret,api,journal,()=>now);await review.execute({kind:"topics.ensure"});expect(api.createTopic).toHaveBeenCalledTimes(4);
 expect((await review.execute({kind:"status"}) as {topics:unknown[]}).topics).toHaveLength(4);
});
it("limits pre-admission topic retries and never repeats an uncertain create",async()=>{
 await activate();vi.mocked(api.inspect).mockResolvedValue(false);
 for(let i=0;i<5;i++)await review.execute({kind:"topics.ensure"});expect(api.inspect).toHaveBeenCalledTimes(12);expect(api.createTopic).not.toHaveBeenCalled();
});
it("keeps lost create ACK uncertain without a new topic alias",async()=>{
 await activate();vi.mocked(api.createTopic).mockRejectedValue(new Error("synthetic-private-error"));await review.execute({kind:"topics.ensure"});await review.execute({kind:"topics.ensure"});
 expect(api.createTopic).toHaveBeenCalledTimes(4);expect((await query("SELECT state FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=?").all()).results).toEqual(Array(4).fill({state:"uncertain"}));
});
it("binds an idempotent outbox to proposal hash and private persisted thread",async()=>{
 await setup();const id=await notify();expect(await notify()).toBe(id);expect(api.send).not.toHaveBeenCalled();
 await expect(review.execute({kind:"notification.prepare",operationId:"notice",topic:"general",decisionId:"decision-1",expiresAt:now+10000})).rejects.toThrow("telegram_conflict");
 await review.execute({kind:"notification.dispatch",id});expect(api.send).toHaveBeenCalledTimes(1);expect(vi.mocked(api.send).mock.calls[0].slice(0,2)).toEqual(["101",12]);
 const raw=JSON.stringify((await query("SELECT * FROM assistant_telegram_notifications WHERE installation_id=? AND generation=? AND bot_instance=?").all()).results);
 expect(raw).not.toContain(secret);expect(raw).not.toContain(vi.mocked(api.send).mock.calls[0][3][0][0].callback_data);
});
it.each(["expired","proposal","source","link"])("suppresses %s notification before API effect",async kind=>{
 await setup();const id=await notify();
 if(kind==="expired")now+=10000;if(kind==="proposal")version++;
 if(kind==="source")beforeAdmission=async()=>{await env.DB.prepare("UPDATE telegram_test_sources SET active=0 WHERE installation_id=?").bind(scope.installationId).run();};
 if(kind==="link")beforeAdmission=async()=>{await query("UPDATE assistant_telegram_links SET state='revoked',revision=2,user_id=NULL,chat_id=NULL,activation_cut=NULL WHERE installation_id=? AND generation=? AND bot_instance=?").run();};
 await review.execute({kind:"notification.dispatch",id});expect(api.send).not.toHaveBeenCalled();
});
it("bounds notification preflight retries and never resends after uncertainty",async()=>{
 await setup();const id=await notify();vi.mocked(api.inspect).mockRejectedValue(new Error("offline"));for(let i=0;i<5;i++)await review.execute({kind:"notification.dispatch",id});
 expect(api.send).not.toHaveBeenCalled();expect((await query("SELECT state,preflights FROM assistant_telegram_notifications WHERE installation_id=? AND generation=? AND bot_instance=? AND id=?",id).first())).toEqual({state:"failed",preflights:3});
 vi.mocked(api.inspect).mockResolvedValue(true);const next=await notify("uncertain");vi.mocked(api.send).mockRejectedValue(new Error("accepted but ACK lost"));
 expect(await review.execute({kind:"notification.dispatch",id:next})).toEqual({id:next,state:"uncertain"});await review.execute({kind:"notification.dispatch",id:next});expect(api.send).toHaveBeenCalledTimes(1);
});
it("admits only one send while concurrent dispatches overlap",async()=>{
 await setup();const id=await notify();let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});vi.mocked(api.send).mockImplementation(async()=>{await hold;return 200;});
 const first=review.execute({kind:"notification.dispatch",id});await vi.waitFor(()=>expect(api.send).toHaveBeenCalledTimes(1));const second=await review.execute({kind:"notification.dispatch",id});expect(second).toEqual({id,state:"attempting"});release();await first;expect(api.send).toHaveBeenCalledTimes(1);
});
it.each([0,1])("records callback action %s as shadow review only and durably deduplicates",async action=>{
 const id=await sent(),update=callback(action);expect(new TextEncoder().encode(update.callback_query.data).length).toBeLessThanOrEqual(64);
 expect(await review.receiveCallback(update)).toBe(action?"simulated":"reviewed");expect(await review.receiveCallback(update)).toBe("duplicate");
 expect(await query("SELECT review_state FROM assistant_telegram_notifications WHERE installation_id=? AND generation=? AND bot_instance=? AND id=?",id).first("review_state")).toBe(action?"simulated":"reviewed");expect(api.answer).toHaveBeenCalledTimes(1);expect(api.send).toHaveBeenCalledTimes(1);
});
it.each(["user","chat","thread","message","expiry","proposal","revoke","source","rotation"])("denies callback with changed %s",async kind=>{
 const id=await sent(),update=callback();
 if(kind==="user")update.callback_query.from.id=202;if(kind==="chat")update.callback_query.message.chat.id=202;if(kind==="thread")update.callback_query.message.message_thread_id=99;if(kind==="message")update.callback_query.message.message_id=999;if(kind==="expiry")now+=10000;if(kind==="proposal")version++;
 if(kind==="revoke")await query("UPDATE assistant_telegram_links SET state='revoked',revision=2,user_id=NULL,chat_id=NULL,activation_cut=NULL WHERE installation_id=? AND generation=? AND bot_instance=?").run();
 if(kind==="source")beforeAdmission=async()=>{await env.DB.prepare("UPDATE telegram_test_sources SET active=0 WHERE installation_id=?").bind(scope.installationId).run();};
 if(kind==="rotation")review=new TelegramReview(env.DB,scope,bot,"rotated-synthetic-private-review-secret",api,journal,()=>now);
 expect(await review.receiveCallback(update)).toBe("denied");expect(api.answer).not.toHaveBeenCalled();expect(await query("SELECT review_state FROM assistant_telegram_notifications WHERE installation_id=? AND generation=? AND bot_instance=? AND id=?",id).first("review_state")).toBe("pending");
});
it("rejects inline, forwarded, business, malformed and mixed callback updates",async()=>{
 await sent();const original=callback();
 for(const update of [{...original,message:{}},{...original,callback_query:{...original.callback_query,inline_message_id:"inline"}},{...original,callback_query:{...original.callback_query,message:{...original.callback_query.message,forward_origin:{type:"user"}}}},{...original,callback_query:{...original.callback_query,from:{id:101,is_bot:true}}}])expect(await review.receiveCallback(update)).toBe("unsupported");
 expect(api.answer).not.toHaveBeenCalled();
});
it("uses a fixed Bot API origin, disallows redirects, checks private topics and hides provider failures",async()=>{
 const token="123456789:synthetic_token_12345678901234567890",fetcher=vi.fn(async()=>Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}));
 const client=new TelegramBotApi(token,bot,fetcher);expect(await client.inspect()).toBe(true);expect(fetcher).toHaveBeenCalledWith(`https://api.telegram.org/bot${token}/getMe`,expect.objectContaining({redirect:"manual",method:"POST"}));
 fetcher.mockResolvedValueOnce(new Response(null,{status:302,headers:{Location:"https://evil.invalid/"}}));await expect(client.inspect()).rejects.toThrow("telegram_api_unavailable");
 fetcher.mockRejectedValueOnce(new Error(token));await expect(client.inspect()).rejects.not.toThrow(token);expect(fetcher).toHaveBeenCalledTimes(3);
});

it("authenticates the callback webhook before DB/body and rejects malformed callbacks without any API",async()=>{
 const settings={DB:env.DB,TELEGRAM_WEBHOOK_SECRET:secret,TELEGRAM_BOT_INSTANCE:bot,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration};
 const touched=vi.fn();const denied={headers:new Headers({"X-Telegram-Bot-Api-Secret-Token":"wrong"}),get body(){touched();return null;}} as Request;
 expect((await receiveTelegram(denied,settings)).status).toBe(403);expect(touched).not.toHaveBeenCalled();
 const response=await receiveTelegram(new Request("https://synthetic.invalid/webhooks/telegram",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":secret},body:JSON.stringify({update_id:100,callback_query:{inline_message_id:"forbidden"}})}),settings);
 expect(await response.json()).toEqual({code:"unsupported"});expect(api.send).not.toHaveBeenCalled();expect(api.answer).not.toHaveBeenCalled();
});
it("suppresses a prepared notice after credential rotation without using a new outbox alias",async()=>{
 await setup();const id=await notify();review=new TelegramReview(env.DB,scope,bot,"rotated-synthetic-private-review-secret",api,journal,()=>now);
 expect(await review.execute({kind:"notification.dispatch",id})).toEqual({id,state:"cancelled"});expect(api.send).not.toHaveBeenCalled();
 expect(await query("SELECT COUNT(*) n FROM assistant_telegram_notifications WHERE installation_id=? AND generation=? AND bot_instance=?").first("n")).toBe(1);
});

it.each(["fetch","body"])("bounds a hung %s even when the transport ignores AbortSignal",async kind=>{
 const fetcher=vi.fn(async()=>kind==="fetch"?await new Promise<Response>(()=>{}):new Response(new ReadableStream<Uint8Array>({start(){}})));
 vi.useFakeTimers();const pending=new TelegramBotApi("123456789:synthetic_token_12345678901234567890",bot,fetcher).inspect(),rejected=expect(pending).rejects.toThrow("telegram_api_unavailable");
 await vi.advanceTimersByTimeAsync(10001);await rejected;
});
it("never starts a late Telegram fetch after its runtime check outlives the API deadline",async()=>{
 let release!:()=>void;const fetcher=vi.fn(async()=>Response.json({ok:true,result:true})),check=()=>new Promise<void>(resolve=>{release=resolve;});
 vi.useFakeTimers();const pending=new TelegramBotApi("123456789:synthetic_token_12345678901234567890",bot,fetcher,check).inspect(),rejected=expect(pending).rejects.toThrow("telegram_api_unavailable");
 await vi.advanceTimersByTimeAsync(10001);await rejected;release();await Promise.resolve();await Promise.resolve();expect(fetcher).not.toHaveBeenCalled();
});
it("keeps timed-out dispatch uncertain when the physical request later acknowledges, without repeating it",async()=>{
 await setup();const id=await notify();let release!:(value:Response)=>void;
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith("/sendMessage")?await new Promise<Response>(resolve=>{release=resolve;}):Response.json({ok:true,result:{is_bot:true,username:bot,has_topics_enabled:true}}));
 review=new TelegramReview(env.DB,scope,bot,secret,new TelegramBotApi("123456789:synthetic_token_12345678901234567890",bot,fetcher),journal,()=>now);
 vi.useFakeTimers();const pending=review.execute({kind:"notification.dispatch",id});await vi.waitFor(()=>expect(release).toBeTypeOf("function"),{timeout:5000});
 await vi.advanceTimersByTimeAsync(10001);expect(await pending).toEqual({id,state:"uncertain"});
 release(Response.json({ok:true,result:{message_id:200,message_thread_id:12,chat:{id:101,type:"private"}}}));await Promise.resolve();await Promise.resolve();
 expect(await review.execute({kind:"notification.dispatch",id})).toEqual({id,state:"uncertain"});expect(fetcher).toHaveBeenCalledTimes(2);
});
it("declares the notification listing truncated when more than twenty rows exist",async()=>{
 await setup();for(let i=0;i<21;i++)await notify(`notice-${i}`);
 expect(await review.execute({kind:"status"})).toMatchObject({notifications:expect.any(Array),notificationCoverage:{limit:20,truncated:true}});
 expect((await review.execute({kind:"status"}) as {notifications:unknown[]}).notifications).toHaveLength(20);
});
