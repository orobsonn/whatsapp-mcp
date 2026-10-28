import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { runtimeHost, resolveRuntimeEpisode } from "../assistant/agent-runtime/runtime";
import type { AssistantEnv } from "../assistant/env";
import { RetrievalRuns } from "../assistant/retrieval-runs";
import type { EngineSearch, SearchTicket, SemanticEnginePort } from "../assistant/engine";
import { SourceController } from "../assistant/sources";
import { JobQueue } from "../assistant/queue";
import { InferenceBudget } from "../assistant/budget";
import { DecisionJournal } from "../assistant/decisions";
import { bridgeHash } from "../assistant/ingress";
import { engineName } from "../assistant/container";
import { hostConfiguredSearch } from "../assistant/configured-search";

const owner = { kind: "owner" } as const;
afterEach(() => vi.restoreAllMocks());

test("host configuration requires a binding for explicit semantic modes and preserves unconfigured lexical fixtures", () => {
  const settings: AssistantEnv = { DB: env.DB, INSTALLATION_ID: "configured-search", OPERATIONAL_GENERATION: "g1" };
  expect(hostConfiguredSearch(settings, "owner_read").semantic).toBeUndefined();
  for (const mode of ["required", "lexical_fallback"]) expect(() => hostConfiguredSearch({ ...settings, SEMANTIC_SEARCH_MODE: mode }, "owner_read")).toThrow("semantic_unconfigured");
  for (const mode of ["", "fallback", "REQUIRED"]) expect(() => hostConfiguredSearch({ ...settings, SEMANTIC_SEARCH_MODE: mode }, "owner_read")).toThrow("semantic_configuration");
  const engine = {} as SemanticEnginePort, namespace = { idFromName: vi.fn(() => ({ toString: () => "nominal-id" })), get: vi.fn(() => engine) } as unknown as NonNullable<AssistantEnv["COGNEE"]>;
  expect(hostConfiguredSearch({ ...settings, COGNEE: namespace }, "automation").semantic).toEqual({ mode: "required", engine });
  expect(hostConfiguredSearch({ ...settings, COGNEE: namespace, SEMANTIC_SEARCH_MODE: "lexical_fallback" }, "automation").semantic).toEqual({ mode: "lexical_fallback", engine });
  expect(namespace.idFromName).toHaveBeenCalledWith(engineName(settings.INSTALLATION_ID!, settings.OPERATIONAL_GENERATION!));
  expect(() => hostConfiguredSearch({ ...settings, DB: undefined }, "automation")).toThrow("search_unconfigured");
});

test("runtime resolution preserves a persisted semantic ranking through the model callback and mandatory journal", async () => {
  const now = Date.now(), scope = { installationId: crypto.randomUUID(), generation: "runtime-semantic" };
  const source = await new SourceController(env.DB, scope, owner).create({ originKey: "runtime-note", text: "Breno cuida das faturas.", occurredAt: now });
  let input!: EngineSearch, ticket!: SearchTicket, submitted = false;
  const outcome = () => ({ state: "complete" as const, operationId: ticket.operationId, indexRevision: ticket.indexRevision, indexState: "checkpoint_confirmed" as const,
    result: { candidates: input.allowedSources.map(ref => ({ ...ref, via: ["chunks"], relationCount: 0 })), missing: [] } });
  const engine: SemanticEnginePort = {
    prepare: vi.fn<SemanticEnginePort["prepare"]>(async (alias, request) => {
      input = request; ticket = { alias, requestHash: await bridgeHash(request), operationId: "a".repeat(64), indexEpoch: "test-index", indexRevision: "b".repeat(64) };
      return { state: "prepared", ticket };
    }),
    submit: vi.fn(async () => { submitted = true; return outcome(); }),
    lookupTicket: vi.fn<SemanticEnginePort["lookupTicket"]>(async () => submitted ? outcome() : { state: "uncertain", reason: "not_submitted", operationId: ticket.operationId }),
  };
  const namespace = { idFromName: vi.fn((name: string) => ({ toString: () => name })), get: vi.fn(() => engine) } as unknown as NonNullable<AssistantEnv["COGNEE"]>;
  const settings: AssistantEnv = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation,
    FLUE_EPISODES_ENABLED: "shadow", OPENAI_API_KEY: "synthetic-openai-secret", COGNEE: namespace };
  const search = new RetrievalRuns(env.DB, scope, { purpose: "owner_read", semantic: { mode: "required", engine } });
  let progress = await search.start(owner, "runtime-search", { query: "Quem responde pela cobrança?" });
  for (let step = 0; progress.state === "pending" && step < 10; step++) progress = await search.step(owner, { runId: progress.runId, stepId: "step-" + step, expectedCheckpoint: progress.checkpoint });
  await search.advanceSemantic(owner, progress.runId);
  const found = await search.result(owner, progress.runId);
  expect(found).toMatchObject({ state: "ready", fence: { ranking: { engine: "complete" } } });
  const job = await new JobQueue(env.DB, scope).enqueue({ kind: "reasoning", dedupeKey: "runtime-semantic", sourceId: source.id, sourceRevision: 1,
    request: "Quem responde pela cobrança?", runtime: "flue", subject: { kind: "owner_request", sourceId: source.id, sourceRevision: 1, requestKey: "runtime-semantic" } }, Date.now());
  const lease = (await new JobQueue(env.DB, scope).claim(Date.now(), 90000))!;
  await new InferenceBudget(env.DB, { ...scope, period: new Date().toISOString().slice(0, 10) }).configure(100000);
  // The adapter owns fetch at factory construction, so install the synthetic
  // transport before creating either preparation or callback hosts.
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(url).toBe("https://api.openai.com/v1/chat/completions"); expect(options?.method).toBe("POST");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ decision: "proposed", text: "Breno cuida das faturas.", citations: [{
      id: source.id, revision: 1, version: 1, hash: found.sources[0].fence.source.hash, quote: "Breno cuida das faturas.",
    }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  });
  const host = runtimeHost(settings, "owner_read"), episode = await host.prepare(lease, "owner", progress.runId);
  const native = { submissionId: "semantic-submission", uid: "semantic-uid", acceptedAt: new Date().toISOString() };
  await host.episodes.dispatch(episode.id);
  await host.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt: native });
  const identity = { profile: "owner", runtimeId: episode.runtime_id, submissionId: native.submissionId };
  const callback = await resolveRuntimeEpisode(settings as Record<string, unknown>, identity);
  expect(callback.episodeId).toBe(episode.id);
  const payload = { messages: [{ role: "user" as const, content: host.message(episode) }] };
  const text = await callback.host.model(callback.episodeId, identity, payload);
  expect(await callback.host.model(callback.episodeId, identity, payload)).toBe(text);
  const published = await callback.host.publish(callback.episodeId, { ...native, text, data: {} });
  expect(published).toMatchObject({ state: "shadow_completed", decisionId: expect.any(String) });
  const diary = new DecisionJournal(env.DB, scope, owner, { search });
  expect(await diary.get(published.decisionId!)).toMatchObject({ freshness: "current", jobId: job.id, proposal: { text: "Breno cuida das faturas." } });
  expect(engine.prepare).toHaveBeenCalledTimes(1); expect(engine.submit).toHaveBeenCalledTimes(1); expect(network).toHaveBeenCalledTimes(1);
  expect(namespace.idFromName).toHaveBeenCalledWith(engineName(scope.installationId, scope.generation));
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("n")).toBe(1);
});
