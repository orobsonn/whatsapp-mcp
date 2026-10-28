import { env } from "cloudflare:test";
import * as transport from "../assistant/model-transport";
import { answerGitHubQuestion } from "../assistant/telegram-research";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TelegramOwnerInbox, type TelegramOwnerTurn } from "../assistant/telegram-owner-inbox";
import { TelegramOwnerRequests } from "../assistant/telegram-owner-requests";
import { TelegramLink } from "../assistant/telegram-auth";
import { SourceAccess, type SourceFence } from "../assistant/access";
import { JobQueue, type JobLease } from "../assistant/queue";
import { Episodes } from "../assistant/agent/episodes";
import { InferenceBudget } from "../assistant/budget";
import type { BrokerConfig, ModelAdapter } from "../assistant/model-broker";
import { SourceController } from "../assistant/sources";
import { RetentionPurge } from "../assistant/retention-purge";
import { OwnerDialoguePhases } from "../assistant/telegram-dialogue-phases";
import { TelegramOwnerReplies } from "../assistant/telegram-owner-replies";
import type { DialogueWitness } from "../assistant/telegram-dialogue-state";
import { TelegramDialogueHost } from "../assistant/telegram-dialogue-runtime";
import { TelegramBotApi } from "../assistant/telegram";
import { bridgeHash } from "../assistant/ingress";
import type { AssistantEnv } from "../assistant/env";

const bot = "synthetic_phase_bot", secret = "synthetic-phase-webhook-secret-for-tests";
const config: BrokerConfig = { extractionConfig: "telegram-owner-dialogue-v1", priceVersion: "synthetic", chatModel: "gpt-6-luna", embeddingModel: "text-embedding-3-small", maxOutputTokens: 100, chatCeiling: 5, embeddingCeiling: 2 };
const retirement = { allow: async () => {}, withdraw: async () => {} };
let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string; period: string };
let inbox: TelegramOwnerInbox, turn: TelegramOwnerTurn, link: TelegramLink, source: SourceFence, context: ConstructorParameters<typeof OwnerDialoguePhases>[2], phases: OwnerDialoguePhases;
let adapter: ReturnType<typeof vi.fn<ModelAdapter>>;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const payload = (text = "Interpret only this authenticated owner request.") => ({ model: config.chatModel, messages: [{ role: "system", content: text }, { role: "user", content: turn.text }], max_completion_tokens: 100 });
async function episode(key = "primary", selectedConfig = config) {
  const queue = new JobQueue(env.DB, scope, { kind: "owner" }, async () => inbox.guard(turn));
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "telegram-owner-v1:" + key, sourceId: source.source.id, sourceRevision: 1, request: "telegram-owner-dialogue-v1", maxAttempts: 1, runtime: "flue_owner_dialogue" }, Date.now(), { id: crypto.randomUUID(), guard: inbox.guard(turn), statements: [] });
  const lease = (await queue.claimId(job.id, Date.now(), 90000, inbox.guard(turn)))!, ledger = (await queue.ledger(job.id))!, episodes = new Episodes(env.DB, scope);
  const checkpoint = await inbox.checkpoint(turn), deadlineAt = Math.min(Date.now() + 60000, turn.deadlineAt - 1);
  const row = await episodes.prepare({ lease, requestHash: ledger.request_hash, profile: "owner", checkpoint: checkpoint.fingerprint, binding: { kind: "telegram_owner_dialogue", scope, source, checkpoint, lease, config: selectedConfig, period: scope.period }, deadline: deadlineAt, maxCalls: 2 });
  await episodes.envelope(row.id, { message: "Execute the admitted private dialogue.", initialData: { bindingId: row.id }, idempotencyKey: "dialogue:" + row.id });
  expect(await episodes.dispatch(row.id)).toBe(true); expect(await episodes.submission(row.id, "synthetic-native-submission")).toBe(true);
  return { lease, episodeId: row.id, bindingHash: row.binding_hash, deadlineAt, source, identity: { profile: "owner-dialogue", runtimeId: row.runtime_id, submissionId: "synthetic-native-submission" }, config: selectedConfig };
}
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "epoch", sourceGeneration: "capture", period: "2026-10-28" };
  await env.DB.prepare("INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',?)").bind(scope.installationId, scope.generation, bot, scope.sourceEpoch, scope.sourceGeneration, Math.floor(Date.now() / 1000) - 10).run();
  link = new TelegramLink(env.DB, scope, bot, secret); inbox = new TelegramOwnerInbox(env.DB, { installationId: scope.installationId, generation: scope.generation, sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration }, bot);
  const activation = await inbox.activate(); await wait(Math.max(1, (activation.cutoffSecond + 1) * 1000 - Date.now() + 10));
  expect(await link.receive({ update_id: 3, message: { message_id: 103, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false }, chat: { id: 101, type: "private" }, text: "O que ficou pendente?" } })).toBe("pending");
  turn = (await inbox.claim(3))!; const captured = (await new TelegramOwnerRequests(env.DB, inbox, retirement).capture(turn))!;
  source = (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, captured.id))!.fence;
  context = await episode(); await new InferenceBudget(env.DB, scope).configure(100);
  adapter = vi.fn<ModelAdapter>(async () => ({ status: 200, body: '{"choices":[{"message":{"content":"synthetic private intent"}}]}', actualUnits: 1 }));
  phases = new OwnerDialoguePhases(env.DB, scope, context, inbox, turn, adapter);
});
afterEach(() => vi.restoreAllMocks());

