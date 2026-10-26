import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { bridgeHash } from "../assistant/ingress";
import { DecisionJournal, type DecisionSubject } from "../assistant/decisions";
import { SourceController } from "../assistant/sources";
import { JobQueue } from "../assistant/queue";
// @ts-expect-error Vite raw SQL imports.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import policy from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import work from "../assistant/migrations/0003_work.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import inbox from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import jobs from "../assistant/migrations/0005_job_ledger.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import origins from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import admissions from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import budget from "../assistant/migrations/0008_inference_budget.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import relations from "../assistant/migrations/0009_relations.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import models from "../assistant/migrations/0010_model_receipts.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import conversations from "../assistant/migrations/0011_conversations.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import commands from "../assistant/migrations/0012_owner_commands.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import episodes from "../assistant/migrations/0013_episodes.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import retrieval from "../assistant/migrations/0014_retrieval_runs.sql?raw";
// @ts-expect-error Vite raw SQL imports.
import semanticSchema from "../assistant/migrations/0015_semantic_retrieval.sql?raw";
import type { SemanticEnginePort, EngineSearch, SearchTicket } from "../assistant/engine";
// @ts-expect-error Vite raw SQL imports.
import decisions from "../assistant/migrations/0017_shadow_decisions.sql?raw";
let database: D1Database;
let scope: { installationId: string; generation: string }, source: { id: string; revision: number }, journal: DecisionJournal;
const now = 100;
const query = (sql: string, ...values: (string | number | null)[]) => env.DB.prepare(sql).bind(...values);
beforeEach(async () => {
  for (const sql of [sources, policy, work, inbox, jobs, origins, admissions, budget, relations, models, conversations, commands, episodes, retrieval, semanticSchema, decisions]) {
    const parts = sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter((part: string) => part.trim());
    if (parts.length) await env.DB.batch(parts.map((part: string) => env.DB.prepare(part)));
  }
  scope = { installationId: crypto.randomUUID(), generation: "synthetic-g" };
  source = await new SourceController(env.DB, scope, { kind: "owner" }, () => now).create({ originKey: "request", text: "Synthetic request", occurredAt: now });
  database = { prepare: (sql: string) => env.DB.prepare(sql), batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements) } as D1Database;
  journal = new DecisionJournal(database, scope, { kind: "owner" }, { clock: () => now });
});
test("a Flue job owns a nominal subject before execution and conflicting linkage is rejected", async () => {
  const queue = new JobQueue(env.DB, scope);
  const input = { kind: "reasoning" as const, dedupeKey: "request", sourceId: source.id, sourceRevision: 1, request: "Synthetic request", runtime: "flue" as const,
    subject: { kind: "owner_request" as const, sourceId: source.id, sourceRevision: 1, requestKey: "owner-request-1" } };
  const job = await queue.enqueue(input, now);
  expect(await query("SELECT subject_kind FROM assistant_decision_jobs WHERE installation_id=? AND generation=? AND job_id=?", scope.installationId, scope.generation, job.id).first("subject_kind")).toBe("owner_request");
  expect((await journal.list({})).items).toContainEqual(expect.objectContaining({ jobId: job.id, phase: "pending", effects: { mode: "shadow", external: "none" } }));
  expect((await queue.enqueue(input, now)).id).toBe(job.id);
  await expect(queue.enqueue({ ...input, subject: { ...input.subject, requestKey: "changed" } }, now)).rejects.toThrow();
});
test("production Flue enqueue without a proven subject cannot create an executable job", async () => {
  await expect(new JobQueue(env.DB, scope).enqueue({ kind: "reasoning", dedupeKey: "unlinked", sourceId: source.id, sourceRevision: 1, request: "Synthetic", runtime: "flue" }, now)).rejects.toThrow("decision_subject_required");
});

