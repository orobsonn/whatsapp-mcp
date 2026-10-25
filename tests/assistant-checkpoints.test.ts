import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CheckpointController, type CheckpointIdentity, type CheckpointManifest, type CheckpointPlan, type CheckpointPort,
  type CheckpointState, type CheckpointStore, type IndexProof } from "../assistant/checkpoints";
import { bridgeHash } from "../assistant/ingress";
let identity: CheckpointIdentity, plan: CheckpointPlan, proof: IndexProof, state: CheckpointState | null;
let store: CheckpointStore, port: CheckpointPort, current: ReturnType<typeof vi.fn<(manifest: CheckpointManifest) => Promise<boolean>>>;
let controller: CheckpointController, now: number, calls: string[];
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
beforeEach(async () => {
  now = 100; state = null; calls = [];
  identity = { installationId: "synthetic-install", generation: "g1", imageRef: "image@sha256:synthetic", buildFingerprint: "b".repeat(64), configurationHash: "c".repeat(64), engineVersion: "1.6.5" };
  plan = { indexEpoch: "index-1", indexRevision: "d".repeat(64), sources: [{ id: "source", revision: 1, version: 1, hash: "a".repeat(64) }] };
  proof = { installationId: identity.installationId, generation: identity.generation, buildFingerprint: identity.buildFingerprint,
    configurationHash: identity.configurationHash, engineVersion: identity.engineVersion, indexEpoch: plan.indexEpoch, indexRevision: plan.indexRevision,
    manifestHash: await bridgeHash(canonical({ ...plan, identity })), closed: true, poisoned: false, pendingOperations: 0,
    sources: plan.sources.map(({ id, version, hash }) => ({ id, version, hash, originalHash: hash, chunks: 1 })) };
  store = { read: async () => structuredClone(state), compareAndSet: vi.fn(async (revision, next) => {
    if ((state?.revision ?? null) !== revision) return false; state = structuredClone(next); return true;
  }) };
  port = { deny: vi.fn(async () => { calls.push("deny"); }), quiesce: vi.fn(async () => { calls.push("quiesce"); return structuredClone(proof); }),
    snapshot: vi.fn(async () => { calls.push("snapshot"); return { id: "snapshot-one", size: 4096 }; }), destroy: vi.fn(async () => { calls.push("destroy"); }),
    restore: vi.fn(async () => { calls.push("restore"); }), inspect: vi.fn(async () => { calls.push("inspect"); return { ...structuredClone(proof), closed: false }; }) };
  current = vi.fn(async () => true); controller = new CheckpointController(identity, store, port, current, () => now);
});
afterEach(() => vi.useRealTimers());
it("confirms only after quiesce, durable handle and a validated fresh restore", async () => {
  const result = await controller.create(plan);
  expect(result).toMatchObject({ state: "checkpoint_confirmed", indexRevision: plan.indexRevision });
  expect(calls).toEqual(["deny", "quiesce", "snapshot", "deny", "destroy", "restore", "inspect"]);
  expect(state).toMatchObject({ phase: "confirmed", confirmed: { snapshot: { id: "snapshot-one" }, manifestHash: proof.manifestHash } });
  expect(await controller.create(plan)).toEqual(result); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("restores the confirmed snapshot after restart without another snapshot or inference", async () => {
  await controller.create(plan); calls = [];
  expect(await new CheckpointController(identity, store, port, current, () => now).restore()).toMatchObject({ state: "checkpoint_confirmed" });
  expect(calls).toEqual(["deny", "destroy", "restore", "inspect"]); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it.each(["originalHash", "missing", "build", "namespace", "configuration", "version", "pending", "poisoned", "open"])("rejects invalid quiescence proof: %s", async fault => {
  if (fault === "originalHash") proof.sources[0].originalHash = "0".repeat(64);
  if (fault === "missing") proof.sources = [];
  if (fault === "build") proof.buildFingerprint = "0".repeat(64);
  if (fault === "namespace") proof.generation = "other";
  if (fault === "configuration") proof.configurationHash = "0".repeat(64);
  if (fault === "version") proof.engineVersion = "different";
  if (fault === "pending") proof.pendingOperations = 1;
  if (fault === "poisoned") proof.poisoned = true;
  if (fault === "open") proof.closed = false;
  expect(await controller.create(plan)).toMatchObject({ state: "rebuild_required" }); expect(port.snapshot).not.toHaveBeenCalled(); expect(port.destroy).toHaveBeenCalled();
});
it("never confirms a snapshot with a missing provenance chunk after restore", async () => {
  vi.mocked(port.inspect).mockImplementation(async () => ({ ...structuredClone(proof), closed: false, sources: proof.sources.map(ref => ({ ...ref, chunks: 0 })) }));
  expect(await controller.create(plan)).toMatchObject({ state: "rebuild_required" }); expect(state?.phase).toBe("rebuild_required");
});
it("denies stale canonical access before capture and after restore", async () => {
  current.mockResolvedValueOnce(false); expect(await controller.create(plan)).toMatchObject({ state: "blocked" }); expect(port.quiesce).not.toHaveBeenCalled();
  current.mockResolvedValue(true); vi.mocked(port.inspect).mockImplementation(async () => { current.mockResolvedValue(false); return { ...proof, closed: false }; });
  expect(await controller.create(plan)).toMatchObject({ state: "rebuild_required" });
});
it("keeps the previous confirmed checkpoint when capture of a newer revision fails", async () => {
  await controller.create(plan); const previous = structuredClone(state!.confirmed);
  vi.mocked(port.snapshot).mockRejectedValue(new Error("synthetic-provider-secret")); plan.indexRevision = "e".repeat(64);
  proof.indexRevision = plan.indexRevision; proof.manifestHash = await bridgeHash(canonical({ ...plan, identity }));
  const result = await controller.create(plan); expect(result).toMatchObject({ state: "uncertain" });
  expect(JSON.stringify(result)).not.toContain("secret"); expect(state?.confirmed).toEqual(previous); expect(state?.phase).not.toBe("confirmed");
});
it("does not repeat an unknown snapshot after its acknowledgement is lost", async () => {
  vi.mocked(port.snapshot).mockImplementation(async () => { throw new Error("snapshot created but ack lost"); });
  expect(await controller.create(plan)).toMatchObject({ state: "uncertain" });
  expect(await controller.create(plan)).toMatchObject({ state: "blocked" }); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("reconciles a lost final CAS acknowledgement without making another snapshot", async () => {
  const cas = store.compareAndSet;
  store.compareAndSet = async (revision, next) => { const result = await cas(revision, next); if (next.phase === "confirmed") throw new Error("ACK lost after commit"); return result; };
  expect(await controller.create(plan)).toMatchObject({ state: "checkpoint_confirmed" }); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("rejects expired or mismatched snapshot identity before booting it", async () => {
  await controller.create(plan); vi.mocked(port.restore).mockClear(); now += 30 * 86400000 + 1;
  expect(await controller.restore()).toMatchObject({ state: "rebuild_required" }); expect(port.restore).not.toHaveBeenCalled();
});
it("allows only one controller to capture a revision concurrently", async () => {
  const second = new CheckpointController(identity, store, port, current, () => now);
  const results = await Promise.all([controller.create(plan), second.create(plan)]);
  expect(results.filter(result => result.state === "checkpoint_confirmed")).toHaveLength(1); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("owns mutable plan and identity before hashing yields", async () => {
  const pending = controller.create(plan); plan.sources[0].hash = "0".repeat(64); identity.generation = "mutated";
  expect(await pending).toMatchObject({ state: "checkpoint_confirmed" }); expect(state?.confirmed?.manifest.sources[0].hash).toBe("a".repeat(64));
});
it("rejects duplicate or oversized plans before quiescing", async () => {
  expect(await controller.create({ ...plan, sources: [plan.sources[0], plan.sources[0]] })).toMatchObject({ state: "blocked" });
  expect(await controller.create({ ...plan, sources: Array(129).fill(plan.sources[0]) })).toMatchObject({ state: "blocked" }); expect(port.quiesce).not.toHaveBeenCalled();
});
it("binds the persisted handle to its checkpoint ID", async () => {
  await controller.create(plan); state!.confirmed!.snapshot.id = "swapped-handle"; vi.mocked(port.restore).mockClear();
  expect(await controller.restore()).toMatchObject({ state: "rebuild_required" }); expect(port.restore).not.toHaveBeenCalled();
});
it("retains a candidate when its persistence ACK is lost and explicitly restores it without another snapshot", async () => {
  const cas = store.compareAndSet; let failed = false;
  store.compareAndSet = async (revision, next) => { const result = await cas(revision, next); if (!failed && next.candidate) { failed = true; throw new Error("candidate ACK lost"); } return result; };
  expect(await controller.create(plan)).toMatchObject({ state: "uncertain" }); expect(state?.candidate).toBeDefined();
  expect(await controller.restore()).toMatchObject({ state: "checkpoint_confirmed" }); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("retains the candidate after a failed destroy and permits a later explicit recovery", async () => {
  vi.mocked(port.destroy).mockRejectedValue(new Error("synthetic destroy failure"));
  expect(await controller.create(plan)).toMatchObject({ state: "rebuild_required" }); expect(state?.candidate).toBeDefined();
  vi.mocked(port.destroy).mockResolvedValue(); expect(await controller.restore()).toMatchObject({ state: "checkpoint_confirmed" }); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("bounds an unknown snapshot timeout and never retries it automatically", async () => {
  vi.useFakeTimers(); vi.mocked(port.snapshot).mockImplementation(() => new Promise(() => {}));
  const pending = controller.create(plan); await vi.waitFor(() => expect(port.snapshot).toHaveBeenCalled(), { timeout: 5000 });
  await vi.advanceTimersByTimeAsync(60001); expect(await pending).toMatchObject({ state: "uncertain" });
  expect(await controller.create(plan)).toMatchObject({ state: "blocked" }); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
it("bounds snapshot attempts per day without resetting unknown outcomes", async () => {
  await controller.create(plan); state!.captures = { day: "1970-01-01", count: 24 }; plan.indexRevision = "e".repeat(64);
  expect(await controller.create(plan)).toMatchObject({ state: "blocked", reason: "checkpoint_daily_limit" }); expect(port.snapshot).toHaveBeenCalledTimes(1);
});
