import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TelegramLink, telegramLinkGuard, type TelegramLinkFence } from "../assistant/telegram-auth";
import { receiveTelegram } from "../assistant/telegram-webhook";
// @ts-expect-error Raw SQL.
import schema from "../assistant/migrations/0018_telegram_owner_link.sql?raw";
let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string }, now: number;
const secret = "synthetic-telegram-webhook-secret-for-tests", bot = "synthetic_bot";
const controller = (key = secret) => new TelegramLink(env.DB, scope, bot, key, () => now);
const query = (sql: string, ...values: (string | number | null)[]) => env.DB.prepare(sql).bind(scope.installationId, scope.generation, bot, ...values);
const message = (update_id = 1, text = "hello", user = 101, chat = 101, date = Math.floor(now / 1000)) => ({ update_id,
  message: { message_id: update_id + 100, date, from: { id: user, is_bot: false, first_name: "Synthetic" }, chat: { id: chat, type: "private" }, text } });
const start = (id: number, link: string, user = 101, chat = 101) => message(id, `/start ${new URL(link).searchParams.get("start")}`, user, chat);
async function begin(operationId = "begin", expectedRevision = 0) { return await controller().execute({ kind: "telegram_link.begin", operationId, expectedRevision }) as { pairingId: string; link: string; revision: number }; }
async function activate(offset = 0, expectedRevision = 0) {
  const a = await begin(`begin-${offset}`, expectedRevision);
  expect(await controller().receive(start(1 + offset, a.link))).toBe("pairing_claimed");
  const b = await controller().execute({ kind: "telegram_link.confirm", operationId: `confirm-${offset}`, pairingId: a.pairingId }) as { link: string };
  expect(await controller().receive(start(2 + offset, b.link))).toBe("linked");
  return { a, b };
}
beforeEach(async () => {
  now = 2_000_000;
  scope = { installationId: crypto.randomUUID(), generation: "generation", sourceEpoch: "epoch", sourceGeneration: "capture" };
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS assistant_owner_commands (installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,token TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(installation_id,generation,operation_id));`);
  await env.DB.batch(schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
});
afterEach(() => vi.restoreAllMocks());
it("requires two proofs and binds the second proof to the same human private chat", async () => {
  const a = await begin(); expect(new URL(a.link).searchParams.get("start")).toMatch(/^p_[A-Za-z0-9_-]{43}$/);
  expect(await controller().receive(start(1, a.link))).toBe("pairing_claimed");
  expect(await controller().receive(message(2))).toBe("denied");
  const b = await controller().execute({ kind: "telegram_link.confirm", operationId: "confirm", pairingId: a.pairingId }) as { link: string };
  expect(await controller().receive(start(3, b.link, 202, 101))).toBe("denied");
  expect(await controller().receive(start(4, b.link, 101, 202))).toBe("denied");
  expect(await controller().receive(start(5, b.link))).toBe("linked");
  expect(await controller().execute({ kind: "telegram_link.status" })).toMatchObject({ state: "active", revision: 1 });
  await expect(begin("overwrite", 1)).rejects.toThrow("telegram_precondition");
  const rows = await query("SELECT revision FROM assistant_telegram_links WHERE installation_id=? AND generation=? AND bot_instance=?").all();
  expect(rows.results).toEqual([{ revision: 1 }]);
});
it("deduplicates updates durably, accepts out of order IDs, and rejects conflicting replay", async () => {
  const { b } = await activate();
  expect(await controller().receive(start(2, b.link))).toBe("linked");
  now += 1000;
  expect(await controller().receive(message(50))).toBe("pending");
  expect(await controller().receive(message(4))).toBe("pending");
  expect(await controller().receive(message(4))).toBe("pending");
  expect(await controller().receive(message(4, "different"))).toBe("conflict");
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND state='pending'").first("n")).toBe(2);
});
it("revokes via MCP, cancels inbox, rejects stale fences and blocks unseen pre-relink messages", async () => {
  await activate(); now += 1000;
  await controller().receive(message(3));
  const fence: TelegramLinkFence = { ...scope, botInstance: bot, linkRevision: 1, userId: "101", chatId: "101" };
  const guard = telegramLinkGuard(fence);
  expect(await env.DB.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.values).first("ok")).toBe(1);
  expect(await controller().execute({ kind: "telegram_link.revoke", operationId: "revoke", expectedRevision: 1 })).toMatchObject({ revision: 2, state: "revoked" });
  expect(await env.DB.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
  expect(await query("SELECT state FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("state")).toBe("cancelled");
  now += 5000; await activate(10, 2);
  expect(await controller().receive(message(30, "old unseen", 101, 101, 2001))).toBe("denied_before_activation");
  expect(await controller().receive(message(31))).toBe("denied_ambiguous_activation");
  expect(await controller().receive(message(32, "future", 101, 101, Math.floor(now / 1000) + 1))).toBe("denied_future");
  expect(await controller().receive(message(3, "hello", 101, 101, 2001))).toBe("pending"); // original durable receipt, cancelled state never reopens
  expect(await query("SELECT state FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("state")).toBe("cancelled");
});
it("recovers deterministic capabilities and receipts after commit ACK loss and restart without storing raw capabilities", async () => {
  const batch = env.DB.batch.bind(env.DB);
  const lose = () => vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("lost ACK"); });
  let fault = lose(); await expect(begin()).rejects.toThrow("lost ACK"); fault.mockRestore();
  const a = await begin(); expect(await begin()).toEqual(a);
  await controller().receive(start(1, a.link));
  const command = { kind: "telegram_link.confirm", operationId: "confirm", pairingId: a.pairingId };
  fault = lose(); await expect(controller().execute(command)).rejects.toThrow("lost ACK"); fault.mockRestore();
  const b = await controller().execute(command) as { link: string };
  expect(await controller().execute(command)).toEqual(b);
  fault = lose(); await expect(controller().receive(start(2, b.link))).rejects.toThrow("lost ACK"); fault.mockRestore();
  expect(await controller().receive(start(2, b.link))).toBe("linked");
  expect(await controller().execute({ kind: "telegram_link.status" })).toMatchObject({ revision: 1 });
  const dump = JSON.stringify((await query("SELECT * FROM assistant_telegram_pairings WHERE installation_id=? AND generation=? AND bot_instance=?").all()).results) + JSON.stringify((await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).all()).results);
  expect(dump).not.toContain(new URL(a.link).searchParams.get("start")!.slice(2));
  expect(dump).not.toContain(new URL(b.link).searchParams.get("start")!.slice(2));
  expect(dump).not.toContain(secret);
  await expect(controller("rotated-synthetic-webhook-secret").execute(command)).rejects.toThrow("telegram_capability_rotated");
});
it("rejects expiry, affinity changes, injected authority and pending-attempt replacement", async () => {
  const a = await begin();
  await expect(controller().execute({ kind: "telegram_link.begin", operationId: "bad", expectedRevision: 0, userId: "101" })).rejects.toThrow("telegram_input");
  await expect(controller().execute({ kind: "telegram_link.confirm", operationId: "early", pairingId: a.pairingId })).rejects.toThrow("telegram_precondition");
  const other = new TelegramLink(env.DB, { ...scope, sourceEpoch: "other" }, bot, secret, () => now);
  expect(await other.receive(start(1, a.link))).toBe("denied");
  const fresh = await begin("replacement");
  expect(await controller().receive(start(2, a.link))).toBe("denied");
  now += 300_000;
  expect(await controller().receive(start(3, fresh.link))).toBe("denied");
});
it("authenticates before reading a body and caps streams without Content-Length", async () => {
  const read = vi.fn(() => { throw new Error("body touched"); });
  const settings = { DB: env.DB, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_INSTANCE: bot, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration };
  const denied = { headers: new Headers({ "X-Telegram-Bot-Api-Secret-Token": "wrong" }), get body() { read(); return null; } } as Request;
  expect((await receiveTelegram(denied, settings)).status).toBe(403); expect(read).not.toHaveBeenCalled();
  const request = new Request("https://example.invalid/webhooks/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65_537)); c.close(); } }) });
  expect((await receiveTelegram(request, settings)).status).toBe(413);
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=?").first("n")).toBe(0);
});
it.each(["sender_chat", "via_bot", "forward_origin", "business_connection_id"])("refuses %s before persisting any sender", async field => {
  await activate(); now += 1000;
  const input = message(10); Object.assign(input.message, { [field]: {} });
  expect(await controller().receive(input)).toBe("unsupported");
  expect(await query("SELECT update_id FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=10").first()).toBeNull();
});
it("rejects bot, group, edited, unsupported, oversized and unsafe identity inputs", async () => {
  await activate(); now += 1000;
  for (const input of [ { ...message(10), message: { ...message(10).message, from: { id: 101, is_bot: true } } }, { ...message(10), message: { ...message(10).message, chat: { id: 101, type: "group" } } }, { update_id: 10, edited_message: message(10).message }, { update_id: 10, callback_query: {} } ]) expect(await controller().receive(input)).toBe("unsupported");
  await expect(controller().receive(message(10, "😃".repeat(4097)))).rejects.toThrow("telegram_input");
  await expect(controller().receive(message(Number.MAX_SAFE_INTEGER + 1))).rejects.toThrow("telegram_input");
  expect(await controller().receive(message(11, "hello", 202))).toBe("denied");
});

import { OwnerAssistant } from "../assistant/mcp";
import { mcpFetch, createMcpServer } from "../src/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../assistant/index";
import type { Env } from "../src/env";
const hostEnv = () => ({ DB: env.DB, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_INSTANCE: bot,
  INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration });
it("requires authenticated MCP props and exact affinity for all link operations", async () => {
  const rpc = new OwnerAssistant(createExecutionContext(), hostEnv());
  for (const key of Object.keys(scope) as (keyof typeof scope)[])
    await expect(rpc.telegramLink({ ...scope, [key]: "foreign" }, { kind: "telegram_link.status" })).rejects.toThrow("owner_binding_affinity");
  const settings = { ...env, MAINTENANCE: "false", OWNER_SUB: "synthetic-owner", INSTALLATION_EPOCH: scope.sourceEpoch,
    CONNECTION_GENERATION: scope.sourceGeneration, ASSISTANT_INSTALLATION_ID: scope.installationId,
    ASSISTANT_GENERATION: scope.generation, ASSISTANT_OWNER: rpc } as unknown as Env;
  const server = createMcpServer(settings), client = new Client({ name: "telegram-no-props", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try { expect((await client.listTools()).tools.some(t => t.name === "assistente_telegram")).toBe(false); }
  finally { await client.close(); await server.close(); }
  const request = (command: unknown) => new Request("https://example.invalid/mcp", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assistente_telegram", arguments: { command } } }) });
  await expect(mcpFetch(request({ kind: "telegram_link.status" }), settings, undefined)).rejects.toThrow();
  const response = await mcpFetch(request({ kind: "telegram_link.begin", operationId: "http-begin", expectedRevision: 0 }), settings, { sub: settings.OWNER_SUB, epoch: scope.sourceEpoch });
  const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result.isError).not.toBe(true);
  expect(JSON.parse(body.result.content[0].text)).toMatchObject({ kind: "telegram_link.begin", state: "issued" });
  const forged = await mcpFetch(request({ kind: "telegram_link.status", role: "owner", namespace: "foreign" }), settings, { sub: settings.OWNER_SUB, epoch: scope.sourceEpoch });
  expect((await forged.json() as { result: { isError: boolean } }).result.isError).toBe(true);
});
it("exposes only the exact POST webhook route and returns durable denial without leaking payload", async () => {
  for (const [method, path] of [["GET", "/webhooks/telegram"], ["POST", "/webhooks/telegram/"], ["POST", "/telegram_link.begin"]])
    expect((await worker.fetch(new Request("https://example.invalid" + path, { method }), hostEnv())).status).toBe(403);
  const request = new Request("https://example.invalid/webhooks/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(message(1)) });
  const response = await worker.fetch(request, hostEnv());
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ code: "denied" });
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=?").first("n")).toBe(0);
});

it("claims only one competing candidate and never resets its identity on replay", async () => {
  const a = await begin();
  const results = await Promise.all([controller().receive(start(1, a.link, 101, 101)), controller().receive(start(2, a.link, 202, 202))]);
  expect(results.sort()).toEqual(["denied", "pairing_claimed"]);
  const pair = await query("SELECT user_id,chat_id FROM assistant_telegram_pairings WHERE installation_id=? AND generation=? AND bot_instance=? AND id=?", a.pairingId).first<{ user_id: string; chat_id: string }>();
  const user = Number(pair!.user_id), chat = Number(pair!.chat_id), other = user === 101 ? 202 : 101;
  const b = await controller().execute({ kind: "telegram_link.confirm", operationId: "confirm", pairingId: a.pairingId }) as { link: string };
  expect(await controller().receive(start(4, b.link, other, other))).toBe("denied");
  expect(await controller().receive(start(5, b.link, user, chat))).toBe("linked");
  now += 1000;
  expect(await Promise.all([controller().receive(message(6, "same", user, chat)), controller().receive(message(6, "same", user, chat))])).toEqual(["pending", "pending"]);
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=6").first("n")).toBe(1);
});
it("revocation wins a race against activation and inbox admission without leaving receipts", async () => {
  const a = await begin(); await controller().receive(start(1, a.link));
  const b = await controller().execute({ kind: "telegram_link.confirm", operationId: "confirm", pairingId: a.pairingId }) as { link: string };
  const batch = env.DB.batch.bind(env.DB);
  let fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    fault.mockRestore(); await controller().execute({ kind: "telegram_link.revoke", operationId: "revoke-zero", expectedRevision: 0 }); return batch(statements);
  });
  expect(await controller().receive(start(2, b.link))).toBe("denied");
  expect(await controller().execute({ kind: "telegram_link.status" })).toMatchObject({ state: "revoked", revision: 1 });
  expect(await query("SELECT update_id FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=2").first()).toBeNull();
  now += 1000; await activate(10, 1); now += 1000;
  fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    fault.mockRestore(); await controller().execute({ kind: "telegram_link.revoke", operationId: "revoke-two", expectedRevision: 2 }); return batch(statements);
  });
  expect(await controller().receive(message(20))).toBe("denied");
  expect(await query("SELECT update_id FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=20").first()).toBeNull();
});
it("rolls back the complete activation when its final SQL statement fails", async () => {
  const a = await begin(); await controller().receive(start(1, a.link));
  const b = await controller().execute({ kind: "telegram_link.confirm", operationId: "confirm", pairingId: a.pairingId }) as { link: string };
  const batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(statements => batch([...statements, env.DB.prepare("INSERT INTO missing_telegram_rollback_table VALUES(1)")]));
  await expect(controller().receive(start(2, b.link))).rejects.toThrow(); fault.mockRestore();
  expect(await controller().execute({ kind: "telegram_link.status" })).toMatchObject({ state: "unlinked", revision: 0, pairing: { state: "confirmable" } });
  expect(await query("SELECT update_id FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=2").first()).toBeNull();
  expect(await controller().receive(start(2, b.link))).toBe("linked");
});
it("recovers revocation and temporal denial ACK loss without reopening the cancelled inbox", async () => {
  await activate(); now += 1000; await controller().receive(message(3));
  const batch = env.DB.batch.bind(env.DB);
  let fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("lost ACK"); });
  const command = { kind: "telegram_link.revoke", operationId: "revoke", expectedRevision: 1 };
  await expect(controller().execute(command)).rejects.toThrow("lost ACK"); fault.mockRestore();
  expect(await controller().execute(command)).toMatchObject({ state: "revoked", revision: 2 });
  expect(await controller().execute(command)).toMatchObject({ state: "revoked", revision: 2 });
  now += 1000; await activate(10, 2);
  const ambiguous = message(20);
  fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("lost ACK"); });
  await expect(controller().receive(ambiguous)).rejects.toThrow("lost ACK"); fault.mockRestore(); now += 1000;
  expect(await controller().receive(ambiguous)).toBe("denied_ambiguous_activation");
  expect(await query("SELECT state FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("state")).toBe("cancelled");
});
it("bounds malformed structures and rejects an unsafe configured bot URL", async () => {
  await expect(controller().receive({ update_id: 1, message: "malformed" })).rejects.toThrow("telegram_input");
  let nested: unknown = {}; for (let i = 0; i < 40; i++) nested = { nested };
  await expect(controller().receive({ ...message(1), extra: nested })).resolves.toBe("unsupported");
  const input = message(2); Object.assign(input.message, { metadata: nested });
  await expect(controller().receive(input)).rejects.toThrow("telegram_input");
  expect(() => new TelegramLink(env.DB, scope, "bad/path?token=unsafe", secret)).toThrow("telegram_unconfigured");
});