import { EpisodeController } from "../assistant/agent/controller";
import { RetrievalRuns } from "../assistant/retrieval-runs";
import { InferenceBudget } from "../assistant/budget";
import { DEFAULT_BROKER_CONFIG } from "../assistant/model-transport";
import { SourceAccess } from "../assistant/access";
import { OriginGuard } from "../assistant/origin-guard";
async function computed(options: { key?: string; decision?: "proposed" | "no_reply"; fail?: boolean; origin?: OriginGuard; subject?: DecisionSubject; anchor?: typeof source; semantic?: { mode: "required" | "lexical_fallback"; engine: SemanticEnginePort } } = {}) {
  const key = options.key ?? "computed", anchor = options.anchor ?? source, purpose = options.subject?.kind === "capture_event" ? "automation" : "owner_read";
  const runtimeScope = options.origin ? { ...scope, sourceEpoch: "epoch", sourceGeneration: "origin" } : scope;
  const queue = new JobQueue(database, runtimeScope);
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: key, sourceId: anchor.id, sourceRevision: 1, request: "Synthetic request", runtime: "flue",
    subject: options.subject ?? { kind: "owner_request", sourceId: anchor.id, sourceRevision: 1, requestKey: key } }, now);
  const lease = (await queue.claim(now, 90000))!, search = new RetrievalRuns(database, runtimeScope, { clock: () => now, purpose, origin: options.origin, semantic: options.semantic });
  let run = await search.start({ kind: "owner" }, "run-" + key, { query: "Synthetic request" });
  for (let i = 0; run.state === "pending" && i < 10; i++) run = await search.step({ kind: "owner" }, { runId: run.runId, stepId: "step-" + i, expectedCheckpoint: run.checkpoint });
  if(options.semantic){await search.result({kind:"owner"},run.runId);await search.advanceSemantic({kind:"owner"},run.runId);}
  await new InferenceBudget(database, { ...scope, period: "synthetic-period" }).configure(1000);
  const original = (await new SourceAccess(database, scope).read({ kind: "owner" }, anchor.id, 1, now))!;
  let calls = 0;
  const host = new EpisodeController(database, { ...runtimeScope, period: "synthetic-period" }, search, async () => {
    calls++; if (options.fail) throw new Error("synthetic-secret-model-error"); return { status: 200, actualUnits: 3, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: options.decision ?? "proposed", text: options.decision === "no_reply" ? "" : "Synthetic proposal", citations: options.decision === "no_reply" ? [] : [{ id: anchor.id, revision: 1, version: 1, hash: original.fence.source.hash, quote: "Synthetic request" }] }) } }] }) };
  }, { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { clock: () => now, purpose });
  const episode = await host.prepare(lease, "owner", run.runId), receipt = { submissionId: "synthetic-submission", uid: "synthetic-uid", acceptedAt: "2026-10-25T00:00:00Z" };
  await host.episodes.dispatch(episode.id);
  await host.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt });
  const text = await host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: receipt.submissionId }, { messages: [{ role: "user", content: host.message(episode) }] });
  return { host, episode, reply: { ...receipt, text, data: {} }, calls: () => calls, lease, job };
}
test("mandatory publication commits the exact journal and a settled decision stays current after the executor deadline", async () => {
  const { host, episode, reply, calls } = await computed();
  const published = await host.publish(episode.id, reply);
  expect(published).toMatchObject({ state: "shadow_completed", decisionId: expect.any(String) });
  expect(await query("SELECT COUNT(*) FROM assistant_shadow_decisions WHERE installation_id=?", scope.installationId).first("COUNT(*)")).toBe(1);
  const current = await new DecisionJournal(env.DB, scope, { kind: "owner" }, { clock: () => 999999 }).get(published.decisionId!);
  expect(current).toMatchObject({ phase: "proposed", freshness: "current", proposal: { text: "Synthetic proposal" } });
  expect(calls()).toBe(1);
});
test("settled authorization and duplicate publication/read preserve the original committed nonce after the deadline", async () => {
  const { host, episode, reply, lease, calls } = await computed(), published = await host.publish(episode.id, reply);
  const nonce = await query("SELECT publication_nonce FROM assistant_shadow_decisions WHERE installation_id=? AND id=?", scope.installationId, published.decisionId!).first("publication_nonce");
  const driver = () => ({ dispatch: async () => { throw new Error("unexpected_dispatch"); }, read: async () => { throw new Error("unexpected_runtime_read"); } });
  for (const at of [now, 200000]) {
    expect(await host.queue.isAuthorized(lease, at)).toBe(false);
    expect(await host.queue.publish(lease, at)).toBe(false);
    expect(await host.publish(episode.id, reply)).toMatchObject({ state: "shadow_completed", decisionId: published.decisionId });
    expect(await host.read(episode.id, driver)).toEqual({ state: "shadow_completed", decisionId: published.decisionId });
    expect(await new DecisionJournal(database, scope, { kind: "owner" }, { clock: () => at }).get(published.decisionId!)).toMatchObject({ phase: "proposed", freshness: "current" });
  }
  expect(await query("SELECT search_nonce FROM assistant_episodes WHERE installation_id=? AND id=?", scope.installationId, episode.id).first("search_nonce")).toBe(nonce);
  expect(calls()).toBe(1);
});
test("a runtime read timeout is visible as uncertainty in the owner journal", async () => {
  const { host, episode, job, calls } = await computed();
  expect(await host.read(episode.id, () => ({ dispatch: async () => { throw new Error("unused"); }, read: async () => { throw new Error("synthetic_read_timeout"); } }))).toEqual({ state: "uncertain" });
  expect((await journal.list({})).items).toContainEqual(expect.objectContaining({ jobId: job.id, phase: "uncertain", reason: "model_uncertain" }));
  expect(calls()).toBe(1);
});
test("queue publication cannot bypass a missing exact journal entry", async () => {
  const { host, reply, lease, job } = await computed();
  await host.queue.recordResult(lease, "synthetic observation", now);
  expect(await host.queue.publish(lease, now)).toBe(false);
  expect((await host.queue.get(job.id))!.state).toBe("processing");
  expect(await host.queue.receipt(job.id)).toBe("synthetic observation");
  expect(reply.text).not.toBe("");
});
test("a missing nominal header denies publication and remains visible as an integration failure", async () => {
  const { host, episode, reply, job, calls } = await computed();
  await query("DELETE FROM assistant_decision_jobs WHERE installation_id=? AND job_id=?", scope.installationId, job.id).run();
  expect(await host.publish(episode.id, reply)).toMatchObject({ state: "blocked" });
  expect((await journal.list({})).items).toContainEqual(expect.objectContaining({ jobId: job.id, phase: "failed", reason: "invariant_failure" }));
  expect((await host.queue.get(job.id))!.state).toBe("processing"); expect(calls()).toBe(1);
});
test("owner list preserves 1050 pending inbox events, filters before LIMIT and binds the cursor to namespace/filters", async () => {
  await query("INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation) VALUES(?,?,'epoch','origin')", scope.installationId, scope.generation).run();
  for (let offset = 0; offset < 1050; offset += 100) await env.DB.batch(Array.from({ length: Math.min(100, 1050 - offset) }, (_, index) => {
    const sequence = offset + index + 1;
    return query(`INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at)
      VALUES(?,?,'epoch','origin',?,?,'chat',?,'message','upsert',?,?,?)`, scope.installationId, scope.generation, sequence, sequence - 1, "message-" + sequence, sequence, "a".repeat(64), sequence);
  }));
  await query("UPDATE assistant_capture_inbox SET application_state='blocked' WHERE installation_id=? AND sequence=501", scope.installationId).run();
  await env.DB.batch([
    query("INSERT INTO assistant_origin_conversations VALUES(?,?,'epoch','origin','chat',1,'private','available')", scope.installationId, scope.generation),
    query("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,'epoch','origin','chat',0,'attend')", scope.installationId, scope.generation),
    query("UPDATE assistant_capture_inbox SET operation='withdraw',application_state='applied' WHERE installation_id=? AND sequence=503", scope.installationId),
    ...["ignored", "withdrawn", "gap"].map((state, index) => query("INSERT INTO assistant_conversation_replay(installation_id,generation,source_epoch,source_generation,chat_id,sequence,state,coalesced) VALUES(?,?,'epoch','origin','chat',?,?,0)", scope.installationId, scope.generation, 502 + index, state)),
  ]);
  const seen = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await journal.list({ cursor, limit: 50, conversationId: "chat" });
    expect(page.items.length).toBeLessThanOrEqual(50);
    for (const item of page.items) { expect(item).not.toHaveProperty("proposal"); expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(1050);
  expect((await journal.list({ state: "waiting_context", limit: 1 })).items).toMatchObject([{ phase: "waiting_context", subject: { sequence: 501 }, capture: { applicationState: "blocked", replayState: null } }]);
  expect(await journal.get('capture:["epoch","origin",502]')).toMatchObject({ phase: "not_evaluated", capture: { replayState: "ignored" } });
  expect(await journal.get('capture:["epoch","origin",503]')).toMatchObject({ phase: "not_evaluated", capture: { operation: "withdraw", replayState: "withdrawn" } });
  const view = (journal as unknown as { view(): string }).view();
  const plan = await query(`EXPLAIN QUERY PLAN WITH items AS(${view}) SELECT * FROM items WHERE phase='waiting_context' ORDER BY sort,family,key LIMIT 1`, scope.installationId, scope.generation, scope.installationId, scope.generation, scope.installationId, scope.generation).all<{ detail: string }>();
  expect(plan.results.some(row => row.detail.includes("SEARCH i USING"))).toBe(true);
  expect(plan.results.some(row => row.detail.includes("assistant_decision_capture"))).toBe(true);
  const first = await journal.list({ limit: 20 });
  expect(first.items).toHaveLength(20);
  await expect(journal.list({ cursor: first.nextCursor, state: "failed" })).rejects.toThrow("decision_cursor");
  await expect(new DecisionJournal(env.DB, { ...scope, generation: "other" }, { kind: "owner" }).list({ cursor: first.nextCursor })).rejects.toThrow("decision_cursor");
  await expect(new DecisionJournal(env.DB, scope, { kind: "extractor" }).list({})).rejects.toThrow("owner_required");
});

test("a changed non-cited source invalidates the whole proposal without another model call", async () => {
  const owner = new SourceController(env.DB, scope, { kind: "owner" }, () => now);
  const background = await owner.create({ originKey: "background", text: "Synthetic request background", occurredAt: now });
  const { host, episode, reply, calls } = await computed(), published = await host.publish(episode.id, reply);
  expect((await journal.get(published.decisionId!))).toMatchObject({ freshness: "current" });
  await owner.correct(background.id, 1, { text: "Changed background", occurredAt: now });
  const stale = await journal.get(published.decisionId!);
  expect(stale).toMatchObject({ freshness: "stale" }); expect(stale).not.toHaveProperty("proposal"); expect(calls()).toBe(1);
});
test("negative work is visible without an episode and failure attempts are immutable, bounded reasons", async () => {
  const queue = new JobQueue(env.DB, scope);
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "negative", sourceId: source.id, sourceRevision: 1, request: "Synthetic request", runtime: "flue",
    subject: { kind: "owner_request", sourceId: source.id, sourceRevision: 1, requestKey: "negative" } }, now);
  const lease = (await queue.claim(now, 90000))!;
  const failed = await journal.record(job.id, lease.lease_generation, "failed", "budget_blocked");
  expect(await journal.record(job.id, lease.lease_generation, "failed", "budget_blocked")).toBe(failed);
  await journal.record(job.id, lease.lease_generation, "uncertain", "model_uncertain");
  const page = await journal.list({});
  expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "failed", reason: "budget_blocked" }), expect.objectContaining({ phase: "uncertain", reason: "model_uncertain" })]));
  await expect(journal.record(job.id, 1, "failed", "synthetic-secret" as never)).rejects.toThrow();
  await expect(query("UPDATE assistant_shadow_decisions SET reason='cancelled' WHERE installation_id=? AND id=?", scope.installationId, failed).run()).rejects.toThrow("decision_result_immutable");
});
test("captured subjects require the exact inbox hash and canonical replay; coalesced provenance survives redelivery", async () => {
  const originScope = { ...scope, sourceEpoch: "epoch", sourceGeneration: "origin" }, hash = "a".repeat(64), k = [scope.installationId,scope.generation];
  await env.DB.batch([
    query("INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation) VALUES(?,?,'epoch','origin')", ...k),
    query("INSERT INTO assistant_origin_conversations VALUES(?,?,'epoch','origin','chat',1,'private','available')", ...k),
    query("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,'epoch','origin','chat',0,'attend')", ...k),
    query(`INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at,application_state)
      VALUES(?,?,'epoch','origin',1,0,'chat','message','message','upsert',1,?,1,'applied')`, ...k, hash),
    query("INSERT INTO assistant_conversation_replay(installation_id,generation,source_epoch,source_generation,chat_id,sequence,state,canonical_id,observed_revision,observed_version,observed_watermark,coalesced) VALUES(?,?,'epoch','origin','chat',1,'applied',?,1,1,2,1)", ...k, source.id),
  ]);
  const queue = new JobQueue(env.DB, originScope), input = { kind: "reasoning" as const, dedupeKey: "capture", sourceId: source.id, sourceRevision: 1, request: "Synthetic request", runtime: "flue" as const,
    subject: { kind: "capture_event" as const, sourceEpoch: "epoch", sourceGeneration: "origin", chatId: "chat", sequence: 1, metadataHash: hash } };
  const job = await queue.enqueue(input, now);
  expect((await journal.list({})).items).toContainEqual(expect.objectContaining({ jobId: job.id, observation: { coalesced: true, revision: 1, watermark: 2 } }));
  await query("UPDATE assistant_conversation_replay SET observed_watermark=3 WHERE installation_id=?", scope.installationId).run();
  expect((await queue.enqueue(input, now)).id).toBe(job.id);
  await expect(queue.enqueue({ ...input, dedupeKey: "bad-capture", subject: { ...input.subject, metadataHash: "b".repeat(64) } }, now)).rejects.toThrow("decision_subject_invalid");
  const next = { ...input.subject, sequence: 2 };
  await expect(queue.enqueue({ ...input, dedupeKey: "missing-event", subject: next }, now)).rejects.toThrow("decision_subject_invalid");
});