it.each(["before_prepare", "after_prepare"] as const)("recovers a persisted reply %s without repeating its model or command", async point => {
  const result = await phases.run("intent", payload()); expect(result.state).toBe("complete"); if (result.state !== "complete") return;
  const phase = await env.DB.prepare("SELECT request_hash,result_hash FROM assistant_telegram_dialogue_phases WHERE installation_id=? AND request_id=?").bind(scope.installationId, source.source.id).first<{ request_hash: string; result_hash: string }>();
  const witnesses: DialogueWitness[] = [{ kind: "owner_model", source, operationKey: result.operationKey, requestHash: phase!.request_hash, resultHash: phase!.result_hash, bindingHash: context.bindingHash, submissionId: context.identity.submissionId }];
  const plan = { kind: "telegram_owner_reply_plan" as const, updateId: turn.updateId, text: "✅ <b>Recibo técnico preservado</b>", dependencies: [], witnesses,
    outboxRequestHash: await bridgeHash([inbox.replyFence(turn), "✅ <b>Recibo técnico preservado</b>", [], witnesses]), intentOperationKey: result.operationKey, intentRequestHash: phase!.request_hash, intentResultHash: phase!.result_hash };
  await env.DB.prepare("UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND id=?").bind(JSON.stringify(plan), scope.installationId, context.episodeId).run();
  const host = new TelegramDialogueHost({ DB: env.DB, TELEGRAM_OWNER_DIALOGUE_ENABLED: "shadow", FLUE_EPISODES_ENABLED: "shadow", OPENAI_API_KEY: "synthetic", TELEGRAM_BOT_TOKEN: "synthetic", TELEGRAM_BOT_INSTANCE: bot,
    INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration } as AssistantEnv);
  if (point === "after_prepare") {
    expect(await new TelegramOwnerReplies(env.DB, scope, bot, inbox, () => ({ send: async () => 303 })).prepare(turn, plan.text, [], witnesses)).toMatchObject({ state: "prepared" });
    vi.spyOn(host.inbox, "resume").mockImplementation(async () => { throw Error("consumed turn must not be resumed"); });
  }
  const send = vi.spyOn(TelegramBotApi.prototype, "send").mockResolvedValue(303), episode = (await new Episodes(env.DB, scope).get(context.episodeId))!;
  await host["finishReply"](episode, plan); await host["finishReply"](episode, plan);
  expect(send).toHaveBeenCalledTimes(1); expect(adapter).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare("SELECT state,attempts,message_id FROM assistant_telegram_owner_replies WHERE installation_id=? AND update_id=?").bind(scope.installationId, turn.updateId).first()).toEqual({ state: "sent", attempts: 1, message_id: 303 });
});

