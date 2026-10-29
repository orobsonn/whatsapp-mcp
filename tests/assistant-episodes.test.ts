import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {buildSync} from "esbuild";
import { Episodes } from "../assistant/agent/episodes";
import { JobQueue, type JobLease } from "../assistant/queue";
import { sourceTextHash, SourceController } from "../assistant/sources";
import { createEpisodeProvider } from "../assistant/agent-runtime/provider";
import { EpisodeController } from "../assistant/agent/controller";
import { SourceAccess } from "../assistant/access";
import { InferenceBudget } from "../assistant/budget";
import { DEFAULT_BROKER_CONFIG } from "../assistant/model-transport";
import { bridgeHash } from "../assistant/ingress";
import type { SemanticEnginePort, SearchTicket, EngineSearchOutcome } from "../assistant/engine";
import { RetrievalRuns } from "../assistant/retrieval-runs";
import { DecisionJournal } from "../assistant/decisions";
import { OwnerControl } from "../assistant/control";
import { FollowUps } from "../assistant/followups";
import {outgoingPort} from '../assistant/outgoing';
import {readD1Migrations} from '@cloudflare/vitest-plugin';

const root = resolve(import.meta.dirname, "..");
const scope = { installationId: "synthetic-episodes", generation: "g1" };
let worker: Miniflare, db: D1Database, episodes: Episodes, lease: JobLease, now: number, requestHash: string;
async function connect(next: Miniflare) {
  worker = next;
  const database = await worker.getD1Database("DB");
  // Keep real workerd D1; local delegates let tests drop an ACK after commit.
  db = { prepare: (sql: string) => {
    const statement = database.prepare(sql);
    return new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => { if (values.length > 100) throw new Error("synthetic_d1_bind_limit"); return target.bind(...values); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  }, batch: (statements: any[]) => database.batch(statements), exec: (sql: string) => database.exec(sql) } as unknown as D1Database;
}
async function bootstrap(next: Miniflare) {
  now = 100; await connect(next);
  for (const name of readdirSync(resolve(root, "assistant/migrations")).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(root, "assistant/migrations", name), "utf8").replace(/^--.*$/gm, "").trim();
    const parts = sql.split(/;\s*(?=CREATE|ALTER|$)/).filter(part => part.trim());
    if (parts.length) await db.batch(parts.map(part => db.prepare(part)));
  }
  await db.batch([
    db.prepare("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key) VALUES(? ,?,'source','owner_note','source')").bind(scope.installationId, scope.generation),
    db.prepare("INSERT INTO assistant_source_versions VALUES(?,?,'source',1,NULL,NULL,'Synthetic original',NULL,?,0)").bind(scope.installationId, scope.generation, await sourceTextHash("Synthetic original")),
  ]);
  const queue = new JobQueue(db, scope);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "synthetic", sourceId: "source", sourceRevision: 1, request: "synthetic" }, now);
  lease = (await queue.claim(now, 90000))!;
  requestHash = (await queue.ledger(lease.id))!.request_hash;
  episodes = new Episodes(db, scope, () => now);
}
beforeEach(() => bootstrap(new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('synthetic')}}", d1Databases: ["DB"], outboundService: () => { throw new Error("network_forbidden"); } }))));
afterEach(async () => { await worker?.dispose(); });
const input = () => ({ lease, requestHash, profile: "owner", checkpoint: "b".repeat(64),
  binding: { actor: { kind: "owner" }, sources: [{ id: "source", text: "Synthetic original" }] }, deadline: 60100, maxCalls: 2 });