test("journal INSERT zero rows cannot complete the job, including the direct queue path", async () => {
  const { host, episode, reply, job, calls } = await computed();
  const prepare = database.prepare.bind(database);
  database.prepare = sql => prepare(sql.startsWith("INSERT INTO assistant_shadow_decisions(") && sql.includes("e.search_nonce") ? sql.replace("WHERE e.installation_id=?", "WHERE 0 AND e.installation_id=?") : sql);
  expect(await host.publish(episode.id, reply)).toMatchObject({ state: "blocked" });
  expect((await host.queue.get(job.id))!.state).toBe("processing");
  expect(await query("SELECT COUNT(*) FROM assistant_shadow_decisions WHERE installation_id=? AND proposal_json IS NOT NULL", scope.installationId).first("COUNT(*)")).toBe(0);
  expect(calls()).toBe(1);
});
test.each(["rollback", "lost_ack"])("publication %s preserves paid truth and reconciles only a committed exact decision", async fault => {
  const { host, episode, reply, job, calls } = await computed();
  const batch = database.batch.bind(database); let injected = false;
  database.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    if (!injected && statements.length === 5) {
      injected = true;
      if (fault === "rollback") return batch<T>([...statements.slice(0,3), database.prepare("SELECT abs(-9223372036854775808)"), ...statements.slice(3)]);
      await batch<T>(statements); throw new Error("synthetic_publication_ack_lost");
    }
    return batch<T>(statements);
  };
  const result = await host.publish(episode.id, reply);
  expect(injected).toBe(true);
  expect(result.state).toBe(fault === "lost_ack" ? "shadow_completed" : "uncertain");
  expect((await host.queue.get(job.id))!.state).toBe(fault === "lost_ack" ? "shadow_completed" : "processing");
  expect(await query("SELECT COUNT(*) FROM assistant_shadow_decisions WHERE installation_id=? AND proposal_json IS NOT NULL", scope.installationId).first("COUNT(*)")).toBe(fault === "lost_ack" ? 1 : 0);
  expect((await host.queue.ledger(job.id))!.state).toBe("complete"); expect(calls()).toBe(1);
  if (fault === "lost_ack") {
    const restored = new DecisionJournal(database, scope, { kind: "owner" }, { clock: () => now });
    expect(await restored.publishedEpisode(episode.id)).toEqual({ state: "shadow_completed", decisionId: result.decisionId });
    expect(await restored.get(result.decisionId!)).toMatchObject({ freshness: "current", proposal: { text: "Synthetic proposal" } });
  }
});