it.each(["calendar", "github"] as const)("pins a %s reply to the native observation and purges it when its authorization support is removed", async kind => {
  const result = await phases.run("intent", payload()); expect(result.state).toBe("complete");
  if (result.state !== "complete") return;
  const phase = await env.DB.prepare("SELECT request_hash,result_hash FROM assistant_telegram_dialogue_phases WHERE installation_id=? AND request_id=?").bind(scope.installationId, source.source.id).first<{ request_hash: string; result_hash: string }>();
  const support = await new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement).create({ originKey: "calendar-authority", text: "Synthetic private calendar authorization", occurredAt: Date.now() });
  const dependency = { source: (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, support.id))!.fence };
  const observation = kind === "calendar" ? { kind, query: { kind: "calendar.availability", start: "2026-10-28T03:00:00Z", end: "2026-10-29T03:00:00Z", timeZone: "America/Fortaleza" }, result: { state: "available", origin: kind, privateMarker: "synthetic calendar intervals" } } : { kind, query: { kind: "github.read", repository: "repo", commit: "a".repeat(40), path: "README.md" }, result: { state: "available", origin: kind, privateMarker: "synthetic repository excerpt" } };
  const witnesses: DialogueWitness[] = [{ kind: "owner_model", source, operationKey: result.operationKey, requestHash: phase!.request_hash, resultHash: phase!.result_hash, bindingHash: context.bindingHash, submissionId: context.identity.submissionId },
    { kind: kind === "calendar" ? "calendar_observation" : "github_observation", episodeId: context.episodeId, bindingHash: context.bindingHash, submissionId: context.identity.submissionId, observationJSON: JSON.stringify(observation) }];
  const plan = { kind: "telegram_owner_reply_plan", observation, dependencies: [dependency], witnesses };
  const save = (value: unknown) => env.DB.prepare("UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND id=?").bind(JSON.stringify(value), scope.installationId, context.episodeId).run();
  await save(plan); const send = vi.fn(async () => 203), replies = new TelegramOwnerReplies(env.DB, scope, bot, inbox, check => ({ send: async () => { await check(); return send(); } }));
  expect(await replies.prepare(turn, "Synthetic Calendar answer", [dependency], witnesses)).toMatchObject({ state: "prepared" });
  await save({ ...plan, observation: { ...observation, result: { state: "changed" } } });
  expect(await replies.dispatch(turn.updateId)).toMatchObject({ state: "blocked", attempts: 0 }); expect(send).not.toHaveBeenCalled();
  await save(plan);
  await new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement).withdraw(support.id, 1);
  const purge = new RetentionPurge(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  let state = "pending"; for (let i = 0; i < 20 && state === "pending"; i++) state = (await purge.advance({ kind: "source.purge", operationId: "calendar-support-purge", sourceId: support.id })).state;
  expect(state).toBe("complete"); expect(await new Episodes(env.DB, scope).get(context.episodeId)).toBeNull();
  const outbox = await env.DB.prepare("SELECT text,deps_json,witnesses_json,purged FROM assistant_telegram_owner_replies WHERE installation_id=? AND update_id=?").bind(scope.installationId, turn.updateId).first();
  expect(outbox).toEqual({ text: null, deps_json: "[]", witnesses_json: "[]", purged: 1 });
  expect((await new InferenceBudget(env.DB, scope).status()).committed).toBe(1); expect(send).not.toHaveBeenCalled();
});

it("executes a frozen phase once, recovers its exact receipt and refuses rekeying before a second reservation", async () => {
  expect(await phases.run("intent", payload())).toMatchObject({ state: "complete", body: { choices: [{ message: { content: "synthetic private intent" } }] } });
  expect(await phases.run("intent", payload())).toMatchObject({ state: "complete" });
  await expect(phases.run("intent", payload("changed instruction"))).rejects.toThrow("dialogue_phase_conflict");
  expect(adapter).toHaveBeenCalledTimes(1); expect((await new InferenceBudget(env.DB, scope).status()).committed).toBe(1);
  expect(await phases.inspect("intent")).toMatchObject({ state: "complete", ordinal: 1, purged: false });
});

