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
  confirmed?: CheckpointRecord; candidate?: CheckpointRecord; reason?: string; captures?: { day: string; count: number } };
export interface CheckpointStore {
  read(): Promise<CheckpointState | null>;
  compareAndSet(expectedRevision: number | null, state: CheckpointState): Promise<boolean>;
}
export interface CheckpointPort {
  deny(): Promise<void>;
  quiesce(manifest: CheckpointManifest): Promise<IndexProof>;
  snapshot(name: string): Promise<SnapshotHandle>;
  destroy(): Promise<void>;
  restore(snapshot: SnapshotHandle): Promise<void>;
  inspect(): Promise<IndexProof>;
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
  private async change(state: CheckpointState | null, owner: string, update: Partial<CheckpointState>) {
    const next = { ...state, ...update, owner, revision: (state?.revision ?? 0) + 1 } as CheckpointState;
    if (!await this.store.compareAndSet(state?.revision ?? null, next)) throw new Error("checkpoint_fenced"); return next;
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
  private async failure(owner: string, uncertain: boolean): Promise<CheckpointResult> {
    const reason = uncertain ? "checkpoint_outcome_uncertain" : "checkpoint_validation_failed";
    try {
      const state = await this.store.read(); if (!state || state.owner !== owner) return { state: "uncertain", reason: "checkpoint_fenced" };
      await Promise.allSettled([bounded(this.port.deny()), bounded(this.port.destroy())]);
      await this.change(state, owner, { phase: "rebuild_required", reason });
    } catch { /* The persisted preparing/restoring fence remains closed. */ }
    return { state: uncertain ? "uncertain" : "rebuild_required", reason };
  }
  async create(plan: CheckpointPlan): Promise<CheckpointResult> {
    // Own all nested fields before the first hash/authorization await.
    try { plan = planSchema.parse(copy(plan)); if (new Set(plan.sources.map(source => source.id)).size !== plan.sources.length) throw 0; }
    catch { return { state: "blocked", reason: "checkpoint_input" }; }
    const owner = crypto.randomUUID(); let uncertain = false;
    try {
      const manifest = await this.manifest(plan), hash = await bridgeHash(canonical(manifest));
      if (!await this.current(copy(manifest))) return { state: "blocked", reason: "source_stale" };
      let state = await this.store.read();
      if (state && state.phase !== "confirmed") return { state: "blocked", reason: "checkpoint_not_idle" };
      if (state?.confirmed?.manifestHash === hash) {
        await this.validateRecord(state.confirmed); return await this.current(copy(manifest)) ? this.confirmed(state.confirmed) : { state: "blocked", reason: "source_stale" };
      }
      const day = new Date(this.clock()).toISOString().slice(0, 10), count = state?.captures?.day === day ? state.captures.count : 0;
      if (!integer(count) || count >= 24) return { state: "blocked", reason: "checkpoint_daily_limit" };
      uncertain = true; state = await this.change(state, owner, { phase: "preparing", candidate: undefined, reason: undefined, captures: { day, count: count + 1 } }); uncertain = false;
      await bounded(this.port.deny());
      await this.proof(await bounded(this.port.quiesce(copy(manifest))), manifest, true, hash);
      if (!await this.current(copy(manifest))) throw 0;
      uncertain = true; const snapshot = snapshotSchema.parse(await bounded(this.port.snapshot("checkpoint-" + hash)));
      const record: CheckpointRecord = { id: await bridgeHash([hash, snapshot.id]), snapshot, manifest, manifestHash: hash, createdAt: this.clock(), restoredAt: this.clock() };
      state = await this.change(state, owner, { phase: "restoring", candidate: record }); uncertain = false;
      return await this.restoreRecord(state, owner, record);
    } catch { return this.failure(owner, uncertain); }
  }
  private async restoreRecord(state: CheckpointState, owner: string, record: CheckpointRecord): Promise<CheckpointResult> {
    try {
      await this.validateRecord(record); if (!await this.current(copy(record.manifest))) throw 0;
      await bounded(this.port.deny()); await bounded(this.port.destroy()); await bounded(this.port.restore(copy(record.snapshot)));
      await this.proof(await bounded(this.port.inspect()), record.manifest, false, record.manifestHash);
      if (!await this.current(copy(record.manifest))) throw 0;
      record = { ...record, restoredAt: this.clock() };
      try { await this.change(state, owner, { phase: "confirmed", confirmed: record, candidate: undefined, reason: undefined }); }
      catch {
        const observed = await this.store.read();
        if (observed?.owner !== owner || observed.phase !== "confirmed" || observed.confirmed?.id !== record.id) throw 0;
      }
      return await this.current(copy(record.manifest)) ? this.confirmed(record) : this.failure(owner, false);
    } catch { return this.failure(owner, false); }
  }
  async restore(): Promise<CheckpointResult> {
    const owner = crypto.randomUUID();
    try {
      const previous = await this.store.read(), record = previous?.candidate ?? previous?.confirmed;
      if (!previous || !record) return { state: "rebuild_required", reason: "checkpoint_missing" };
      if (["preparing", "restoring"].includes(previous.phase)) return { state: "blocked", reason: "checkpoint_not_idle" };
      const state = await this.change(previous, owner, { phase: "restoring" }); return this.restoreRecord(state, owner, copy(record));
    } catch { return this.failure(owner, true); }
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
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("checkpoint_timeout")), 60000); })]); }
  finally { clearTimeout(timer); }
}
