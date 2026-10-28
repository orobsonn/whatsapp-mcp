import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { Evaluation } from "../assistant/evaluation";
import { assistantHealth } from "../assistant/health";
import { SourceController } from "../assistant/sources";
import { DecisionJournal } from "../assistant/decisions";
import { JobQueue } from "../assistant/queue";
import { RetrievalRuns } from "../assistant/retrieval-runs";
import { InferenceBudget } from "../assistant/budget";
import { EpisodeController } from "../assistant/agent/controller";
import { DEFAULT_BROKER_CONFIG } from "../assistant/model-transport";
import { OwnerAssistant, type OwnerAffinity } from "../assistant/mcp";
const owner = { kind: "owner" } as const;
let scope: OwnerAffinity, now: number, journal: DecisionJournal, evaluation: Evaluation;
const sql = (query: string, ...values: (string | number | null)[]) => env.DB.prepare(query).bind(...values);
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "evaluation-g", sourceEpoch: "capture-e", sourceGeneration: "capture-g" }; now = 1000;
  journal = new DecisionJournal(env.DB, scope, owner, { clock: () => now });
  evaluation = new Evaluation(env.DB, scope, owner, journal, { clock: () => now });
});
async function job(key: string) {
  const source = await new SourceController(env.DB, scope, owner, () => now).create({ originKey: key, text: "Synthetic evidence " + key, occurredAt: now });
  const queue = new JobQueue(env.DB, scope), item = await queue.enqueue({ kind: "reasoning", dedupeKey: key, sourceId: source.id, sourceRevision: 1,
    request: "Synthetic evidence " + key, runtime: "flue", subject: { kind: "owner_request", sourceId: source.id, sourceRevision: 1, requestKey: key } }, now);
  const lease = (await queue.claim(now, 90000))!; return { source, queue, item, lease };
}
async function decision(key: string, choice: "proposed" | "no_reply" | "waiting_context" = "proposed") {
  const seeded = await job(key), text = "Synthetic evidence " + key, search = new RetrievalRuns(env.DB, scope, { purpose: "owner_read", clock: () => now });
  let run = await search.start(owner, key, { query: text });
  for (let step = 0; run.state === "pending" && step < 20; step++) run = await search.step(owner, { runId: run.runId, stepId: "step-" + step, expectedCheckpoint: run.checkpoint });
  await new InferenceBudget(env.DB, { ...scope, period: "synthetic" }).configure(100000);
  const found = await search.result(owner, run.runId), parent = found.sources.find(row => row.id === seeded.source.id)!;
  const host = new EpisodeController(env.DB, { ...scope, period: "synthetic" }, search, async () => ({ status: 200, actualUnits: 3,
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: choice, text: choice === "proposed" ? text : "", citations: choice === "proposed" ? [{
      id: parent.id, revision: 1, version: 1, hash: parent.fence.source.hash, quote: text }] : [] }) } }] }) }),
    { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { purpose: "owner_read", clock: () => now });
  const episode = await host.prepare(seeded.lease, "owner", run.runId), receipt = { submissionId: key, uid: "native-" + key, acceptedAt: new Date(now).toISOString() };
  await host.episodes.dispatch(episode.id); await host.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt });
  const response = await host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: receipt.submissionId }, { messages: [{ role: "user", content: host.message(episode) }] });
  now += 20; const result = await host.publish(episode.id, { ...receipt, text: response, data: {} });
  expect(result.state).toBe("shadow_completed"); return { ...seeded, result, search };
}
async function exposure(entryId: string, key = "expose") { return await evaluation.execute({ kind: "evaluation.expose", operationId: key, entryId }) as { id: string; openedAt: number }; }
async function assess(exposureId: string, key: string, label = "correct", extra: Record<string, unknown> = {}) {
  return evaluation.execute({ kind: "evaluation.assess", operationId: key, exposureId, basis: "owner_report", label, ...extra });
}
test("zero journal or labels stays unknown rather than becoming full coverage or correct", async () => {
  expect(await evaluation.sample()).toMatchObject({ items: [], coverage: { observedEntries: 0, proposalOrSilenceFraction: null, state: "unknown", globalCoverage: "unknown" } });
  expect(await evaluation.metrics()).toMatchObject({ quality: { denominator: 0, observations: 0, correctFraction: null, currentCorrectness: "unknown" }, latency: { denominator: 0, meanMs: null }, cost: { committed: 0 } });
});
test("samples the actual mandatory journal including proposals, silence, context, failures, uncertainty and unevaluated capture", async () => {
  await decision("proposal"); await decision("silence", "no_reply"); await decision("context", "waiting_context");
  const failed = await job("failed"); await journal.record(failed.item.id, failed.lease.lease_generation, "failed", "budget_blocked"); await failed.queue.fail(failed.lease, "budget_blocked", now);
  const uncertain = await job("uncertain"); await journal.record(uncertain.item.id, uncertain.lease.lease_generation, "uncertain", "model_uncertain");
  await sql("INSERT INTO assistant_capture_streams VALUES(?,?,?,?,1,0)", scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration).run();
  await sql("INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at) VALUES(?,?,?,?,1,0,'captured-chat','message','message','upsert',1,?,1)", scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration, "a".repeat(64)).run();
  const page = await evaluation.sample({ limit: 50 });
  expect(page.counts).toMatchObject({ proposed: 1, silence: 1, waiting_context: 1, failed: 1, uncertain: 1, not_evaluated: 1 });
  expect(JSON.stringify(page)).not.toContain("Synthetic evidence");
  const first = await evaluation.sample({ limit: 2 }), second = await evaluation.sample({ limit: 2, cursor: first.nextCursor });
  expect(first.items.map(row => row.id).some(id => second.items.some(row => row.id === id))).toBe(false);
  await expect(evaluation.sample({ limit: 2, cursor: first.nextCursor, state: "silence" })).rejects.toThrow("decision_cursor");
  expect((await evaluation.sample({ state: "silence" })).counts.silence).toBe(1);
});
test("server exposures and explicit owner assessments are immutable/idempotent and wall time is not active review time", async () => {
  const fixture = await decision("review"), opened = await exposure(fixture.result.decisionId!); now += 5000;
  const result = await assess(opened.id, "assessment", "unsupported", { humanAction: "replied" });
  expect(result).toMatchObject({ basis: "owner_assessment_at_exposure", elapsedWallMs: 5000, measurement: "elapsed_wall_not_active_review" });
  now += 7000; expect(await exposure(fixture.result.decisionId!)).toEqual(opened); expect(await assess(opened.id, "assessment", "unsupported", { humanAction: "replied" })).toEqual(result);
  await expect(assess(opened.id, "assessment", "correct")).rejects.toThrow("control_operation_conflict");
  await expect(assess(opened.id, "different-assessment", "correct")).rejects.toThrow("evaluation_precondition");
  expect(await evaluation.exposure(opened.id)).toMatchObject({ freshness: "current", assessment: { label: "unsupported", humanAction: "replied", verification: "owner_report_not_provider_receipt", elapsedWallMs: 5000 } });
  const metrics = await evaluation.metrics(); expect(metrics.humanActions.comparisons).toContainEqual({ phase: "proposed", humanAction: "replied", n: 1 });
  expect(metrics.quality).toMatchObject({ denominator: 1, correctFraction: 0, freshness: "unchecked_historical" });
});
test("latest assessment uses canonical entry identity and an explicit deterministic denominator, including unknown judgments", async () => {
  const fixture = await decision("latest"), raw = fixture.result.decisionId!, first = await exposure(raw, "first"); await assess(first.id, "first-review");
  const second = await exposure("decision:" + raw, "second"); now += 1; await assess(second.id, "second-review", "unknown");
  expect((await evaluation.metrics()).quality).toMatchObject({ observations: 1, denominator: 0, unknownCount: 1, correctFraction: null });
});
test("source changes mark an exposed proposal stale while preserving the historical judgment and suppressing withdrawn evidence", async () => {
  const fixture = await decision("stale"), opened = await exposure(fixture.result.decisionId!);
  await assess(opened.id, "judge-stale", "correct", { evidence: { sourceId: fixture.source.id, revision: 1 }, humanAction: "replied" });
  await new SourceController(env.DB, scope, owner).withdraw(fixture.source.id, 1);
  expect(await evaluation.exposure(opened.id)).toMatchObject({ freshness: "stale", assessment: { label: "correct", evidence: { state: "unavailable" } } });
  const result = await evaluation.metrics(); expect(result.quality).toMatchObject({ observations: 1, freshness: "unchecked_historical", currentCorrectness: "unknown" });
  expect(JSON.stringify(result)).not.toContain("Synthetic evidence");
});
test("lost commit ACK recovers the original assessment without a duplicate observation", async () => {
  const fixture = await decision("ack"), opened = await exposure(fixture.result.decisionId!), batch = env.DB.batch.bind(env.DB); let lose = true;
  const uncertain = new Evaluation({ prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { const result = await batch(statements); if (lose) { lose = false; throw new Error("synthetic lost ACK"); } return result; } } as D1Database, scope, owner, journal, { clock: () => now });
  const command = { kind: "evaluation.assess", operationId: "ack-review", exposureId: opened.id, label: "correct", basis: "owner_report" };
  await expect(uncertain.execute(command)).rejects.toThrow("synthetic lost ACK");
  expect(await uncertain.execute(command)).toMatchObject({ exposureId: opened.id });
  expect((await evaluation.metrics()).quality.observations).toBe(1);
});
test("financial totals retain reservations from every generation and period without inventing a global cap", async () => {
  const live = new InferenceBudget(env.DB, { ...scope, period: "today" }); await live.configure(100); await live.reserve("settled", "a".repeat(64), 10); await live.settle("settled", "a".repeat(64), 3); await live.reserve("reserved", "b".repeat(64), 8);
  const old = new InferenceBudget(env.DB, { ...scope, generation: "old-generation", period: "yesterday" }); await old.configure(100); await old.reserve("uncertain", "c".repeat(64), 40); await old.uncertain("uncertain");
  const other = new InferenceBudget(env.DB, { installationId: "another-installation", generation: "g", period: "today" }); await other.configure(100); await other.reserve("other", "d".repeat(64), 50);
  expect((await evaluation.metrics()).cost).toMatchObject({ unit: "microUSD", settled: 3, reserved: 8, uncertain: 40, committed: 51, reservations: 3, globalCap: "not_inferred" });
});
test("latency is a paired host wall-clock observation and never claims to measure inference duration", async () => {
  await decision("latency"); expect((await evaluation.metrics()).latency).toEqual({ population: "historical_committed_publications", measurement: "seed_to_committed_decision_wall_ms", denominator: 1, meanMs: 20, modelInferenceLatency: "not_measured" });
  await sql("UPDATE assistant_shadow_decisions SET publication_nonce='uncommitted' WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).run();
  expect((await evaluation.metrics()).latency).toMatchObject({ denominator: 0, meanMs: null });
});
test("fromMe and Telegram simulated reviews never become reported human action or measured quality", async () => {
  const fixture = await decision("simulation");
  await sql("INSERT INTO assistant_telegram_reviews VALUES(?,?,'synthetic_bot',1,'query','hash','notice','simulated','answered',?)", scope.installationId, scope.generation, now).run();
  await exposure(fixture.result.decisionId!);
  expect((await evaluation.metrics()).humanActions.comparisons).toEqual([]); expect((await evaluation.metrics()).quality.observations).toBe(0);
  await expect(evaluation.execute({ kind: "evaluation.assess", operationId: "automatic", exposureId: "a".repeat(64), label: "correct", basis: "fromMe" })).rejects.toThrow();
});
test("health separates configuration from observed pipeline and never derives full coverage from zero events", async () => {
  const settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration, OPENAI_API_KEY: "synthetic-secret", FLUE_EPISODES_ENABLED: "shadow" };
  expect(await assistantHealth(settings, owner, now)).toMatchObject({ state: "unknown", coverage: { appliedFraction: null }, clientHealth: "not_observed", configuration: { modelKey: true } });
  await new InferenceBudget(env.DB, { ...scope, period: "old-period" }).configure(100);
  expect(await assistantHealth(settings, owner, now)).toMatchObject({ budget: { scope: "current_generation_all_periods", configuredAccounts: 1, currentPeriod: "1970-01-01", currentAccountConfigured: false } });
  await new InferenceBudget(env.DB, { ...scope, period: "1970-01-01" }).configure(100);
  expect(await assistantHealth(settings, owner, now)).toMatchObject({ budget: { configuredAccounts: 2, currentAccountConfigured: true } });
  await sql("INSERT INTO assistant_capture_streams VALUES(?,?,?,?,1,0)", scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration).run();
  await sql("INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at,application_state) VALUES(?,?,?,?,1,0,'chat','source','message','upsert',1,?,500,'blocked')", scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration, "a".repeat(64)).run();
  const result = await assistantHealth(settings, owner, now);
  expect(result).toMatchObject({ state: "observed_local_pipeline", pipeline: { received: 1, applied: 0, blocked: 1 }, coverage: { appliedFraction: 0, upstreamCompleteness: "unknown" }, recency: { ageMs: 500 }, clientHealth: "not_observed" });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
});
test("only the authenticated owner receiver admits judgments and injected authority is rejected", async () => {
  const wrong = new Evaluation(env.DB, scope, { kind: "extractor" }, journal);
  await expect(wrong.sample()).rejects.toThrow("owner_required"); await expect(wrong.metrics()).rejects.toThrow("owner_required");
  await expect(wrong.execute({ kind: "evaluation.expose", operationId: "x", entryId: "x" })).rejects.toThrow("owner_required");
  await expect(assistantHealth({ DB: env.DB }, { kind: "extractor" })).rejects.toThrow("owner_required");
  const rpc = new OwnerAssistant(createExecutionContext(), { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration });
  expect(await rpc.query(scope, { kind: "evaluation.sample" })).toMatchObject({ items: [] });
  for (const key of Object.keys(scope) as (keyof OwnerAffinity)[]) await expect(rpc.evaluate({ ...scope, [key]: "foreign" }, { kind: "evaluation.expose", operationId: "x", entryId: "x" })).rejects.toThrow("owner_binding_affinity");
  await expect(rpc.evaluate(scope, { kind: "evaluation.expose", operationId: "x", entryId: "x", role: "owner" })).rejects.toThrow();
});