test("calculated silence, model failure, pending context, cancelled and unlinked jobs remain distinct", async () => {
  const successful = await computed({ key: "proposal" }); await successful.host.publish(successful.episode.id, successful.reply);
  const silent = await computed({ key: "silence", decision: "no_reply" }); await silent.host.publish(silent.episode.id, silent.reply);
  await expect(computed({ key: "error", fail: true })).rejects.toThrow("episode_denied");
  const queue = new JobQueue(env.DB, scope);
  for (const kind of ["waiting", "cancelled"]) {
    const job = await queue.enqueue({ kind: "reasoning", dedupeKey: kind, sourceId: source.id, sourceRevision: 1, request: "Synthetic request", runtime: "flue", subject: { kind: "owner_request", sourceId: source.id, sourceRevision: 1, requestKey: kind } }, now);
    const lease = (await queue.claim(now, 90000))!;
    if (kind === "waiting") await journal.record(job.id, lease.lease_generation, "waiting_context", "waiting_context");
    else await query("UPDATE assistant_jobs SET state='cancelled',lease_until=NULL WHERE installation_id=? AND id=?", scope.installationId,job.id).run();
  }
  const unlinked = await queue.enqueue({ kind: "reasoning", dedupeKey: "legacy-unlinked", sourceId: source.id, sourceRevision: 1, request: "Synthetic request" },now);
  await query("UPDATE assistant_job_ledger SET request_json=json_set(request_json,'$.runtime','flue') WHERE installation_id=? AND job_id=?",scope.installationId,unlinked.id).run();
  const page = await journal.list({limit:50});
  expect(page.items).toEqual(expect.arrayContaining([
    expect.objectContaining({phase:"proposed"}),expect.objectContaining({phase:"silence"}),expect.objectContaining({phase:"uncertain",reason:"model_uncertain"}),
    expect.objectContaining({phase:"waiting_context"}),expect.objectContaining({phase:"cancelled"}),expect.objectContaining({jobId:unlinked.id,phase:"failed",reason:"invariant_failure",recordedAt:null}),
  ]));
  expect(JSON.stringify(page)).not.toContain("synthetic-secret");expect(JSON.stringify(page)).not.toContain("Synthetic proposal");
});
test("a corrupted publication hash produces only error metadata and never proposal text",async()=>{
  const {host,episode,reply}=await computed(),published=await host.publish(episode.id,reply);
  await env.DB.prepare("DROP TRIGGER assistant_decision_result_immutable").run();
  await query("UPDATE assistant_shadow_decisions SET proposal_hash=? WHERE installation_id=? AND id=?","b".repeat(64),scope.installationId,published.decisionId!).run();
  const detail=await journal.get(published.decisionId!);
  expect(detail).toMatchObject({freshness:"unavailable",reason:"invariant_failure"});expect(detail).not.toHaveProperty("proposal");
});

