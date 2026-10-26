import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { RetrievalRuns, type SearchFence } from "../assistant/retrieval-runs";
import { SourceController, sourceTextHash } from "../assistant/sources";
import { CaptureMaterializer } from "../assistant/materialize";
import { OriginGuard } from "../assistant/origin-guard";
import type { TrustedActor } from "../assistant/access";
// @ts-expect-error Raw SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Raw SQL.
import policies from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Raw SQL.
import inbox from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Raw SQL.
import origins from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Raw SQL.
import controls from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Raw SQL.
import relations from "../assistant/migrations/0009_relations.sql?raw";
// @ts-expect-error Raw SQL.
import conversations from "../assistant/migrations/0011_conversations.sql?raw";
// @ts-expect-error Raw SQL.
import runs from "../assistant/migrations/0014_retrieval_runs.sql?raw";
let scope: { installationId: string; generation: string }, now: number, search: RetrievalRuns;
const owner = { kind: "owner" } as const;
const guest: TrustedActor = { kind: "interlocutor", provider: "whatsapp", address: "unknown", conversationId: "chat", conversationKind: "private", action: "reply_text" };
const sql = (query: string, ...values: (string | number | null)[]) => env.DB.prepare(query).bind(scope.installationId, scope.generation, ...values);
beforeEach(async () => {
  for (const migration of [sources, policies, inbox, origins, controls, relations, conversations, runs]) await env.DB.batch(migration.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
  scope = { installationId: crypto.randomUUID(), generation: "g1" }; now = 1000;
  search = new RetrievalRuns(env.DB, scope, { clock: () => now });
});
async function seed(count: number, privateEvery = 0) {
  const ordinary = "Algodão e chá sem relação com a pergunta.", target = "Órbita prazo NÃO é terça; correção para quinta depende de Lara.";
  const hashes = [await sourceTextHash(ordinary), await sourceTextHash(target)];
  const rows = Array.from({ length: count }, (_, index) => ({ id: `s${String(index).padStart(5, "0")}`, text: index === count - 1 ? target : ordinary,
    hash: index === count - 1 ? hashes[1] : hashes[0], audience: privateEvery && index % privateEvery === 0 && index !== count - 1 ? "owner" : "public" }));
  await env.DB.batch([
    sql("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,audience) SELECT ?,?,json_extract(value,'$.id'),'owner_note',json_extract(value,'$.id'),json_extract(value,'$.audience') FROM json_each(?)", JSON.stringify(rows)),
    sql("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) SELECT ?,?,json_extract(value,'$.id'),1,json_extract(value,'$.text'),json_extract(value,'$.hash'),100 FROM json_each(?)", JSON.stringify(rows)),
  ]);
  return rows;
}
async function finish(actor: TrustedActor, progress: Awaited<ReturnType<RetrievalRuns["start"]>>) {
  for (let step = 0; step < 80 && progress.state !== "ready" && progress.state !== "waiting_context"; step++) progress = await search.step(actor, { runId: progress.runId, stepId: `step-${step}`, expectedCheckpoint: progress.checkpoint });
  return search.result(actor, progress.runId);
}
it("finds a late target beyond 1000 canonical rows without private IDs or bodies entering the result", async () => {
  const rows = await seed(1105, 5);
  const progress = await search.start(guest, "late", { query: "Órbita prazo quinta Lara", limit: 2 });
  const result = await finish(guest, progress);
  expect(result.state).toBe("ready"); expect(result.coverage.inventoryComplete).toBe(true);
  expect(result.sources[0]).toMatchObject({ id: "s01104", text: rows[1104].text });
  expect(result.coverage.gaps).toContain("index_capacity");
  const serialized = JSON.stringify(result); expect(serialized).not.toContain('"s00000"'); expect(serialized).not.toMatch(/evaluated|scanned|privateCount/);
  expect(await search.check(guest, result.fence!)).toBe(true);
  const allowed=rows.filter(row=>row.audience==='public').length;
  expect(await sql("SELECT steps_used,evaluations FROM assistant_retrieval_runs WHERE installation_id=? AND generation=? AND id=?",progress.runId).first()).toEqual({steps_used:Math.ceil(allowed/64),evaluations:allowed});
  expect(await sql("SELECT COUNT(*) n FROM assistant_retrieval_items WHERE installation_id=? AND generation=? AND run_id=?",progress.runId).first("n")).toBe(allowed);
}, 90000); // Includes seeding and every durable page; not a per-request latency SLO.
it("persists a complete 64-entry page and resumes global ranking after restart", async () => {
  await seed(130);
  let progress = await search.start(owner, "resume", { query: "Órbita prazo" });
  progress = await search.step(owner, { runId: progress.runId, stepId: "first", expectedCheckpoint: 0 });
  expect(progress).toMatchObject({ checkpoint: 1, state: "pending" });
  expect(await sql("SELECT COUNT(*) AS n FROM assistant_retrieval_items WHERE installation_id=? AND generation=?").first()).toEqual({ n: 64 });
  search = new RetrievalRuns(env.DB, scope, { clock: () => now });
  expect((await finish(owner, progress)).sources[0].id).toBe("s00129");
});
it("recovers the exact completed step receipt after lost ACK without evaluating a moving page again", async () => {
  await seed(3); const progress = await search.start(owner, "lost", { query: "Órbita" });
  const batch = env.DB.batch.bind(env.DB); let calls = 0;
  const fault = vi.spyOn(env.DB, "batch").mockImplementation(async statements => { const result = await batch(statements); if (++calls === 2) throw new Error("lost completion ACK"); return result; });
  await expect(search.step(owner, { runId: progress.runId, stepId: "same", expectedCheckpoint: 0 })).rejects.toThrow(); fault.mockRestore();
  await new SourceController(env.DB, scope, owner).create({ originKey: "behind", text: "Órbita nova", audience: "public", occurredAt: 100 });
  const receipt = await search.step(owner, { runId: progress.runId, stepId: "same", expectedCheckpoint: 0 });
  expect(receipt).toMatchObject({ checkpoint: 1, state: "ready" });
  expect((await search.result(owner, progress.runId)).state).not.toBe("ready");
  await expect(search.step(owner, { runId: progress.runId, stepId: "same", expectedCheckpoint: 1 })).rejects.toThrow("retrieval_step_conflict");
});
it("admits one checkpoint under concurrent step IDs and refuses changed query/run ownership", async () => {
  await seed(80); const progress = await search.start(owner, "race", { query: "Órbita" });
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => search.step(owner, { runId: progress.runId, stepId: `concurrent-${index}`, expectedCheckpoint: 0 })));
  expect(outcomes.filter(result => result.status === "fulfilled" && result.value.checkpoint === 1)).toHaveLength(1);
  expect(await sql("SELECT checkpoint FROM assistant_retrieval_runs WHERE installation_id=? AND generation=?").first()).toEqual({ checkpoint: 1 });
  await expect(search.start(owner, "race", { query: "different" })).rejects.toThrow("retrieval_run_conflict");
  await expect(search.result(guest, progress.runId)).rejects.toThrow("retrieval_run_denied");
});
it("discovers a source inserted behind the processed cursor and never treats LIMIT as coverage", async () => {
  await seed(65); let progress = await search.start(owner, "behind", { query: "Órbita" });
  progress = await search.step(owner, { runId: progress.runId, stepId: "page", expectedCheckpoint: 0 });
  await env.DB.batch([
    sql("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,audience) VALUES(?,?,'a-behind','owner_note','a-behind','public')"),
    sql("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,'a-behind',1,'Órbita prazo quinta Lara',?,100)", await sourceTextHash("Órbita prazo quinta Lara")),
  ]);
  const result = await finish(owner, progress); expect(result.sources.some(source => source.id === "a-behind")).toBe(true); expect(result.coverage.inventoryComplete).toBe(true);
});
it("handles grant, revoke and corrections between pages using current authorization fingerprints", async () => {
  await seed(66); await sql("UPDATE assistant_sources SET audience='owner' WHERE installation_id=? AND generation=? AND id='s00000'").run();
  let progress = await search.start(guest, "grant", { query: "Órbita" });
  progress = await search.step(guest, { runId: progress.runId, stepId: "first", expectedCheckpoint: 0 });
  await sql("UPDATE assistant_sources SET audience='public' WHERE installation_id=? AND generation=? AND id='s00000'").run();
  await new SourceController(env.DB, scope, owner).correct("s00000", 1, { text: "Órbita prazo quinta Lara", occurredAt: 100 });
  await sql("UPDATE assistant_sources SET audience='owner' WHERE installation_id=? AND generation=? AND id='s00065'").run();
  const result = await finish(guest, progress); expect(result.sources.map(source => source.id)).toContain("s00000"); expect(result.sources.map(source => source.id)).not.toContain("s00065");
});
it("invalidates SearchFence for policy/proof/mandate expiry and local conversation pause", async () => {
  await seed(1); await sql("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'chat','private')").run();
  const progress = await search.start(guest, "policy", { query: "Órbita" }); const result = await finish(guest, progress); const fence = result.fence!;
  await sql("UPDATE assistant_conversation_policies SET revision=2 WHERE installation_id=? AND generation=?").run(); expect(await search.check(guest, fence)).toBe(false);
  await sql("UPDATE assistant_conversation_policies SET revision=1 WHERE installation_id=? AND generation=?").run();
  await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,'e','g','chat',0,'private','available')").run();
  await sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,'e','g','chat',1,'attend')").run();
  expect(await search.check(guest, fence)).toBe(false);
  search = new RetrievalRuns(env.DB, { ...scope, sourceEpoch: "e", sourceGeneration: "g" }, { clock: () => now });
  const observed = await search.start(guest, "observed", { query: "Órbita" });
  const fresh = await finish(guest, observed); expect(fresh.state).toBe("ready");
  await sql("UPDATE assistant_conversations SET paused=1,revision=2 WHERE installation_id=? AND generation=?").run(); expect(await search.check(guest, fresh.fence!)).toBe(false);
});
it("cannot mark ready when a source is inserted between the last read and final batch", async () => {
  await seed(1); const progress = await search.start(owner, "final-race", { query: "Órbita" });
  const batch = env.DB.batch.bind(env.DB); let calls = 0;
  const fault = vi.spyOn(env.DB, "batch").mockImplementation(async statements => {
    if (++calls === 2) await batch([
      sql("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,audience) VALUES(?,?,'new','owner_note','new','public')"),
      sql("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,'new',1,'Órbita nova',?,100)", await sourceTextHash("Órbita nova")),
    ]);
    return batch(statements);
  });
  const receipt = await search.step(owner, { runId: progress.runId, stepId: "race", expectedCheckpoint: 0 }); fault.mockRestore();
  expect(receipt.state).toBe("pending"); expect((await search.result(owner, progress.runId)).coverage.inventoryComplete).toBe(false);
});
it("counts churn, re-evaluation and retry attempts toward persistent caps", async () => {
  await seed(2); search = new RetrievalRuns(env.DB, scope, { clock: () => now, pageSize: 1, maxEvaluations: 2, maxSteps: 3 });
  let progress = await search.start(owner, "cap", { query: "Órbita" });
  progress = await search.step(owner, { runId: progress.runId, stepId: "one", expectedCheckpoint: 0 });
  await new SourceController(env.DB, scope, owner).correct("s00000", 1, { text: "Órbita changed", occurredAt: 100 });
  progress = await search.step(owner, { runId: progress.runId, stepId: "two", expectedCheckpoint: 1 });
  const result = await search.result(owner, progress.runId); expect(result).toMatchObject({ state: "waiting_context", sources: [], coverage: { inventoryComplete: false } }); expect(result.coverage.gaps).toContain("search_limit");
});
it("keeps unavailable origin explicit, bounded, and out of any result/model pack", async () => {
  await seed(2); await sql("UPDATE assistant_sources SET origin='whatsapp',conversation_id='chat' WHERE installation_id=? AND generation=? AND id='s00000'").run();
  const progress = await search.start(owner, "origin", { query: "Órbita" }); const result = await finish(owner, progress);
  expect(result.state).toBe("waiting_context"); expect(result.sources).toEqual([]); expect(result.coverage.gaps).toContain("origin_unavailable");
});
it("does not return changed originals after ready and preserves body/context byte caps", async () => {
  await seed(1); const progress = await search.start(owner, "current", { query: "Órbita" }); const result = await finish(owner, progress);
  await new SourceController(env.DB, scope, owner).correct("s00000", 1, { text: "No longer relevant", occurredAt: 100 });
  expect(await search.check(owner, result.fence!)).toBe(false); expect((await search.result(owner, progress.runId)).sources).toEqual([]);
});
it.each(["expiry", "proof", "revocation"])("invalidates effective restricted authorization on %s without changing the target body", async change => {
  await seed(1); await sql("UPDATE assistant_sources SET audience='restricted' WHERE installation_id=? AND generation=?").run();
  const proof = await new SourceController(env.DB, scope, owner).create({ originKey: "proof", text: "Private proof", occurredAt: 100 });
  await env.DB.batch([
    sql("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'chat','private')"),
    sql("INSERT INTO assistant_people VALUES(?,?,'person','Synthetic person')"),
    sql("INSERT INTO assistant_provider_identities VALUES(?,?,'whatsapp','unknown','person',?,1,'owner_confirmed',100)", proof.id),
    sql("INSERT INTO assistant_mandates VALUES(?,?,'mandate',1,'chat',NULL,'Purpose','active',100,2000)"),
    sql("INSERT INTO assistant_mandate_actions VALUES(?,?,'mandate',1,'reply_text')"),
    sql("INSERT INTO assistant_mandate_sources VALUES(?,?,'mandate',1,'s00000')"),
  ]);
  const actor = { ...guest, mandateId: "mandate" } as TrustedActor;
  const result = await finish(actor, await search.start(actor, "restricted", { query: "Órbita" })); expect(result.state).toBe("ready");
  expect(await search.check(actor, result.fence!)).toBe(true);
  if (change === "expiry") now = 2000;
  if (change === "proof") await new SourceController(env.DB, scope, owner).withdraw(proof.id, 1);
  if (change === "revocation") await sql("INSERT INTO assistant_mandates VALUES(?,?,'mandate',2,'chat',NULL,'Revoked','revoked',100,2000)").run();
  expect(await search.check(actor, result.fence!)).toBe(false); expect((await search.result(actor, result.fence!.runId)).sources).toEqual([]);
});
it("recovers a prepared page unchanged after a lost preparation ACK and counts its retry", async () => {
  await seed(2); search = new RetrievalRuns(env.DB, scope, { clock: () => now, pageSize: 1, leaseMs: 10 });
  const progress = await search.start(owner, "prepared", { query: "Órbita" });
  const batch = env.DB.batch.bind(env.DB); const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("lost preparation ACK"); });
  await expect(search.step(owner, { runId: progress.runId, stepId: "fixed", expectedCheckpoint: 0 })).rejects.toThrow(); fault.mockRestore();
  const before = await sql("SELECT page_json FROM assistant_retrieval_steps WHERE installation_id=? AND generation=?").first<{page_json:string}>();
  await new SourceController(env.DB, scope, owner).correct("s00000", 1, { text: "Changed while the prepared step waited", occurredAt: 100 });
  now += 11;
  const receipt = await search.step(owner, { runId: progress.runId, stepId: "fixed", expectedCheckpoint: 0 }); expect(receipt.state).toBe("pending");
  expect(await sql("SELECT page_json FROM assistant_retrieval_steps WHERE installation_id=? AND generation=?").first()).toEqual(before);
  expect(await sql("SELECT evaluations,steps_used FROM assistant_retrieval_runs WHERE installation_id=? AND generation=?").first()).toEqual({ evaluations: 2, steps_used: 2 });
});
it("rolls back the entire final step batch and recovers that prepared snapshot", async () => {
  await seed(2); search = new RetrievalRuns(env.DB, scope, { clock: () => now, leaseMs: 10 });
  const progress = await search.start(owner, "rollback", { query: "Órbita" });
  const batch = env.DB.batch.bind(env.DB); let calls = 0;
  const fault = vi.spyOn(env.DB, "batch").mockImplementation(statements => batch(++calls === 2 ? [...statements, env.DB.prepare("SELECT * FROM missing_search_table")] : statements));
  await expect(search.step(owner, { runId: progress.runId, stepId: "rollback", expectedCheckpoint: 0 })).rejects.toThrow(); fault.mockRestore();
  expect(await sql("SELECT checkpoint FROM assistant_retrieval_runs WHERE installation_id=? AND generation=?").first()).toEqual({ checkpoint: 0 });
  expect(await sql("SELECT COUNT(*) AS n FROM assistant_retrieval_items WHERE installation_id=? AND generation=?").first()).toEqual({ n: 0 });
  now += 11; expect((await search.step(owner, { runId: progress.runId, stepId: "rollback", expectedCheckpoint: 0 })).state).toBe("ready");
});
it("uses one bounded SearchGuard bind and binds the exact result pack and configuration", async () => {
  await seed(65); const result = await finish(owner, await search.start(owner, "guard", { query: "Órbita" }));
  const guard = search.guard(owner, result.fence!, now); expect(guard.values).toHaveLength(1);
  expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).not.toBeNull();
  for (const delta of [{ requestHash: "a".repeat(64) }, { allowedPackHash: "b".repeat(64) }, { selected: [] }, { selected: [{ ...result.fence!.selected[0], auxiliary: "forbidden" }] }]) expect(await search.check(owner, { ...result.fence!, ...delta })).toBe(false);
  const moved = new RetrievalRuns(env.DB, { ...scope, sourceEpoch: "other", sourceGeneration: "g2" }); expect(await moved.check(owner, result.fence!)).toBe(false);
});

