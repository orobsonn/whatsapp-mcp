import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { RetentionPurge } from "../assistant/retention-purge";
import { RetentionObjects, retentionObjectPrefix } from "../assistant/retention-objects";
import { InferenceBudget } from "../assistant/budget";
import { CogneeModelBroker } from "../assistant/model-broker";
import { JobQueue } from "../assistant/queue";
// @ts-expect-error Vite SQL assets.
const migrations = import.meta.glob("../assistant/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const owner = { kind: "owner" } as const, digest = "a".repeat(64), guard = { allow: async () => {}, withdraw: async () => {} };
let scope: { installationId: string; generation: string; period: string }, controller: SourceController;
beforeEach(async () => {
  for (const [, sql] of Object.entries(migrations).sort()) await env.DB.batch(sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|DROP|$)/).filter(part => part.trim()).map(part => env.DB.prepare(part)));
  scope = { installationId: crypto.randomUUID(), generation: "g", period: "2026-10-26" }; controller = new SourceController(env.DB, scope, owner, () => 100, guard);
});
const note = (originKey = "source") => controller.create({ originKey, text: "Synthetic BODY remains private", occurredAt: 1 });
const count = (table: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE installation_id=? AND generation=?`).bind(scope.installationId, scope.generation).first<number>("n");
async function purge(id: string, db = env.DB, operationId = "purge") {
  const service = new RetentionPurge(db, scope, owner, () => 100, guard);
  for (let step = 0; step < 20; step++) { const result = await service.advance({ kind: "source.purge", operationId, sourceId: id }); if (result.state !== "pending") return result; }
  throw new Error("test_purge_progress");
}
test("pending external withdrawal atomically invalidates reads, guards, inventory and every version/revival writer", async () => {
  const source = await note(), access = new SourceAccess(env.DB, scope), original = (await access.read(owner, source.id))!;
  let entered!: () => void, release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }), external = new Promise<void>(resolve => { release = resolve; });
  const pending = new SourceController(env.DB, scope, owner, () => 100, { allow: guard.allow, withdraw: async () => { entered(); await external; } }).execute({ kind: "source.withdraw", operationId: "withdraw", id: source.id, expectedRevision: 1 });
  await waiting;
  expect(await access.read(owner, source.id)).toBeNull();
  const fence = access.guard(owner, original.fence, 100); expect(await env.DB.prepare(`SELECT 1 WHERE ${fence.sql}`).bind(...fence.values).first()).toBeNull();
  const inventory = access.inventory(owner, undefined, 100); expect((await env.DB.prepare(inventory.sql).bind(...inventory.values).all()).results).toEqual([]);
  await expect(env.DB.prepare("UPDATE assistant_sources SET status='active' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId, scope.generation, source.id).run()).rejects.toThrow("source_retired");
  await expect(env.DB.prepare("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,?,2,'late',?,1)").bind(scope.installationId, scope.generation, source.id, digest).run()).rejects.toThrow();
  await expect(new SourceController(env.DB, { ...scope, generation: "new-generation" }, owner).create({ originKey: "source", text: "late replay", occurredAt: 1 })).rejects.toThrow("source_retired");
  release(); expect(await pending).toMatchObject({ id: source.id, revision: 2, version: 1 });
});
test("DO refusal leaves a monotone local block and restart retries the same original CAS without another revision", async () => {
  const source = await note(); let attempts = 0;
  const port = { allow: guard.allow, withdraw: async () => { if (++attempts === 1) throw new Error("synthetic DO unavailable"); } };
  const command = { kind: "source.withdraw", operationId: "withdraw", id: source.id, expectedRevision: 1 };
  await expect(new SourceController(env.DB, scope, owner, () => 100, port).execute(command)).rejects.toThrow("synthetic DO unavailable");
  expect(await new SourceAccess(env.DB, scope).read(owner, source.id)).toBeNull();
  expect(await env.DB.prepare("SELECT state FROM assistant_retention_barriers WHERE installation_id=?").bind(scope.installationId).first("state")).toBe("pending_withdraw");
  expect(await new SourceController(env.DB, scope, owner, () => 100, port).execute(command)).toMatchObject({ revision: 2 });
  expect(attempts).toBe(2); expect(await count("assistant_source_changes")).toBe(2);
  await expect(env.DB.prepare("DELETE FROM assistant_retention_barriers WHERE installation_id=?").bind(scope.installationId).run()).rejects.toThrow("monotone_retention_barrier");
});
test("an older already existing generation with the same origin is blocked by the installation-wide barrier", async () => {
  const source = await note(), older = new SourceController(env.DB, { ...scope, generation: "old" }, owner), alias = await older.create({ originKey: "source", text: "Synthetic old copy", occurredAt: 1 });
  await controller.correct(source.id, 1, { text: "Synthetic newer revision", occurredAt: 1 });
  await controller.withdraw(source.id, 2);
  expect(await new SourceAccess(env.DB, { ...scope, generation: "old" }).read(owner, alias.id)).toBeNull();
  await expect(older.correct(alias.id, 1, { text: "late", occurredAt: 1 })).rejects.toThrow("source_retired");
  const oldScope = { ...scope, generation: "old" };
  await new SourceController(env.DB, oldScope, owner, () => 100, guard).withdraw(alias.id, 1);
  expect(await new RetentionPurge(env.DB, oldScope, owner, () => 100, guard).advance({ kind: "source.purge", operationId: "old-purge", sourceId: alias.id })).toMatchObject({ state: "complete" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_source_versions WHERE installation_id=? AND generation='old'").bind(scope.installationId).first("n")).toBe(0);
});
test("a lost ACK of the first local barrier is reconciled before external recording", async () => {
  const source = await note(), batch = env.DB.batch.bind(env.DB); let calls = 0, records = 0;
  const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { const result = await batch(statements); if (++calls === 1) throw new Error("synthetic local barrier ACK"); return result; } } as D1Database;
  const service = new SourceController(db, scope, owner, () => 100, { allow: guard.allow, withdraw: async () => { records++; expect(await new SourceAccess(env.DB, scope).read(owner, source.id)).toBeNull(); } });
  expect(await service.execute({ kind: "source.withdraw", operationId: "withdraw", id: source.id, expectedRevision: 1 })).toMatchObject({ revision: 2 }); expect(records).toBe(1);
});
test("ordered D1 purge removes attributed payloads and settles known actual while preserving all financial generations", async () => {
  const source = await note(), budget = new InferenceBudget(env.DB, scope); await budget.configure(100); await budget.reserve("paid", digest, 8);
  const old = new InferenceBudget(env.DB, { ...scope, generation: "old" }); await old.configure(100); await old.reserve("old-uncertain", digest, 40); await old.uncertain("old-uncertain");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_relation_batches VALUES(?,?,?, ?,?,1,1,?,'author','Synthetic name',?)").bind(scope.installationId, scope.generation, "relation", digest, source.id, digest, JSON.stringify([{ quote: "BODY" }])),
    env.DB.prepare("INSERT INTO assistant_model_permits VALUES(?,?,?,?,?,?,999)").bind(scope.installationId, scope.generation, digest, source.id, "{}", digest),
    env.DB.prepare("INSERT INTO assistant_model_receipts(installation_id,generation,operation_key,request_hash,source_id,source_revision,config_hash,state,response_json,actual_units,created_at) VALUES(?,?, 'paid',?,?,1,?,'response_ready',?,3,100)").bind(scope.installationId, scope.generation, digest, source.id, digest, JSON.stringify({ quote: "BODY" })),
    env.DB.prepare("INSERT INTO assistant_media_receipts(installation_id,generation,operation_key,source_id,source_revision,source_version,source_hash,blob_hash,config_hash,state,created_at) VALUES(?,?,'media',?,1,1,?,?,?,'complete',100)").bind(scope.installationId, scope.generation, source.id, digest, digest, digest),
    env.DB.prepare("INSERT INTO assistant_media_artifacts VALUES(?,?,'media',?,1,1,?,?,?,?,?,100)").bind(scope.installationId, scope.generation, source.id, digest, digest, digest, digest, JSON.stringify({ quote: "BODY" })),
  ]);
  await controller.withdraw(source.id, 1);
  const result = await purge(source.id); expect(result).toMatchObject({ state: "complete", logicalBlock: "withdrawn", d1: "purged", r2: "pending", externalIndex: "pending" });
  for (const table of ["assistant_source_versions", "assistant_relation_batches", "assistant_model_permits", "assistant_model_receipts", "assistant_media_artifacts", "assistant_media_receipts", "assistant_retention_purge_grants"]) expect(await count(table)).toBe(0);
  expect(await count("assistant_sources")).toBe(1); expect((await budget.status()).committed).toBe(3); expect((await old.status()).committed).toBe(40);
  expect(await purge(source.id)).toEqual(result);
});
test("a lost final D1 purge acknowledgement returns the exact committed receipt without repeating deletion", async () => {
  const source = await note(); await controller.withdraw(source.id, 1);
  const batch = env.DB.batch.bind(env.DB); let calls = 0;
  const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { const result = await batch(statements); if (++calls === 2) throw new Error("synthetic final purge ACK lost"); return result; } } as D1Database;
  const result = await purge(source.id, db, "ack-purge"); expect(result).toMatchObject({ state: "complete", d1: "purged" });
  expect(await count("assistant_source_versions")).toBe(0); expect(await purge(source.id, env.DB, "ack-purge")).toEqual(result); expect(calls).toBe(2);
});
test("secondary context closes jobs, episodes and their model operations even when paid receipt belongs to another anchor", async () => {
  const target = await note("target"), anchor = await note("anchor"), budget = new InferenceBudget(env.DB, scope); await budget.configure(100); await budget.reserve("secondary-paid", digest, 8);
  const queue = new JobQueue(env.DB, { installationId: scope.installationId, generation: scope.generation }), job = await queue.enqueue({ kind: "reasoning", dedupeKey: "secondary", sourceId: anchor.id, sourceRevision: 1, request: "Synthetic independent request", runtime: "flue", subject: { kind: "owner_request", sourceId: anchor.id, sourceRevision: 1, requestKey: "secondary" } }, 100), ledger = (await queue.ledger(job.id))!;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_episodes(installation_id,generation,id,job_id,episode_generation,request_hash,binding_hash,binding_json,profile,runtime_id,deadline,max_calls) VALUES(?,?,?, ?,1,?,?,?,'owner','runtime',1000,1)").bind(scope.installationId, scope.generation, digest, job.id, ledger.request_hash, digest, JSON.stringify({ context: { sources: [{ id: target.id, text: "BODY" }] }, lease: { source_id: anchor.id } })),
    env.DB.prepare("INSERT INTO assistant_episode_calls(installation_id,generation,episode_id,ordinal,payload_hash,token,operation_key,state) VALUES(?,?,?,1,?,'token','secondary-paid','complete')").bind(scope.installationId, scope.generation, digest, digest),
    env.DB.prepare("INSERT INTO assistant_model_receipts(installation_id,generation,operation_key,request_hash,source_id,source_revision,config_hash,state,response_json,actual_units,created_at) VALUES(?,?,'secondary-paid',?,?,1,?,'response_ready',?,3,100)").bind(scope.installationId, scope.generation, digest, anchor.id, digest, JSON.stringify({ quote: "BODY" })),
  ]);
  await controller.withdraw(target.id, 1); expect(await purge(target.id)).toMatchObject({ state: "complete" });
  for (const table of ["assistant_jobs", "assistant_job_ledger", "assistant_episodes", "assistant_episode_calls", "assistant_model_receipts", "assistant_decision_jobs"]) expect(await count(table)).toBe(0);
  expect(await new SourceAccess(env.DB, scope).read(owner, anchor.id)).not.toBeNull(); expect((await budget.status()).committed).toBe(3);
});
test("missing financial proof blocks deletion and an unknown schema never receives a false purge receipt", async () => {
  const source = await note(); await controller.withdraw(source.id, 1);
  await env.DB.prepare("INSERT INTO assistant_model_receipts(installation_id,generation,operation_key,request_hash,source_id,source_revision,config_hash,state,response_json,actual_units,created_at) VALUES(?,?,'missing',?,?,1,?,'complete','{}',3,100)").bind(scope.installationId, scope.generation, digest, source.id, digest).run();
  const service = new RetentionPurge(env.DB, scope, owner, () => 100, guard);
  await service.advance({ kind: "source.purge", operationId: "blocked", sourceId: source.id });
  expect(await service.advance({ kind: "source.purge", operationId: "blocked", sourceId: source.id })).toMatchObject({ state: "pending", reason: "closure_changed_or_financial_proof_missing" });
  expect(await count("assistant_source_versions")).toBe(1);
  await env.DB.prepare("CREATE TABLE assistant_unknown_projection(installation_id TEXT,generation TEXT,body TEXT)").run();
  try { expect(await service.advance({ kind: "source.purge", operationId: "unknown", sourceId: source.id })).toMatchObject({ state: "blocked", reason: "retention_schema_adapter_required" }); }
  finally { await env.DB.prepare("DROP TABLE assistant_unknown_projection").run(); }
});
test("bounded closure requires every page before deleting original bytes", async () => {
  const source = await note(), rows = Array.from({ length: 132 }, (_, index) => ({ id: String(index).padStart(4, "0") }));
  await env.DB.prepare("INSERT INTO assistant_jobs(installation_id,generation,id,kind,dedupe_key,source_id,source_revision,next_attempt_at) SELECT ?,?,json_extract(value,'$.id'),'reasoning',json_extract(value,'$.id'),?,1,100 FROM json_each(?)").bind(scope.installationId, scope.generation, source.id, JSON.stringify(rows)).run();
  await controller.withdraw(source.id, 1); const service = new RetentionPurge(env.DB, scope, owner, () => 100, guard), command = { kind: "source.purge", operationId: "bounded", sourceId: source.id };
  for (let page = 0; page < 2; page++) { expect(await service.advance(command)).toMatchObject({ state: "pending", reason: "collecting_closure" }); expect(await count("assistant_source_versions")).toBe(1); }
  expect(await service.advance(command)).toMatchObject({ state: "complete" }); expect(await count("assistant_jobs")).toBe(0);
});
test("late model answer after payload purge settles real usage and cannot recreate a response", async () => {
  const source = await note(), budget = new InferenceBudget(env.DB, scope); await budget.configure(100);
  let entered!: () => void, release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }), external = new Promise<void>(resolve => { release = resolve; });
  const config = { extractionConfig: "synthetic", priceVersion: "synthetic", chatModel: "synthetic", embeddingModel: "synthetic", maxOutputTokens: 100, chatCeiling: 8, embeddingCeiling: 1 };
  const broker = new CogneeModelBroker(env.DB, scope, config, async () => { entered(); await external; return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "BODY" } }] }), actualUnits: 3 }; }, () => 100);
  const pending = broker.invoke(await broker.issuePermit(source.id, 1, 200), "/v1/chat/completions", { model: "synthetic", messages: [{ role: "user", content: "Synthetic input" }] });
  await waiting; await controller.withdraw(source.id, 1); expect(await purge(source.id)).toMatchObject({ state: "complete" });
  expect((await budget.status()).committed).toBe(8); release(); expect(await pending).toMatchObject({ state: "uncertain" });
  expect((await budget.status()).committed).toBe(3); expect(await count("assistant_model_receipts")).toBe(0);
});
test("cached response copied before settlement cannot escape after secondary-source purge during that await", async () => {
  const target = await note("target"), anchor = await note("anchor"), budget = new InferenceBudget(env.DB, scope); await budget.configure(100); let calls = 0;
  const config = { extractionConfig: "synthetic", priceVersion: "synthetic", chatModel: "synthetic", embeddingModel: "synthetic", maxOutputTokens: 100, chatCeiling: 8, embeddingCeiling: 1 }, payload = { model: "synthetic", messages: [{ role: "user", content: "Synthetic secondary BODY" }] };
  const broker = new CogneeModelBroker(env.DB, scope, config, async () => { calls++; return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "BODY" } }] }), actualUnits: 3 }; }, () => 100), token = await broker.issuePermit(anchor.id, 1, 200);
  const initial = await broker.invoke(token, "/v1/chat/completions", payload); expect(initial.state).toBe("complete");
  const queue = new JobQueue(env.DB, { installationId: scope.installationId, generation: scope.generation }), job = await queue.enqueue({ kind: "reasoning", dedupeKey: "cached-secondary", sourceId: anchor.id, sourceRevision: 1, request: "Synthetic request" }, 100), ledger = (await queue.ledger(job.id))!;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_episodes(installation_id,generation,id,job_id,episode_generation,request_hash,binding_hash,binding_json,profile,runtime_id,deadline,max_calls) VALUES(?,?,?, ?,1,?,?,?,'owner','runtime',1000,1)").bind(scope.installationId, scope.generation, digest, job.id, ledger.request_hash, digest, JSON.stringify({ context: { sources: [{ id: target.id, text: "BODY" }] }, lease: { source_id: anchor.id } })),
    env.DB.prepare("INSERT INTO assistant_episode_calls(installation_id,generation,episode_id,ordinal,payload_hash,token,operation_key,state) VALUES(?,?,?,1,?,'token',?,'complete')").bind(scope.installationId, scope.generation, digest, digest, initial.operationKey!),
  ]);
  const settle = InferenceBudget.prototype.settle, fault = vi.spyOn(InferenceBudget.prototype, "settle").mockImplementationOnce(async function(this: InferenceBudget, ...args) {
    await settle.apply(this, args); await controller.withdraw(target.id, 1); expect(await purge(target.id)).toMatchObject({ state: "complete" });
  });
  try { expect(await broker.invoke(token, "/v1/chat/completions", payload)).toMatchObject({ state: "uncertain" }); }
  finally { fault.mockRestore(); }
  expect(calls).toBe(1); expect(await count("assistant_model_receipts")).toBe(0); expect((await budget.status()).committed).toBe(3);
});
const artifacts = () => (env as unknown as { ARTIFACTS: R2Bucket }).ARTIFACTS;
const objects = (bucket = artifacts(), marker = scope.installationId) => new RetentionObjects({ DB: env.DB, ARTIFACTS: bucket, ARTIFACTS_INSTALLATION_ID: marker, ARTIFACTS_GENERATION: scope.generation }, scope, owner, () => 100);
async function reference(key: string, installationId = scope.installationId, hash = digest) {
  const id = crypto.randomUUID(); await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key) VALUES(?,?,?,'owner_note',?)").bind(installationId, scope.generation, id, id),
    env.DB.prepare("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_object_key,content_hash,occurred_at) VALUES(?,?,?,1,?,?,1)").bind(installationId, scope.generation, id, key, hash),
  ]); return id;
}
test("R2 preserves referenced objects in any installation and refuses another namespace or unproved binding", async () => {
  const key = retentionObjectPrefix(scope) + "original"; await artifacts().put(key, "synthetic bytes");
  const batch = env.DB.batch.bind(env.DB), fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("synthetic D1 ACK lost"); });
  try { await expect(reference(key, "other-installation")).rejects.toThrow("synthetic D1 ACK lost"); } finally { fault.mockRestore(); }
  expect(await objects().collect({ kind: "object.collect", operationId: "gc", key })).toMatchObject({ state: "retained", reason: "referenced_in_any_namespace" });
  expect(await artifacts().head(key)).not.toBeNull();
  expect(await objects(artifacts(), "wrong").collect({ kind: "object.collect", operationId: "gc", key })).toMatchObject({ state: "pending_configuration" });
  await expect(objects().collect({ kind: "object.collect", operationId: "gc", key: retentionObjectPrefix({ ...scope, generation: "other" }) + "original" })).rejects.toThrow("retention_object_namespace");
});
test("R2 orphan after a lost D1 transaction can be collected while source archive bucket remains untouched", async () => {
  const key = retentionObjectPrefix(scope) + "orphan"; await artifacts().put(key, "synthetic orphan"); await env.MEDIA.put(key, "archive must survive");
  const uncertainWrite = async () => { try { await reference(key, scope.installationId, "invalid"); } catch { throw new Error("synthetic D1 ACK lost; outcome unknown to caller"); } };
  await expect(uncertainWrite()).rejects.toThrow("synthetic D1 ACK lost");
  expect(await objects().collect({ kind: "object.collect", operationId: "orphan", key })).toMatchObject({ state: "deleted", attempts: 1 });
  expect(await artifacts().head(key)).toBeNull(); expect(await env.MEDIA.head(key)).not.toBeNull();
  expect(await objects().collect({ kind: "object.collect", operationId: "orphan", key })).toMatchObject({ state: "deleted", attempts: 1 });
});
test("a persisted global claim prevents references racing the R2 await and survives a lost deletion ACK", async () => {
  const key = retentionObjectPrefix(scope) + "claimed"; await artifacts().put(key, "synthetic bytes");
  let entered!: () => void, release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }), external = new Promise<void>(resolve => { release = resolve; });
  const bucket = { delete: async (value: string) => { entered(); await external; await artifacts().delete(value); throw new Error("synthetic R2 ACK lost"); } } as unknown as R2Bucket;
  const pending = objects(bucket).collect({ kind: "object.collect", operationId: "claimed", key }); await waiting;
  await expect(reference(key, "third-installation")).rejects.toThrow("object_retirement_claimed");
  release(); expect(await pending).toMatchObject({ state: "uncertain", attempts: 1 });
  expect(await objects().collect({ kind: "object.collect", operationId: "claimed", key })).toMatchObject({ state: "deleted", attempts: 2 });
  await expect(env.DB.prepare("DELETE FROM assistant_retention_object_claims WHERE object_key=?").bind(key).run()).rejects.toThrow("monotone_object_claim");
});
test("purge and object collection copy owner authentication before any read", async () => {
  const actor = { kind: "extractor" } as { kind: "extractor" | "owner" }, service = new RetentionPurge(env.DB, scope, actor as never), gc = new RetentionObjects({ DB: env.DB }, scope, actor as never);
  actor.kind = "owner";
  await expect(service.advance({ kind: "source.purge", operationId: "denied", sourceId: "source" })).rejects.toThrow("owner_required");
  await expect(gc.collect({ kind: "object.collect", operationId: "denied", key: retentionObjectPrefix(scope) + "object" })).rejects.toThrow("owner_required");
});