test("a corrupted publication nonce cannot reconcile as a committed decision", async () => {
  const { host, episode, reply } = await computed(), published = await host.publish(episode.id, reply);
  await query("UPDATE assistant_shadow_decisions SET publication_nonce='wrong-proof' WHERE installation_id=? AND id=?", scope.installationId, published.decisionId!).run();
  expect(await journal.publishedEpisode(episode.id)).toEqual({ state: "blocked" });
  expect(await journal.get(published.decisionId!)).not.toHaveProperty("proposal");
});
test("a corrupted subject header cannot attribute a valid proposal to a different request", async () => {
  const { host, episode, reply } = await computed(), published = await host.publish(episode.id, reply);
  await env.DB.prepare("DROP TRIGGER assistant_decision_seed_immutable").run();
  await query("UPDATE assistant_decision_jobs SET subject_json=json_set(subject_json,'$.requestKey','another-request') WHERE installation_id=?", scope.installationId).run();
  const detail = await journal.get(published.decisionId!);
  expect(detail).toMatchObject({ freshness: "unavailable", reason: "invariant_failure" }); expect(detail).not.toHaveProperty("proposal");
});
test("a malformed job request is an isolated visible invariant failure and cannot break the owner page", async () => {
  const broken = await computed({ key: "broken-request" });
  await broken.host.publish(broken.episode.id, broken.reply);
  const healthy = await computed({ key: "healthy-request" });
  await query("UPDATE assistant_job_ledger SET request_json='{malformed' WHERE installation_id=? AND job_id=?", scope.installationId, healthy.job.id).run();
  const page = await journal.list({});
  expect(page.items).toContainEqual(expect.objectContaining({ jobId: healthy.job.id, phase: "failed", reason: "invariant_failure" }));
  expect(page.items).toContainEqual(expect.objectContaining({ jobId: broken.job.id, phase: "proposed" }));
  expect(await journal.get("job:" + healthy.job.id)).toMatchObject({ phase: "failed", reason: "invariant_failure" });
});

