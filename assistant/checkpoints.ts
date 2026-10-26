import { z } from "zod";
import { bridgeHash } from "./ingress";
export type CheckpointIdentity = { installationId: string; generation: string; imageRef: string; buildFingerprint: string;
  configurationHash: string; engineVersion: string };
export type SourceStamp = { id: string; revision: number; version: number; hash: string };
export type CheckpointPlan = { indexEpoch: string; indexRevision: string; sources: SourceStamp[] };
export type CheckpointManifest = CheckpointPlan & { identity: CheckpointIdentity };
export type SnapshotHandle = { id: string; size: number };
export type IndexProof = { installationId: string; generation: string; buildFingerprint: string; configurationHash: string;
  engineVersion: string; indexEpoch: string; indexRevision: string; manifestHash: string; closed: boolean; poisoned: boolean; pendingOperations: number;
  sources: { id: string; version: number; hash: string; originalHash: string; chunks: number }[] };
export type CheckpointRecord = { id: string; snapshot: SnapshotHandle; manifest: CheckpointManifest; manifestHash: string; createdAt: number; restoredAt: number };
export type CheckpointState = { revision: number; phase: "preparing" | "restoring" | "confirmed" | "rebuild_required"; owner: string;
  confirmed?: CheckpointRecord; candidate?: CheckpointRecord; index?: CheckpointPlan; reason?: string; captures?: { day: string; count: number } };
export type CheckpointFence = { owner: string; revision: number; indexEpoch: string };
export interface CheckpointStore {
  read(): Promise<CheckpointState | null>;
  compareAndSet(expectedRevision: number | null, state: CheckpointState): Promise<boolean>;
  owns?(fence: CheckpointFence): Promise<boolean>;
}
export interface CheckpointPort {
  deny(fence: CheckpointFence): Promise<void>;
  quiesce(manifest: CheckpointManifest, fence: CheckpointFence): Promise<IndexProof>;
  snapshot(name: string, fence: CheckpointFence): Promise<SnapshotHandle>;
  destroy(fence: CheckpointFence): Promise<void>;
  restore(snapshot: SnapshotHandle, fence: CheckpointFence): Promise<void>;
  inspect(fence: CheckpointFence): Promise<IndexProof>;
}
export type CheckpointResult = { state: "checkpoint_confirmed"; id: string; indexRevision: string }
  | { state: "blocked" | "uncertain" | "rebuild_required"; reason: string };
