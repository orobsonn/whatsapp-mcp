import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CogneeEngine, type ContainerPort, type EngineGuard, type EngineIngest, type EnginePermit, type EngineSearch, type EngineStore } from "../assistant/engine";
import { sourceTextHash } from "../assistant/sources";
import { env } from "cloudflare:test";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { CanonicalEngineGuard, DirectContainerPort, handleBrokerRequest } from "../assistant/container";
// @ts-expect-error Vite raw SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL.
import controls from "../assistant/migrations/0007_source_controls.sql?raw";
let engine: CogneeEngine, port: ContainerPort, guard: EngineGuard, store: EngineStore, data: Map<string, unknown>;
let ingest: EngineIngest, search: EngineSearch, now: number, epoch: string, revoked: string[];
let storageTail=Promise.resolve();
const scope = { installationId: "synthetic-install", generation: "g1" };
beforeEach(async () => {
  data = new Map(); storageTail=Promise.resolve(); now = 100; revoked = []; epoch = "";
  const storage=transactionalStore();
  store = { get: <T>(key: string) => storage(tx=>tx.get<T>(key)),
    put: (key, value) => storage(tx=>tx.put(key,value)),
    transaction: transactionalStore(),
    putFenced: async (key, value, epoch, owner) => {
      const run = data.get("rebuild") as { indexEpoch: string; owner: string };
      if (run?.indexEpoch !== epoch || run.owner !== owner) throw new Error("rebuild_fenced"); data.set(key, structuredClone(value));
    } };
  const fence = { ...scope, actor: "owner", source: { id: "source", revision: 1, version: 1,
    hash: await sourceTextHash("Synthetic source"), audience: "owner" as const, origin: "note", conversationId: null, projectId: null }, policy: null, identity: null, mandate: null };
  ingest = { actor: { kind: "owner" }, source: { id: "source", text: "Synthetic source", authorId: null, authorLabel: null, occurredAt: 100, fence } };
  search = { actor: ingest.actor, permits: [{ source: fence }], query: "Synthetic query", allowedSources: [{ id: "source", version: 1, hash: fence.source.hash }], limit: 2 };
  guard = { check: vi.fn(async () => true), issue: vi.fn(async () => "host-only-token"), revoke: vi.fn(async token => { revoked.push(token); }) };
  port = { running: false, start: vi.fn(async () => { Object.defineProperty(port, "running", { value: true, configurable: true }); }),
    intercept: vi.fn(async value => { epoch = value; }), deny: vi.fn(async () => {}), destroy: vi.fn(async () => { Object.defineProperty(port, "running", { value: false, configurable: true }); }),
    request: vi.fn(async (path, body) => path === "/health" ? { ready: true, poisoned: false, busy: false, cognee: "1.6.5", namespace: scope, mode: "shadow" }
      : { ok: true, result: path === "/ingest" ? { id: "source", version: 1, hash: fence.source.hash, state: "completed", chunks: 1, relations: 1, nodes: 2, edges: 1 } : { candidates: [{ ...search.allowedSources[0], via: ["chunks"], relationCount: 0 }], missing: [] } }) };
  engine = new CogneeEngine(scope, store, port, guard, () => now);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("uses a restricted immutable wire and an ephemeral receipt without leaking host permits", async () => {
  const result = await engine.ingest(ingest) as Record<string, unknown>;
  expect(result).toMatchObject({ state: "complete", indexState: "needs_checkpoint" });
  const call = vi.mocked(port.request).mock.calls.find(([path]) => path === "/ingest")!;
  expect(call[1]).toMatchObject({ operationId: expect.stringMatching(/^[a-f0-9]{64}$/), source: { id: "source", text: "Synthetic source" } });
  expect(JSON.stringify(call[1])).not.toMatch(/fence|permit|actor|owner_only|host-only-token/);
  expect(revoked).toEqual(["host-only-token"]);
  const count = vi.mocked(port.request).mock.calls.length;
  expect(await engine.ingest(ingest)).toEqual(result); expect(port.request).toHaveBeenCalledTimes(count);
});
it("rechecks authorization for each callback and the result, denying expired or previous epochs", async () => {
  vi.mocked(port.request).mockImplementation(async path => {
    if (path === "/health") return { ready: true, poisoned: false, busy: false, cognee: "1.6.5", namespace: scope, mode: "shadow" };
    expect(await engine.authorize(epoch)).toEqual({ token: "host-only-token", period: "1970-01-01" });
    expect(await engine.authorize("wrong-epoch")).toBeNull(); vi.mocked(guard.check).mockResolvedValue(false);
    expect(await engine.authorize(epoch)).toBeNull(); return { ok: true, result: {} };
  });
  expect(await engine.ingest(ingest)).toMatchObject({ state: "blocked" });
  expect(await engine.authorize(epoch)).toBeNull(); expect(port.destroy).toHaveBeenCalled();
});
it("does not start when scope, hash or source authorization is invalid", async () => {
  vi.mocked(guard.check).mockResolvedValue(false);
  expect(await engine.ingest(ingest)).toMatchObject({ state: "blocked" });
  vi.mocked(guard.check).mockResolvedValue(true); ingest.source.text = "tampered";
  expect(await engine.ingest(ingest)).toMatchObject({ state: "blocked" }); expect(port.start).not.toHaveBeenCalled();
});
it("never silently restarts an initialized index after filesystem loss", async () => {
  await engine.ingest(ingest); await port.destroy();
  const restarted = new CogneeEngine(scope, store, port, guard, () => now);
  expect(await restarted.search(search)).toMatchObject({ state: "blocked", reason: "index_lost" }); expect(port.start).toHaveBeenCalledTimes(1);
});
it("search sends only query and the authorized reference pack and rejects expanded candidates", async () => {
  await engine.ingest(ingest); expect(await engine.search(search)).toMatchObject({ state: "complete", result: { missing: [] } });
  const wire = vi.mocked(port.request).mock.calls.find(([path]) => path === "/search")![1];
  expect(Object.keys(wire as object).sort()).toEqual(["allowedSources", "limit", "operationId", "query"]);
  vi.mocked(port.request).mockResolvedValue({ ok: true, result: { candidates: [{ id: "private-other", version: 1, hash: "0".repeat(64), via: ["graph"], relationCount: 1 }], missing: [] } });
  expect(await engine.search({ ...search, query: "different" })).toMatchObject({ state: "uncertain" });
});
it("does not issue a model permit for an empty authorized search pack", async () => {
  expect(await engine.search({ ...search, allowedSources: [], permits: [] })).toMatchObject({ state: "complete", result: { candidates: [], missing: [] } });
  expect(guard.issue).not.toHaveBeenCalled(); expect(port.start).not.toHaveBeenCalled();
});
it("rejects concurrent operations while allowing the broker callback", async () => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const request = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation(async (path, body, signal) => { if (path === "/ingest") await hold; return request(path, body, signal); });
  const first = engine.ingest(ingest); await vi.waitFor(() => expect(epoch).not.toBe(""));
  expect(await engine.search(search)).toMatchObject({ state: "blocked", reason: "busy" });
  expect(await engine.authorize(epoch)).not.toBeNull(); release(); expect(await first).toMatchObject({ state: "complete" });
});
it("treats a restarted active pipeline as uncertain and destroys before another operation", async () => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); const original = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation(async (path, body, signal) => { if (path === "/ingest") await hold; return original(path, body, signal); });
  const pending = engine.ingest(ingest); await vi.waitFor(() => expect(epoch).not.toBe(""));
  const restarted = new CogneeEngine(scope, store, port, guard, () => now);
  expect(await restarted.authorize(epoch)).toBeNull();
  expect(await restarted.search(search)).toMatchObject({ state: "blocked", reason: "restart_uncertain" }); expect(port.destroy).toHaveBeenCalled();
  release(); await pending;
});
it("bounds a stalled pipeline, revokes its permit and destroys before reuse", async () => {
  vi.useFakeTimers(); const original = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation((path, body, signal) => path === "/health" ? original(path, body, signal) : new Promise(() => {}));
  const pending = engine.ingest(ingest); await vi.waitFor(() => expect(epoch).not.toBe(""), { timeout: 5000 });
  await vi.advanceTimersByTimeAsync(250001); expect(await pending).toMatchObject({ state: "uncertain" });
  expect(port.deny).toHaveBeenCalled(); expect(revoked).toEqual(["host-only-token"]); expect(port.destroy).toHaveBeenCalled();
});
it("rejects arbitrary outbound routes and excessive streamed bodies before model admission", async () => {
  const host = { authorize: vi.fn(async () => ({ token: "secret-host-token", period: "synthetic" })) }, invoke = vi.fn(async () => ({ state: "complete", body: { choices: [] } }));
  for (const url of ["https://broker.internal/v1/embeddings", "http://evil.example/v1/embeddings", "http://broker.internal/v1/embeddings?override=1", "http://broker.internal/delete"]) {
    expect((await handleBrokerRequest(new Request(url, { method: "POST", body: "{}" }), "epoch", host, () => ({ invoke }))).status).toBe(403);
  }
  const huge = new Request("http://broker.internal/v1/embeddings", { method: "POST", body: JSON.stringify({ data: "x".repeat(65536) }) });
  expect((await handleBrokerRequest(huge, "epoch", host, () => ({ invoke }))).status).toBe(403);
  expect(host.authorize).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});
