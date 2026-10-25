import { beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import app from "../src/index";
import { ingestEvent } from "../src/capture";
import { setCapture, upsertDirectoryPage } from "../src/directory";
import type { Env } from "../src/env";
const fence = { epoch: "outbox-e", generation: "outbox-g" };
const e: Env = { ...env, OWNER_SUB: "owner", INSTALLATION_EPOCH: fence.epoch,
  CONNECTION_GENERATION: fence.generation, MAINTENANCE: "false" };
let chatId: string;
beforeEach(async () => {
  await env.DB.exec("DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM participants; DELETE FROM chats;");
  const page = await upsertDirectoryPage(e, fence, {items:[{externalId:"outbox-chat",kind:"individual",name:"Synthetic"}], complete:true});
  chatId=page.items[0]!.id;
  await setCapture(e, chatId, true, fence);
  await env.DB.exec("DELETE FROM assistant_capture_changes;");
});
const ingest = (extra = {}) => ingestEvent(e, fence, { chatExternalId:"outbox-chat",externalId:"outbox-message",
  fromMe:false,kind:"text",text:"original",timestamp:100,...extra });
const changes = () => env.DB.prepare("SELECT * FROM assistant_capture_changes WHERE epoch=? AND generation=? ORDER BY sequence").bind(fence.epoch,fence.generation).all<{sequence:number; operation:string; source_id:string}>();
describe("transactional capture change feed",()=>{
  it("deduplicates ingress and orders edits/deletion by local sequence",async()=>{
    await ingest(); await ingest();
    expect((await changes()).results).toHaveLength(1);
    await ingest({revision:2,text:"changed",timestamp:50});
    await ingest({revision:1,text:"obsolete",timestamp:200});
    await ingest({deleted:true,revision:1});
    await ingest({revision:3,text:"resurrection"});
    const rows=(await changes()).results;
    expect(rows.map(x=>x.operation)).toEqual(["upsert","upsert","withdraw"]);
    expect(rows[0].sequence).toBeLessThan(rows[1].sequence);
    expect(rows[1].sequence).toBeLessThan(rows[2].sequence);
    expect(await env.DB.prepare("SELECT text FROM messages WHERE id=?").bind(rows[0].source_id).first("text")).toBeNull();
  });
  it("rolls back the feed when the same database transaction fails",async()=>{
    await ingest(); const before=(await changes()).results;
    await expect(env.DB.batch([
      env.DB.prepare("UPDATE messages SET text='uncommitted',version=2 WHERE chat_id=?").bind(chatId),
      env.DB.prepare("INSERT INTO message_versions(message_id,version,kind,created_at) VALUES('missing',1,'text',1)")
    ])).rejects.toThrow();
    expect((await changes()).results).toEqual(before);
    expect(await env.DB.prepare("SELECT text FROM messages WHERE chat_id=?").bind(chatId).first("text")).toBe("original");
  });
  it("does not treat delivery status as a changed source",async()=>{
    await ingest(); const before=(await changes()).results;
    await env.DB.prepare("UPDATE messages SET status_rank=4 WHERE chat_id=?").bind(chatId).run();
    expect((await changes()).results).toEqual(before);
  });
  it("routes a validated deletion callback through the same capture transaction",async()=>{
    await ingest();
    const local={...e,CONNECTED_PHONE:"device",ZAPI_INSTANCE_ID:"instance",WEBHOOK_SECRET:"synthetic-webhook-secret-at-least-24"};
    const response=await app.fetch(new Request(`https://example.test/webhook/${fence.generation}/${local.WEBHOOK_SECRET}`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"DeletedCallback",instanceId:"instance",connectedPhone:"device",phone:"outbox-chat",messageId:"outbox-message",fromMe:false,momment:100})
    }),local,createExecutionContext());
    expect(await response.json()).toMatchObject({accepted:true,captured:true});
    expect((await changes()).results.at(-1)?.operation).toBe("withdraw");
  });
  it("records physical deletion without retaining the message body",async()=>{
    const {messageId}=await ingest();
    await env.DB.batch([env.DB.prepare("DELETE FROM message_versions WHERE message_id=?").bind(messageId!),env.DB.prepare("DELETE FROM messages WHERE id=?").bind(messageId!)]);
    const rows=(await changes()).results;
    expect(rows.at(-1)?.operation).toBe("withdraw");
    expect(rows.at(-1)?.source_id).toBe(messageId);
    expect(JSON.stringify(rows)).not.toContain("original");
  });
});
