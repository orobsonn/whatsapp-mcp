import { beforeEach, expect, it, vi } from "vitest";
import { RebuildController, type RebuildPort, type RebuildState, type RebuildStore } from "../assistant/rebuild";
import { bridgeHash } from "../assistant/ingress";
import type { CheckpointIdentity, CheckpointManifest, IndexProof, SourceStamp } from "../assistant/checkpoints";
let identity: CheckpointIdentity, sources: SourceStamp[], state: RebuildState | null, epoch: string, now: number;
let store: RebuildStore, port: RebuildPort, current: ReturnType<typeof vi.fn<(sources: SourceStamp[]) => Promise<boolean>>>, controller: RebuildController;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
async function proof(manifest: CheckpointManifest): Promise<IndexProof> {
  return { ...manifest.identity, indexEpoch: manifest.indexEpoch, indexRevision: manifest.indexRevision,
    manifestHash: await bridgeHash(canonical(manifest)), closed: false, poisoned: false, pendingOperations: 0,
    sources: manifest.sources.map(({ id, version, hash }) => ({ id, version, hash, originalHash: hash, chunks: 1 })) };
}
beforeEach(() => {
  identity = { installationId: "synthetic", generation: "g1", imageRef: "image-pinned", buildFingerprint: "b".repeat(64), configurationHash: "c".repeat(64), engineVersion: "1.6.5" };
  sources = ["first", "second"].map(id => ({ id, revision: 1, version: 1, hash: "a".repeat(64) })); state = null; epoch = "old-index"; now = 100;
  store = { read: async () => structuredClone(state), compareAndSet: vi.fn(async (revision, previous, next) => {
    if ((state?.revision ?? null) !== revision || epoch !== previous) return false;
    state = structuredClone(next); epoch = next.indexEpoch; return true;
  }) };
  port = { deny: vi.fn(async () => {}), destroy: vi.fn(async () => {}), fresh: vi.fn(async () => {}),
    materialize: vi.fn(async () => ({ state: "complete", indexRevision: "d".repeat(64) })), inspect: vi.fn(proof) };
  current = vi.fn(async () => true); controller = new RebuildController(identity, store, port, current, () => now);
});
async function begin() { const result = await controller.begin(epoch, sources); expect(result.state).toBe("pending"); return result.indexEpoch!; }
it("persists a new physical epoch before touching the process and materializes one source per fenced step", async () => {
  vi.mocked(port.destroy).mockImplementation(async () => { expect(state?.phase).toBe("preparing"); expect(epoch).not.toBe("old-index"); });
  const run = await begin(); expect(port.materialize).not.toHaveBeenCalled(); expect(port.fresh).toHaveBeenCalledWith(run, expect.any(String));
  expect(await controller.step(run, 0)).toMatchObject({ state: "pending", next: 1 });
  expect(await controller.step(run, 0)).toMatchObject({ state: "pending", next: 1 }); expect(port.materialize).toHaveBeenCalledTimes(1);
  expect(await controller.step(run, 1)).toMatchObject({ state: "pending", next: 2 });
  expect(await controller.step(run, 2)).toMatchObject({ state: "ready", next: 2 }); expect(port.inspect).toHaveBeenCalledTimes(1);
});
it("keeps original plan order and deduplicates begin acknowledgement loss", async () => {
  const original = structuredClone(sources), run = await begin(), previous = "old-index";
  expect(await controller.begin(previous, original)).toMatchObject({ state: "pending", indexEpoch: run }); expect(port.destroy).toHaveBeenCalledTimes(1);
  expect(await controller.begin(previous, [...original].reverse())).toMatchObject({ state: "blocked" });
  await controller.recover(run);
  const change = store.compareAndSet; let lost = false;
  store.compareAndSet = async (...args) => { const accepted = await change(...args); if (!lost && args[2].phase === "building") { lost = true; throw new Error("commit ACK lost"); } return accepted; };
  const replacement = await controller.begin(run, original); expect(replacement.state).toBe("pending"); expect(replacement.indexEpoch).not.toBe(run);
});
it("does not let concurrent controllers materialize the same physical step twice", async () => {
  const run = await begin(), other = new RebuildController(identity, store, port, current, () => now);
  const results = await Promise.all([controller.step(run, 0), other.step(run, 0)]);
  expect(results.some(result => result.state === "pending")).toBe(true); expect(port.materialize).toHaveBeenCalledTimes(1);
});
it("leaves an interrupted physical step blocked until a fresh epoch confirms destruction", async () => {
  const run = await begin(); state!.phase = "materializing";
  expect(await controller.step(run, 0)).toMatchObject({ state: "uncertain" }); expect(port.materialize).not.toHaveBeenCalled();
  vi.mocked(port.destroy).mockRejectedValueOnce(new Error("synthetic destroy secret"));
  expect(await controller.begin(run, sources)).toMatchObject({ state: "blocked", reason: "rebuild_active" });
  expect(await controller.recover(run)).toMatchObject({ state: "uncertain" }); expect(port.fresh).toHaveBeenCalledTimes(1);
  expect(state?.phase).toBe("stopping");
});
it.each(["before", "during", "final"])("never readies a changed/withdrawn source: %s", async when => {
  const run = await begin();
  if (when === "before") current.mockResolvedValue(false);
  if (when === "during") vi.mocked(port.materialize).mockImplementation(async () => { current.mockResolvedValue(false); return { state: "complete", indexRevision: "d".repeat(64) }; });
  if (when === "final") { await controller.step(run, 0); await controller.step(run, 1); vi.mocked(port.inspect).mockImplementation(async manifest => { current.mockResolvedValue(false); return proof(manifest); }); }
  const result = await controller.step(run, when === "final" ? 2 : 0); expect(result.state).toBe("blocked"); expect(state?.phase).toBe("blocked");
});
it("blocks an exact-cache miss and never marks a partial index ready", async () => {
  const run = await begin(); vi.mocked(port.materialize).mockResolvedValue({ state: "blocked" });
  expect(await controller.step(run, 0)).toMatchObject({ state: "blocked", reason: "replay_unavailable" }); expect(port.inspect).not.toHaveBeenCalled();
});
it.each(["missing", "hash", "configuration", "poisoned"])("requires actual physical provenance proof: %s", async fault => {
  const run = await begin(); await controller.step(run, 0); await controller.step(run, 1);
  vi.mocked(port.inspect).mockImplementation(async manifest => {
    const value = await proof(manifest); if (fault === "missing") value.sources.pop(); if (fault === "hash") value.sources[0].originalHash = "0".repeat(64);
    if (fault === "configuration") value.configurationHash = "0".repeat(64); if (fault === "poisoned") value.poisoned = true; return value;
  });
  expect(await controller.step(run, 2)).toMatchObject({ state: "blocked" });
});
it("owns input before hashing and rejects duplicates/129 sources without destroying an index", async () => {
  const pending = controller.begin(epoch, sources); sources[0].hash = "0".repeat(64); identity.generation = "mutated";
  expect((await pending).state).toBe("pending"); expect(state?.sources[0].hash).toBe("a".repeat(64)); expect(state?.identity.generation).toBe("g1");
  vi.mocked(port.destroy).mockClear(); const run = epoch;
  expect(await controller.begin(run, [sources[0], sources[0]])).toMatchObject({ state: "blocked" });
  expect(await controller.begin(run, Array.from({ length: 129 }, (_, i) => ({ ...sources[0], id: `source-${i}` })))).toMatchObject({ state: "blocked", reason: "source_capacity" }); expect(port.destroy).not.toHaveBeenCalled();
});
it("rejects stale index epochs and bounds rebuild starts while preserving the prior checkpoint outside its store", async () => {
  const run = await begin(); expect(await controller.begin("stale-epoch", sources)).toMatchObject({ state: "blocked" });
  await controller.recover(run);
  state!.starts.count = 8; expect(await controller.begin(run, sources)).toMatchObject({ state: "blocked", reason: "rebuild_daily_limit" }); expect(port.fresh).toHaveBeenCalledTimes(1);
});
it("fences delayed cleanup after recovery so it cannot destroy or overwrite the new physical epoch", async () => {
  const run = await begin(); let release!: () => void, stalledOwner = "";
  const hold = new Promise<void>(resolve => { release = resolve; }), destroyed: string[] = [];
  const fence = (epoch: string, owner: string) => { if (state?.indexEpoch !== epoch || state.owner !== owner) throw new Error("stale physical fence"); };
  vi.mocked(port.deny).mockImplementation(async (epoch, owner) => { if (!stalledOwner) stalledOwner = owner; if (owner === stalledOwner) await hold; fence(epoch, owner); });
  vi.mocked(port.destroy).mockImplementation(async (epoch, owner) => { fence(epoch, owner); destroyed.push(epoch); });
  vi.mocked(port.materialize).mockResolvedValue({ state: "blocked" });
  const stale = controller.step(run, 0); await vi.waitFor(() => expect(state?.phase).toBe("stopping"));
  expect(await controller.begin(run, sources)).toMatchObject({ state: "blocked", reason: "rebuild_active" });
  expect(await controller.recover(run)).toMatchObject({ state: "blocked", reason: "rebuild_recovered" });
  const replacement = await controller.begin(run, sources); expect(replacement.state).toBe("pending"); expect(replacement.indexEpoch).not.toBe(run);
  const effects = destroyed.length; release(); expect((await stale).state).toBe("uncertain");
  expect(destroyed).toHaveLength(effects); expect(state).toMatchObject({ indexEpoch: replacement.indexEpoch, phase: "building", next: 0 });
});
it("does not advance an old materialization after explicit recovery transferred ownership", async () => {
  const run = await begin(); let release!: () => void;
  vi.mocked(port.materialize).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { state: "complete", indexRevision: "e".repeat(64) }; });
  const stale = controller.step(run, 0); await vi.waitFor(() => expect(port.materialize).toHaveBeenCalled());
  await controller.recover(run); const next = await controller.begin(run, sources); release();
  expect((await stale).state).toBe("uncertain"); expect(state).toMatchObject({ indexEpoch: next.indexEpoch, phase: "building", next: 0, indexRevision: "empty" });
});