it("never returns a completed model result when the active grant is revoked meanwhile", async () => {
  const host = { authorize: vi.fn().mockResolvedValueOnce({ token: "host-token", period: "synthetic" }).mockResolvedValueOnce(null) };
  const invoke = vi.fn(async () => ({ state: "complete", body: { secret: "do-not-return" } }));
  const response = await handleBrokerRequest(new Request("http://broker.internal/v1/embeddings", { method: "POST", body: "{}" }), "epoch", host, () => ({ invoke }));
  expect(response.status).toBe(403); expect(await response.text()).not.toContain("do-not-return"); expect(invoke).toHaveBeenCalledTimes(1);
});
it("starts the fixed image without internet or provider keys and waits for readiness", async () => {
  const start = vi.fn(), interceptOutboundHttp = vi.fn(async () => {}), fetch = vi.fn().mockRejectedValueOnce(new Error("not-listening")).mockResolvedValue(new Response("{}"));
  const container = { running: false, images: { cognee: "pinned-image" }, start, interceptOutboundHttp, getTcpPort: vi.fn(() => ({ fetch })), setInactivityTimeout: vi.fn(async () => {}) } as unknown as Container;
  const adapter = new DirectContainerPort(container, () => ({ fetch } as unknown as Fetcher), scope);
  await adapter.deny(); await adapter.start();
  expect(start).toHaveBeenCalledWith({ image: "pinned-image", instance: "standard-1", enableInternet: false, env: { ASSISTANT_INSTALLATION_ID: scope.installationId, ASSISTANT_GENERATION: scope.generation, ASSISTANT_CONFIGURATION_HASH: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(interceptOutboundHttp).toHaveBeenCalledWith("broker.internal", expect.anything()); expect(fetch).toHaveBeenCalledTimes(2);
});
it("a checkpoint restore fenced while its configuration hash yields never starts a replacement process", async () => {
  let owned = true, resume!: () => void;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { resume = resolve; }); return digest(...args); });
  const start = vi.fn(), fetch = vi.fn(async () => new Response("{}"));
  const container = { running: false, images: { cognee: "fixed" }, start, getTcpPort: () => ({ fetch }), setInactivityTimeout: async () => {}, interceptOutboundHttp: async () => {} } as unknown as Container;
  const adapter = new DirectContainerPort(container, () => ({ fetch } as unknown as Fetcher), scope);
  const pending = adapter.restore({ id: "existing-snapshot", size: 4096 }, async () => { if (!owned) throw new Error("checkpoint_fenced"); });
  await vi.waitFor(() => expect(resume).toBeTypeOf("function")); owned = false; resume();
  await expect(pending).rejects.toThrow("checkpoint_fenced"); expect(start).not.toHaveBeenCalled();
  expect(hashing).toHaveBeenCalledTimes(1);
});
it("a checkpoint destroy must confirm the process stopped before any restore", async () => {
  const container = { running: true, destroy: vi.fn(async () => {}) } as unknown as Container;
  const adapter = new DirectContainerPort(container, () => ({} as Fetcher), scope);
  await expect(adapter.destroy(async () => {})).rejects.toThrow("checkpoint_destroy_uncertain");
});
it("checks real canonical ACL and source correction before granting the host capability", async () => {
  for (const sql of [sources, controls]) {
    await env.DB.batch(sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
  }
  const ns = { installationId: crypto.randomUUID(), generation: "g1" }, owner = new SourceController(env.DB, ns, { kind: "owner" });
  const created = await owner.create({ originKey: "note", text: "Synthetic canonical", occurredAt: 100 });
  const read = (await new SourceAccess(env.DB, ns).read({ kind: "owner" }, created.id))!;
  const canonical = new CanonicalEngineGuard({ DB: env.DB, INSTALLATION_ID: ns.installationId, OPERATIONAL_GENERATION: ns.generation, OPENAI_API_KEY: "synthetic-not-real" });
  expect(await canonical.check({ kind: "owner" }, [{ source: read.fence }])).toBe(true);
  expect(await canonical.check({ kind: "interlocutor", provider: "synthetic", address: "other", conversationId: "chat", conversationKind: "private", action: "reply_text" }, [{ source: read.fence }])).toBe(false);
  await owner.correct(created.id, 1, { text: "Changed", occurredAt: 100 }); expect(await canonical.check({ kind: "owner" }, [{ source: read.fence }])).toBe(false);
});
it("fails closed if the cold process has a different namespace or poisoned index", async () => {
  vi.mocked(port.request).mockResolvedValue({ ready: true, poisoned: false, namespace: { ...scope, generation: "wrong" } });
  expect(await engine.ingest(ingest)).toMatchObject({ state: "uncertain" }); expect(port.destroy).toHaveBeenCalled(); expect(guard.issue).not.toHaveBeenCalled();
});
it.each(["deny", "revoke", "destroy"] as const)("quarantines uncertain work even when %s fails during cleanup", async fault => {
  const original = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation(async (path, body, signal) => {
    if (path !== "/ingest") return original(path, body, signal);
    if (fault === "revoke") vi.mocked(guard.revoke).mockRejectedValue(new Error("synthetic revoke failure"));
    else vi.mocked(port[fault]).mockRejectedValue(new Error("synthetic cleanup failure"));
    return { ok: false };
  });
  expect(await engine.ingest(ingest)).toMatchObject({ state: "uncertain" });
  expect(port.destroy).toHaveBeenCalled(); expect(await engine.authorize(epoch)).toBeNull();
  const count = vi.mocked(port.intercept).mock.calls.length;
  expect(await new CogneeEngine(scope, store, port, guard, () => now).search(search)).toMatchObject({ state: "blocked" });
  expect(port.intercept).toHaveBeenCalledTimes(count);
});
it("invalidates the active epoch before awaiting cleanup", async () => {
  const original = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation(async (path, body, signal) => {
    if (path !== "/ingest") return original(path, body, signal);
    vi.mocked(port.deny).mockImplementation(async () => { expect(await engine.authorize(epoch)).toBeNull(); }); return { ok: false };
  });
  expect(await engine.ingest(ingest)).toMatchObject({ state: "uncertain" }); expect(port.destroy).toHaveBeenCalled();
});
it("rejects Python-incompatible metadata before touching an existing index", async () => {
  await engine.ingest(ingest); const starts = vi.mocked(port.start).mock.calls.length;
  expect(await engine.ingest({ ...ingest, source: { ...ingest.source, authorId: "á" } })).toMatchObject({ state: "blocked" });
  expect(port.destroy).not.toHaveBeenCalled(); expect(port.start).toHaveBeenCalledTimes(starts);
});
it("owns only namespace keys when the host config object contains bindings", async () => {
  engine = new CogneeEngine({ ...scope, db: { syntheticBinding: true } } as typeof scope, store, port, guard, () => now);
  expect(await engine.ingest(ingest)).toMatchObject({ state: "complete" });
});
it("rechecks access after persistence and after reading a cached result", async () => {
  const put = store.put; store.put = async (key, value) => { await put(key, value); if (key.startsWith("receipt:")) vi.mocked(guard.check).mockResolvedValue(false); };
  expect(await engine.ingest(ingest)).toMatchObject({ state: "blocked" });
});
it("keeps a completed receipt after its persistence acknowledgement is lost without re-executing", async () => {
  const put = store.put; store.put = async (key, value) => { await put(key, value); if (key.startsWith("receipt:")) throw new Error("synthetic ACK lost"); };
  const result = await engine.ingest(ingest) as { operationId: string };
  expect(result).toMatchObject({ state: "uncertain" }); expect(await engine.lookup(result.operationId)).toMatchObject({ state: "complete" });
  expect(await engine.ingest(ingest)).toMatchObject({ state: "blocked" });
  expect(vi.mocked(port.request).mock.calls.filter(([path]) => path === "/ingest")).toHaveLength(1);
  vi.mocked(guard.check).mockResolvedValue(false); expect(await engine.lookup(result.operationId)).toEqual({ state: "uncertain" });
});
it("rechecks a cached receipt after the storage read yields", async () => {
  await engine.ingest(ingest); const get = store.get;
  store.get = async <T>(key: string) => { const value = await get<T>(key); if (key.startsWith("receipt:")) vi.mocked(guard.check).mockResolvedValue(false); return value; };
  expect(await engine.ingest(ingest)).toMatchObject({ state: "blocked" });
});
it("excludes inference during checkpoint maintenance and records confirmed index state", async () => {
  await engine.ingest(ingest);
  const result = await engine.maintain(async plan => {
    expect(plan?.sources).toEqual([{ id: "source", revision: 1, version: 1, hash: ingest.source.fence.source.hash }]);
    expect(await engine.search(search)).toMatchObject({ state: "blocked", reason: "busy" });
    expect(await engine.authorize(epoch)).toBeNull();
    data.set("checkpoint", { phase: "confirmed", confirmed: { manifest: plan } });
    data.set("index", { ...(data.get("index") as object), indexState: "checkpoint_confirmed" });
    data.set("maintenance", false); data.set("quarantine", false);
    return { value: { state: "checkpoint_confirmed" }, restored: plan! };
  });
  expect(result).toMatchObject({ state: "checkpoint_confirmed" });
  expect(await engine.search(search)).toMatchObject({ state: "complete", indexState: "checkpoint_confirmed" });
});
it("an old maintenance callback cannot publish its restored index over a replacement epoch", async () => {
  await engine.ingest(ingest); const original = structuredClone(data.get("index")) as Record<string, unknown>;
  const replacement = { ...original, epoch: "replacement-epoch", revision: "replacement-revision", lost: true };
  const result = await engine.maintain(async plan => {
    data.set("index", replacement); data.set("checkpoint", { revision: 99, owner: "replacement-owner", phase: "restoring" });
    data.set("maintenance", true); data.set("quarantine", true);
    return { value: { state: "checkpoint_confirmed" }, restored: plan! };
  });
  expect(result).toMatchObject({ state: "uncertain" });
  expect(data.get("index")).toEqual(replacement); expect(data.get("maintenance")).toBe(true); expect(data.get("quarantine")).toBe(true);
});
it("a timed-out checkpoint destroy keeps lifecycle exclusion until the underlying operation settles", async () => {
  await engine.ingest(ingest); vi.useFakeTimers(); let finish!: () => void;
  vi.mocked(port.destroy).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = engine.maintain(async () => {
    data.set("maintenance", true);
    await Promise.race([engine.checkpointEffect(() => port.destroy()), new Promise(resolve => setTimeout(resolve, 10))]);
    return { value: { state: "uncertain" } };
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await vi.advanceTimersByTimeAsync(11);
  expect(await result).toEqual({ state: "uncertain" });
  expect(await engine.search(search)).toMatchObject({ state: "blocked", reason: "busy" });
  expect(await engine.rebuildExclusive(async () => "unexpected")).toMatchObject({ state: "blocked", reason: "busy" });
  expect(await engine.maintain(async () => ({ value: "unexpected" }), true)).toMatchObject({ state: "blocked", reason: "busy" });
  finish(); await vi.waitFor(async () => expect(await engine.search(search)).toMatchObject({ state: "blocked", reason: "checkpoint_pending" }));
});
it("recovers a lost index only through explicit validated maintenance", async () => {
  await engine.ingest(ingest); const meta = data.get("index") as { epoch: string; revision: string };
  await port.destroy();
  expect(await engine.maintain(async () => { throw 0; })).toMatchObject({ state: "rebuild_required" });
  expect(await engine.maintain(async () => {
    Object.defineProperty(port, "running", { value: true, configurable: true });
    const restored = { indexEpoch: meta.epoch, indexRevision: meta.revision, sources: [{ id: "source", revision: 1, version: 1, hash: ingest.source.fence.source.hash }] };
    data.set("checkpoint", { phase: "confirmed", confirmed: { manifest: restored } });
    data.set("index", { ...(data.get("index") as object), indexState: "checkpoint_confirmed" });
    data.set("maintenance", false); data.set("quarantine", false);
    return { value: { state: "checkpoint_confirmed" }, restored };
  }, true)).toMatchObject({ state: "checkpoint_confirmed" });
  expect(await engine.search(search)).toMatchObject({ state: "complete", indexState: "checkpoint_confirmed" });
  expect(vi.mocked(port.request).mock.calls.filter(([path]) => path === "/ingest")).toHaveLength(1);
});
it("materializes an existing logical ingestion again in a fresh epoch using replay-only grants", async () => {
  const first = await engine.ingest(ingest) as { operationId: string };
  const old = data.get("index") as { epoch: string };
  const fresh = { ...old, epoch: "rebuild-epoch", revision: "empty", sources: [], lost: true, indexState: "needs_checkpoint" };
  data.set("index", fresh); data.set("maintenance", true);
  data.set("rebuild", { phase: "materializing", indexEpoch: "rebuild-epoch", owner: "synthetic-owner", next: 0, sources: [{ id: "source", revision: 1, version: 1, hash: ingest.source.fence.source.hash }] });
  const original = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation(async (path, body, signal) => {
    if (path === "/ingest") expect(await engine.authorize(epoch)).toMatchObject({ mode: "replay_only" });
    return original(path, body, signal);
  });
  const rebuilt = await engine.rebuildExclusive(async () => {
    await engine.destroyForRebuild(async () => true); await engine.freshForRebuild("rebuild-epoch", "synthetic-owner", async () => true);
    return engine.ingestForRebuild(ingest, "rebuild-epoch", "synthetic-owner");
  }) as { operationId: string };
  expect(rebuilt).toMatchObject({ state: "complete" }); expect(rebuilt.operationId).not.toBe(first.operationId);
  expect(vi.mocked(port.request).mock.calls.filter(([path]) => path === "/ingest")).toHaveLength(2);
  expect(await engine.search(search)).toMatchObject({ state: "blocked", reason: "checkpoint_pending" });
  expect(await engine.lookup(first.operationId)).toMatchObject({ state: "uncertain" });
});
it("never starts a replacement when destruction of the preceding process is unconfirmed", async () => {
  await engine.ingest(ingest); vi.mocked(port.destroy).mockRejectedValue(new Error("destroy uncertain"));
  expect(await engine.rebuildExclusive(async () => { await engine.destroyForRebuild(async () => true); await engine.freshForRebuild("fresh", "owner", async () => true); })).toMatchObject({ state: "uncertain" });
  expect(port.start).toHaveBeenCalledTimes(1); expect(await engine.authorize(epoch)).toBeNull();
});
it("uses host-only replay mode and cannot fall back to paid invocation on cache miss", async () => {
  const host = { authorize: vi.fn(async () => ({ token: "host-token", period: "synthetic", mode: "replay_only" as const })) };
  const invoke = vi.fn(async () => ({ state: "complete", body: {} })), replay = vi.fn(async () => ({ state: "blocked" }));
  const response = await handleBrokerRequest(new Request("http://broker.internal/v1/chat/completions", { method: "POST", body: JSON.stringify({ mode: "paid" }) }), "epoch", host, () => ({ invoke, replay }));
  expect(response.status).toBe(403); expect(replay).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
});
it("does not write or destroy the replacement index when an old rebuild response resumes after ownership changed", async () => {
  await engine.ingest(ingest); const previous = data.get("index") as Record<string, unknown>;
  data.set("index", { ...previous, epoch: "rebuild-epoch", revision: "empty", sources: [], lost: true }); data.set("maintenance", true);
  data.set("rebuild", { phase: "materializing", indexEpoch: "rebuild-epoch", owner: "old-owner", next: 0, sources: [{ id: "source", revision: 1, version: 1, hash: ingest.source.fence.source.hash }] });
  const original = vi.mocked(port.request).getMockImplementation()!;
  vi.mocked(port.request).mockImplementation(async (path, body, signal) => {
    if (path === "/ingest") { data.set("rebuild", { ...(data.get("rebuild") as object), owner: "new-owner" }); data.set("index", { ...previous, epoch: "replacement-epoch", revision: "empty", sources: [] }); }
    return original(path, body, signal);
  });
  const result = await engine.rebuildExclusive(async () => {
    await engine.destroyForRebuild(async () => true); await engine.freshForRebuild("rebuild-epoch", "old-owner", async () => true);
    return engine.ingestForRebuild(ingest, "rebuild-epoch", "old-owner");
  });
  expect(result).toMatchObject({ state: "blocked" }); expect(data.get("index")).toMatchObject({ epoch: "replacement-epoch", sources: [] });
  expect(port.destroy).toHaveBeenCalledTimes(1);
});

// Faithful serializable adapter: isolated copy, commit on success, rollback on throw.
function transactionalStore(): NonNullable<EngineStore["transaction"]> {
  return async operation=>{
    const previous=storageTail;let release!:()=>void;storageTail=new Promise(resolve=>{release=resolve;});await previous;
    const snapshot=new Map(structuredClone([...data]));
    try {const result=await operation({get:async <T>(key:string)=>structuredClone(snapshot.get(key)) as T|undefined,put:async(key,value)=>{snapshot.set(key,structuredClone(value));},list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map(structuredClone([...snapshot].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit))) as Map<string,T>});data.clear();for(const [key,value]of snapshot)data.set(key,value);return result;} finally {release();}
  };
}
it("prepares a persistent alias without wake or permit, then submits once across restart and ACK loss", async () => {
  await engine.ingest(ingest);
  store.transaction = transactionalStore();
  vi.mocked(port.request).mockClear(); vi.mocked(port.start).mockClear(); vi.mocked(guard.issue).mockClear();
  const prepared = await engine.prepare("retrieval-run", search);
  expect(prepared.state).toBe("prepared");
  expect(port.request).not.toHaveBeenCalled(); expect(port.start).not.toHaveBeenCalled(); expect(guard.issue).not.toHaveBeenCalled();
  const restarted = new CogneeEngine(scope, store, port, guard, () => now);
  expect(await restarted.prepare("retrieval-run", search)).toEqual(prepared);
  expect(await restarted.prepare("retrieval-run", { ...search, query: "conflict" })).toMatchObject({ state: "blocked", reason: "ticket_conflict" });
  if (prepared.state !== "prepared") throw new Error("ticket missing");
  const results = await Promise.all([engine.submit(prepared.ticket), restarted.submit(prepared.ticket)]);
  expect(results.some(result => result.state === "complete")).toBe(true);
  expect(vi.mocked(port.request).mock.calls.filter(([path]) => path === "/search")).toHaveLength(1);
  expect((await restarted.lookupTicket(prepared.ticket)).state).toBe("complete");
  await restarted.submit(prepared.ticket);
  expect(vi.mocked(port.request).mock.calls.filter(([path]) => path === "/search")).toHaveLength(1);
});
it("blocks a prepared ticket on index mutation without rekey or search", async () => {
  await engine.ingest(ingest); store.transaction = transactionalStore();
  const prepared = await engine.prepare("index-fixed", search);
  if (prepared.state !== "prepared") throw new Error("ticket missing");
  data.set("index", { ...(data.get("index") as object), revision: "a".repeat(64) });
  vi.mocked(port.request).mockClear();
  expect(await engine.submit(prepared.ticket)).toMatchObject({ state: "blocked", reason: "index_changed" });
  expect(port.request).not.toHaveBeenCalled();
});

it("keeps a cold submit prepared without wake, permit or search, then admits the same ticket once warm",async()=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();const prepared=await engine.prepare("cold",search);
  if(prepared.state!=="prepared")throw new Error("ticket missing");
  await port.destroy();vi.mocked(port.request).mockClear();vi.mocked(port.start).mockClear();vi.mocked(guard.issue).mockClear();
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked"});
  expect(await engine.lookupTicket(prepared.ticket)).toMatchObject({state:"uncertain",reason:"not_submitted"});
  expect(port.request).not.toHaveBeenCalled();expect(port.start).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
  Object.defineProperty(port,"running",{value:true,configurable:true});
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"complete"});
  expect(vi.mocked(port.request).mock.calls.filter(([path])=>path==="/search")).toHaveLength(1);
});
it("owns exclusion before the first preflight await until search finishes",async()=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();const prepared=await engine.prepare("lock",search);
  if(prepared.state!=="prepared")throw new Error("ticket missing");
  const get=store.get;let entered!:()=>void,release!:()=>void,held=true;const waiting=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  store.get=async<T>(key:string)=>{if(held&&key.startsWith("search-ticket:")){held=false;entered();await hold;}return get<T>(key);};
  const pending=engine.submit(prepared.ticket);await waiting;
  expect(await engine.maintain(async()=>{throw new Error("must not enter");})).toMatchObject({state:"blocked",reason:"busy"});
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked",reason:"busy"});
  expect(await engine.search(search)).toMatchObject({state:"blocked",reason:"busy"});
  release();expect(await pending).toMatchObject({state:"complete"});
});
it.each(["maintenance","quarantine","active","cold"])("revalidates %s at the final submit CAS without spending the ticket",async gate=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();const prepared=await engine.prepare("last-gate",search);
  if(prepared.state!=="prepared")throw new Error("ticket missing");
  const transaction=store.transaction;store.transaction=async operation=>{
    if(gate==="cold")Object.defineProperty(port,"running",{value:false,configurable:true});
    else data.set(gate,gate==="active"?{epoch:"other",token:"other"}:true);
    return transaction!(operation);
  };
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked"});
  expect([...data].filter(([key])=>key.startsWith("search-ticket:")).map(([,value])=>(value as {state:string}).state)).toEqual(["prepared"]);
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
});