test("binding is owned before await and stable across controller restart; changed checkpoint conflicts", async () => {
  const value = input(), pending = episodes.prepare(value); value.binding.sources[0].text = "caller changed";
  const prepared = await pending;
  expect(prepared).toMatchObject({ profile: "owner", binding: { sources: [{ text: "Synthetic original" }] } });
  expect(await new Episodes(db, scope, () => now).prepare(input())).toEqual(prepared);
  await expect(episodes.prepare({ ...input(), checkpoint: "c".repeat(64) })).rejects.toThrow("episode_conflict");
});
test("dispatch is a persistent CAS and accepted receipt is reattachable", async () => {
  const prepared = await episodes.prepare(input());
  await episodes.envelope(prepared.id, { message: "Synthetic original", initialData: { bindingId: prepared.id }, idempotencyKey: prepared.id });
  expect(await Promise.all([episodes.dispatch(prepared.id), episodes.dispatch(prepared.id)])).toEqual(expect.arrayContaining([true, false]));
  const receipt = { submissionId: "synthetic-submission", uid: "synthetic-incarnation", acceptedAt: "2026-10-25T00:00:00Z" };
  await episodes.accept(prepared.id, receipt);
  expect((await new Episodes(db, scope, () => now).get(prepared.id))!.receipt).toEqual(receipt);
  expect(await episodes.dispatch(prepared.id)).toBe(false);
});
test("the exact dispatch envelope is persistent and immutable, and replay is bounded without reopening the model latch", async () => {
  const prepared = await episodes.prepare(input()), envelope = { message: "Synthetic original", initialData: { bindingId: prepared.id }, idempotencyKey: prepared.id };
  await episodes.envelope(prepared.id, envelope);
  await expect(episodes.envelope(prepared.id, { ...envelope, message: "changed" })).rejects.toThrow("episode_envelope_conflict");
  await episodes.dispatch(prepared.id); await episodes.uncertain(prepared.id, "dispatch_ack");
  expect(await episodes.replayDispatch(prepared.id)).toBe(true);
  expect(await episodes.replayDispatch(prepared.id)).toBe(false);
  const restored = (await new Episodes(db, scope, () => now).get(prepared.id))!;
  expect(restored.envelope).toEqual(envelope); expect(restored.state).toBe("uncertain");
  expect(await episodes.slot(prepared.id, "c".repeat(64))).toBeNull();
});
test("only one concurrent callback slot is admitted and completed slots count toward the cap", async () => {
  const prepared = await episodes.prepare(input());
  const slots = await Promise.all([episodes.slot(prepared.id, "c".repeat(64)), episodes.slot(prepared.id, "d".repeat(64))]);
  expect(slots.filter(Boolean)).toHaveLength(1);
  await episodes.finish(prepared.id, slots.find(Boolean)!.ordinal);
  expect(await episodes.slot(prepared.id, "e".repeat(64))).toMatchObject({ ordinal: 2 });
  await episodes.finish(prepared.id, 2);
  expect(await episodes.slot(prepared.id, "f".repeat(64))).toBeNull();
});
test("an uncertain callback persistently denies every new payload and namespace", async () => {
  const prepared = await episodes.prepare(input());
  await episodes.slot(prepared.id, "c".repeat(64)); await episodes.uncertain(prepared.id);
  expect(await new Episodes(db, scope, () => now).slot(prepared.id, "d".repeat(64))).toBeNull();
  expect(await new Episodes(db, { ...scope, generation: "g2" }).get(prepared.id)).toBeNull();
  await expect(episodes.prepare({ ...input(), episodeGeneration: 2 })).rejects.toThrow("episode_conflict");
});
test("a Flue job cannot bypass its runtime guard through a legacy queue instance", async () => {
  const queue = new JobQueue(db, scope);
  await queue.fail(lease, "synthetic_previous_job", now);
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "runtime", sourceId: "source", sourceRevision: 1,
    request: "synthetic", runtime: "flue", subject: { kind: "owner_request", sourceId: "source", sourceRevision: 1, requestKey: "synthetic-runtime" } }, now);
  const current = (await queue.claim(now, 90000))!;
  expect(current.id).toBe(job.id);
  expect(await queue.admit(current, now)).toBeNull();
  expect((await queue.ledger(job.id))?.state).toBe("prepared");
});
test("runtime admission is composable in D1 and publication retests the runtime fence", async () => {
  let current = true;
  const queue = new JobQueue(db, scope, { kind: "owner" }, async () => ({ sql: "?=1", values: [current ? 1 : 0] }));
  await queue.fail(lease, "synthetic_previous_job", now);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "runtime", sourceId: "source", sourceRevision: 1,
    request: "synthetic", runtime: "flue", subject: { kind: "owner_request", sourceId: "source", sourceRevision: 1, requestKey: "synthetic-runtime" } }, now);
  const claimed = (await queue.claim(now, 90000))!;
  const statement = await queue.admissionStatement(claimed, now);
  expect(statement).not.toBeNull();
  expect((await db.batch([statement!]))[0].results).toHaveLength(1);
  current = false;
  expect(await queue.complete(claimed, "synthetic paid result", now)).toBe(false);
  expect(await queue.receipt(claimed.id)).toBe("synthetic paid result");
  expect((await queue.get(claimed.id))?.state).toBe("processing");
});
test("native Pi provider buffers all events until the host returns a guarded complete result", async () => {
  let release!: (text: string) => void, submitted: any;
  const provider = createEpisodeProvider(async payload => { submitted = payload; return new Promise<string>(resolve => { release = resolve; }); });
  const stream = provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Synthetic question", timestamp: 100 }] } as any);
  const iterator = stream[Symbol.asyncIterator](); let emitted = false;
  const first = iterator.next().then((value: any) => { emitted = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  expect(submitted.messages).toEqual([{ role: "user", content: "Synthetic question" }]); expect(emitted).toBe(false);
  release('{"decision":"no_reply","text":"","citations":[]}');
  expect((await first).value.type).toBe("start");
  expect((await stream.result()).content).toEqual([{ type: "text", text: '{"decision":"no_reply","text":"","citations":[]}' }]);
});
test("native Pi provider selects the separate owner dialogue lane and reports only its completion marker", async () => {
  let selected: unknown;
  const provider = createEpisodeProvider(async (_payload, lane) => { selected = lane; return "owner_dialogue_complete"; });
  const model = provider.getModels().find(model => model.id === "owner-dialogue");
  expect(model).toBeDefined();
  const result = await provider.streamSimple(model!, { messages: [{ role: "user", content: "Execute the admitted private dialogue.", timestamp: 100 }] } as any).result();
  expect(selected).toBe("owner-dialogue"); expect(result.model).toBe("owner-dialogue");
  expect(result.content).toEqual([{ type: "text", text: "owner_dialogue_complete" }]);
});
test("native Pi provider never routes an unknown or spoofed model to its host", async () => {
  let calls = 0;
  const provider = createEpisodeProvider(async () => { calls++; return "forbidden"; });
  for (const patch of [{ id: "unregistered-model" }, { provider: "other-host" }, { api: "other-api" }]) {
    const result = await provider.streamSimple({ ...provider.getModels()[0], ...patch } as any, { messages: [{ role: "user", content: "synthetic", timestamp: 100 }] } as any).result();
    expect(result.stopReason).toBe("error");
  }
  expect(calls).toBe(0);
});
test("native owner dialogue never streams a private host result into the Flue transcript", async () => {
  const provider = createEpisodeProvider(async () => "synthetic_private_reply_do_not_stream");
  const model = provider.getModels().find(model => model.id === "owner-dialogue")!;
  const result = await provider.streamSimple(model, { messages: [{ role: "user", content: "Execute the admitted private dialogue.", timestamp: 100 }] } as any).result();
  expect(result.stopReason).toBe("error"); expect(result.content).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("synthetic_private_reply_do_not_stream");
});
test("native dialogue forwards its invocation abort signal to the private host", async () => {
  const native = new AbortController(); let observed: AbortSignal | undefined;
  const provider = createEpisodeProvider(async (_payload, _lane, signal) => { observed = signal; return "owner_dialogue_complete"; });
  const model = provider.getModels().find(model => model.id === "owner-dialogue")!;
  expect((await provider.streamSimple(model, { messages: [{ role: "user", content: "Execute the admitted private dialogue.", timestamp: 100 }] } as any, { signal: native.signal }).result()).stopReason).toBe("stop");
  expect(observed).toBe(native.signal);
});
test("native Pi provider refuses extra tools/non-text history before calling its host", async () => {
  let calls = 0;
  const provider = createEpisodeProvider(async () => { calls++; return "forbidden"; });
  for (const messages of [[{ role: "system", content: "synthetic", timestamp: 100, toolsAdded: [{ name: "send_whatsapp" }] }],
    [{ role: "assistant", content: [{ type: "toolCall", name: "task", arguments: {}, id: "child" }], timestamp: 100 }]]) {
    const result = await provider.streamSimple(provider.getModels()[0], { messages } as any).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe("episode_model_blocked");
  }
  expect(calls).toBe(0);
});
test("only the native reserved task declaration is omitted and no provider error text is exposed", async () => {
  let payload: any;
  const provider = createEpisodeProvider(async value => { payload = value; throw new Error("synthetic_secret_do_not_expose"); });
  const result = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "system", content: "synthetic", timestamp: 100, toolsAdded: [{ name: "task" }] }] } as any).result();
  expect(payload).not.toHaveProperty("tools"); expect(JSON.stringify(result)).not.toContain("synthetic_secret");
  expect(result.stopReason).toBe("error");
});
async function controller(during: () => Promise<void> = async () => {}) {
  let calls = 0;
  const queue = new JobQueue(db, scope);
  await queue.fail(lease, "synthetic_previous_job", now);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "controller", sourceId: "source", sourceRevision: 1, request: "Synthetic question", runtime: "flue", subject: { kind: "owner_request", sourceId: "source", sourceRevision: 1, requestKey: "synthetic-question" } }, now);
  lease = (await queue.claim(now, 90000))!;
  const source = (await new SourceAccess(db, scope).read({ kind: "owner" }, "source", 1, now))!;
  const search = new RetrievalRuns(db, scope, { clock: () => now, purpose: "owner_read" });
  let progress = await search.start({ kind: "owner" }, "synthetic-run", { query: "Synthetic question" });
  for (let index = 0; progress.state === "pending" && index < 10; index++) progress = await search.step({ kind: "owner" }, { runId: progress.runId, stepId: "step-" + index, expectedCheckpoint: progress.checkpoint });
  expect(progress.state).toBe("ready");
  const budgetScope = { ...scope, period: "synthetic-period" }; await new InferenceBudget(db, budgetScope).configure(100000);
  const adapter = async () => { calls++; await during(); return { status: 200, actualUnits: 3, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "proposed", text: "Synthetic proposal", citations: [{ id: "source", revision: 1, version: 1, hash: source.fence.source.hash, quote: "Synthetic original" }] }) } }] }) }; };
  const host = new EpisodeController(db, budgetScope, search, adapter, { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { clock: () => now, purpose: "owner_read" });
  return { host, runId: progress.runId, calls: () => calls, revoke: () => new SourceController(db, scope, { kind: "owner" }, () => now).correct("source", 1, { text: "Corrected synthetic source", occurredAt: now }) };
}
test("host binds canonical context and profile, admits the real broker callback and returns a typed shadow proposal", async () => {
  const { host, calls, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  expect(episode.binding.context.sources[0].text).toBe("Synthetic original");
  expect(await host.queue.admissionPlan(lease, now)).not.toBeNull();
  const raw = await host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, { messages: [{ role: "user", content: host.message(episode) }] });
  const result = JSON.parse(raw);
  expect(result).toMatchObject({ decision: "proposed", text: "Synthetic proposal" }); expect(calls()).toBe(1);
  expect((await new JobQueue(db, scope).ledger(lease.id))?.state).toBe("attempting");
});
test("known budget exhaustion is a fixed blocked reason with no attempt, charge or adapter", async () => {
  const { host, runId, calls } = await controller(), episode = await host.prepare(lease, "owner", runId);
  await db.prepare("UPDATE assistant_budget_accounts SET cap_units=0").run();
  await expect(host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, { messages: [{ role: "user", content: host.message(episode) }] })).rejects.toThrow("episode_budget_blocked");
  expect(await host.episodes.get(episode.id)).toMatchObject({ state: "blocked", reason: "budget_blocked" });
  expect((await host.queue.ledger(lease.id))!.state).toBe("prepared");
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_budget_reservations").first("COUNT(*)")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_model_receipts").first("COUNT(*)")).toBe(0);
  expect(calls()).toBe(0);
});
test("a nominal profile mismatch or a changed pack denies the model before spending", async () => {
  const { host, calls, revoke, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  await expect(host.model(episode.id, { profile: "interlocutor", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, { messages: [{ role: "user", content: "Synthetic" }] })).rejects.toThrow("episode_denied");
  await revoke();
  await expect(host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, { messages: [{ role: "user", content: "Synthetic" }] })).rejects.toThrow("episode_denied");
  expect(calls()).toBe(0);
});
test("cancelling the job during the paid adapter prevents every result event while conserving cost and receipt", async () => {
  const { host, calls, runId } = await controller(async () => {
    await new JobQueue(db, scope).fail(lease, "synthetic_cancel_during_call", now);
  });
  const episode = await host.prepare(lease, "owner", runId);
  const provider = createEpisodeProvider(payload => host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, payload));
  const stream = provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: host.message(episode), timestamp: now }] } as any);
  const events = []; for await (const event of stream) events.push(event);
  expect(events.map(event => event.type)).toEqual(["error"]); expect(calls()).toBe(1);
  expect(await db.prepare("SELECT state FROM assistant_model_receipts").first("state")).toBe("complete");
  expect(await db.prepare("SELECT actual_units FROM assistant_budget_reservations").first("actual_units")).toBe(3);
});
test("the exact post-callback guard rejects a job whose live lease was cancelled", async () => {
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  await new JobQueue(db, scope).fail(lease, "synthetic_cancel", now);
  // Directly exercise the shared final predicate while the inference path is
  // independently constrained by D1's expression-depth boundary.
  expect(await (host as any).check(episode)).toBe(false);
});
test.each(["before_commit", "after_commit"])("atomic admission ACK lost %s latches without an adapter call or a new payload retry", async phase => {
  const { host, runId, calls } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const batch = db.batch.bind(db); let dropped = false;
  db.batch = async statements => {
    if (statements.length === 4 && !dropped) {
      dropped = true; if (phase === "after_commit") await batch(statements);
      throw new Error("synthetic_admission_ack_lost");
    }
    return batch(statements);
  };
  const nominal = { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, payload = { messages: [{ role: "user" as const, content: host.message(episode) }] };
  await expect(host.model(episode.id, nominal, payload)).rejects.toThrow("episode_denied");
  expect(dropped).toBe(true); expect(calls()).toBe(0);
  expect(await db.prepare("SELECT state FROM assistant_model_receipts").first("state")).toBe(phase === "after_commit" ? "attempting" : null);
  expect(await db.prepare("SELECT ceiling_units FROM assistant_budget_reservations").first("ceiling_units")).toBe(5);
  expect((await new Episodes(db, scope, () => now).get(episode.id))!.state).toBe("uncertain");
  await expect(host.model(episode.id, nominal, { messages: [...payload.messages, { role: "user", content: "changed retry" }] })).rejects.toThrow("episode_denied");
  expect(calls()).toBe(0);
});
test("real D1 rollback removes the new authority/slot proof; a previous nonce cannot admit the receipt", async () => {
  const { host, runId, calls } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const batch = db.batch.bind(db); let oldNonce: unknown, injected = false;
  db.batch = async statements => {
    if (statements.length === 4 && !injected) {
      injected = true; oldNonce = await db.prepare("SELECT search_nonce FROM assistant_episodes WHERE id=?").bind(episode.id).first("search_nonce");
      return batch([...statements.slice(0, 3), db.prepare("SELECT abs(-9223372036854775808)"), statements[3]]);
    }
    return batch(statements);
  };
  await expect(host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, { messages: [{ role: "user", content: host.message(episode) }] })).rejects.toThrow("episode_denied");
  expect(injected).toBe(true); expect(calls()).toBe(0);
  expect(await db.prepare("SELECT search_nonce FROM assistant_episodes WHERE id=?").bind(episode.id).first("search_nonce")).toBe(oldNonce);
  expect(await db.prepare("SELECT claim_nonce FROM assistant_episode_calls").first("claim_nonce")).toBeNull();
  expect((await host.queue.ledger(lease.id))!.state).toBe("prepared");
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_model_receipts").first("COUNT(*)")).toBe(0);
});
test("cache recovery cannot reuse an old proof if the source changes immediately before the atomic admission", async () => {
  const { host, runId, calls, revoke } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const nominal = { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-submission" }, payload = { messages: [{ role: "user" as const, content: host.message(episode) }] };
  await host.model(episode.id, nominal, payload);
  const batch = db.batch.bind(db); let changed = false;
  db.batch = async statements => {
    if (statements.length === 4 && !changed) { changed = true; await revoke(); }
    return batch(statements);
  };
  await expect(host.model(episode.id, nominal, payload)).rejects.toThrow("episode_denied");
  expect(changed).toBe(true); expect(calls()).toBe(1);
  expect(await db.prepare("SELECT actual_units FROM assistant_budget_reservations").first("actual_units")).toBe(3);
});
test("publication returns only a structurally checked shadow proposal and exposes one guarded journal transaction", async () => {
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const native = { submissionId: "synthetic-submission", uid: "synthetic-uid", acceptedAt: "2026-10-25T00:00:00Z" };
  await host.episodes.dispatch(episode.id);
  await host.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt: native });
  const raw = await host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: native.submissionId }, { messages: [{ role: "user", content: host.message(episode) }] });
  const result = await host.publish(episode.id, { text: raw, data: {}, ...native });
  expect(result).toMatchObject({ state: "shadow_completed", proposal: { kind: "shadow_proposal", execution: "unconfirmed", semanticValidation: "structure_and_attribution_only",
    binding: { episodeId: episode.id, bindingHash: episode.binding_hash, runId, allowedPackHash: episode.binding.search.allowedPackHash } } });
  expect((await host.queue.get(lease.id))!.state).toBe("shadow_completed");
  expect((await host.episodes.get(episode.id))!.result).toEqual(result.proposal);
});

