import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { ingestEvent } from "../src/capture";
import { registerProviderRelationship, conversationActivity } from "../src/conversation-activity";
import { upsertDirectoryPage } from "../src/directory";
import { prepareApprovedSend, executeApprovedSend, approvedSendStatus } from "../src/assistant-approved-send";
import { executeAction, type SendProvider } from "../src/actions";
const scope={installationId:"own",generation:"own-g1",sourceEpoch:"e1",sourceGeneration:"g1"};
const secret="s".repeat(48);
let authorized=true,checks=0,authorizationHook:(()=>Promise<void>)|undefined;
let activity:{triggerSequence:number;watermark:number;relationshipRevision:number;relationshipProof:string;members:string[]};
const e:Env={...env,OWNER_SUB:"owner",INSTALLATION_EPOCH:"e1",CONNECTION_GENERATION:"g1",CONNECTED_PHONE:"device",ZAPI_INSTANCE_ID:"instance",MAINTENANCE:"false",PUBLIC_ORIGIN:"http://localhost:8787",RUNTIME_CONFIG:"static",DEVELOPMENT:"true",ASSISTANT_INSTALLATION_ID:"own",ASSISTANT_GENERATION:"own-g1",ASSISTANT_APPROVED_SEND_SECRET:secret,
 ASSISTANT_OWNER:{approvedSendAuthorization:async (_scope:unknown,q:{actionId:string;hash:string;approvalId:string})=>{checks++;await authorizationHook?.();return authorized?{authorized:true,actionId:q.actionId,hash:q.hash,approvalId:q.approvalId,expiresAt:Date.now()+5000}:{authorized:false};}} as unknown as Env["ASSISTANT_OWNER"]};
