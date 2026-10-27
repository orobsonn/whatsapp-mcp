import { afterAll, beforeAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(import.meta.dirname, ".."), scratch = mkdtempSync(join(tmpdir(), "telegram-native-"));
const affinity = { installationId: "synthetic-native-telegram", generation: "g1", sourceEpoch: "e1", sourceGeneration: "capture-g1" };
const secret = "synthetic-native-telegram-webhook-secret", token = "123456789:synthetic_token_12345678901234567890";
let runtime: Miniflare, calls: string[] = [];
function filesAt(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name); return entry.isDirectory() ? filesAt(path) : [path];
  });
}
beforeAll(async () => {
  execFileSync("npm", ["run", "build:assistant"], { cwd: root, stdio: "pipe" });
  const files = filesAt(join(root, "dist/assistant")), configPath = files.find(path => path.endsWith("wrangler.json"))!;
  const config = JSON.parse(readFileSync(configPath, "utf8")), base = dirname(configPath), main = resolve(base, config.main);
  runtime = new Miniflare({ ...convertV4MiniflareOptions({ workers: [{
    name: "telegram-official", modulesRoot: base,
    modules: [main, ...files.filter(path => /\.m?js$/.test(path) && path !== main)].map(path => ({ type: "ESModule" as const, path })),
    compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    durableObjects: Object.fromEntries(config.durable_objects.bindings.map((binding: { name: string; class_name: string }) =>
      [binding.name, { className: binding.class_name, useSQLite: true }])),
    bindings: { INSTALLATION_ID: affinity.installationId, OPERATIONAL_GENERATION: affinity.generation,
      BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration,
      TELEGRAM_BOT_INSTANCE: "synthetic_bot", TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_TOKEN: token },
    outboundService: async request => {
      const url = new URL(request.url), method = url.pathname.split("/").at(-1)!;
      if (url.origin !== "https://api.telegram.org" || url.pathname !== `/bot${token}/${method}` || request.method !== "POST") throw Error("unexpected_outbound");
      calls.push(method);
      if (method === "getMe") return Response.json({ ok: true, result: { is_bot: true, username: "synthetic_bot", has_topics_enabled: true } });
      if (method === "createForumTopic") {
        const body = await request.json() as { chat_id: string; name: string };
        if (body.chat_id !== "101") throw Error("unexpected_chat");
        return Response.json({ ok: true, result: { name: body.name, message_thread_id: 100 + calls.length } });
      }
      throw Error("unexpected_telegram_method");
    },
  }, {
    name: "telegram-owner-caller", modules: true, compatibilityDate: "2026-10-25",
    script: `export default {async fetch(request,env){const {method,affinity,input}=await request.json();
      if(!['telegramLink','telegramReview'].includes(method))throw Error('unsupported');
      return Response.json(await env.OWNER[method](affinity,input));}};`,
    serviceBindings: { OWNER: { name: "telegram-official", entrypoint: "OwnerAssistant", props: {} } },
  }] }), resourcePersistencePath: join(scratch, "state") });
  const db = await runtime.getD1Database("DB", "telegram-official");
  for (const name of readdirSync(join(root, "assistant/migrations")).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(root, "assistant/migrations", name), "utf8").replace(/^--.*$/gm, "").trim();
    const parts = sql.split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(part => part.trim());
    if (parts.length) await db.batch(parts.map(part => db.prepare(part)));
  }
});
afterAll(async () => { await runtime?.dispose(); rmSync(scratch, { recursive: true, force: true }); });
async function owner(method: string, input: unknown) {
  const caller = await runtime.getWorker("telegram-owner-caller");
  const response = await caller.fetch("https://synthetic.invalid/", { method: "POST", body: JSON.stringify({ method, affinity, input }) });
  expect(response.status).toBe(200); return response.json() as Promise<Record<string, unknown>>;
}
async function challenge(link: string, updateId: number) {
  const worker = await runtime.getWorker("telegram-official");
  const response = await worker.fetch("https://synthetic.invalid/webhooks/telegram", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ update_id: updateId,
      message: { message_id: updateId, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false },
        chat: { id: 101, type: "private" }, text: `/start ${new URL(link).searchParams.get("start")}` } }) });
  expect(response.status).toBe(200);
}
test("official owner binding creates four topics through native workerd fetch without binding its receiver", async () => {
  const begin = await owner("telegramLink", { kind: "telegram_link.begin", operationId: "native-begin", expectedRevision: 0 });
  await challenge(begin.link as string, 1);
  const confirm = await owner("telegramLink", { kind: "telegram_link.confirm", operationId: "native-confirm", pairingId: begin.pairingId });
  await challenge(confirm.link as string, 2);
  expect(await owner("telegramLink", { kind: "telegram_link.status" })).toMatchObject({ state: "active" });
  const result = await owner("telegramReview", { kind: "topics.ensure" });
  expect(result).toMatchObject({ mode: "shadow", topics: expect.arrayContaining([
    { slot: "general", state: "ready", thread_id: 102, preflights: 1 },
    { slot: "summaries", state: "ready", thread_id: 104, preflights: 1 },
    { slot: "pending", state: "ready", thread_id: 106, preflights: 1 },
    { slot: "missions", state: "ready", thread_id: 108, preflights: 1 },
  ]) });
  expect(calls).toEqual(Array.from({ length: 4 }, () => ["getMe", "createForumTopic"]).flat());
  expect(await owner("telegramReview", { kind: "topics.ensure" })).toEqual(result);
  expect(calls).toHaveLength(8);
});
