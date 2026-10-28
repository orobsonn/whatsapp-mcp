import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { upsertDirectoryPage } from "../src/directory";
import { prepareApprovedSend, executeApprovedSend, approvedSendStatus } from "../src/assistant-approved-send";
import { executeAction, type SendProvider } from "../src/actions";
const scope={installationId:"own",generation:"own-g1",sourceEpoch:"e1",sourceGeneration:"g1"};
const secret="s".repeat(48);
let authorized=true,checks=0;
const e:Env={...env,OWNER_SUB:"owner",INSTALLATION_EPOCH:"e1",CONNECTION_GENERATION:"g1",CONNECTED_PHONE:"device",MAINTENANCE:"false",PUBLIC_ORIGIN:"http://localhost:8787",RUNTIME_CONFIG:"static",DEVELOPMENT:"true",ASSISTANT_INSTALLATION_ID:"own",ASSISTANT_GENERATION:"own-g1",ASSISTANT_APPROVED_SEND_SECRET:secret,
 ASSISTANT_OWNER:{approvedSendAuthorization:async (_scope:unknown,q:{actionId:string;hash:string;approvalId:string})=>{checks++;return authorized?{authorized:true,actionId:q.actionId,hash:q.hash,approvalId:q.approvalId,expiresAt:Date.now()+5000}:{authorized:false};}} as unknown as Env["ASSISTANT_OWNER"]};