async function remoteProposal(timeoutMs = 4000) {
  const nominal = { ...scope, sourceEpoch: "epoch", sourceGeneration: "origin" };
  const background = await new SourceController(env.DB, scope, { kind: "owner" }, () => now).create({ originKey: "remote-background", text: "Synthetic request remote background", occurredAt: now });
  let state: "available" | "withdrawn" | "offline" | "hung" = "available";
  let during: () => Promise<void> = async () => {};
  const access = { captureEnabled: true, captureSince: 0, discontinuous: false };
  const content = { kind: "text", messageId: "message", messageVersion: 1, text: "Synthetic request remote background", occurredAt: now };
  const origin = new OriginGuard(database, () => nominal, { async readSnapshot() {
    if (state === "offline") throw new Error("synthetic-reader-private-error");
    if (state === "hung") return new Promise(() => {});
    await during();
    return { observation: "capture_snapshot", state, ...nominal, sourceKind: "message", sourceId: "message", chatId: "chat", sourceVersion: 1, watermark: 1, conversationKind: "private", access, content };
  } }, "synthetic-secret");
  const hash = (await origin.observe(nominal, { sourceKind: "message", sourceId: "message", chatId: "chat" })).hash!;
  await env.DB.batch([
    query("UPDATE assistant_sources SET origin='whatsapp',conversation_id='chat' WHERE installation_id=? AND id=?", scope.installationId, background.id),
    query("INSERT INTO assistant_origin_conversations VALUES(?,?,'epoch','origin','chat',1,'private','available')", scope.installationId, scope.generation),
    query("INSERT INTO assistant_source_origins VALUES(?,?,'epoch','origin','message','message','chat',?,1,?,0)", scope.installationId, scope.generation, background.id, hash),
    query("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,'epoch','origin','chat',0,'attend')", scope.installationId, scope.generation),
  ]);
  const result = await computed({ origin }), published = await result.host.publish(result.episode.id, result.reply);
  expect(published.state).toBe("shadow_completed");
  // Healthy setup must not compete with the deliberately short failure deadline.
  expect(await new DecisionJournal(database, nominal, { kind: "owner" }, { origin, clock: () => now }).get(published.decisionId!)).toMatchObject({ freshness: "current" });
  const diary = new DecisionJournal(database, nominal, { kind: "owner" }, { origin, clock: () => now, timeoutMs });
  return { ...result, diary, origin, background, id: published.decisionId!, setState: (value: typeof state) => { state = value; }, race: (action: typeof during) => { during = action; } };
}
test("captured events own their completed decision or model failure without inheriting the previous event", async () => {
  const remote = await remoteProposal(), hash = "a".repeat(64), k = [scope.installationId, scope.generation];
  await query("INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation,read_sequence) VALUES(?,?,'epoch','origin',3)", ...k).run();
  for (let sequence = 1; sequence <= 3; sequence++) {
    await query("INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at,application_state) VALUES(?,?,'epoch','origin',?,?,'chat','message','message','upsert',1,?,1,'applied')", ...k, sequence, sequence - 1, hash).run();
    await query("INSERT INTO assistant_conversation_replay(installation_id,generation,source_epoch,source_generation,chat_id,sequence,state,canonical_id,observed_revision,observed_version,observed_watermark,coalesced) VALUES(?,?,'epoch','origin','chat',?,'applied',?,1,1,1,0)", ...k, sequence, remote.background.id).run();
  }
  await query("UPDATE assistant_conversations SET evaluated_sequence=3,applied_sequence=3 WHERE installation_id=?", scope.installationId).run();
  const subject = { kind: "capture_event" as const, sourceEpoch: "epoch", sourceGeneration: "origin", chatId: "chat", sequence: 1, metadataHash: hash };
  const first = await computed({ key: "event-1", origin: remote.origin, anchor: remote.background, subject });
  expect(await first.host.publish(first.episode.id, first.reply)).toMatchObject({ state: "shadow_completed" });
  await expect(computed({ key: "event-2", origin: remote.origin, anchor: remote.background, subject: { ...subject, sequence: 2 }, fail: true })).rejects.toThrow("episode_denied");
  expect((await remote.diary.list({ conversationId: "chat" })).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ subject: { ...subject, sequence: 1 }, phase: "proposed" }),
    expect.objectContaining({ subject: { ...subject, sequence: 2 }, phase: "uncertain", reason: "model_uncertain" }),
    expect.objectContaining({ subject: { ...subject, sequence: 3 }, phase: "not_evaluated" }),
  ]));
});
test.each(["withdrawn", "offline", "hung"] as const)("remote %s suppresses an unchanged proposal within the total read deadline", async state => {
  const result = await remoteProposal(25); result.setState(state);
  const started = Date.now(), detail = await result.diary.get(result.id);
  expect(detail).toMatchObject({ freshness: "unavailable" }); expect(detail).not.toHaveProperty("proposal");
  expect(Date.now() - started).toBeLessThan(1000); expect(result.calls()).toBe(1);
});
test("a policy mutation during remote revalidation is denied by the final local batch", async () => {
  const result = await remoteProposal();
  const before = await query("SELECT revision FROM assistant_conversations WHERE installation_id=? AND chat_id='chat'", scope.installationId).first<{ revision: number }>();
  let mutations = 0;
  result.race(async () => {
    await query("UPDATE assistant_conversations SET revision=revision+1 WHERE installation_id=? AND chat_id='chat'", scope.installationId).run();
    mutations++;
  });
  const detail = await result.diary.get(result.id);
  expect(mutations).toBeGreaterThan(0);
  expect(await query("SELECT revision FROM assistant_conversations WHERE installation_id=? AND chat_id='chat'", scope.installationId).first()).toEqual({ revision: before!.revision + mutations });
  expect(detail).toMatchObject({ freshness: "stale" }); expect(detail).not.toHaveProperty("proposal"); expect(result.calls()).toBe(1);
});