it("retains submit ownership after deadline until the physical search promise settles",async()=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();const prepared=await engine.prepare("late-physical",search);
  if(prepared.state!=="prepared")throw new Error("ticket missing");
  let release!:()=>void,entered=false;const hold=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(port.request).mockImplementation(async path=>{if(path!=="/search")throw new Error("unexpected path");entered=true;await hold;return {ok:false};});
  vi.useFakeTimers();const pending=engine.submit(prepared.ticket);
  await vi.waitFor(()=>expect(entered).toBe(true),{timeout:5000});
  await vi.advanceTimersByTimeAsync(250001);expect(await pending).toMatchObject({state:"uncertain"});
  expect(await engine.maintain(async()=>{throw new Error("must not enter");},true)).toMatchObject({state:"blocked",reason:"busy"});
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked",reason:"busy"});
  release();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked",reason:"index_changed"});
});

it("owns a canonical ticket identity regardless of caller property order",async()=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();const prepared=await engine.prepare("canonical-ticket",search);
  if(prepared.state!=="prepared")throw new Error("ticket missing");
  const reordered=Object.fromEntries(Object.entries(prepared.ticket).reverse()) as typeof prepared.ticket;
  expect(await engine.submit(reordered)).toMatchObject({state:"complete",operationId:prepared.ticket.operationId});
});