it("never exceeds the evaluation cap while recovering a multi-row prepared page", async () => {
  await seed(3); search = new RetrievalRuns(env.DB, scope, { clock: () => now, pageSize: 2, maxEvaluations: 3, leaseMs: 10 });
  const progress = await search.start(owner, "retry-cap", { query: "Órbita" });
  const batch = env.DB.batch.bind(env.DB); const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("lost ACK"); });
  await expect(search.step(owner, { runId: progress.runId, stepId: "fixed", expectedCheckpoint: 0 })).rejects.toThrow(); fault.mockRestore(); now += 11;
  const receipt = await search.step(owner, { runId: progress.runId, stepId: "fixed", expectedCheckpoint: 0 });
  expect(receipt.state).toBe("waiting_context"); expect(receipt.gaps).toContain("search_limit");
  expect(await sql("SELECT evaluations,steps_used,state FROM assistant_retrieval_runs WHERE installation_id=? AND generation=?").first()).toEqual({ evaluations: 2, steps_used: 1, state: "waiting_context" });
});
it("invalidates scores when relation batches change without changing the original", async () => {
  await seed(1); const result = await finish(owner, await search.start(owner, "relation", { query: "Órbita" }));
  await sql("INSERT INTO assistant_relation_batches(installation_id,generation,operation_key,request_hash,source_id,source_revision,source_version,source_hash,claims_json) SELECT ?,?,'new-extraction',?,id,revision,current_version,content_hash,'[]' FROM assistant_sources JOIN assistant_source_versions ON source_id=id WHERE assistant_sources.installation_id=? AND assistant_sources.generation=? AND assistant_source_versions.installation_id=assistant_sources.installation_id AND assistant_source_versions.generation=assistant_sources.generation", "a".repeat(64), ...[scope.installationId,scope.generation]).run();
  expect(await search.check(owner, result.fence!)).toBe(false); expect((await search.result(owner, result.fence!.runId)).sources).toEqual([]);
});
it("rechecks actual origin snapshots and rejects unchanged bodies after watermark, pause or reader loss", async () => {
  const rows = await seed(1), originScope = { ...scope, sourceEpoch: "e", sourceGeneration: "g" };
  const access = { captureEnabled: true, captureSince: 0, discontinuous: false };
  const content = { kind: "text", messageId: "message", messageVersion: 1, text: rows[0].text, occurredAt: 100 };
  let available = true, calls = 0;
  const origin = new OriginGuard(env.DB, () => originScope, { async readSnapshot() { calls++; if (!available) throw new Error("offline"); return { observation: "capture_snapshot", state: "available", ...originScope, sourceKind: "message", sourceId: "message", chatId: "chat", sourceVersion: 1, watermark: 1, conversationKind: "private", access, content }; } }, "synthetic-reader-secret");
  await env.DB.batch([
    sql("UPDATE assistant_sources SET origin='whatsapp',conversation_id='chat' WHERE installation_id=? AND generation=?"),
    sql("INSERT INTO assistant_origin_conversations VALUES(?,?,'e','g','chat',1,'private','available')"),
    sql("INSERT INTO assistant_source_origins VALUES(?,?,'e','g','message','message','chat','s00000',1,?,0)", (await origin.observe(originScope,{ sourceKind: "message", sourceId: "message", chatId: "chat" })).hash!),
    sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,'e','g','chat',0,'attend')"),
  ]);
  search = new RetrievalRuns(env.DB, originScope, { clock: () => now, origin });
  const result = await finish(owner, await search.start(owner, "actual-origin", { query: "Órbita" })); expect(result.state).toBe("ready"); expect(calls).toBe(3);
  expect(await search.check(owner, result.fence!)).toBe(true);
  available = false; expect(await search.check(owner, result.fence!)).toBe(false); expect((await search.result(owner, result.fence!.runId)).sources).toEqual([]); available = true;
  await sql("UPDATE assistant_origin_conversations SET watermark=2 WHERE installation_id=? AND generation=?").run();
  const guard = search.guard(owner,result.fence!,now); expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
  await sql("UPDATE assistant_origin_conversations SET watermark=1 WHERE installation_id=? AND generation=?").run();
  await sql("UPDATE assistant_conversations SET paused=1 WHERE installation_id=? AND generation=?").run(); expect(await search.check(owner,result.fence!)).toBe(false);
});