test("a zero-row publication gate preserves the paid observation without completing the job", async () => {
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const native = { submissionId: "synthetic-submission", uid: "synthetic-uid", acceptedAt: "2026-10-25T00:00:00Z" };
  await host.episodes.dispatch(episode.id);
  await host.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt: native });
  const raw = await host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: native.submissionId }, { messages: [{ role: "user", content: host.message(episode) }] });
  const plan = await (host as any).preparePublication(episode.id, { text: raw, data: {}, ...native }, { publicationGate: () => ({ sql: "0=1", values: [] }) });
  const result = await db.batch(plan.statements);
  expect(result[plan.publicationIndex].results).toHaveLength(0);
  expect((await host.queue.get(lease.id))!.state).toBe("processing");
  expect((await host.queue.ledger(lease.id))!.state).toBe("complete");
  expect(await host.queue.receipt(lease.id)).not.toBeNull();
  expect((await host.episodes.get(episode.id))!.state).not.toBe("settled");
});
test("a fresh job rebuilds from the current canonical checkpoint instead of a previous Flue transcript", async () => {
  const first = await controller(), before = await first.host.prepare(lease, "owner", first.runId);
  await first.revoke();
  await expect(first.host.model(before.id, { profile: "owner", runtimeId: before.runtime_id, submissionId: "old-submission" }, { messages: [{ role: "user", content: first.host.message(before) }] })).rejects.toThrow("episode_denied");
  await first.host.queue.fail(lease, "superseded", now);
  const queue = new JobQueue(db, scope);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "rebuilt", sourceId: "source", sourceRevision: 2, request: "Corrected synthetic source", runtime: "flue", subject: { kind: "owner_request", sourceId: "source", sourceRevision: 2, requestKey: "rebuilt-owner-request" } }, now);
  lease = (await queue.claim(now, 90000))!;
  const search = new RetrievalRuns(db, scope, { clock: () => now, purpose: "owner_read" });
  let progress = await search.start({ kind: "owner" }, "rebuilt-search", { query: "Corrected synthetic source" });
  for (let index = 0; progress.state === "pending" && index < 10; index++) progress = await search.step({ kind: "owner" }, { runId: progress.runId, stepId: "rebuilt-" + index, expectedCheckpoint: progress.checkpoint });
  const host = new EpisodeController(db, { ...scope, period: "synthetic-period" }, search, async () => { throw new Error("not_called"); }, { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { clock: () => now, purpose: "owner_read" });
  const rebuilt = await host.prepare(lease, "owner", progress.runId);
  expect(rebuilt.runtime_id).not.toBe(before.runtime_id);
  expect(rebuilt.binding.context.sources[0]).toMatchObject({ text: "Corrected synthetic source", fence: { source: { revision: 2, version: 2 } } });
  expect(host.message(rebuilt)).not.toContain("Synthetic original");
  expect(first.calls()).toBe(0);
});
test("overflow waits intact; a distinct owner request rebuilds a useful episode from the corrected canonical checkpoint", async () => {
  await worker.dispose(); await bootstrap(nativeWorker("overflow-rebuild"));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  const owner = new SourceController(db, scope, { kind: "owner" }, () => now);
  const large: { id: string }[] = [];
  for (let index = 0; index < 2; index++) large.push(await owner.create({ originKey: "large-" + index, text: "Synthetic question " + "x".repeat(26000), occurredAt: now }));
  const { host, runId, calls } = await controller();
  await expect(host.prepare(lease, "owner", runId)).rejects.toThrow("episode_waiting_context");
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_episodes").first("COUNT(*)")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_budget_reservations").first("COUNT(*)")).toBe(0);
  expect(calls()).toBe(0);
  // An explicit later request is distinct work, not an automatic retry of an
  // uncertain inference or an attempt to reset the original job's call cap.
  const originalJobId = lease.id;
  await host.queue.fail(lease, "waiting_context", now);
  for (const source of large) await owner.correct(source.id, 1, { text: "Corrected synthetic question", occurredAt: now });
  const query = "Review corrected synthetic question", anchor = await owner.create({ originKey: "later-owner-request", text: query, occurredAt: now });
  const queue = new JobQueue(db, scope);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "distinct-owner-request", sourceId: anchor.id, sourceRevision: 1, request: query, runtime: "flue", subject: { kind: "owner_request", sourceId: anchor.id, sourceRevision: 1, requestKey: "distinct-owner-request" } }, now);
  const currentLease = (await queue.claim(now, 90000))!, search = new RetrievalRuns(db, scope, { clock: () => now, purpose: "owner_read" });
  let progress = await search.start({ kind: "owner" }, "corrected-checkpoint", { query });
  for (let index = 0; progress.state === "pending" && index < 10; index++) progress = await search.step({ kind: "owner" }, { runId: progress.runId, stepId: "corrected-" + index, expectedCheckpoint: progress.checkpoint });
  const current = new EpisodeController(db, { ...scope, period: "synthetic-period" }, search, async () => { throw new Error("native_callback_only"); }, { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { clock: () => now, purpose: "owner_read" });
  const rebuilt = await current.prepare(currentLease, "owner", progress.runId);
  expect(rebuilt.binding.context.sources.filter(source => large.some(row => row.id === source.id)).map(row => row.fence.source.version)).toEqual([2, 2]);
  expect(current.message(rebuilt)).not.toContain("x".repeat(100));
  expect(rebuilt.job_id).not.toBe(originalJobId);
  expect((await current.prepare(currentLease, "owner", progress.runId)).runtime_id).toBe(rebuilt.runtime_id);
  const accepted = await runtimeCall("/dispatch", { episodeId: rebuilt.id });
  expect(accepted.body.state).toBe("accepted");
  expect((await runtimeCall("/read", { episodeId: rebuilt.id })).body).toMatchObject({ state: "shadow_completed", proposal: { text: "Synthetic proposal", execution: "unconfirmed" } });
  const replay = await runtimeCall("/rawdispatch", { episodeId: rebuilt.id });
  expect(replay.body).toMatchObject({ ...accepted.body.receipt, deduplicated: true });
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(1);
  expect((await queue.get(originalJobId))).toMatchObject({ state: "failed", last_error: "waiting_context" });
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_episodes WHERE job_id=?").bind(originalJobId).first("COUNT(*)")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_budget_reservations").first("COUNT(*)")).toBe(1);
  expect(calls()).toBe(0);

});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "assistant-episodes-")));
let artifact: any, archiveFixtureScript: string, externalCalls = 0;
function findConfig(directory: string): any {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const result = findConfig(path); if (result) return result; }
    else if (entry.name === "wrangler.json") { const value = JSON.parse(readFileSync(path, "utf8")); if (value.durable_objects) return { ...value, artifact: path }; }
  }
}
beforeAll(() => {
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  writeFileSync(join(scratch, "wrangler.jsonc"), readFileSync(join(root, "assistant/wrangler.jsonc")));
  writeFileSync(join(scratch, "app.ts"), `
import {installEpisodeRuntime} from ${JSON.stringify(join(root, "assistant/agent-runtime/install.ts"))};
import {episodeDriver} from ${JSON.stringify(join(root, "assistant/agent-runtime/driver.ts"))};
import {EpisodeController} from ${JSON.stringify(join(root, "assistant/agent/controller.ts"))};
import {RetrievalRuns} from ${JSON.stringify(join(root, "assistant/retrieval-runs.ts"))};
import {DEFAULT_BROKER_CONFIG} from ${JSON.stringify(join(root, "assistant/model-transport.ts"))};
function host(env,purpose='owner_read',dropPublication=false){
 const scope={installationId:env.INSTALLATION_ID,generation:env.OPERATIONAL_GENERATION};
 const database={prepare(sql){const statement=env.DB.prepare(sql);return new Proxy(statement,{get(target,key){if(key==='bind')return(...values)=>{if(values.length>100)throw new Error('synthetic_d1_bind_limit');return target.bind(...values)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})},async batch(statements){const result=await env.DB.batch(statements);if(dropPublication&&statements.length===5)throw new Error('synthetic_publication_ack_lost');return result}};
 return new EpisodeController(database,{...scope,period:'synthetic-period'},new RetrievalRuns(database,scope,{clock:()=>100,purpose}),async request=>{
  await env.DB.prepare('INSERT INTO synthetic_model_calls(body) VALUES(?)').bind(request.body).run();
  const payload=JSON.parse(request.body), pack=payload.messages.filter(m=>m.role==='user').map(m=>{try{return JSON.parse(m.content)}catch{return null}}).find(v=>v?.sources);
  const source=pack.sources[0];
  return {status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'proposed',text:pack.outgoing?.envelope.kind==='text'?pack.outgoing.envelope.text:'Synthetic proposal',citations:[{id:source.id,revision:source.revision,version:source.version,hash:source.hash,quote:source.text}]})}}]})};
 },{...DEFAULT_BROKER_CONFIG,chatCeiling:5},{clock:()=>100,purpose,outgoing:{prepare:async()=>{throw Error('host_only')},check:async proof=>{const row=await database.prepare('SELECT proof_json FROM synthetic_outgoing_proof WHERE id=1').first();return row?.proof_json===JSON.stringify(proof)}}});
}
installEpisodeRuntime(async(env,identity)=>{
 const row=await env.DB.prepare('SELECT id,binding_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND profile=? AND runtime_id=?').bind(env.INSTALLATION_ID,env.OPERATIONAL_GENERATION,identity.profile,identity.runtimeId).first();
 if(!row)throw new Error('episode_denied');return {host:host(env,JSON.parse(row.binding_json).purpose),episodeId:row.id};
});
export default {async fetch(request,env){
 try {const input=await request.json(), path=new URL(request.url).pathname;let controller=host(env);
 const episode=await controller.episodes.get(input.episodeId);if(!episode)return Response.json({error:'missing'},{status:404});
 controller=host(env,episode.binding.purpose,input.dropPublication===true);
 let driver=episodeDriver;
 if(input.drop)driver=(profile,id)=>{const native=episodeDriver(profile,id);return {read:(...args)=>native.read(...args),async dispatch(envelope){
  if(input.drop==='before_commit')throw new Error('synthetic_transport_lost');
  const receipt=await native.dispatch(envelope);if(input.drop==='after_model')await native.read(receipt,{signal:AbortSignal.timeout(15000)});
  throw new Error('synthetic_transport_lost');
 }}};
 if(path==='/dispatch')return Response.json(await controller.dispatch(input.episodeId,driver));
 if(path==='/reconcile')return Response.json(await controller.reconcile(input.episodeId,episodeDriver));
 if(path==='/read')return Response.json(await controller.read(input.episodeId,episodeDriver));
 if(path==='/rawdispatch'){try{return Response.json(await episodeDriver(episode.profile,episode.runtime_id).dispatch(input.envelope??episode.envelope))}catch{return Response.json({error:'submission_conflict'},{status:409})}}
 return Response.json({error:'blocked'},{status:403});
 }catch(error){return Response.json({error:error?.name??'failure'},{status:500})}
}};
`);
  const config = join(scratch, "vite.config.mts");
  writeFileSync(config, `import {defineConfig} from 'vite';import {flue,flueWorkerConfig} from '@flue/vite';import {cloudflare} from '@cloudflare/vite-plugin';
export default defineConfig({root:${JSON.stringify(scratch)},envDir:false,plugins:[flue({target:'cloudflare',app:${JSON.stringify(join(scratch,"app.ts"))},cloudflare:${JSON.stringify(join(root,"assistant/cloudflare.ts"))},agents:${JSON.stringify(join(root,"assistant/agent-runtime/entry.ts"))},providers:[],tracing:false}),cloudflare({configPath:${JSON.stringify(join(scratch,"wrangler.jsonc"))},config:flueWorkerConfig(),persistState:false})],build:{outDir:${JSON.stringify(join(scratch,"dist"))},emptyOutDir:true}});`);
  execFileSync(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", config], { cwd: root, stdio: "pipe" });
  artifact = findConfig(join(scratch, "dist"));
  // Source helpers import the Workers OAuth runtime. Execute them in workerd,
  // never through Node's ESM loader. This fixture facade/status are controlled
  // ports, not a live CaptureReader service-binding or provider proof.
  archiveFixtureScript=buildSync({stdin:{contents:`
import {resolveRecipient} from ${JSON.stringify(join(root,'src/recipients.ts'))};
import {readRecipientEnvelope} from ${JSON.stringify(join(root,'src/assistant-recipient-reader.ts'))};
const phone='12025550100',status={status:async()=>({connected:true,phone})};
export default {async fetch(request,env){
 const e={DB:env.ARCHIVE,OWNER_SUB:'fixture-owner',INSTALLATION_EPOCH:'recipient-e',CONNECTION_GENERATION:'recipient-g',CONNECTED_PHONE:phone,MAINTENANCE:'false',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',PUBLIC_ORIGIN:'https://fixture.invalid',ASSISTANT_READER_SECRET:'synthetic-native-recipient-reader-secret',ZAPI_INSTANCE_ID:'fixture',ZAPI_TOKEN:'fixture',ZAPI_CLIENT_TOKEN:'fixture'};
 const input=await request.json(),path=new URL(request.url).pathname;
 if(path==='/resolve')return Response.json(await resolveRecipient(e,input,status));
 if(path==='/envelope')return Response.json(await readRecipientEnvelope(e,input,status));
 return new Response('denied',{status:403});
}};`,resolveDir:root,sourcefile:'synthetic-source-recipient-fixture.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:*','node:*'],logLevel:'silent'}).outputFiles[0].text;
});
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); expect(externalCalls).toBe(0); });
function nativeWorker(state: string) {
  const base = dirname(artifact.artifact), files: string[] = [];
  function visit(directory: string) { for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name); if (item.isDirectory()) visit(path); else if (/\.m?js$/.test(path)) files.push(path);
  } } visit(base);
  const main = resolve(base, artifact.main);
  return new Miniflare({ ...convertV4MiniflareOptions({ modulesRoot: base, modules: [main, ...files.filter(path => path !== main)].map(path => ({ type: "ESModule" as const, path })),
    compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"],
    durableObjects: Object.fromEntries(artifact.durable_objects.bindings.map((binding: any) => [binding.name, { className: binding.class_name, useSQLite: true }])),
    d1Databases: ["DB"], bindings: { INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation },
    outboundService: () => { externalCalls++; throw new Error("external_network_forbidden"); },
  }), resourcePersistencePath: join(scratch, state) });
}
async function runtimeCall(path: string, input: unknown) {
  const response = await worker.dispatchFetch("https://episodes.test" + path, { method: "POST", body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() as any };
}
test("real workerd Flue uses the bounded broker and publishes an attributed shadow proposal", async () => {
  await worker.dispose(); await bootstrap(nativeWorker("native"));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const dispatched = await runtimeCall("/dispatch", { episodeId: episode.id });
  expect(dispatched).toMatchObject({ status: 200, body: { state: "accepted" } });
  const read = await runtimeCall("/read", { episodeId: episode.id });
  expect(read).toMatchObject({ status: 200, body: { state: "shadow_completed", proposal: { execution: "unconfirmed", decision: "proposed" } } });
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(1);
});
test("native exact submission replay survives cold restart, with one model call and a 409 for a changed envelope", async () => {
  await worker.dispose(); await bootstrap(nativeWorker("cold"));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const dispatched = await runtimeCall("/dispatch", { episodeId: episode.id });
  expect((await runtimeCall("/read", { episodeId: episode.id })).body.state).toBe("shadow_completed");
  await worker.dispose(); await connect(nativeWorker("cold"));
  const replay = await runtimeCall("/rawdispatch", { episodeId: episode.id });
  expect(replay).toMatchObject({ status: 200, body: { ...dispatched.body.receipt, deduplicated: true } });
  expect((await runtimeCall("/rawdispatch", { episodeId: episode.id, envelope: { ...episode.envelope, message: "Changed synthetic message" } })).status).toBe(409);
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_episodes").first("COUNT(*)")).toBe(1);
});
test("native publication ACK loss preserves one journal reference across cold restart without another model call", async () => {
  await worker.dispose(); await bootstrap(nativeWorker("journal-ack"));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  const original = await db.prepare("SELECT id,revision,current_version,status FROM assistant_sources ORDER BY id").all();
  expect((await runtimeCall("/dispatch", { episodeId: episode.id })).body.state).toBe("accepted");
  const published = await runtimeCall("/read", { episodeId: episode.id, dropPublication: true });
  expect(published.body).toMatchObject({ state: "shadow_completed", decisionId: expect.any(String) });
  await worker.dispose(); await connect(nativeWorker("journal-ack"));
  const restored = await runtimeCall("/read", { episodeId: episode.id });
  expect(restored.body).toEqual(published.body);
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_shadow_decisions WHERE proposal_json IS NOT NULL").first("COUNT(*)")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(1);
  expect((await db.prepare("SELECT id,revision,current_version,status FROM assistant_sources ORDER BY id").all()).results).toEqual(original.results);
  expect(await new DecisionJournal(db, scope, { kind: "owner" }, { clock: () => 200000 }).get(published.body.decisionId)).toMatchObject({ freshness: "current" });
});
test.each(["before_commit", "after_model"])("lost dispatch ACK %s reconciles only the identical native envelope after restart", async drop => {
  const state = "dispatch-" + drop;
  await worker.dispose(); await bootstrap(nativeWorker(state));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  const { host, runId } = await controller(), episode = await host.prepare(lease, "owner", runId);
  expect((await runtimeCall("/dispatch", { episodeId: episode.id, drop })).body.state).toBe("uncertain");
  await worker.dispose(); await connect(nativeWorker(state));
  const reconciled = await runtimeCall("/reconcile", { episodeId: episode.id });
  expect(reconciled.body.state).toBe("accepted");
  expect((await runtimeCall("/read", { episodeId: episode.id })).body).not.toHaveProperty("proposal");
  const replay = await runtimeCall("/rawdispatch", { episodeId: episode.id });
  expect(replay.body).toMatchObject({ ...reconciled.body.receipt, deduplicated: true });
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(drop === "after_model" ? 1 : 0);
  expect(await db.prepare("SELECT COUNT(*) FROM assistant_model_receipts").first("COUNT(*)")).toBe(drop === "after_model" ? 1 : 0);
});
async function followUp(during: () => Promise<void> = async () => {}) {
  const previous = await controller(); await previous.host.queue.fail(lease, "synthetic_previous", now);
  await db.batch([
    db.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'fup-target','private')").bind(scope.installationId, scope.generation),
    db.prepare(`INSERT INTO assistant_follow_ups(installation_id,generation,id,version,source_id,source_revision,origin,conversation_id,purpose,timezone,next_evaluation_at,due_at,precision,state)
      VALUES(?,?,'fup',1,'source',1,'owner_request','fup-target','Synthetic follow up','UTC',0,0,'exact','scheduled')`).bind(scope.installationId, scope.generation),
    db.prepare("INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at) VALUES(?,?,'occurrence','fup',1,0)").bind(scope.installationId, scope.generation),
  ]);
  const queue = new JobQueue(db, scope), job = await queue.enqueue({ kind: "follow_up", dedupeKey: "fup", sourceId: "source", sourceRevision: 1, request: "Synthetic question", runtime: "flue", subject: { kind: "fup_occurrence", occurrenceId: "occurrence", followUpId: "fup", followUpVersion: 1 } }, now);
  await db.prepare("UPDATE assistant_jobs SET occurrence_id='occurrence' WHERE id=?").bind(job.id).run();
  lease = (await queue.claim(now, 90000))!;
  const nominal = { ...scope, sourceEpoch: "synthetic-epoch", sourceGeneration: "synthetic-source-generation" };
  const search = new RetrievalRuns(db, nominal, { clock: () => now });
  let progress = await search.start({ kind: "owner" }, "fup-search", { query: "Synthetic question" });
  for (let index = 0; progress.state === "pending" && index < 10; index++) progress = await search.step({ kind: "owner" }, { runId: progress.runId, stepId: "fup-step-" + index, expectedCheckpoint: progress.checkpoint });
  const source = (await new SourceAccess(db, scope).read({ kind: "owner" }, "source", 1, now))!;
  let calls = 0;
  const host = new EpisodeController(db, { ...nominal, period: "synthetic-period" }, search, async () => {
    calls++; await during(); return { status: 200, actualUnits: 3, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "proposed", text: "Synthetic FUP proposal", citations: [{ ...source.fence.source, quote: source.text }].map(({ id, revision, version, hash, quote }) => ({ id, revision, version, hash, quote })) }) } }] }) };
  }, { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { clock: () => now });
  return { host, runId: progress.runId, calls: () => calls, nominal };
}
test("a current FUP completes the guarded publication plan within real D1 limits", async () => {
  const { host, runId, calls } = await followUp(), episode = await host.prepare(lease, "owner", runId);
  const before = await db.batch([db.prepare("SELECT * FROM assistant_follow_ups"), db.prepare("SELECT * FROM assistant_fup_occurrences"), db.prepare("SELECT * FROM assistant_source_versions")]);
  const native = { submissionId: "synthetic-fup-submission", uid: "synthetic-fup-uid", acceptedAt: "2026-10-25T00:00:00Z" };
  await host.episodes.dispatch(episode.id);
  await host.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt: native });
  const raw = await host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: native.submissionId }, { messages: [{ role: "user", content: host.message(episode) }] });
  expect(await host.publish(episode.id, { text: raw, data: {}, ...native })).toMatchObject({ state: "shadow_completed", proposal: { execution: "unconfirmed" } });
  expect(calls()).toBe(1);
  const after = await db.batch([db.prepare("SELECT * FROM assistant_follow_ups"), db.prepare("SELECT * FROM assistant_fup_occurrences"), db.prepare("SELECT * FROM assistant_source_versions")]);
  expect(after.map(result => result.results)).toEqual(before.map(result => result.results));
  const diary = new DecisionJournal(db, { ...scope, sourceEpoch: "synthetic-epoch", sourceGeneration: "synthetic-source-generation" }, { kind: "owner" }, { clock: () => 200000 });
  const entry = (await diary.list({})).items.find(row => row.episodeId === episode.id && row.phase === "proposed")!;
  expect(await diary.get(entry.id)).toMatchObject({ freshness: "current" });
  await db.prepare("UPDATE assistant_follow_ups SET state='cancelled' WHERE id='fup'").run();
  expect(await diary.get(entry.id)).toMatchObject({ freshness: "stale" });

});
test("owner FUP due admission crosses real Flue and the mandatory journal exactly once without closing its obligation",async()=>{
  await worker.dispose();await bootstrap(nativeWorker("due-fup-49"));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  await new JobQueue(db,scope).fail(lease,"previous",now);
  const owner=new OwnerControl(db,{...scope,sourceEpoch:"test-epoch",sourceGeneration:"test-origin"},{kind:"owner"},()=>now);
  await owner.execute({kind:"policy.put",operationId:"fup-policy",id:"fup-target",expectedRevision:0,conversationKind:"private"});
  await owner.execute({kind:"mission.put",operationId:"mission",id:"mission",expectedRevision:0,objective:"Synthetic review",source:{id:"source",revision:1},state:"active"});
  await owner.execute({kind:"fup.put",operationId:"due-fup",id:"due-fup",expectedVersion:0,conversationId:"fup-target",policyRevision:1,source:{id:"source",revision:1},mission:{id:"mission",revision:1},purpose:"Synthetic question",dueAt:100,timezone:"UTC",precision:"exact",state:"scheduled"});
  const due=new FollowUps(db,scope,{clock:()=>now}),item=(await due.admitDue()).items[0];
  expect(item).toMatchObject({state:"admitted"});
  const queue=new JobQueue(db,scope),claimed=(await queue.claim(now,90000))!,search=new RetrievalRuns(db,scope,{clock:()=>now});
  const evaluationInput=JSON.parse((await queue.ledger(claimed.id))!.request_json).input;
  expect(evaluationInput).toContain("Condition (none_explicit; not proven satisfied)");
  let progress=await search.start({kind:"owner"},"due-search",{query:evaluationInput});
  for(let i=0;progress.state==="pending"&&i<10;i++)progress=await search.step({kind:"owner"},{runId:progress.runId,stepId:`due-${i}`,expectedCheckpoint:progress.checkpoint});
  await new InferenceBudget(db,{...scope,period:"synthetic-period"}).configure(1000);
  const host=new EpisodeController(db,{...scope,period:"synthetic-period"},search,async()=>{throw new Error("native_callback_only");},{...DEFAULT_BROKER_CONFIG,chatCeiling:5},{clock:()=>now});
  const episode=await host.prepare(claimed,"owner",progress.runId),before=await db.batch([db.prepare("SELECT * FROM assistant_follow_ups"),db.prepare("SELECT * FROM assistant_fup_occurrences"),db.prepare("SELECT * FROM assistant_missions")]);
  expect((await runtimeCall("/dispatch",{episodeId:episode.id})).body.state).toBe("accepted");
  const published=(await runtimeCall("/read",{episodeId:episode.id})).body;
  expect(published).toMatchObject({state:"shadow_completed",proposal:{execution:"unconfirmed"}});
  expect(await new DecisionJournal(db,scope,{kind:"owner"},{clock:()=>10000}).get(published.decisionId)).toMatchObject({phase:"proposed",freshness:"current",subject:{kind:"fup_occurrence",occurrenceId:item.occurrenceId}});
  expect(await due.get("due-fup")).toMatchObject({obligationState:"scheduled",evaluationState:"shadow_completed"});
  const after=await db.batch([db.prepare("SELECT * FROM assistant_follow_ups"),db.prepare("SELECT * FROM assistant_fup_occurrences"),db.prepare("SELECT * FROM assistant_missions")]);
  expect(after.map(r=>r.results)).toEqual(before.map(r=>r.results));
  expect((await due.admitDue()).items[0].jobId).toBe(item.jobId);
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(1);
});
test('an explicit new recipient with no history crosses real Flue once with its immutable shadow envelope and no send capability',async()=>{
 await worker.dispose();await bootstrap(nativeWorker('outgoing-128'));await db.prepare('CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)').run();await new JobQueue(db,scope).fail(lease,'previous',now);
 const archiveWorker=new Miniflare(convertV4MiniflareOptions({modules:true,script:archiveFixtureScript,compatibilityDate:'2026-10-26',compatibilityFlags:['nodejs_compat'],d1Databases:['ARCHIVE'],outboundService:()=>{externalCalls++;throw Error('external_network_forbidden')}}));
 try{const archive=await archiveWorker.getD1Database('ARCHIVE');for(const migration of await readD1Migrations(resolve(root,'migrations')))await archive.batch(migration.queries.map(q=>archive.prepare(q)));
  const nominal={...scope,sourceEpoch:'recipient-e',sourceGeneration:'recipient-g'},secret='synthetic-native-recipient-reader-secret';
  const sourceCall=async(path:string,input:unknown)=>{const response=await archiveWorker.dispatchFetch('https://source-fixture.test'+path,{method:'POST',body:JSON.stringify(input)});if(!response.ok)throw Error('source_fixture_failed');return response.json() as Promise<any>;};
  const recipient=await sourceCall('/resolve',{phone:'+12025550123'}),port=outgoingPort({DB:db,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:nominal.sourceEpoch,BRIDGE_SOURCE_GENERATION:nominal.sourceGeneration,BRIDGE_SECRET:secret,FLUE_EPISODES_ENABLED:'shadow',CAPTURE_READER:{readSnapshot:async()=>{throw Error('no_history')},readRecipientEnvelope:input=>sourceCall('/envelope',input)}}),control=new OwnerControl(db,nominal,{kind:'owner'},()=>now,port);
  await control.execute({kind:'policy.put',operationId:'outgoing-policy',id:recipient.chatId,expectedRevision:0,conversationKind:'private'});await control.execute({kind:'fup.put',operationId:'outgoing-fup',id:'outgoing-fup',expectedVersion:0,conversationId:recipient.chatId,policyRevision:1,source:{id:'source',revision:1},purpose:'Synthetic question',dueAt:100,timezone:'UTC',precision:'exact',state:'scheduled',outgoing:{authorization:{kind:'owner_exact'},envelope:{kind:'text',chatId:recipient.chatId,text:'Exact first-contact shadow text.'}}});
  const proof=JSON.parse((await db.prepare('SELECT body_json FROM assistant_fup_provenance WHERE fup_id=?').bind('outgoing-fup').first<string>('body_json'))!).outgoing;await db.prepare('CREATE TABLE synthetic_outgoing_proof(id INTEGER PRIMARY KEY,proof_json TEXT)').run();await db.prepare('INSERT INTO synthetic_outgoing_proof VALUES(1,?)').bind(JSON.stringify(proof)).run();
  const due=new FollowUps(db,scope,{clock:()=>now}),item=(await due.admitDue()).items[0];expect(item.state).toBe('admitted');const queue=new JobQueue(db,scope),claimed=(await queue.claim(now,90000))!,ledger=(await queue.ledger(claimed.id))!,request=JSON.parse(ledger.request_json),search=new RetrievalRuns(db,scope,{clock:()=>now});let progress=await search.start({kind:'owner'},'outgoing-search',{query:request.input});for(let i=0;progress.state==='pending'&&i<10;i++)progress=await search.step({kind:'owner'},{runId:progress.runId,stepId:'outgoing-'+i,expectedCheckpoint:progress.checkpoint});
  await new InferenceBudget(db,{...scope,period:'synthetic-period'}).configure(1000);const host=new EpisodeController(db,{...scope,period:'synthetic-period'},search,async()=>{throw Error('native_callback_only')},{...DEFAULT_BROKER_CONFIG,chatCeiling:5},{clock:()=>now,outgoing:port}),episode=await host.prepare(claimed,'owner',progress.runId);expect(episode.binding.outgoing).toEqual(proof);
  expect((await runtimeCall('/dispatch',{episodeId:episode.id})).body.state).toBe('accepted');const result=(await runtimeCall('/read',{episodeId:episode.id})).body;expect(result).toMatchObject({state:'shadow_completed',proposal:{mode:'shadow',externalAttempted:false,outgoing:proof}});expect((await runtimeCall('/read',{episodeId:episode.id})).body).toMatchObject({state:'shadow_completed',decisionId:result.decisionId});
  expect(await db.prepare('SELECT COUNT(*) n FROM synthetic_model_calls').first('n')).toBe(1);expect((await queue.ledger(claimed.id))!.request_json).toBe(ledger.request_json);for(const table of ['messages','actions'])expect(await archive.prepare('SELECT COUNT(*) n FROM '+table).first('n')).toBe(0);expect(await db.prepare('SELECT COUNT(*) n FROM assistant_origin_conversations').first('n')).toBe(0);
 }finally{await archiveWorker.dispose();}
});
test("journal freshness rechecks mandate expiry after awaits rather than using its first clock sample", async () => {
  const { host, runId, nominal } = await followUp();
  await db.prepare("INSERT INTO assistant_mandates(installation_id,generation,id,version,conversation_id,purpose,status,issued_at,expires_at) VALUES(?,?,'mandate',1,'fup-target','Synthetic evaluation','active',0,500)").bind(scope.installationId,scope.generation).run();
  await db.prepare("UPDATE assistant_follow_ups SET mandate_id='mandate',mandate_version=1 WHERE id='fup'").run();
  const episode = await host.prepare(lease,"owner",runId), native = { submissionId:"synthetic-fup-submission",uid:"synthetic-fup-uid",acceptedAt:"2026-10-25T00:00:00Z" };
  await host.episodes.dispatch(episode.id);await host.episodes.accept(episode.id,{profile:"owner",runtimeId:episode.runtime_id,bindingHash:episode.binding_hash,envelopeHash:episode.dispatch_hash,receipt:native});
  const text = await host.model(episode.id,{profile:"owner",runtimeId:episode.runtime_id,submissionId:native.submissionId},{messages:[{role:"user",content:host.message(episode)}]});
  const published = await host.publish(episode.id,{...native,text,data:{}});let ticks=0;
  const diary = new DecisionJournal(db,nominal,{kind:"owner"},{clock:()=>++ticks===1?100:1000});
  const detail = await diary.get(published.decisionId!);
  expect(detail).toMatchObject({freshness:"stale"});expect(detail).not.toHaveProperty("proposal");
});
test("a follow-up anchored in an owner note cannot ignore a paused target conversation", async () => {
  const { host, runId, nominal } = await followUp();
  await db.batch([
    db.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'fup-target',0,'private','available')").bind(scope.installationId, scope.generation, nominal.sourceEpoch, nominal.sourceGeneration),
    db.prepare("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,paused,policy_revision,mode) VALUES(?,?,?,?,'fup-target',1,1,'attend')").bind(scope.installationId, scope.generation, nominal.sourceEpoch, nominal.sourceGeneration),
  ]);
  await expect(host.prepare(lease, "owner", runId)).rejects.toThrow("episode_denied");
});
test.each(["before_adapter", "during_adapter"])("FUP cancellation %s blocks output and preserves the model ledger", async stage => {
  const cancel = () => db.prepare("UPDATE assistant_follow_ups SET state='cancelled' WHERE id='fup'").run().then(() => {});
  const { host, runId, calls } = await followUp(stage === "during_adapter" ? cancel : undefined);
  const episode = await host.prepare(lease, "owner", runId);
  expect(await (host as any).check(episode)).toBe(true);
  if (stage === "before_adapter") {
    const batch = db.batch.bind(db); let invalidated = false;
    db.batch = async <T = unknown>(statements: D1PreparedStatement[]) => { const result = await batch<T>(statements); if (statements.length === 6 && !invalidated) { invalidated = true; await cancel(); } return result; };
  }
  const provider = createEpisodeProvider(payload => host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: "synthetic-fup-submission" }, payload));
  const stream = provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: host.message(episode), timestamp: now }] } as any);
  const events = []; for await (const event of stream) events.push(event);
  expect(events.map(event => event.type)).toEqual(["error"]); expect(calls()).toBe(stage === "during_adapter" ? 1 : 0);
  expect(await db.prepare("SELECT state FROM assistant_model_receipts").first("state")).toBe(stage === "during_adapter" ? "complete" : "uncertain");
  expect(await db.prepare("SELECT actual_units FROM assistant_budget_reservations").first("actual_units")).toBe(stage === "during_adapter" ? 3 : null);
});
test("real interlocutor Flue receives public canonical context instead of owner input or private notes", async () => {
  await worker.dispose(); await bootstrap(nativeWorker("profiles"));
  await db.prepare("CREATE TABLE synthetic_model_calls(body TEXT NOT NULL)").run();
  const owner = new SourceController(db, scope, { kind: "owner" }, () => now);
  await owner.create({ originKey: "private-secret", text: "Synthetic OWNER_PRIVATE_SENTINEL", occurredAt: now });
  const publicSource = await owner.create({ originKey: "public", text: "Synthetic public source", audience: "public", occurredAt: now });
  const ownerContext = await controller(), ownerEpisode = await ownerContext.host.prepare(lease, "owner", ownerContext.runId);
  expect(ownerContext.host.message(ownerEpisode)).toContain("OWNER_PRIVATE_SENTINEL");
  const actor = { kind: "interlocutor", provider: "synthetic-provider", address: "synthetic-address", conversationId: "synthetic-private-chat", conversationKind: "private", action: "reply_text" } as const;
  const queue = new JobQueue(db, scope, actor);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "interlocutor", sourceId: publicSource.id, sourceRevision: 1, request: "OWNER_PRIVATE_SENTINEL must never enter the interlocutor input", runtime: "flue", subject: { kind: "owner_request", sourceId: publicSource.id, sourceRevision: 1, requestKey: "owner-requested-interlocutor-proposal" } }, now);
  const interlocutorLease = (await queue.claim(now, 90000))!;
  const search = new RetrievalRuns(db, scope, { clock: () => now });
  let progress = await search.start(actor, "interlocutor-search", { query: "Synthetic public source" });
  for (let index = 0; progress.state === "pending" && index < 10; index++) progress = await search.step(actor, { runId: progress.runId, stepId: "interlocutor-step-" + index, expectedCheckpoint: progress.checkpoint });
  const host = new EpisodeController(db, { ...scope, period: "synthetic-period" }, search, async () => { throw new Error("native_callback_only"); }, { ...DEFAULT_BROKER_CONFIG, chatCeiling: 5 }, { clock: () => now });
  const episode = await host.prepare(interlocutorLease, "interlocutor", progress.runId);
  expect(host.message(episode)).not.toContain("OWNER_PRIVATE_SENTINEL");
  expect((await runtimeCall("/dispatch", { episodeId: episode.id })).body.state).toBe("accepted");
  expect((await runtimeCall("/read", { episodeId: episode.id })).body.state).toBe("shadow_completed");
  expect(await db.prepare("SELECT COUNT(*) FROM synthetic_model_calls").first("COUNT(*)")).toBe(1);
  expect(await db.prepare("SELECT body FROM synthetic_model_calls").first("body")).not.toContain("OWNER_PRIVATE_SENTINEL");
});

