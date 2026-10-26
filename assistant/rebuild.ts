import type { CheckpointIdentity, CheckpointManifest, IndexProof, SourceStamp } from "./checkpoints";
import { bridgeHash } from "./ingress";
import { z } from "zod";
export type RebuildState = { revision: number; owner: string; predecessor: string; indexEpoch: string; indexRevision: string;
  planHash: string; identity: CheckpointIdentity; sources: SourceStamp[]; next: number;
  phase: "preparing" | "building" | "materializing" | "validating" | "stopping" | "ready" | "blocked"; reason?: string;
  starts: { day: string; count: number } };
/** CAS must atomically compare the authoritative index epoch, persist this run,
 * move that epoch to next.indexEpoch and close normal engine admission unless ready. */
export interface RebuildStore {
  read(): Promise<RebuildState | null>;
  compareAndSet(revision: number | null, expectedIndexEpoch: string, next: RebuildState): Promise<boolean>;
}
export interface RebuildPort {
  deny(indexEpoch: string, owner: string): Promise<void>;
  destroy(indexEpoch: string, owner: string): Promise<void>; // Confirms stopped, and fences immediately before the physical effect.
  fresh(indexEpoch: string, owner: string): Promise<void>;
  materialize(indexEpoch: string, owner: string, source: SourceStamp): Promise<{ state: string; indexRevision?: string }>;
  inspect(manifest: CheckpointManifest, owner: string): Promise<IndexProof>;
}
export type RebuildResult = { state: "pending" | "ready" | "blocked" | "uncertain"; indexEpoch?: string; next?: number; reason?: string };
export class RebuildController {
  private readonly identity: CheckpointIdentity;
  constructor(identity: CheckpointIdentity, private store: RebuildStore, private port: RebuildPort,
    private current: (sources: SourceStamp[]) => Promise<boolean>, private clock = Date.now) { this.identity = identitySchema.parse(copy(identity)); }
  private result(state: RebuildState): RebuildResult {
    return { state: state.phase === "ready" ? "ready" : state.phase === "blocked" ? "blocked" : "pending", indexEpoch: state.indexEpoch, next: state.next, ...(state.reason ? { reason: state.reason } : {}) };
  }
  private async change(previous: RebuildState | null, expectedEpoch: string, next: RebuildState) {
    try { if (await this.store.compareAndSet(previous?.revision ?? null, expectedEpoch, next)) return next; }
    catch {
      const observed = await this.store.read();
      if (observed?.owner === next.owner && observed.revision === next.revision && observed.phase === next.phase && observed.indexEpoch === next.indexEpoch) return observed;
    }
    return null;
  }
  private async fail(owned: RebuildState, reason: string, uncertain = false): Promise<RebuildResult> {
    try {
      const stopping = await this.change(owned, owned.indexEpoch, { ...owned, revision: owned.revision + 1, phase: "stopping", reason });
      if (!stopping) return { state: "uncertain", reason: "rebuild_fenced" };
      const cleanup = await Promise.allSettled([bounded(this.port.deny(stopping.indexEpoch, stopping.owner), 60000), bounded(this.port.destroy(stopping.indexEpoch, stopping.owner), 60000)]);
      if (cleanup.some(result => result.status === "rejected")) return { state: "uncertain", indexEpoch: owned.indexEpoch, reason };
      const next = await this.change(stopping, stopping.indexEpoch, { ...stopping, revision: stopping.revision + 1, phase: "blocked" });
      return next ? { ...this.result(next), state: uncertain ? "uncertain" : "blocked" } : { state: "uncertain", reason: "rebuild_fenced" };
    } catch { return { state: "uncertain", reason: "rebuild_cleanup_uncertain" }; }
  }
  /** Explicit abandoned-run reconciliation. A new owner invalidates every old
   * port fence; normal begin remains closed until this destruction confirms. */
  async recover(epoch: string): Promise<RebuildResult> {
    try {
      const prior = await this.store.read(); if (!prior || prior.indexEpoch !== epoch) return { state: "blocked", reason: "rebuild_fenced" };
      const owned = await this.change(prior, epoch, { ...prior, revision: prior.revision + 1, owner: crypto.randomUUID(), phase: "stopping" });
      if (!owned) return { state: "uncertain", reason: "rebuild_fenced" };
      await bounded(this.port.deny(epoch, owned.owner), 60000); await bounded(this.port.destroy(epoch, owned.owner), 60000);
      const stopped = await this.change(owned, epoch, { ...owned, revision: owned.revision + 1, phase: "blocked", reason: "rebuild_recovered" });
      return stopped ? this.result(stopped) : { state: "uncertain", reason: "rebuild_fenced" };
    } catch { return { state: "uncertain", reason: "rebuild_recovery_uncertain" }; }
  }
  async begin(expectedEpoch: string, sources: SourceStamp[]): Promise<RebuildResult> {
    try {
      expectedEpoch = id.parse(expectedEpoch);
      if (Array.isArray(sources) && sources.length > 128) return { state: "blocked", reason: "source_capacity" };
      sources = z.array(stamp).min(1).max(128).parse(copy(sources)); if (new Set(sources.map(source => source.id)).size !== sources.length) throw 0;
    } catch { return { state: "blocked", reason: "rebuild_input" }; }
    let owned: RebuildState | null = null;
    try {
      const planHash = await bridgeHash(canonical([this.identity, sources])), previous = await this.store.read();
      if (!await this.current(copy(sources))) return { state: "blocked", reason: "source_stale" };
      if (previous?.predecessor === expectedEpoch) return previous.planHash === planHash ? this.result(previous) : { state: "blocked", reason: "rebuild_conflict" };
      if (previous && !["ready", "blocked"].includes(previous.phase)) return { state: "blocked", reason: "rebuild_active" };
      const day = new Date(this.clock()).toISOString().slice(0, 10), count = previous?.starts.day === day ? previous.starts.count : 0;
      if (!Number.isSafeInteger(count) || count < 0 || count >= 8) return { state: "blocked", reason: "rebuild_daily_limit" };
      owned = await this.change(previous, expectedEpoch, { revision: (previous?.revision ?? 0) + 1, owner: crypto.randomUUID(), predecessor: expectedEpoch,
        indexEpoch: crypto.randomUUID(), indexRevision: "empty", planHash, identity: copy(this.identity), sources, next: 0, phase: "preparing", starts: { day, count: count + 1 } });
      if (!owned) return { state: "blocked", reason: "rebuild_fenced" };
      await bounded(this.port.deny(owned.indexEpoch, owned.owner), 60000); await bounded(this.port.destroy(owned.indexEpoch, owned.owner), 60000); await bounded(this.port.fresh(owned.indexEpoch, owned.owner), 60000);
      if (!await this.current(copy(sources))) return this.fail(owned, "source_stale");
      const next = await this.change(owned, owned.indexEpoch, { ...owned, revision: owned.revision + 1, phase: "building" });
      return next ? this.result(next) : { state: "uncertain", reason: "rebuild_fenced" };
    } catch { return owned ? this.fail(owned, "rebuild_start_uncertain", true) : { state: "uncertain", reason: "rebuild_store_unavailable" }; }
  }
  async step(epoch: string, cursor: number): Promise<RebuildResult> {
    if (!id.safeParse(epoch).success || !Number.isSafeInteger(cursor) || cursor < 0) return { state: "blocked", reason: "rebuild_input" };
    let owned: RebuildState | null = null;
    try {
      const state = await this.store.read();
      if (!state || state.indexEpoch !== epoch || JSON.stringify(canonical(state.identity)) !== JSON.stringify(canonical(this.identity))) return { state: "blocked", reason: "rebuild_fenced" };
      if (state.phase === "blocked") return this.result(state);
      if (["preparing", "materializing", "validating", "stopping"].includes(state.phase)) return { state: "uncertain", reason: "rebuild_step_pending", indexEpoch: epoch };
      if (!await this.current(copy(state.sources))) return this.fail(state, "source_stale");
      if (state.phase === "ready" || cursor < state.next) return this.result(state);
      if (cursor !== state.next) return { state: "blocked", reason: "rebuild_cursor" };
      owned = await this.change(state, epoch, { ...state, revision: state.revision + 1, owner: crypto.randomUUID(), phase: cursor < state.sources.length ? "materializing" : "validating" });
      if (!owned) return { state: "uncertain", reason: "rebuild_fenced" };
      if (cursor < owned.sources.length) {
        const result = await bounded(this.port.materialize(epoch, owned.owner, copy(owned.sources[cursor])), 250000);
        if (result.state !== "complete" || !hash.safeParse(result.indexRevision).success) return this.fail(owned, "replay_unavailable", result.state === "uncertain");
        if (!await this.current(copy(owned.sources))) return this.fail(owned, "source_stale");
        const next = await this.change(owned, epoch, { ...owned, revision: owned.revision + 1, phase: "building", next: cursor + 1, indexRevision: result.indexRevision! });
        return next ? this.result(next) : { state: "uncertain", reason: "rebuild_fenced" };
      }
      const manifest: CheckpointManifest = { identity: copy(this.identity), indexEpoch: epoch, indexRevision: owned.indexRevision, sources: copy(owned.sources) };
      const proof = await bounded(this.port.inspect(manifest, owned.owner), 60000);
      if (!await validIndexProof(proof, manifest) || !await this.current(copy(owned.sources))) return this.fail(owned, "rebuild_validation_failed");
      const next = await this.change(owned, epoch, { ...owned, revision: owned.revision + 1, phase: "ready" });
      if (!next) return { state: "uncertain", reason: "rebuild_fenced" };
      owned = next;
      return await this.current(copy(next.sources)) ? this.result(next) : this.fail(next, "source_stale");
    } catch { return owned ? this.fail(owned, "rebuild_step_uncertain", true) : { state: "uncertain", reason: "rebuild_store_unavailable" }; }
  }
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const stamp = z.object({ id, revision: positive, version: positive.max(2147483647), hash }).strict();
const identitySchema = z.object({ installationId: id, generation: id, imageRef: z.string().min(1).max(1024), buildFingerprint: hash, configurationHash: hash, engineVersion: z.string().min(1).max(64) }).strict();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
}
/** Exact open-index proof shared by reconstruction and read-only preflight. */
export async function validIndexProof(value: IndexProof, manifest: CheckpointManifest) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536 || value.closed !== false || value.poisoned !== false || value.pendingOperations !== 0 ||
    value.indexEpoch !== manifest.indexEpoch || value.indexRevision !== manifest.indexRevision || value.manifestHash !== await bridgeHash(canonical(manifest)) ||
    Object.entries(manifest.identity).some(([key, expected]) => key !== "imageRef" && (value as unknown as Record<string, unknown>)[key] !== expected) ||
    !Array.isArray(value.sources) || value.sources.length !== manifest.sources.length) return false;
  return new Set(value.sources.map(source => source.id)).size === manifest.sources.length && manifest.sources.every(source => value.sources.some(row =>
    row.id === source.id && row.version === source.version && row.hash === source.hash && row.originalHash === source.hash && Number.isSafeInteger(row.chunks) && row.chunks > 0));
}
async function bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("rebuild_timeout")), timeout); })]); }
  finally { clearTimeout(timer); }
}