it("never admits another alias for an operation with a legacy attempting ticket and no receipt",async()=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();
  const first=await engine.prepare("legacy-attempt",search),second=await engine.prepare("original-prepare-refusal",search);
  if(first.state!=="prepared"||second.state!=="prepared")throw new Error("ticket missing");
  expect(first.ticket.operationId).toBe(second.ticket.operationId);
  for(const [key,row]of data)if(key.startsWith("search-ticket:")&&(row as {ticket:{alias:string}}).ticket.alias==="legacy-attempt")data.set(key,{...(row as object),state:"attempting"});
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  const restarted=new CogneeEngine(scope,store,port,guard,()=>now);
  expect(await restarted.submit(second.ticket)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain",operationId:first.ticket.operationId});
  expect(await restarted.lookupTicket(second.ticket)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
  expect([...data].filter(([key])=>key.startsWith("search-ticket:")).map(([,row])=>(row as {state:string}).state).sort()).toEqual(["attempting","prepared"]);
});

it("does not bypass a legacy ticket's uncertainty through the direct search API after exact index restore",async()=>{
  await engine.ingest(ingest);store.transaction=transactionalStore();
  const first=await engine.prepare("legacy-direct",search);if(first.state!=="prepared")throw new Error("ticket missing");
  for(const [key,row]of data)if(key.startsWith("search-ticket:"))data.set(key,{...(row as object),state:"attempting"});
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  const restarted=new CogneeEngine(scope,store,port,guard,()=>now);
  expect(await restarted.search(search)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain",operationId:first.ticket.operationId});
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
});

it("migrates an old direct operation without a receipt before admitting another search",async()=>{
  await engine.ingest(ingest);const prepared=await engine.prepare("old-direct-access",search);if(prepared.state!=="prepared")throw new Error("ticket missing");
  data.set("access:"+prepared.ticket.operationId,{actor:search.actor,permits:search.permits});
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  expect(await engine.search(search)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect(data.get("search-operation:"+prepared.ticket.operationId)).toMatchObject({alias:null,requestHash:null});
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
});

it("claims one shared operation across different aliases before the first model permit await",async()=>{
  await engine.ingest(ingest);const first=await engine.prepare("first-alias",search),second=await engine.prepare("second-alias",search);
  if(first.state!=="prepared"||second.state!=="prepared")throw new Error("ticket missing");
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(guard.issue).mockImplementationOnce(async()=>{entered();await held;return "host-only-token";});
  const active=engine.submit(first.ticket);await waiting;
  const restarted=new CogneeEngine(scope,store,port,guard,()=>now);
  expect(await restarted.submit(second.ticket)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect(guard.issue).toHaveBeenCalledTimes(1);expect(port.request).not.toHaveBeenCalled();
  release();expect(await active).toMatchObject({state:"complete"});
  expect(await restarted.lookupTicket(second.ticket)).toMatchObject({state:"complete",operationId:first.ticket.operationId});
  expect(await restarted.submit(second.ticket)).toMatchObject({state:"complete"});
  expect(vi.mocked(port.request).mock.calls.filter(([path])=>path==="/search")).toHaveLength(1);expect(guard.issue).toHaveBeenCalledTimes(1);
});

it("preserves both operation and alias admission after a lost transaction ACK without another effect",async()=>{
  await engine.ingest(ingest);const first=await engine.prepare("lost-claim-ack",search),second=await engine.prepare("other-after-lost-ack",search);
  if(first.state!=="prepared"||second.state!=="prepared")throw new Error("ticket missing");
  const transaction=store.transaction!;let lost=false;
  store.transaction=async operation=>{const result=await transaction(operation);if(!lost){lost=true;throw new Error("commit ACK lost");}return result;};
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  await expect(engine.submit(first.ticket)).rejects.toThrow("commit ACK lost");
  const restarted=new CogneeEngine(scope,store,port,guard,()=>now);
  expect(await restarted.submit(second.ticket)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect(await restarted.lookupTicket(first.ticket)).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
});

it.each(["capacity","missing_inventory","invalid_seal"])("fails closed on %s before search admission",async kind=>{
  await engine.ingest(ingest);const prepared=await engine.prepare("history-guard",search);if(prepared.state!=="prepared")throw new Error("ticket missing");
  if(kind==="capacity")for(let i=0;i<257;i++)data.set("search-ticket:legacy-"+i,{ticket:{...prepared.ticket,alias:"legacy-"+i},state:"prepared"});
  if(kind==="invalid_seal")data.set("search-operation-history-v1",{version:1,untrusted:true});
  if(kind==="missing_inventory"){const transaction=store.transaction!;store.transaction=operation=>transaction(({list:_,...tx})=>operation(tx));}
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked",reason:kind==="capacity"?"operation_history_capacity":kind==="invalid_seal"?"operation_history_invalid":"operation_history_unavailable"});
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
  expect(data.has("search-operation:"+prepared.ticket.operationId)).toBe(false);
});

it("seals legacy inventory once and does not impose its migration limit on future aliases",async()=>{
  await engine.ingest(ingest);expect(await engine.search(search)).toMatchObject({state:"complete"});
  expect(data.get("search-operation-history-v1")).toEqual({version:1});
  for(let i=0;i<257;i++)data.set("search-ticket:future-"+i,{malformed:"must not rescan sealed migration"});
  const before=vi.mocked(port.request).mock.calls.length;
  expect(await engine.search({...search,query:"A legitimate new query"})).toMatchObject({state:"complete"});
  expect(port.request).toHaveBeenCalledTimes(before+1);
});

it("rechecks source authorization after legacy metadata inventory before any permit or query leaves",async()=>{
  await engine.ingest(ingest);const transaction=store.transaction!;
  store.transaction=operation=>transaction(tx=>operation({...tx,list:async<T>(options:{prefix:string;limit:number})=>{const rows=await tx.list!<T>(options);vi.mocked(guard.check).mockResolvedValue(false);return rows;}}));
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  expect(await engine.search(search)).toMatchObject({state:"blocked",reason:"source_denied"});
  expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
});

it.each([null,false,0])("never overwrites an existing falsy operation marker %s or reports it not submitted",async value=>{
  await engine.ingest(ingest);const prepared=await engine.prepare("invalid-operation-marker",search);if(prepared.state!=="prepared")throw new Error("ticket missing");
  const key="search-operation:"+prepared.ticket.operationId;data.set(key,value);
  vi.mocked(port.request).mockClear();vi.mocked(guard.issue).mockClear();
  expect(await engine.lookupTicket(prepared.ticket)).toMatchObject({state:"blocked",reason:"operation_history_invalid"});
  expect(await engine.submit(prepared.ticket)).toMatchObject({state:"blocked",reason:"operation_history_invalid"});
  expect(await engine.search(search)).toMatchObject({state:"blocked",reason:"operation_history_invalid"});
  expect(data.get(key)).toBe(value);expect(port.request).not.toHaveBeenCalled();expect(guard.issue).not.toHaveBeenCalled();
});