let chatId:string;
const input=()=>({secret,scope,operationId:"notice-1",activity,envelope:{kind:"text" as const,chatId,text:"Olá, confirmo nossa conversa."}});
beforeEach(async()=>{
 authorized=true;checks=0;authorizationHook=undefined;
 await env.DB.exec("DELETE FROM conversation_relationships; DELETE FROM owner_message_originals; DELETE FROM approved_sends; DELETE FROM actions; DELETE FROM assistant_capture_changes; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM chats;");
 const {items}=await upsertDirectoryPage(e,{epoch:"e1",generation:"g1"},{items:[{externalId:"5585999999999",kind:"individual",name:"Pessoa selecionada"}],complete:true});chatId=items[0]!.id;
 const incoming=await ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:"5585999999999",chatKind:"individual",externalId:"incoming",fromMe:false,kind:"text",text:"Pedido de teste",timestamp:Date.now()});
 const sequence=(await env.DB.prepare("SELECT MIN(sequence) n FROM assistant_capture_changes WHERE source_id=? AND operation='upsert'").bind(incoming.messageId).first<number>("n"))!;activity={triggerSequence:sequence,watermark:sequence,relationshipRevision:0,relationshipProof:"0".repeat(64),members:[chatId]};
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
 it("sends one reviewed group response to the exact group, never its participant, and vetoes a later owner reply",async()=>{
  const groupAddress="120363999999999999-group",participant="5585777777777";
  const {items}=await upsertDirectoryPage(e,{epoch:"e1",generation:"g1"},{items:[{externalId:groupAddress,kind:"group",name:"Grupo sintético"}],complete:true});const groupId=items[0]!.id;
  const groupMessage=(externalId:string,fromMe:boolean)=>ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:groupAddress,chatKind:"group",externalId,authorExternalId:fromMe?e.CONNECTED_PHONE:participant,authorName:fromMe?"Dono":"Participante",fromMe,kind:"text",text:"Mensagem sintética do grupo",timestamp:Date.now()});
  const prepareGroup=async(operationId:string)=>{const current=await conversationActivity(e,groupId);if(current.state!=="available")throw Error("group blocked");return prepareApprovedSend(e,{secret,scope,operationId,envelope:{kind:"text",chatId:groupId,text:"Resposta integral aprovada para o grupo"},activity:{triggerSequence:current.latestIncomingOriginalSequence,watermark:current.watermark,relationshipRevision:current.relationshipRevision,relationshipProof:current.relationshipProof,members:current.members.map(member=>member.chatId)}});};
  const incoming=await groupMessage("group-incoming",false),a=await prepareGroup("group-review-1");
  expect(a.target).toEqual({chatId:groupId,name:"Grupo sintético",address:groupAddress,kind:"group"});expect(a.activity.members).toEqual([groupId]);
  expect(await env.DB.prepare("SELECT p.external_id FROM messages m JOIN participants p ON p.id=m.author_id WHERE m.id=?").bind(incoming.messageId).first<string>("external_id")).toBe(participant);
  const sent:Parameters<SendProvider["send"]>[0][]=[];const port:SendProvider={status:async()=>({connected:true,phone:e.CONNECTED_PHONE}),send:async envelope=>{sent.push(envelope);return {messageId:"provider-group-1",zaapId:"provider-group-ack"};}};
  const request={secret,scope,actionId:a.actionId,approvalId:"owner-group-exact-approval"};
  authorized=false;await expect(executeApprovedSend(e,request,port)).rejects.toThrow("approved_send_denied");expect(sent).toHaveLength(0);
  authorized=true;expect((await executeApprovedSend(e,request,port)).status).toBe("accepted");await executeApprovedSend(e,request,port);
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({destination:groupAddress,kind:"text",text:"Resposta integral aprovada para o grupo"});expect(sent[0]!.destination).not.toBe(participant);
  expect(await env.DB.prepare("SELECT approval_channel FROM actions WHERE id=?").bind(a.actionId).first<string>("approval_channel")).toBe("telegram_owner");
  await groupMessage("group-next-incoming",false);const next=await prepareGroup("group-review-2");await groupMessage("group-owner-already-replied",true);
  expect((await executeApprovedSend(e,{secret,scope,actionId:next.actionId,approvalId:"owner-group-next-approval"},port)).status).toBe("proposed");expect(sent).toHaveLength(1);
  expect(await env.DB.prepare("SELECT attempted_at FROM actions WHERE id=?").bind(next.actionId).first("attempted_at")).toBeNull();
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
 it("vetoes an owner LID reply even when the suggestion would be prepared afterwards",async()=>{
  const {items}=await upsertDirectoryPage(e,{epoch:"e1",generation:"g1"},{items:[{externalId:"777777777777777@lid",kind:"individual",name:"Outro nome"}],complete:true});const lid=items[0]!.id;
  await ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:"777777777777777@lid",chatKind:"individual",externalId:"owner-reply",fromMe:true,kind:"text",text:"Resposta do dono de teste",timestamp:Date.now()});
  await registerProviderRelationship(e,{sourceEpoch:"e1",sourceGeneration:"g1",instanceId:"instance",phoneChatId:chatId,lidChatId:lid,phone:"5585999999999",lid:"777777777777777@lid",proofHash:"a".repeat(64),observedAt:Date.now()});
  const current=await conversationActivity(e,chatId);if(current.state!=="available")throw Error("blocked");activity={...activity,watermark:current.watermark,relationshipRevision:current.relationshipRevision,relationshipProof:current.relationshipProof,members:current.members.map(m=>m.chatId)};
  await expect(prepareApprovedSend(e,input())).rejects.toThrow("conversation_activity_changed");
 });
 it("registers one direct relation atomically, cancelling only pending unattempted sends",async()=>{
  const a=await prepareApprovedSend(e,input()),attempted=await prepareApprovedSend(e,{...input(),operationId:"already-attempted"});
  await env.DB.prepare("UPDATE actions SET status='attempting',attempted_at=1 WHERE id=?").bind(attempted.actionId).run();
  const {items}=await upsertDirectoryPage(e,{epoch:"e1",generation:"g1"},{items:[{externalId:"777777777777777@lid",kind:"individual",name:"Pessoa"}],complete:true});
  const q={sourceEpoch:"e1",sourceGeneration:"g1",instanceId:"instance",phoneChatId:chatId,lidChatId:items[0]!.id,phone:"5585999999999",lid:"777777777777777@lid",proofHash:"a".repeat(64),observedAt:Date.now()};
  const before=(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_capture_changes").first<number>("n"))!;
  await registerProviderRelationship(e,q);expect(await env.DB.prepare("SELECT status FROM actions WHERE id=?").bind(a.actionId).first<string>("status")).toBe("cancelled");expect(await env.DB.prepare("SELECT status FROM actions WHERE id=?").bind(attempted.actionId).first<string>("status")).toBe("attempting");
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_capture_changes").first<number>("n")).toBe(before+2);
  await registerProviderRelationship(e,q);expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_capture_changes").first<number>("n")).toBe(before+2);
 });
 it("rejects greeting suggestions superseded by a newer incoming question even with a refreshed watermark",async()=>{
  await ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:"5585999999999",chatKind:"individual",externalId:"new-question",fromMe:false,kind:"text",text:"Qual é o próximo passo do projeto?",timestamp:Date.now()});
  const latest=await conversationActivity(e,chatId);if(latest.state!=="available")throw Error("blocked");activity={...activity,watermark:latest.watermark};
  await expect(prepareApprovedSend(e,input())).rejects.toThrow("conversation_activity_changed");
 });
 it("does not attempt when a new incoming arrives between Own authorization and Source claim",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider();authorizationHook=async()=>{authorizationHook=undefined;await ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:"5585999999999",chatKind:"individual",externalId:"burst-after-authorization",fromMe:false,kind:"text",text:"Mais uma pergunta antes de responder",timestamp:Date.now()});};
  const result=await executeApprovedSend(e,{secret,scope,actionId:a.actionId,approvalId:"human-1"},p.port);expect(result.status).toBe("proposed");expect(p.count()).toBe(0);
 });
 it("freezes the full member watermark even when an edit does not create a new original incoming",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider();authorizationHook=async()=>{authorizationHook=undefined;await ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:"5585999999999",chatKind:"individual",externalId:"incoming",fromMe:false,kind:"text",text:"Pergunta corrigida no mesmo turno",timestamp:Date.now(),revision:2});};
  const result=await executeApprovedSend(e,{secret,scope,actionId:a.actionId,approvalId:"human-1"},p.port);expect(result.status).toBe("proposed");expect(p.count()).toBe(0);
  const current=await conversationActivity(e,chatId);if(current.state!=="available")throw Error("blocked");expect(current.latestIncomingOriginalSequence).toBe(activity.triggerSequence);expect(current.watermark).toBeGreaterThan(activity.watermark);
  await expect(prepareApprovedSend(e,input())).rejects.toThrow("conversation_activity_changed");
 });
 it("rechecks Source owner replies after Own authorization in the same final claim",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider();authorizationHook=async()=>{authorizationHook=undefined;await ingestEvent(e,{epoch:"e1",generation:"g1"},{chatExternalId:"5585999999999",chatKind:"individual",externalId:"new-owner",fromMe:true,kind:"text",text:"Já respondi em teste",timestamp:Date.now()});};
  const result=await executeApprovedSend(e,{secret,scope,actionId:a.actionId,approvalId:"human-1"},p.port);expect(result.status).toBe("proposed");expect(p.count()).toBe(0);
 });
 it("rechecks Source capture opt-out after Own authorization",async()=>{
  const a=await prepareApprovedSend(e,input()),p=provider();authorizationHook=async()=>{await env.DB.prepare("UPDATE chats SET capture_enabled=0 WHERE id=?").bind(chatId).run();};
  const result=await executeApprovedSend(e,{secret,scope,actionId:a.actionId,approvalId:"human-1"},p.port);expect(result.status).toBe("proposed");expect(p.count()).toBe(0);
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