it("guards a relation insertion between scoring and the atomic publication of the page", async () => {
  await seed(1); const progress = await search.start(owner,"relation-final-race",{ query:"Órbita" });
  const batch = env.DB.batch.bind(env.DB); let calls = 0;
  const fault = vi.spyOn(env.DB,"batch").mockImplementation(async statements => {
    if (++calls === 2) await sql("INSERT INTO assistant_relation_batches(installation_id,generation,operation_key,request_hash,source_id,source_revision,source_version,source_hash,claims_json) SELECT ?,?,'changed',?,id,revision,1,content_hash,'[]' FROM assistant_sources s JOIN assistant_source_versions v ON v.source_id=s.id AND v.installation_id=s.installation_id AND v.generation=s.generation WHERE s.installation_id=? AND s.generation=?", "b".repeat(64),scope.installationId,scope.generation).run();
    return batch(statements);
  });
  const receipt = await search.step(owner,{runId:progress.runId,stepId:"race",expectedCheckpoint:0}); fault.mockRestore();
  expect(receipt.state).toBe("pending"); expect((await search.result(owner,progress.runId)).sources).toEqual([]);
});
it("keeps a project-scoped guard narrow and refuses an oversized final original pack", async () => {
  const controller = new SourceController(env.DB,scope,owner);
  await sql("INSERT INTO assistant_projects(installation_id,generation,id,name) VALUES(?,?,'project','Synthetic project')").run();
  for(let index=0;index<3;index++) await controller.create({originKey:`large-${index}`,text:"Órbita "+"x".repeat(23000),audience:"public",projectId:"project",occurredAt:100});
  const result = await finish(owner,await search.start(owner,"bytecap",{query:"Órbita",projectId:"project",limit:3}));
  expect(result).toMatchObject({state:"waiting_context",sources:[],coverage:{inventoryComplete:true}}); expect(result.coverage.gaps).toContain("context_bytes_limit");
  const narrow = await finish(owner,await search.start(owner,"narrow",{query:"Órbita",projectId:"project",limit:1})); expect(narrow.state).toBe("ready");
  await controller.create({originKey:"outside",text:"Órbita outside",audience:"public",occurredAt:100}); expect(await search.check(owner,narrow.fence!)).toBe(true);
});