async function semanticController(mode:"required"|"lexical_fallback") {
  const actor={kind:"owner"} as const,query=mode==="required"?"Quem responde pela cobrança?":"Synthetic question";
  const queue=new JobQueue(db,scope);await queue.fail(lease,"previous",now);
  await queue.enqueue({kind:"reasoning",dedupeKey:"semantic-episode",sourceId:"source",sourceRevision:1,request:query,runtime:"flue",subject:{kind:"owner_request",sourceId:"source",sourceRevision:1,requestKey:"semantic-episode"}},now);lease=(await queue.claim(now,90000))!;
  let semanticReceipt:EngineSearchOutcome={state:"uncertain",reason:"not_submitted"},preparedInput:Parameters<SemanticEnginePort["prepare"]>[1],semanticCalls=0,modelCalls=0;
  const engine:SemanticEnginePort={prepare:async(alias,input)=>{
    preparedInput=input;
    return mode==="lexical_fallback"?{state:"blocked",reason:"PRIVATE_ENGINE_REASON_SENTINEL"}:{state:"prepared",ticket:{alias,requestHash:await bridgeHash(input),operationId:"a".repeat(64),indexEpoch:"synthetic-index",indexRevision:"b".repeat(64)}};
  },submit:async(ticket:SearchTicket)=>{semanticCalls++;semanticReceipt={state:"complete",operationId:ticket.operationId,indexRevision:ticket.indexRevision,indexState:"needs_checkpoint",result:{candidates:[{...preparedInput.allowedSources[0],via:["chunks"],relationCount:0}],missing:[]}};return semanticReceipt;},lookupTicket:async()=>semanticReceipt};
  const search=new RetrievalRuns(db,scope,{clock:()=>now,purpose:"owner_read",semantic:{mode,engine}});
  let progress=await search.start(actor,"semantic-controller",{query});
  for(let i=0;progress.state==="pending"&&i<10;i++)progress=await search.step(actor,{runId:progress.runId,stepId:`semantic-${i}`,expectedCheckpoint:progress.checkpoint});
  const source=(await new SourceAccess(db,scope).read(actor,"source"))!,budgetScope={...scope,period:"synthetic-period"};await new InferenceBudget(db,budgetScope).configure(100000);
  const host=new EpisodeController(db,budgetScope,search,async()=>{modelCalls++;return {status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:"proposed",text:"Synthetic proposal",citations:[{id:"source",revision:1,version:1,hash:source.fence.source.hash,quote:"Synthetic original"}]})}}]})};},{...DEFAULT_BROKER_CONFIG,chatCeiling:5},{clock:()=>now,purpose:"owner_read"});
  if(mode==="required") {await expect(host.prepare(lease,"owner",progress.runId)).rejects.toThrow("episode_waiting_context");expect(modelCalls).toBe(0);}
  await search.advanceSemantic(actor,progress.runId);
  return {host,search,runId:progress.runId,modelCalls:()=>modelCalls,semanticCalls:()=>semanticCalls};
}
test.each(["required","lexical_fallback"] as const)("real episode binds strict %s semantic provenance through admission and guarded publication",async mode=>{
  const {host,runId,semanticCalls,modelCalls}=await semanticController(mode),episode=await host.prepare(lease,"owner",runId);
  expect(episode.binding.search.ranking).toMatchObject({engine:mode==="required"?"complete":"unavailable"});
  expect(JSON.stringify(episode)).not.toContain("PRIVATE_ENGINE_REASON_SENTINEL");
  expect(host.message(episode)).toContain(mode==="required"?'"gaps":[]':'semantic_unsearched');
  const native={submissionId:"semantic-submission",uid:"semantic-uid",acceptedAt:"2026-10-25T00:00:00Z"};
  await host.episodes.dispatch(episode.id);await host.episodes.accept(episode.id,{profile:"owner",runtimeId:episode.runtime_id,bindingHash:episode.binding_hash,envelopeHash:episode.dispatch_hash,receipt:native});
  const raw=await host.model(episode.id,{profile:"owner",runtimeId:episode.runtime_id,submissionId:native.submissionId},{messages:[{role:"user",content:host.message(episode)}]});
  expect(await db.prepare("SELECT search_nonce FROM assistant_episodes WHERE id=?").bind(episode.id).first("search_nonce")).toEqual(expect.any(String));
  expect(await host.publish(episode.id,{text:raw,data:{},...native})).toMatchObject({state:"shadow_completed",proposal:{coverage:{engine:mode==="required"?"complete":"unavailable"},binding:{allowedPackHash:episode.binding.search.allowedPackHash}}});
  expect(modelCalls()).toBe(1);expect(semanticCalls()).toBe(mode==="required"?1:0);
});
test.each(["required","lexical_fallback"] as const)("fresh inventory insertion blocks the %s episode receipt and nonce atomically",async mode=>{
  const {host,runId,modelCalls}=await semanticController(mode),episode=await host.prepare(lease,"owner",runId);
  let oldNonce:unknown;
  const batch=db.batch.bind(db);let inserted=false;
  db.batch=async statements=>{if(statements.length===4&&!inserted){inserted=true;oldNonce=await db.prepare("SELECT search_nonce FROM assistant_episodes WHERE id=?").bind(episode.id).first("search_nonce");await new SourceController(db,scope,{kind:"owner"},()=>now).create({originKey:"insert-behind",text:"Fresh context after search",occurredAt:now});}return batch(statements);};
  await expect(host.model(episode.id,{profile:"owner",runtimeId:episode.runtime_id,submissionId:"semantic-submission"},{messages:[{role:"user",content:host.message(episode)}]})).rejects.toThrow("episode_denied");
  expect(inserted).toBe(true);expect(modelCalls()).toBe(0);expect(await db.prepare("SELECT COUNT(*) n FROM assistant_model_receipts").first("n")).toBe(0);
  expect(await db.prepare("SELECT search_nonce FROM assistant_episodes WHERE id=?").bind(episode.id).first("search_nonce")).toBe(oldNonce);
});