it("does not give another episode a second phase slot or model cost for the same owner request", async () => {
  await phases.run("intent", payload());
  const alternate = new OwnerDialoguePhases(env.DB, scope, await episode("alternate"), inbox, turn, adapter);
  await expect(alternate.run("intent", payload())).rejects.toThrow("dialogue_phase_conflict");
  expect(adapter).toHaveBeenCalledTimes(1);
});

it("a losing concurrent descriptor cannot consume an ordinal or reserve another model attempt", async () => {
  const result = await Promise.allSettled([phases.run("intent", payload("first candidate")), phases.run("intent", payload("second candidate"))]);
  expect(result.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(result.filter(row => row.status === "rejected")).toHaveLength(1);
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_episode_calls WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("n")).toBe(1);
});

it("does not poison an in-flight winner when an identical invocation arrives concurrently", async () => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  adapter.mockImplementation(async () => { await waiting; return { status: 200, body: '{"choices":[{"message":{"content":"winner"}}]}', actualUnits: 1 }; });
  const winner = phases.run("intent", payload());
  await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
  expect(await phases.run("intent", payload())).toMatchObject({ state: "in_progress" });
  release(); expect(await winner).toMatchObject({ state: "complete" }); expect(adapter).toHaveBeenCalledTimes(1);
});

it("preserves a reservation when execution is interrupted before receipt admission and never rekeys it", async () => {
  const reserve = InferenceBudget.prototype.reserve;
  vi.spyOn(InferenceBudget.prototype, "reserve").mockImplementation(async function (this: InferenceBudget, ...args) { await reserve.apply(this, args); throw Error("synthetic interruption after reservation"); });
  expect(await phases.run("intent", payload())).toMatchObject({ state: "uncertain" });
  expect(await phases.run("intent", payload())).toMatchObject({ state: "uncertain" });
  expect(await phases.inspect("intent")).toMatchObject({ state: "uncertain" });
  expect(adapter).not.toHaveBeenCalled(); expect((await new InferenceBudget(env.DB, scope).status()).committed).toBe(5);
});

it("propagates native cancellation to the real adapter signal and prevents a second phase", async () => {
  const native = new AbortController(); let observed: AbortSignal | undefined;
  adapter.mockImplementation(async request => { observed = request.signal; return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(Error("synthetic adapter aborted")), { once: true })); });
  phases = new OwnerDialoguePhases(env.DB, scope, context, inbox, turn, adapter, { signal: native.signal });
  const result = phases.run("intent", payload()); await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1)); native.abort();
  expect(await result).toMatchObject({ state: "uncertain" }); expect(observed?.aborted).toBe(true);
  expect(await phases.run("answer", payload())).toMatchObject({ state: "blocked" }); expect(adapter).toHaveBeenCalledTimes(1);
});

it("purges private phases and a late model body while preserving a paid settlement and the phase latch", async () => {
  await phases.run("intent", payload());
  const note = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "support", text: "synthetic private support", occurredAt: 1 });
  const dependency = (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, note.id))!.fence;
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  adapter.mockImplementation(async () => { await waiting; return { status: 200, body: '{"choices":[{"message":{"content":"late private support"}}]}', actualUnits: 2 }; });
  const result = phases.run("answer", payload("Use synthetic private support"), [{ source: dependency }]);
  await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(2));
  await new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement).withdraw(note.id, 1);
  const purge = new RetentionPurge(env.DB, scope, { kind: "owner" }, Date.now, retirement); let state: { state: string } = { state: "pending" };
  for (let i = 0; i < 25 && state.state !== "complete"; i++) state = await purge.advance({ kind: "source.purge", operationId: "purge-phase-support", sourceId: note.id });
  expect(state.state).toBe("complete"); release(); expect(await result).toMatchObject({ state: "uncertain" });
  expect(await phases.inspect("answer")).toMatchObject({ state: "cancelled", purged: true });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_episodes WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_model_receipts WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("n")).toBe(0);
  expect((await new InferenceBudget(env.DB, scope).status()).committed).toBe(3);
  const row = await env.DB.prepare("SELECT body_json,result_json,deps_json FROM assistant_telegram_dialogue_phases WHERE installation_id=? AND generation=? AND request_id=? AND phase='answer'").bind(scope.installationId, scope.generation, source.source.id).first();
  expect(row).toEqual({ body_json: null, result_json: null, deps_json: "[]" });
});

