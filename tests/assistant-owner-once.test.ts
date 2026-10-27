import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { OwnerAssistant, type OwnerAffinity } from "../assistant/mcp";
import { SourceController } from "../assistant/sources";
import { OwnerControl } from "../assistant/control";
import { InferenceBudget } from "../assistant/budget";
import type { AssistantEnv } from "../assistant/env";
import { JobQueue } from "../assistant/queue";
import { RetentionPurge } from "../assistant/retention-purge";
import { SourceAccess } from "../assistant/access";
import { CanonicalEngineGuard } from "../assistant/container";
import { readOnceGrant, onceReceipt } from "../assistant/owner-once-guard";
import type { InitialIngestAdmission } from "../assistant/engine";

// @ts-expect-error Vite raw migration fixtures, including future additive files.
const migrations = import.meta.glob("../assistant/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
type Receiver = { ownerOnce(expected: OwnerAffinity, command: unknown): Promise<unknown> };
let scope: OwnerAffinity, settings: AssistantEnv, now: number;
let bootstrap: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  for (const [_, migration] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    const sql = migration.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(part => part.trim());
    if (sql.length) await env.DB.batch(sql.map(part => env.DB.prepare(part)));
  }
  now = Date.parse("2026-10-27T12:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  scope = { installationId: crypto.randomUUID(), generation: "once-g1", sourceEpoch: "once-e1", sourceGeneration: "once-c1" };
  bootstrap = vi.fn(async () => { throw Error("plan_must_not_start_ingestion"); });
  const engine = { lifecycleState: vi.fn(async () => ({ running: false })), reserveInitialIngest: bootstrap, commitInitialIngest: bootstrap, ingest: bootstrap };
  settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation,
    BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration,
    OPENAI_API_KEY: "synthetic-unused-key", FLUE_EPISODES_ENABLED: "shadow", ROUTINES_ENABLED: "shadow", ROUTINES_PAUSED: "true", SEMANTIC_SEARCH_MODE: "required",
    COGNEE: { idFromName: () => ({ toString: () => "synthetic-once-engine" }), get: () => engine } as unknown as NonNullable<AssistantEnv["COGNEE"]> };
  await new OwnerControl(env.DB, scope, { kind: "owner" }).execute({ kind: "project.put", id: "once-project", name: "Synthetic bounded project", expectedVersion: 0, operationId: "once-project" });
  await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).configure(600000);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("plans bounded Owner execution through the authenticated receiver without admitting a model or bootstrap", async () => {
  const text = "Synthetic Owner request: explain the blue test marker. No external action is authorized.";
  const source = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "owner-once-request", text, audience: "owner", projectId: "once-project", occurredAt: now });
  const rpc = new OwnerAssistant(createExecutionContext(), settings) as unknown as Receiver;
  expect(rpc.ownerOnce).toBeTypeOf("function");
  const result = await rpc.ownerOnce(scope, { kind: "owner_once.plan", operationId: "once-valid", sourceId: source.id, expectedRevision: 1,
    projectId: "once-project", query: "Explain the blue test marker using the source.", deadlineAt: now + 600000, maxCostMicroUsd: 600000 });
  expect(result).toMatchObject({ state: "planned", corpus: { sourceCount: 1, utf8Bytes: new TextEncoder().encode(text).length } });
  expect(JSON.stringify(result)).not.toContain(text);
  expect(bootstrap).not.toHaveBeenCalled();
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(0);
  expect(settings.ROUTINES_PAUSED).toBe("true");
});