test("owner journal reads required semantic decisions without engine calls and rejects changed ranking configuration", async()=>{
  let input:EngineSearch, ticket:SearchTicket, submitted=false, reads=0;
  const engine:SemanticEnginePort={
    prepare:async(alias,request)=>{input=request;ticket={alias,requestHash:await bridgeHash(request),operationId:"a".repeat(64),indexEpoch:"synthetic-index",indexRevision:"b".repeat(64)};return {state:"prepared",ticket};},
    submit:async()=>{submitted=true;return outcome();},
    lookupTicket:async()=>{reads++;return submitted?outcome():{state:"uncertain",reason:"not_submitted",operationId:ticket.operationId};},
  };
  const outcome=()=>({state:"complete" as const,operationId:ticket.operationId,indexRevision:ticket.indexRevision,indexState:"checkpoint_confirmed" as const,
    result:{candidates:input.allowedSources.map(ref=>({...ref,via:["chunks"],relationCount:0})),missing:[]}});
  const {host,episode,reply}=await computed({semantic:{mode:"required",engine}}),published=await host.publish(episode.id,reply),before=reads;
  engine.prepare=async()=>{throw new Error("unexpected_engine_prepare");};
  engine.submit=async()=>{throw new Error("unexpected_engine_submit");};
  engine.lookupTicket=async()=>{throw new Error("unexpected_engine_lookup");};
  const current=await new DecisionJournal(database,scope,{kind:"owner"},{clock:()=>now,semantic:{mode:"required",engine}}).get(published.decisionId!);
  expect(current).toMatchObject({phase:"proposed",freshness:"current",proposal:{text:"Synthetic proposal"}});
  expect(reads).toBe(before);
  expect(await new DecisionJournal(database,scope,{kind:"owner"},{clock:()=>now,semantic:{mode:"lexical_fallback",engine}}).get(published.decisionId!)).toMatchObject({freshness:"stale"});
  await query("UPDATE assistant_retrieval_semantic SET ranking_json='{}' WHERE installation_id=?",scope.installationId).run();
  const changed=await new DecisionJournal(database,scope,{kind:"owner"},{clock:()=>now,semantic:{mode:"required",engine}}).get(published.decisionId!);
  expect(changed).toMatchObject({freshness:"stale"});expect(changed).not.toHaveProperty("proposal");expect(reads).toBe(before);
});

