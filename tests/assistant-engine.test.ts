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
const scope = { installationId: "synthetic-install", generation: "g1" };
beforeEach(async () => {
  data = new Map(); now = 100; revoked = []; epoch = "";
  store = { get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => { data.set(key, structuredClone(value)); } };
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
    expect(await engine.authorize(epoch)).toBeNull(); return { value: { state: "checkpoint_confirmed" }, restored: plan! };
  });
  expect(result).toMatchObject({ state: "checkpoint_confirmed" });
  expect(await engine.search(search)).toMatchObject({ state: "complete", indexState: "checkpoint_confirmed" });
});
it("recovers a lost index only through explicit validated maintenance", async () => {
  await engine.ingest(ingest); const meta = data.get("index") as { epoch: string; revision: string };
  await port.destroy();
  expect(await engine.maintain(async () => { throw 0; })).toMatchObject({ state: "rebuild_required" });
  expect(await engine.maintain(async () => {
    Object.defineProperty(port, "running", { value: true, configurable: true });
    return { value: { state: "checkpoint_confirmed" }, restored: { indexEpoch: meta.epoch, indexRevision: meta.revision,
      sources: [{ id: "source", revision: 1, version: 1, hash: ingest.source.fence.source.hash }] } };
  }, true)).toMatchObject({ state: "checkpoint_confirmed" });
  expect(await engine.search(search)).toMatchObject({ state: "complete", indexState: "checkpoint_confirmed" });
  expect(vi.mocked(port.request).mock.calls.filter(([path]) => path === "/ingest")).toHaveLength(1);
});