async function fixture(text = "Synthetic private blue marker") {
  const sources = new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  const source = await sources.create({ originKey: crypto.randomUUID(), text, audience: "owner", projectId: "once-project", occurredAt: now });
  const rpc = new OwnerAssistant(createExecutionContext(), settings) as unknown as Receiver;
  const command = { kind: "owner_once.plan", operationId: "once-case", sourceId: source.id, expectedRevision: 1,
    projectId: "once-project", query: "Explain the private blue marker", deadlineAt: now + 600000, maxCostMicroUsd: 600000 };
  return { sources, source, rpc, command };
}
const retirement = { allow: async () => {}, withdraw: async () => {} };
async function purge(id: string) {
  const retention = new RetentionPurge(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  for (let i = 0; i < 20; i++) {
    const result = await retention.advance({ kind: "source.purge", operationId: `purge-${id}`, sourceId: id });
    if (result.state !== "pending") { expect(result.state).toBe("complete"); return; }
  }
  throw Error("synthetic_purge_no_progress");
}
it("recovers the same plan after a lost receipt ACK and rejects a changed question", async () => {
  const { rpc, command } = await fixture(), batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementation(async statements => {
    const result = await batch(statements);
    if (await env.DB.prepare("SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first()) {
      fault.mockRestore(); throw Error("synthetic_plan_ack_lost");
    }
    return result;
  });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("synthetic_plan_ack_lost");
  const recovered = await rpc.ownerOnce(scope, command);
  expect(recovered).toMatchObject({ state: "planned" });
  expect(await rpc.ownerOnce(scope, command)).toEqual(recovered);
  await expect(rpc.ownerOnce(scope, { ...command, query: "Another question" })).rejects.toThrow("control_operation_conflict");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(1);
});
it("keeps private bodies, question and raw catalog names out of immutable receipts", async () => {
  const { rpc, command } = await fixture("secret body only in canonical source");
  await rpc.ownerOnce(scope, command);
  const rows = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).all();
  const stored = JSON.stringify(rows.results);
  for (const privateText of ["secret body only in canonical source", command.query, "Synthetic bounded project"]) expect(stored).not.toContain(privateText);
});
it.each(["withdraw", "addition", "revision"] as const)("blocks the original receipt after corpus %s without making a fresh job", async mode => {
  const { rpc, command, source, sources } = await fixture();
  await rpc.ownerOnce(scope, command);
  if (mode === "withdraw") await sources.withdraw(source.id, 1);
  if (mode === "revision") await sources.correct(source.id, 1, { text: "Revised marker", occurredAt: now });
  if (mode === "addition") await sources.create({ originKey: "support", text: "New supporting original", audience: "owner", projectId: "once-project", occurredAt: now });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "blocked" });
  expect(await rpc.ownerOnce(scope, command)).toMatchObject({ state: "blocked" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(1);
  expect(bootstrap).not.toHaveBeenCalled();
});
it("refuses a concurrently enlarged corpus in the same receipt transaction", async () => {
  const { rpc, command, sources } = await fixture(), batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    fault.mockRestore();
    await sources.create({ originKey: "concurrent-support", text: "Concurrent support", audience: "owner", projectId: "once-project", occurredAt: now });
    return batch(statements);
  });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("job_admission_changed");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
});
it("counts UTF8 bytes and rejects an oversized original", async () => {
  const { rpc, command } = await fixture("é".repeat(12001));
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("owner_once_corpus");
});
it("rejects the twenty fifth authorized original instead of truncating the project", async () => {
  const { rpc, command, sources } = await fixture();
  for (let i = 0; i < 24; i++) await sources.create({ originKey: `support-${i}`, text: `Support ${i}`, audience: "owner", projectId: "once-project", occurredAt: now });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("owner_once_corpus");
});
it.each(["foreign_affinity", "foreign_project", "wrong_revision", "deadline", "budget", "arbitrary_actor", "query_bytes"])("rejects %s before creating execution work", async mode => {
  const { rpc, command } = await fixture();
  const raw: Record<string, unknown> = { ...command };
  if (mode === "foreign_project") raw.projectId = "foreign-project";
  if (mode === "wrong_revision") raw.expectedRevision = 2;
  if (mode === "deadline") raw.deadlineAt = now + 900001;
  if (mode === "budget") raw.maxCostMicroUsd = 100;
  if (mode === "arbitrary_actor") raw.actor = { kind: "owner" };
  if (mode === "query_bytes") raw.query = "é".repeat(1025);
  await expect(rpc.ownerOnce(mode === "foreign_affinity" ? { ...scope, generation: "foreign" } : scope, raw)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
});
it.each(["pause", "cap", "utc_day", "hold"])("blocks a recovered plan after %s changes", async mode => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  if (mode === "pause") settings.ROUTINES_PAUSED = "false";
  if (mode === "cap") await env.DB.prepare("UPDATE assistant_budget_accounts SET cap_units=700000 WHERE installation_id=?").bind(scope.installationId).run();
  if (mode === "utc_day") vi.setSystemTime(now + 86400000);
  if (mode === "hold") await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold(installation_id,operation_id,target_generation,active,created_at) VALUES(?,'synthetic-hold',?,1,?)").bind(scope.installationId, scope.generation, now).run();
  expect(await rpc.ownerOnce(scope, command)).toMatchObject({ state: "blocked" });
});
it("does not let the generic queue claim a plan before explicit Owner admission", async () => {
  const { rpc, command } = await fixture(); const result = await rpc.ownerOnce(scope, command) as { jobId: string };
  const queue = new JobQueue(env.DB, scope);
  expect(await queue.claim(now)).toBeNull();
  expect(await queue.claimId(result.jobId, now)).toBeNull();
  expect((await queue.get(result.jobId))?.attempts).toBe(0);
});
it("does not rewrite a private question after withdrawal and purge win the admission race", async () => {
  const { rpc, command, source, sources } = await fixture(), batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    fault.mockRestore(); await sources.withdraw(source.id, 1); await purge(source.id); return batch(statements);
  });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("job_admission_changed");
  for (const table of ["assistant_jobs", "assistant_job_ledger"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE installation_id=?`).bind(scope.installationId).first("n")).toBe(0);
  }
});
it("purges a planned job when a supporting original is removed, retaining only its nontext replay tombstone", async () => {
  const { rpc, command, sources } = await fixture();
  const support = await sources.create({ originKey: "support-to-purge", text: "Private supporting body", audience: "owner", projectId: "once-project", occurredAt: now });
  const planned = await rpc.ownerOnce(scope, command) as { jobId: string };
  await sources.withdraw(support.id, 1); await purge(support.id);
  expect(await new JobQueue(env.DB, scope).get(planned.jobId)).toBeNull();
  expect(await rpc.ownerOnce(scope, command)).toMatchObject({ state: "blocked", jobId: planned.jobId });
  const tombstone = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  expect(tombstone).toBeTruthy(); expect(tombstone).not.toContain(command.query); expect(tombstone).not.toContain("Private supporting body");
});
it("does not invalidate source authority merely because ingestion adds derived relations", async () => {
  const { rpc, command, source } = await fixture(); await rpc.ownerOnce(scope, command);
  const current = (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, source.id))!;
  await env.DB.prepare("INSERT INTO assistant_relation_batches VALUES(?,?,?,?,?,1,1,?,'synthetic-author',NULL,'[]')")
    .bind(scope.installationId, scope.generation, "synthetic-derived-after-plan", "a".repeat(64), source.id, current.fence.source.hash).run();
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "planned" });
});
it("invalidates source authority when the selected project metadata changes", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  await new OwnerControl(env.DB, scope, { kind: "owner" }).execute({ kind: "project.put", id: "once-project", name: "Changed project metadata", expectedVersion: 1, operationId: "project-rename" });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "blocked" });
});
it("bounds metadata volume even when the original corpus is small", async () => {
  const { rpc, command, source } = await fixture(), control = new OwnerControl(env.DB, scope, { kind: "owner" });
  for (let i = 0; i < 18; i++) await control.execute({ kind: "mission.put", operationId: `large-mission-${i}`, id: `large-${i}`,
    expectedRevision: 0, objective: "x".repeat(2048), source: { id: source.id, revision: 1 }, state: "draft" });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("owner_once_manifest_capacity");
});
it("rechecks expiry after status awaits rather than reporting an expired plan as usable", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  const namespace = settings.COGNEE!, original = namespace.idFromName.bind(namespace);
  vi.spyOn(namespace, "idFromName").mockImplementationOnce(name => { vi.setSystemTime(command.deadlineAt + 1); return original(name); });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "blocked" });
});
it("records explicit admission separately from planning and recovers its original receipt without charging", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  const first = await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  expect(first).toMatchObject({ state: "admitted" });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toEqual(first);
  expect(await rpc.ownerOnce(scope, command)).toEqual(first);
  const receipts = await env.DB.prepare("SELECT result_json,token FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-admit-v1:%'").bind(scope.installationId).all<{ result_json: string; token: string }>();
  expect(receipts.results).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain(receipts.results[0].token);
  expect(bootstrap).not.toHaveBeenCalled();
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(0);
});
it("does not admit a withdrawn plan or create a replacement operation", async () => {
  const { rpc, command, source, sources } = await fixture(); await rpc.ownerOnce(scope, command);
  await sources.withdraw(source.id, 1);
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId })).toMatchObject({ state: "blocked" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-admit-v1:%'").bind(scope.installationId).first("n")).toBe(0);
});
it("admits bootstrap under pause only with the separate current Owner receipt", async () => {
  const { rpc, command, source } = await fixture(); const planned = await rpc.ownerOnce(scope, command) as { id: string };
  const input = { actor: { kind: "owner" } as const, source: (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, source.id))! };
  const guard = new CanonicalEngineGuard(settings);
  const admission = { kind: "owner_once", itemId: planned.id, owner: crypto.randomUUID() } as InitialIngestAdmission;
  expect(await guard.checkInitialAdmission(admission, input)).toBe(false);
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const grant = (await readOnceGrant(settings, onceReceipt.parse(JSON.parse(raw!))))!;
  admission.owner = grant.token;
  expect(await guard.checkInitialAdmission(admission, input)).toBe(true);
  expect(await guard.checkInitialAdmission({ itemId: admission.itemId, owner: admission.owner }, input)).toBe(false);
  expect(await guard.checkInitialAdmission({ ...admission, owner: crypto.randomUUID() }, input)).toBe(false);
});
it("redacts durable admission grants from the paginated MCP export, including reconstructed chunks", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const token = await env.DB.prepare("SELECT token FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-admit-v1:%'").bind(scope.installationId).first<string>("token");
  expect(token).toBeTruthy();
  const reader = new OwnerAssistant(createExecutionContext(), settings);
  type Part = { table: string; row: number; offset: number; data: string };
  const rows = new Map<number, Part[]>(); let cursor: string | undefined;
  do {
    const page = await reader.query(scope, { kind: "assistant.export", limit: 50, ...(cursor ? { cursor } : {}) }) as { parts: Part[]; nextCursor?: string };
    for (const part of page.parts.filter(part => part.table === "assistant_owner_commands")) rows.set(part.row, [...(rows.get(part.row) ?? []), part]);
    cursor = page.nextCursor;
  } while (cursor);
  const exported = [...rows.values()].map(parts => {
    const chunks = parts.sort((a, b) => a.offset - b.offset).map(part => Uint8Array.from(atob(part.data), c => c.charCodeAt(0)));
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  });
  expect(JSON.stringify(exported)).not.toContain(token!);
  expect(exported.find(row => row.operation_id.startsWith("owner-once-admit-v1:"))).toMatchObject({ token: null });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "admitted" });
});