export class CheckpointController {
  private readonly identity: CheckpointIdentity;
  constructor(identity: CheckpointIdentity, private store: CheckpointStore, private port: CheckpointPort,
    private current: (manifest: CheckpointManifest) => Promise<boolean>, private clock = Date.now) {
    this.identity = identitySchema.parse(copy(identity));
  }
  private async manifest(plan: CheckpointPlan): Promise<CheckpointManifest> {
    const result = planSchema.parse(plan); result.sources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (new Set(result.sources.map(source => source.id)).size !== result.sources.length) throw 0;
    return { ...result, identity: copy(this.identity) };
  }
  private fence(state: CheckpointState): CheckpointFence {
    if (!state.index) throw new Error("checkpoint_fenced");
    return { owner: state.owner, revision: state.revision, indexEpoch: state.index.indexEpoch };
  }
  private async owned(state: CheckpointState) {
    const fence = this.fence(state), current = await this.store.read();
    if (!current || current.owner !== fence.owner || current.revision !== fence.revision || current.index?.indexEpoch !== fence.indexEpoch ||
      (this.store.owns && !await this.store.owns(fence))) throw new Error("checkpoint_fenced");
  }
  private async change(state: CheckpointState | null, owner: string, update: Partial<CheckpointState>) {
    const next = { ...state, ...update, owner, revision: (state?.revision ?? 0) + 1 } as CheckpointState;
    try { if (await this.store.compareAndSet(state?.revision ?? null, next)) return next; }
    catch {
      const observed = await this.store.read();
      if (JSON.stringify(canonical(observed)) === JSON.stringify(canonical(next))) return next;
    }
    throw new Error("checkpoint_fenced");
  }
  private async effect<T>(state: CheckpointState, action: (fence: CheckpointFence) => Promise<T>): Promise<T> {
    await this.owned(state);
    try { const value = await bounded(action(this.fence(state))); await this.owned(state); return value; }
    catch (error) { await this.owned(state); throw error; }
  }
  private confirmed(record: CheckpointRecord): CheckpointResult {
    return { state: "checkpoint_confirmed", id: record.id, indexRevision: record.manifest.indexRevision };
  }
  private async validateRecord(record: CheckpointRecord) {
    if (!record || JSON.stringify(canonical(record.manifest.identity)) !== JSON.stringify(canonical(this.identity)) ||
      record.manifestHash !== await bridgeHash(canonical(await this.manifest({ indexEpoch: record.manifest.indexEpoch, indexRevision: record.manifest.indexRevision, sources: record.manifest.sources }))) ||
      !integer(record.createdAt) || !integer(record.restoredAt) || record.createdAt > record.restoredAt || record.restoredAt > this.clock() ||
      this.clock() - record.restoredAt >= TTL || record.id !== await bridgeHash([record.manifestHash, record.snapshot.id])) throw 0;
    snapshotSchema.parse(record.snapshot);
  }
  private async proof(raw: IndexProof, manifest: CheckpointManifest, closed: boolean, hash: string) {
    if (JSON.stringify(raw).length > 65536) throw 0;
    const value = proofSchema.parse(copy(raw)), id = manifest.identity;
    if (value.installationId !== id.installationId || value.generation !== id.generation || value.buildFingerprint !== id.buildFingerprint ||
      value.configurationHash !== id.configurationHash || value.engineVersion !== id.engineVersion || value.indexEpoch !== manifest.indexEpoch ||
      value.indexRevision !== manifest.indexRevision || value.manifestHash !== hash || value.closed !== closed || value.poisoned || value.pendingOperations) throw 0;
    const sources = [...value.sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (sources.length !== manifest.sources.length || sources.some((source, index) => {
      const expected = manifest.sources[index]; return source.id !== expected.id || source.version !== expected.version || source.hash !== expected.hash || source.originalHash !== expected.hash || source.chunks < 1;
    })) throw 0;
  }
  private async failure(state: CheckpointState | null, uncertain: boolean, timeout = false): Promise<CheckpointResult> {
    const reason = uncertain ? "checkpoint_outcome_uncertain" : "checkpoint_validation_failed";
    try {
      if (!state) return { state: "uncertain", reason: "checkpoint_fenced" };
      await this.owned(state);
      // A timed-out physical operation is still running. Its host retains the
      // lifecycle lock; do not race another destroy or overwrite its fence.
      if (timeout) return { state: "uncertain", reason };
      try { await this.effect(state, fence => this.port.deny(fence)); await this.effect(state, fence => this.port.destroy(fence)); }
      catch (error) { await this.owned(state); if (error instanceof CheckpointTimeout) return { state: "uncertain", reason }; }
      await this.owned(state); await this.change(state, state.owner, { phase: "rebuild_required", reason });
    } catch { return { state: "uncertain", reason: "checkpoint_fenced" }; }
    return { state: uncertain ? "uncertain" : "rebuild_required", reason };
  }
  async create(plan: CheckpointPlan): Promise<CheckpointResult> {
    try { plan = planSchema.parse(copy(plan)); if (new Set(plan.sources.map(source => source.id)).size !== plan.sources.length) throw 0; }
    catch { return { state: "blocked", reason: "checkpoint_input" }; }
    const owner = crypto.randomUUID(); let uncertain = false, state: CheckpointState | null = null;
    try {
      const manifest = await this.manifest(plan), hash = await bridgeHash(canonical(manifest));
      if (!await this.current(copy(manifest))) return { state: "blocked", reason: "source_stale" };
      const previous = await this.store.read();
      if (previous && previous.phase !== "confirmed") return { state: "blocked", reason: "checkpoint_not_idle" };
      if (previous?.confirmed?.manifestHash === hash) {
        await this.validateRecord(previous.confirmed);
        return await this.current(copy(manifest)) ? this.confirmed(previous.confirmed) : { state: "blocked", reason: "source_stale" };
      }
      const day = new Date(this.clock()).toISOString().slice(0, 10), count = previous?.captures?.day === day ? previous.captures.count : 0;
      if (!integer(count) || count >= 24) return { state: "blocked", reason: "checkpoint_daily_limit" };
      uncertain = true; state = await this.change(previous, owner, { phase: "preparing", index: copy(plan), candidate: undefined, reason: undefined, captures: { day, count: count + 1 } }); uncertain = false;
      await this.effect(state, fence => this.port.deny(fence));
      const proof = await this.effect(state, fence => this.port.quiesce(copy(manifest), fence));
      await this.proof(proof, manifest, true, hash); await this.owned(state);
      if (!await this.current(copy(manifest))) throw 0;
      await this.owned(state); uncertain = true;
      const snapshot = snapshotSchema.parse(await this.effect(state, fence => this.port.snapshot("checkpoint-" + hash, fence)));
      const record: CheckpointRecord = { id: await bridgeHash([hash, snapshot.id]), snapshot, manifest, manifestHash: hash, createdAt: this.clock(), restoredAt: this.clock() };
      await this.owned(state); state = await this.change(state, owner, { phase: "restoring", candidate: record }); uncertain = false;
      return await this.restoreRecord(state, record);
    } catch (error) { return this.failure(state, uncertain || error instanceof CheckpointTimeout, error instanceof CheckpointTimeout); }
  }
  private async restoreRecord(state: CheckpointState, record: CheckpointRecord): Promise<CheckpointResult> {
    try {
      await this.validateRecord(record); await this.owned(state);
      if (!await this.current(copy(record.manifest))) throw 0;
      await this.owned(state);
      await this.effect(state, fence => this.port.deny(fence));
      await this.effect(state, fence => this.port.destroy(fence));
      await this.effect(state, fence => this.port.restore(copy(record.snapshot), fence));
      const proof = await this.effect(state, fence => this.port.inspect(fence));
      await this.proof(proof, record.manifest, false, record.manifestHash); await this.owned(state);
      if (!await this.current(copy(record.manifest))) throw 0;
      await this.owned(state); record = { ...record, restoredAt: this.clock() };
      await this.change(state, state.owner, { phase: "confirmed", confirmed: record, candidate: undefined, reason: undefined });
      return this.confirmed(record);
    } catch (error) { return this.failure(state, error instanceof CheckpointTimeout, error instanceof CheckpointTimeout); }
  }
  async restore(): Promise<CheckpointResult> {
    const owner = crypto.randomUUID(); let state: CheckpointState | null = null;
    try {
      const previous = await this.store.read();
      if (!previous) return { state: "rebuild_required", reason: "checkpoint_missing" };
      // An unfinished capture never falls back to its older confirmed record.
      const record = previous.phase === "confirmed" ? previous.confirmed : previous.candidate;
      if (!record) return { state: "uncertain", reason: "checkpoint_candidate_missing" };
      // Legacy records gain an index fence only after full record validation.
      try { await this.validateRecord(record); }
      catch { return { state: "rebuild_required", reason: "checkpoint_validation_failed" }; }
      if (previous.index && await bridgeHash(canonical(await this.manifest(previous.index))) !== record.manifestHash)
        return { state: "rebuild_required", reason: "checkpoint_validation_failed" };
      const index = { indexEpoch: record.manifest.indexEpoch, indexRevision: record.manifest.indexRevision, sources: copy(record.manifest.sources) };
      state = await this.change(previous, owner, { phase: "restoring", index, candidate: copy(record) });
      return await this.restoreRecord(state, copy(record));
    } catch (error) { return this.failure(state, true, error instanceof CheckpointTimeout); }
  }

}
const TTL = 30 * 86400000;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const counter = z.number().int().nonnegative().safe(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/);
const identitySchema = z.object({ installationId: id, generation: id, imageRef: z.string().min(1).max(1024), buildFingerprint: hash, configurationHash: hash, engineVersion: z.string().min(1).max(64) }).strict();
const ref = z.object({ id, version: counter.min(1).max(2147483647), hash }).strict();
const planSchema = z.object({ indexEpoch: id, indexRevision: z.union([hash, z.literal("empty")]), sources: z.array(ref.extend({ revision: counter.min(1) })).max(128) }).strict();
const proofSchema = z.object({ installationId: id, generation: id, buildFingerprint: hash, configurationHash: hash, engineVersion: z.string(), indexEpoch: id,
  indexRevision: z.union([hash, z.literal("empty")]), manifestHash: hash, closed: z.boolean(), poisoned: z.boolean(), pendingOperations: counter,
  sources: z.array(ref.extend({ originalHash: hash, chunks: counter })).max(128) }).strict();
const snapshotSchema = z.object({ id: z.string().min(1).max(512), size: counter.min(1).max(8 * 1024 ** 3) }).strict();
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
class CheckpointTimeout extends Error {}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CheckpointTimeout("checkpoint_timeout")), 60000); })]); }
  finally { clearTimeout(timer); }
}