it("isolates the active nominal conversation from a paused historical namespace", async () => {
  await seed(1);
  for(const epoch of ["old","new"]) await env.DB.batch([
    sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,'g','chat',0,'private','available')",epoch),
    sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode,paused) VALUES(?,?,?,'g','chat',0,'attend',?)",epoch,epoch==="old"?1:0),
  ]);
  search = new RetrievalRuns(env.DB,{...scope,sourceEpoch:"new",sourceGeneration:"g"},{clock:()=>now});
  const result = await finish(guest,await search.start(guest,"nominal",{query:"Órbita"})); expect(result.state).toBe("ready"); expect(await search.check(guest,result.fence!)).toBe(true);
});
it("separates manual owner reads from automation while paused new messages await materialization", async () => {
  await seed(1); await sql("UPDATE assistant_sources SET conversation_id='chat' WHERE installation_id=? AND generation=?").run();
  const nominal = {...scope,sourceEpoch:"e",sourceGeneration:"g"};
  await env.DB.batch([
    sql("INSERT INTO assistant_origin_conversations VALUES(?,?,'e','g','chat',0,'private','available')"),
    sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode,paused) VALUES(?,?,'e','g','chat',0,'attend',1)"),
    sql("INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation,read_sequence) VALUES(?,?,'e','g',1)"),
    sql("INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at) VALUES(?,?,'e','g',1,0,'chat','message','message','upsert',1,?,1)","a".repeat(64)),
  ]);
  const reader = {async readSnapshot(){return {observation:"capture_snapshot",state:"available",...nominal,sourceKind:"message",sourceId:"message",chatId:"chat",sourceVersion:1,watermark:1,conversationKind:"private",access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:"text",messageId:"message",messageVersion:1,text:"Órbita nova mensagem materializada",occurredAt:1}};}};
  const origin = new OriginGuard(env.DB,()=>nominal,reader,"synthetic-secret");
  search = new RetrievalRuns(env.DB,nominal,{clock:()=>now,purpose:"owner_read",origin});
  const waiting = await finish(owner,await search.start(owner,"pending-manual",{query:"Órbita"})); expect(waiting.state).toBe("waiting_context"); expect(waiting.sources).toEqual([]);
  expect(await new CaptureMaterializer(env.DB,()=>nominal,reader,"synthetic-secret",()=>now).process(1)).toMatchObject({state:"applied"});
  const manual = await finish(owner,await search.start(owner,"manual",{query:"Órbita"})); expect(manual.state).toBe("ready"); expect(manual.sources.some(source=>source.text==="Órbita nova mensagem materializada")).toBe(true); expect(await search.check(owner,manual.fence!)).toBe(true);
  expect(await sql("SELECT applied_sequence,evaluated_sequence,paused FROM assistant_conversations WHERE installation_id=? AND generation=?").first()).toEqual({applied_sequence:0,evaluated_sequence:0,paused:1});
  const automation = new RetrievalRuns(env.DB,nominal,{clock:()=>now}); expect(await automation.check(owner,manual.fence!)).toBe(false);
  await expect(search.start(guest,"wrong-actor",{query:"Órbita"})).rejects.toThrow("retrieval_run_denied");
  const manualSearch=search; search=automation;
  expect((await finish(owner,await automation.start(owner,"automatic",{query:"Órbita"}))).state).not.toBe("ready"); search=manualSearch;
  await sql("UPDATE assistant_origin_conversations SET watermark=0 WHERE installation_id=? AND generation=?").run(); expect(await search.check(owner,manual.fence!)).toBe(false);
});
it("invalidates a manual pack for pending inbox metadata before its origin conversation exists", async () => {
  await seed(1); await sql("UPDATE assistant_sources SET conversation_id='chat' WHERE installation_id=? AND generation=?").run();
  const nominal={...scope,sourceEpoch:"e",sourceGeneration:"g"}; search=new RetrievalRuns(env.DB,nominal,{clock:()=>now,purpose:"owner_read"});
  const result=await finish(owner,await search.start(owner,"before-origin",{query:"Órbita"})); expect(result.state).toBe("ready");
  await env.DB.batch([
    sql("INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation,read_sequence) VALUES(?,?,'e','g',1)"),
    sql("INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at) VALUES(?,?,'e','g',1,0,'chat','message','message','upsert',1,?,1)","a".repeat(64)),
  ]);
  const guard=search.guard(owner,result.fence!,now); expect(guard.values).toHaveLength(1); expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
  expect(await search.check(owner,result.fence!)).toBe(false);
  expect((await finish(owner,await search.start(owner,"pending-origin",{query:"Órbita"}))).sources).toEqual([]);
});
it("keeps a complex guest page of 64 entries below the D1 bind boundary", async () => {
  await seed(64); let maximum=0;
  const db={prepare(query:string){const statement=env.DB.prepare(query); return new Proxy(statement,{get(target,key){if(key==="bind")return (...values:unknown[])=>{maximum=Math.max(maximum,values.length);return target.bind(...values);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});},batch:env.DB.batch.bind(env.DB)} as D1Database;
  search=new RetrievalRuns(db,scope,{clock:()=>now}); const result=await finish(guest,await search.start(guest,"bindings",{query:"Órbita"}));
  expect(result.state).toBe("ready"); expect(maximum).toBeLessThanOrEqual(100); expect(search.guard(guest,result.fence!,now).values).toHaveLength(1);
  expect(await sql("SELECT COUNT(*) n FROM assistant_retrieval_items WHERE installation_id=? AND generation=?").first()).toEqual({n:64});
});
