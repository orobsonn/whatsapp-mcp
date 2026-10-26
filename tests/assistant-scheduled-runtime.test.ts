import { afterAll, beforeAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(import.meta.dirname, ".."), scratch = mkdtempSync(join(tmpdir(), "assistant-scheduled-"));
let runtime: Miniflare, outbound = 0;
function filesAt(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name); return entry.isDirectory() ? filesAt(path) : [path];
  });
}
beforeAll(async () => {
  execFileSync("npm", ["run", "build:assistant"], { cwd: root, stdio: "pipe",
    env: { ...process.env, WRANGLER_LOG_PATH: join(scratch, "wrangler-logs") } });
  const files = filesAt(join(root, "dist/assistant")), configPath = files.find(path => path.endsWith("wrangler.json"))!;
  const config = JSON.parse(readFileSync(configPath, "utf8")), base = dirname(configPath), main = resolve(base, config.main);
  runtime = new Miniflare({ ...convertV4MiniflareOptions({ workers: [{ name: "scheduled-official", modulesRoot: base,
    modules: [main, ...files.filter(path => /\.m?js$/.test(path) && path !== main)].map(path => ({ type: "ESModule" as const, path })),
    compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    durableObjects: Object.fromEntries(config.durable_objects.bindings.map((binding: { name: string; class_name: string }) =>
      [binding.name, { className: binding.class_name, useSQLite: true }])),
    bindings: { INSTALLATION_ID: "synthetic-official-cron", OPERATIONAL_GENERATION: "g1",
      BRIDGE_SOURCE_EPOCH: "synthetic-epoch", BRIDGE_SOURCE_GENERATION: "capture-g1",
      BRIDGE_SECRET: "synthetic-bridge-secret-for-scheduled-test", ROUTINES_ENABLED: "shadow", ROUTINES_PAUSED: "true",
      FLUE_EPISODES_ENABLED: "shadow", MEDIA_CONTEXT_ENABLED: "false", TELEGRAM_SUMMARIES_ENABLED: "false",
      OPENAI_API_KEY: "synthetic-key-must-never-be-used" },
    serviceBindings: { CAPTURE_READER: { name: "forbidden-reader", entrypoint: "CaptureReader" } },
    outboundService: () => { outbound++; throw new Error("network_forbidden"); },
  }, { name: "forbidden-reader", modules: true, compatibilityDate: "2026-10-25",
    script: `import {WorkerEntrypoint} from "cloudflare:workers";
      export class CaptureReader extends WorkerEntrypoint {async readSnapshot(){throw Error("reader_not_expected_without_inbox");}}
      export default {fetch(){throw Error("reader_http_forbidden");}};`,
    outboundService: () => { outbound++; throw new Error("network_forbidden"); },
  }] }), resourcePersistencePath: join(scratch, "state") });
  const db = await runtime.getD1Database("DB", "scheduled-official");
  for (const name of readdirSync(join(root, "assistant/migrations")).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(root, "assistant/migrations", name), "utf8").replace(/^--.*$/gm, "").trim();
    const parts = sql.split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(part => part.trim());
    if (parts.length) await db.batch(parts.map(part => db.prepare(part)));
  }
});
afterAll(async () => { await runtime?.dispose(); rmSync(scratch, { recursive: true, force: true }); expect(outbound).toBe(0); });

test("official Flue default receives native scheduled events and runs paused routines once per natural minute without model effects", async () => {
  const worker = await runtime.getWorker("scheduled-official"), db = await runtime.getD1Database("DB", "scheduled-official");
  const startWindow = Math.floor(Date.now() / 60000);
  // Dispatch the generated entrypoint, not assistant/index.ts or AssistantScheduler directly.
  const results = await Promise.all([worker.scheduled({ cron: "* * * * *" }), worker.scheduled({ cron: "* * * * *" })]);
  expect(results.map(result => result.outcome)).toEqual(["ok", "ok"]);
  const endWindow = Math.floor(Date.now() / 60000);
  const cycles = (await db.prepare("SELECT window_key,state FROM assistant_routine_cycles ORDER BY window_key").all<{window_key:number;state:string}>()).results;
  expect(cycles.length).toBeGreaterThanOrEqual(1);
  expect(cycles.every(row => row.state === "completed")).toBe(true);
  expect(new Set(cycles.map(row => row.window_key)).size).toBe(cycles.length);
  // A real clock boundary permits one per each minute; it never permits two in the same minute.
  expect(cycles.length).toBeLessThanOrEqual(endWindow - startWindow + 1);
  if (startWindow === endWindow) expect(cycles).toHaveLength(1);
  const daily = (await db.prepare("SELECT payload_json FROM assistant_routine_reviews").all<{payload_json:string}>()).results;
  expect(daily).toHaveLength(1);
  expect(JSON.parse(daily[0]!.payload_json)).toMatchObject({ paused: true, budget: { state: "unconfigured" } });
  expect(await db.prepare("SELECT paused FROM assistant_routine_state").first("paused")).toBe(1);
  for (const table of ["assistant_jobs", "assistant_job_ledger", "assistant_episodes", "assistant_episode_calls",
    "assistant_model_permits", "assistant_model_receipts", "assistant_budget_accounts", "assistant_budget_reservations",
    "assistant_media_receipts", "assistant_media_artifacts", "assistant_shadow_decisions", "assistant_telegram_notifications", "assistant_telegram_summaries"]) {
    expect(await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), table).toBe(0);
  }
  const response = await worker.fetch("https://scheduled.invalid/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: "shadow", capabilities: { whatsappSend: false, calendarWrite: false } });
});