let chatId:string;
const input=()=>({secret,scope,operationId:"notice-1",envelope:{kind:"text" as const,chatId,text:"Olá, confirmo nossa conversa."}});
beforeEach(async()=>{
 authorized=true;checks=0;
 await env.DB.exec("DELETE FROM approved_sends; DELETE FROM actions; DELETE FROM assistant_capture_changes; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM chats;");
 const {items}=await upsertDirectoryPage(e,{epoch:"e1",generation:"g1"},{items:[{externalId:"5585999999999",kind:"individual",name:"Pessoa selecionada"}],complete:true});chatId=items[0]!.id;
});
function provider(hook?:()=>Promise<void>,fail=false){let sends=0;const port:SendProvider={status:async()=>{await hook?.();return {connected:true,phone:"device"};},send:async()=>{sends++;if(fail)throw Error("lost ack");return {messageId:"provider-1",zaapId:"zaap-1"};}};return {port,count:()=>sends};}
describe("private Source approved send",()=>{
 it("prepares one atomic action under concurrent retries and rejects conflicting text",async()=>{
  const [a,b]=await Promise.all([prepareApprovedSend(e,input()),prepareApprovedSend(e,input())]);expect(a).toEqual(b);
  expect(a.target).toEqual({chatId,name:"Pessoa selecionada",address:"5585999999999",kind:"individual"});
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM actions").first<{n:number}>())?.n).toBe(1);
  await expect(prepareApprovedSend(e,{...input(),envelope:{...input().envelope,text:"Alterado"}})).rejects.toThrow("approved_send_conflict");
 });
 it("cannot bypass the human-receipt actuator through the manual send API",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider();
  await expect(executeAction(e,a.actionId,p.port,{confirmed:true,hash:a.hash})).rejects.toThrow("approved_send_actuator_required");expect(p.count()).toBe(0);
 });
 it("redacts frozen recipient metadata with action retention and cannot recreate the operation",async()=>{
  const a=await prepareApprovedSend(e,input());
  await env.DB.prepare("UPDATE actions SET status='expired',envelope_json='{}' WHERE id=?").bind(a.actionId).run();
  expect(await env.DB.prepare("SELECT target_json FROM approved_sends WHERE action_id=?").bind(a.actionId).first<string>("target_json")).toBe("{}");
  await expect(prepareApprovedSend(e,input())).rejects.toThrow("approved_send_expired");
 });
 it("denies wrong secret, source affinity and broad/media envelopes",async()=>{
  await expect(prepareApprovedSend(e,{...input(),secret:"bad"})).rejects.toThrow();
  await expect(prepareApprovedSend(e,{...input(),scope:{...scope,sourceGeneration:"wrong"}})).rejects.toThrow();
  await expect(prepareApprovedSend(e,{...input(),envelope:{...input().envelope,replyTo:"unapproved"}})).rejects.toThrow();
 });
 it("uses current human authorization and one attempt even when callback repeats",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider();
  const req={secret,scope,actionId:a.actionId,approvalId:"human-1"};
  const [first,second]=await Promise.all([executeApprovedSend(e,req,p.port),executeApprovedSend(e,req,p.port)]);
  expect([first.status,second.status]).toContain("accepted");expect(p.count()).toBe(1);expect(checks).toBeGreaterThan(0);
  expect(await env.DB.prepare("SELECT approval_channel FROM actions WHERE id=?").bind(a.actionId).first<string>("approval_channel")).toBe("telegram_owner");
  expect(await approvedSendStatus(e,{secret,scope,actionId:a.actionId})).toMatchObject({providerMessageId:"provider-1",providerZaapId:"zaap-1"});
  authorized=false;await executeApprovedSend(e,req,p.port);expect(p.count()).toBe(1);
 });
 it("blocks changed destination after provider status without sending",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider(async()=>{await env.DB.prepare("UPDATE chats SET external_id='5585888888888' WHERE id=?").bind(chatId).run();});
  const result=await executeApprovedSend(e,{secret,scope,actionId:a.actionId,approvalId:"human-1"},p.port);expect(result.status).not.toBe("accepted");expect(p.count()).toBe(0);
 });
 it("blocks an A-B-A recipient change between wrapper validation and the send snapshot",async()=>{
  const a=await prepareApprovedSend(e,input());let changed=false;
  const changingDb=new Proxy(env.DB,{get(db,key){
   if(key!=="prepare"){const value=Reflect.get(db,key);return typeof value==="function"?value.bind(db):value;}
   return (sql:string)=>{
    const statement=db.prepare(sql);
    if(sql!=="SELECT * FROM chats WHERE id=? AND epoch=? AND generation=?")return statement;
    const wrap=(st:D1PreparedStatement):D1PreparedStatement=>new Proxy(st,{get(target,property){
     if(property==="bind")return (...values:unknown[])=>wrap(target.bind(...values));
     if(property==="first")return async()=>{const result=await target.first();if(!changed){changed=true;await env.DB.prepare("UPDATE chats SET external_id='5585888888888' WHERE id=?").bind(chatId).run();}return result;};
     const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});return wrap(statement);
   };
  }});
  const p=provider(async()=>{await env.DB.prepare("UPDATE chats SET external_id='5585999999999' WHERE id=?").bind(chatId).run();});
  await expect(executeApprovedSend({...e,DB:changingDb},{secret,scope,actionId:a.actionId,approvalId:"human-1"},p.port)).rejects.toThrow("approved_send_changed");
  expect(changed).toBe(true);expect(p.count()).toBe(0);
 });
 it("rechecks human approval after provider await and preserves uncertainty",async()=>{
  const a=await prepareApprovedSend(e,input()),denied=provider(async()=>{authorized=false;});
  await expect(executeApprovedSend(e,{secret,scope,actionId:a.actionId,approvalId:"human-1"},denied.port)).rejects.toThrow("approved_send_denied");expect(denied.count()).toBe(0);
  expect(await env.DB.prepare("SELECT status,approval_channel,approved_at FROM actions WHERE id=?").bind(a.actionId).first()).toMatchObject({status:"proposed",approval_channel:null,approved_at:null});
  authorized=true;const uncertain=provider(undefined,true),req={secret,scope,actionId:a.actionId,approvalId:"human-1"};
  expect((await executeApprovedSend(e,req,uncertain.port)).status).toBe("uncertain");
  expect((await executeApprovedSend(e,req,uncertain.port)).status).toBe("uncertain");expect(uncertain.count()).toBe(1);
 });
});
