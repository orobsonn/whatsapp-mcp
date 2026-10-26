import { beforeAll, afterAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(import.meta.dirname, ".."), scratch = mkdtempSync(join(tmpdir(), "assistant-owner-binding-"));
const affinity = { installationId: "synthetic-owner-binding", generation: "g1", sourceEpoch: "e1", sourceGeneration: "capture-g1" };
let runtime: Miniflare, outbound = 0;
function filesAt(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name); return entry.isDirectory() ? filesAt(path) : [path];
  });
}
async function start() {
  const files = filesAt(join(root, "dist/assistant"));
  const configPath = files.find(path => path.endsWith("wrangler.json"))!;
  const config = JSON.parse(readFileSync(configPath, "utf8")), base = dirname(configPath), main = resolve(base, config.main);
  runtime = new Miniflare({ ...convertV4MiniflareOptions({ workers: [{ name: "owner-receiver", modulesRoot: base,
    modules: [main, ...files.filter(path => /\.m?js$/.test(path) && path !== main)].map(path => ({ type: "ESModule" as const, path })),
    compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    durableObjects: Object.fromEntries(config.durable_objects.bindings.map((binding: { name: string; class_name: string }) =>
      [binding.name, { className: binding.class_name, useSQLite: true }])),
    bindings: { INSTALLATION_ID: affinity.installationId, OPERATIONAL_GENERATION: affinity.generation,
      BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration,
      TELEGRAM_BOT_INSTANCE: "synthetic_bot", TELEGRAM_WEBHOOK_SECRET: "synthetic-telegram-webhook-secret-for-tests" },
    outboundService: () => { outbound++; throw new Error("network_forbidden"); },
  }, { name: "owner-binding-probe", modules: true, compatibilityDate: "2026-10-25",
    script: `export default {async fetch(request,env){try{const {method,affinity,input}=await request.json();
      if(!['source','control','query','telegramLink','telegramReview'].includes(method))return new Response(null,{status:400});
      return Response.json(await env.OWNER[method](affinity,input));}catch{return Response.json({error:'binding_rejected'},{status:403});}}};`,
    serviceBindings: { OWNER: { name: "owner-receiver", entrypoint: "OwnerAssistant", props: {} } },
  }] }), resourcePersistencePath: join(scratch, "state") });
}
async function call(method: string, input: unknown, expected = affinity) {
  const probe = await runtime.getWorker("owner-binding-probe");
  const response = await probe.fetch("https://owner-binding.invalid/", { method: "POST", body: JSON.stringify({ method, affinity: expected, input }) });
  return { status: response.status, body: await response.json() };
}
beforeAll(() => { execFileSync("npm", ["run", "build:assistant"], { cwd: root, stdio: "pipe" }); });
afterAll(async () => { await runtime?.dispose(); rmSync(scratch, { recursive: true, force: true }); expect(outbound).toBe(0); });
test("official bundle exports the named owner capability and preserves command receipts across a real service binding and restart", async () => {
  await start();
  const db = await runtime.getD1Database("DB", "owner-receiver");
  for (const name of readdirSync(join(root, "assistant/migrations")).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(root, "assistant/migrations", name), "utf8").replace(/^--.*$/gm, "").trim();
    const parts = sql.split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(part => part.trim());
    if (parts.length) await db.batch(parts.map(part => db.prepare(part)));
  }
  const diary=await call("query",{kind:"decisions"});
  expect(diary).toMatchObject({status:200,body:{items:[],coverage:{kind:"page",remoteFreshness:"unchecked"}}});
  expect(await call("query",{kind:"decision",id:"capture:"+"x".repeat(300)})).toMatchObject({status:200,body:{state:"unavailable"}});
  expect((await call("telegramReview", { kind: "status" })).status).toBe(403); // Unlinked, never inferred from observed IDs.
  for (const key of Object.keys(affinity) as (keyof typeof affinity)[]) {
    expect((await call("telegramReview", { kind: "topics.ensure" }, { ...affinity, [key]: "foreign" })).status).toBe(403);
  }
  const command = { kind: "source.create", operationId: "bound-note", input: { originKey: "bound-note", text: "Synthetic owner note", occurredAt: 1 } };
  for (const key of Object.keys(affinity) as (keyof typeof affinity)[]) {
    expect((await call("source", command, { ...affinity, [key]: "foreign" })).status).toBe(403);
  }
  for (const extra of [{ role: "owner" }, { sub: "synthetic-owner" }, { namespace: "foreign" }, { userId: "101" }, { chatId: "101" }]) {
    expect((await call("telegramLink", { kind: "telegram_link.status", ...extra })).status).toBe(403);
  }
  for (const key of Object.keys(affinity) as (keyof typeof affinity)[])
    expect((await call("telegramLink", { kind: "telegram_link.status" }, { ...affinity, [key]: "foreign" })).status).toBe(403);
  const begin = { kind: "telegram_link.begin", operationId: "bound-telegram-begin", expectedRevision: 0 };
  const linked = await call("telegramLink", begin);
  expect(linked).toMatchObject({ status: 200, body: { kind: "telegram_link.begin", state: "issued", revision: 0 } });
  const first = await call("source", command);
  expect(first).toMatchObject({ status: 200, body: { revision: 1, version: 1, shadow: true } });
  expect(await call("control",{kind:"policy.put",operationId:"fup-policy",id:"chat",expectedRevision:0,conversationKind:"private"})).toMatchObject({status:200});
  const followUp={kind:"fup.put",operationId:"fup",id:"fup",expectedVersion:0,conversationId:"chat",policyRevision:1,source:{id:(first.body as {id:string}).id,revision:1},purpose:"Synthetic review",dueAt:"2030-10-26T09:00:00-03:00",timezone:"America/Fortaleza",precision:"exact",state:"scheduled"};
  expect(await call("control",followUp)).toMatchObject({status:200,body:{version:1,fupProvenance:1}});
  expect(await call("query",{kind:"follow_up",id:"fup"})).toMatchObject({status:200,body:{obligationState:"scheduled",dueAt:Date.UTC(2030,9,26,12),provenance:{evidenceKind:"owner_directive",conditionStatus:"none_explicit"}}});
  await runtime.dispose(); await start();
  expect(await call("source", command)).toEqual(first);
  expect(await call("telegramLink", begin)).toEqual(linked);
  expect(await call("control",followUp)).toMatchObject({status:200,body:{version:1}});
  const rows = await call("query", { kind: "sources" });
  expect(rows.body).toMatchObject({ items: [{ origin: "owner_note", revision: 1 }], coverage: "end_of_listing" });
  expect(JSON.stringify(rows.body)).not.toContain("Synthetic owner note");
});