async function reviewAdmissionFixture() {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS assistant_telegram_read_admissions (installation_id TEXT,generation TEXT,token TEXT,decision_id TEXT,proposal_hash TEXT,publication_nonce TEXT,PRIMARY KEY(installation_id,generation,token));CREATE TABLE IF NOT EXISTS telegram_admission_effects (installation_id TEXT,id TEXT,PRIMARY KEY(installation_id,id));");
  const result=await computed(),published=await result.host.publish(result.episode.id,result.reply),detail=await journal.get(published.decisionId!);
  if(!("proposal"in detail))throw new Error("proposal missing");
  const hash=await bridgeHash(detail.proposal),id=published.decisionId!;
  const build=(guard:{sql:string;values:(string|number|null)[]})=>[env.DB.prepare(`INSERT INTO telegram_admission_effects SELECT ?,? WHERE ${guard.sql} ON CONFLICT DO NOTHING RETURNING id`).bind(scope.installationId,"effect",...guard.values)];
  return {id,hash,build};
}
test("host review admission consumes a same-batch nonce and supports ten source guards without one giant predicate",async()=>{
  for(let i=0;i<9;i++)await new SourceController(env.DB,scope,{kind:"owner"},()=>now).create({originKey:`review-${i}`,text:`Synthetic request background ${i}`,occurredAt:now});
  const {id,hash,build}=await reviewAdmissionFixture();
  expect((await journal.admitReview(id,hash,build))?.[0].results).toEqual([{id:"effect"}]);
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_read_admissions WHERE installation_id=?",scope.installationId).first("n")).toBe(0);
});
test.each(["source","nonce"])("host review admission rejects %s mutation immediately before the atomic batch",async kind=>{
  const {id,hash,build}=await reviewAdmissionFixture(),batch=env.DB.batch.bind(env.DB);let changed=false;
  const fault=vi.spyOn(env.DB,"batch").mockImplementation(async statements=>{
    if(!changed){changed=true;if(kind==="source")await query("UPDATE assistant_sources SET revision=revision+1 WHERE installation_id=? AND id=?",scope.installationId,source.id).run();else await query("UPDATE assistant_shadow_decisions SET publication_nonce='stale-nonce' WHERE installation_id=? AND id=?",scope.installationId,id).run();}
    return batch(statements);
  });
  expect(await journal.admitReview(id,hash,build)).toBeNull();fault.mockRestore();
  expect(await query("SELECT COUNT(*) n FROM telegram_admission_effects WHERE installation_id=?",scope.installationId).first("n")).toBe(0);
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_read_admissions WHERE installation_id=?",scope.installationId).first("n")).toBe(0);
});
test.each(["rollback","lost_ack"])("host review admission leaves no reusable attestation after %s",async mode=>{
  const {id,hash,build}=await reviewAdmissionFixture(),batch=env.DB.batch.bind(env.DB);
  const fault=mode==="lost_ack"?vi.spyOn(env.DB,"batch").mockImplementationOnce(async statements=>{await batch(statements);throw new Error("ACK lost");}):null;
  expect(await journal.admitReview(id,hash,guard=>[...build(guard),...(mode==="rollback"?[env.DB.prepare("SELECT json('invalid-json')")]:[])])).toBeNull();fault?.mockRestore();
  expect(await query("SELECT COUNT(*) n FROM telegram_admission_effects WHERE installation_id=?",scope.installationId).first("n")).toBe(mode==="lost_ack"?1:0);
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_read_admissions WHERE installation_id=?",scope.installationId).first("n")).toBe(0);
});
test("host review admission denies a remotely withdrawn proposal without yielding any action statement",async()=>{
  const remote=await remoteProposal(),detail=await remote.diary.get(remote.id);if(!("proposal"in detail))throw new Error("proposal missing");
  remote.setState("withdrawn");const build=vi.fn(()=>[]);
  expect(await remote.diary.admitReview(remote.id,await bridgeHash(detail.proposal),build)).toBeNull();expect(build).not.toHaveBeenCalled();
});