it("read-context intent is admitted only in a host-locked GitHub research episode and replays without a second provider call", async () => {
  const support = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "github-research-grant", text: "Synthetic read grant", occurredAt: Date.now() });
  const dep = { source: (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, support.id))!.fence };
  const research = new OwnerDialoguePhases(env.DB, scope, context, inbox, turn, adapter, { githubQuestion: true });
  expect((await research.run("intent", payload(), [dep])).state).toBe("blocked"); expect(adapter).not.toHaveBeenCalled();
  await env.DB.prepare("UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND id=?").bind(JSON.stringify({ kind: "telegram_owner_research", mode: "github_question", dependencies: [dep] }), scope.installationId, context.episodeId).run();
  expect((await research.run("intent", payload(), [dep])).state).toBe("complete");
  expect((await new OwnerDialoguePhases(env.DB, scope, context, inbox, turn, adapter, { githubQuestion: true }).run("intent", payload(), [dep])).state).toBe("complete"); expect(adapter).toHaveBeenCalledTimes(1);
  await new SourceController(env.DB, scope, { kind: "owner" }).withdraw(support.id, 1);
  expect((await research.run("answer", payload("Explain the selected sources."), [dep])).state).toBe("blocked"); expect(adapter).toHaveBeenCalledTimes(1);
});

it("completes repository research through both real model phases and the persisted context", async () => {
  const c = await episode("github-complete", { ...config, maxOutputTokens: 6000, chatCeiling: 20 });
  const row = (await new Episodes(env.DB, scope).get(c.episodeId))!;
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "github-project", "Synthetic repository").run();
  const grant = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "github-complete-grant", text: "Synthetic read-only repository authority", projectId: "github-project", occurredAt: Date.now() });
  const evidence = "OAuth checks the owner before access.", text = evidence + "\n" + "x".repeat(28000);
  let calls = 0;
  const model: ModelAdapter = async () => { calls++; const content = calls === 1 ? { paths: ["src/auth.ts"] } : { claims: [{ text: "O projeto verifica o dono via OAuth antes de liberar o acesso.", basis: "observed", citations: [{ id: "src/auth.ts", quote: evidence }] }], missing: null }; return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), actualUnits: 1 }; };
  vi.spyOn(transport, "createOpenAIAdapter").mockReturnValue(model);
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } });
    if (path.includes("/git/trees/")) return Response.json({ sha: "b".repeat(40), truncated: false, tree: [{ path: "src/auth.ts", type: "blob", mode: "100644", size: text.length }] });
    if (path.includes("/contents/")) return Response.json({ name: "auth.ts", path: "src/auth.ts", type: "file", size: text.length, sha: "c".repeat(40), encoding: "base64", content: btoa(text) });
    return Response.json({ name: "app", owner: { id: 123, login: "owner" }, default_branch: "main" });
  });
  try {
    const settings = { DB: env.DB, OPENAI_API_KEY: "synthetic", GITHUB_READ_REPOSITORIES: JSON.stringify([{ id: "app", owner: "owner", repo: "app", ownerId: 123, version: 1, projectId: "github-project", authorization: { sourceId: grant.id, revision: 1 } }]) } as AssistantEnv;
    const result = await answerGitHubQuestion({ env: settings, scope, episode: row, identity: c.identity, turn, inbox, repository: "app" });
    expect(result.text).toContain("verifica o dono via OAuth"); expect(result.research.documents).toBe(1); expect(calls).toBe(2);
    expect(JSON.parse(result.checkpointJSON).documents).toBeUndefined();
    const frozen = await env.DB.prepare("SELECT body_json FROM assistant_telegram_dialogue_phases WHERE installation_id=? AND request_id=? AND phase='answer'").bind(scope.installationId, source.source.id).first<{ body_json: string }>();
    expect(JSON.parse(JSON.parse(frozen!.body_json).messages[1].content).documents[0].text).toBe(text);
  } finally { vi.unstubAllGlobals(); }
});
