import type { SourceFence, SourceRead, TrustedActor } from "./access";
import type { OriginFence } from "./origin-guard";
import { bridgeHash } from "./ingress";
import { sourceTextHash } from "./sources";
import { z } from "zod";
import type { CheckpointPlan, SourceStamp } from "./checkpoints";
export type Ref = { id: string; version: number; hash: string };
export type EnginePermit = { source: SourceFence; origin?: OriginFence };
export type EngineSearch = { query: string; allowedSources: Ref[]; limit: number; actor: TrustedActor; permits: EnginePermit[] };
export type EngineRequest = EngineSearch;
export type EngineIngest = { source: SourceRead; actor: TrustedActor; origin?: OriginFence };
export type EngineSearchOutcome = { state: "complete"; operationId: string; result: { candidates: (Ref & { via: string[]; relationCount: number })[]; missing: Ref[] }; indexRevision: string; indexState: "needs_checkpoint" | "checkpoint_confirmed" }
  | { state: "blocked" | "uncertain"; reason: string; operationId?: string };
export interface EnginePort { search(input: EngineSearch): Promise<EngineSearchOutcome> }
export interface EngineStore { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
export interface ContainerPort {
  readonly running: boolean;
  start(): Promise<void>;
  intercept(epoch: string): Promise<void>;
  deny(): Promise<void>;
  destroy(): Promise<void>;
  request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
}
export interface EngineGuard {
  check(actor: TrustedActor, permits: EnginePermit[]): Promise<boolean>;
  issue(source: SourceFence, expiresAt: number): Promise<string>;
  revoke(token: string): Promise<void>;
}
type Active = { epoch: string; operationId: string; token: string; period: string; actor: TrustedActor; permits: EnginePermit[]; until: number };
type Meta = { namespace: string; revision: string; lost: boolean; epoch?: string; sources?: SourceStamp[]; indexState?: "needs_checkpoint" | "checkpoint_confirmed" };
type Receipt = { state: "complete"; operationId: string; result: unknown; indexRevision: string; indexState: "needs_checkpoint" | "checkpoint_confirmed" };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/);
const refSchema = z.object({ id: identifier, version: z.number().int().positive().max(2147483647), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const counter = z.number().int().nonnegative().safe();
const searchResult = z.object({ candidates: z.array(refSchema.extend({ via: z.array(z.enum(["chunks", "graph"])).max(2), relationCount: counter })).max(10), missing: z.array(refSchema).max(64) }).strict();
export class CogneeEngine implements EnginePort {
  private busy = false;
  private quarantined = false;
  private activeEpoch: string | null = null;
  private scope: Readonly<{ installationId: string; generation: string }>;
  constructor(scope: { installationId: string; generation: string }, private store: EngineStore, private container: ContainerPort,
    private guard: EngineGuard, private clock = Date.now) { this.scope = Object.freeze({ installationId: scope.installationId, generation: scope.generation }); }
  async ingest(input: EngineIngest): Promise<unknown> {
    try {
      input = JSON.parse(JSON.stringify(input)) as EngineIngest;
      const s = input.source, f = s.fence.source;
      if (s.id !== f.id || !s.text || await sourceTextHash(s.text) !== f.hash) throw 0;
      const source = refSchema.extend({ text: z.string().min(1), occurredAt: counter, authorId: identifier.optional(), projectId: identifier.optional() }).strict().parse({ id: s.id, version: f.version, hash: f.hash, text: s.text, occurredAt: s.occurredAt,
        ...(s.authorId !== null ? { authorId: s.authorId } : {}), ...(f.projectId !== null ? { projectId: f.projectId } : {}) });
      return this.run("/ingest", { source }, input.actor, [{ source: s.fence, ...(input.origin ? { origin: input.origin } : {}) }]);
    } catch { return { state: "blocked", reason: "invalid_source" }; }
  }
  async search(input: EngineSearch): Promise<EngineSearchOutcome> {
    try {
      input = JSON.parse(JSON.stringify(input)) as EngineSearch;
      if (!input.query.trim() || new TextEncoder().encode(input.query).length > 2048 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10 || input.allowedSources.length > 64) throw 0;
      const refs = z.array(refSchema).parse(input.allowedSources);
      if (refs.length !== input.permits.length || new Set(refs.map(ref => ref.id)).size !== refs.length || refs.some((ref, i) => {
        const f = input.permits[i].source.source; return ref.id !== f.id || ref.version !== f.version || ref.hash !== f.hash;
      })) throw 0;
      if (!refs.length) return { state: "complete", operationId: await bridgeHash([this.scope, "empty", input.query]), result: { candidates: [], missing: [] }, indexRevision: "empty", indexState: "needs_checkpoint" };
      return await this.run("/search", { query: input.query, allowedSources: refs, limit: input.limit }, input.actor, input.permits) as EngineSearchOutcome;
    } catch { return { state: "blocked", reason: "invalid_search" }; }
  }
  async lookup(id: string): Promise<Receipt | { state: "uncertain" }> {
    if (!/^[a-f0-9]{64}$/.test(id)) return { state: "uncertain" };
    const receipt = await this.store.get<Receipt>(`receipt:${id}`), auth = await this.store.get<Pick<Active, "actor" | "permits">>(`access:${id}`);
    return receipt && auth && await this.guard.check(auth.actor, auth.permits) ? receipt : { state: "uncertain" };
  }
  /** Host-only lifecycle exclusion. Callback contains trusted checkpoint code,
   * never a model tool, URL or caller-supplied command. Persisted gate survives DO restart. */
  async maintain<T>(operation: (plan: CheckpointPlan | null) => Promise<{ value: T; restored?: CheckpointPlan }>, recovering = false): Promise<T | { state: "blocked" | "uncertain" | "rebuild_required"; reason: string }> {
    if (this.busy) return { state: "blocked", reason: "busy" }; this.busy = true; this.activeEpoch = null;
    try {
      const active = await this.store.get<Active>("active");
      if (active) { await this.stop(active); if (!recovering) return { state: "blocked", reason: "restart_uncertain" }; }
      const meta = await this.store.get<Meta>("index");
      if (!recovering && (!meta?.epoch || !meta.sources || meta.lost || !this.container.running)) return { state: "rebuild_required", reason: "index_lost" };
      await this.store.put("maintenance", true); await this.container.deny();
      const outcome = await operation(meta?.epoch && meta.sources ? { indexEpoch: meta.epoch, indexRevision: meta.revision, sources: JSON.parse(JSON.stringify(meta.sources)) } : null);
      if (outcome.restored) {
        if (!this.container.running) throw 0;
        await this.store.put("index", { namespace: JSON.stringify(this.scope), revision: outcome.restored.indexRevision, epoch: outcome.restored.indexEpoch,
          sources: outcome.restored.sources, indexState: "checkpoint_confirmed", lost: false } satisfies Meta);
        await this.store.put("quarantine", false); await this.store.put("maintenance", false); this.quarantined = false;
      }
      return outcome.value;
    } catch { await this.stop().catch(() => {}); return { state: "uncertain", reason: "checkpoint_operation_uncertain" }; }
    finally { this.busy = false; }
  }
  async authorize(epoch: string): Promise<{ token: string; period: string } | null> {
    if (!epoch || epoch !== this.activeEpoch) return null;
    const active = await this.store.get<Active>("active");
    if (!active || active.epoch !== epoch || active.until <= this.clock() || !await this.guard.check(active.actor, active.permits)) return null;
    const current = await this.store.get<Active>("active");
    return current?.epoch === epoch ? { token: active.token, period: active.period } : null;
  }
  private async stop(active?: Active) {
    // Stop admission first. Never hand a surviving old process a new permit.
    this.activeEpoch = null; this.quarantined = true;
    await Promise.allSettled([this.container.deny(), active ? this.guard.revoke(active.token) : Promise.resolve(), this.store.put("quarantine", true),
      (async () => { const meta = await this.store.get<Meta>("index"); if (meta) await this.store.put("index", { ...meta, lost: true }); })()]);
    // Keep the persistent active fence until destruction is confirmed, even if
    // deny/revoke/storage failed. A new DO can only reconcile, never re-admit it.
    try { await this.container.destroy(); if (!this.container.running) await this.store.put("active", null); } catch { /* Quarantine remains. */ }
  }
  private async run(path: "/ingest" | "/search", wire: Record<string, unknown>, actor: TrustedActor, permits: EnginePermit[]): Promise<unknown> {
    if (this.busy) return { state: "blocked", reason: "busy" }; this.busy = true;
    let active: Active | undefined, timer: ReturnType<typeof setTimeout> | undefined; const controller = new AbortController();
    try {
      if (bytes({ wire, actor, permits }) > 65536 || permits.some(p => p.source.installationId !== this.scope.installationId || p.source.generation !== this.scope.generation)
        || !await this.guard.check(actor, permits)) return { state: "blocked", reason: "source_denied" };
      const previous = await this.store.get<Active>("active");
      if (previous) { await this.stop(previous); return { state: "blocked", reason: "restart_uncertain" }; }
      if (await this.store.get<boolean>("maintenance")) return { state: "blocked", reason: "checkpoint_pending" };
      if (this.quarantined || await this.store.get<boolean>("quarantine")) return { state: "blocked", reason: "index_lost" };
      let meta = await this.store.get<Meta>("index"); const namespace = JSON.stringify(this.scope);
      if (meta && (meta.namespace !== namespace || meta.lost || !this.container.running)) return { state: "blocked", reason: "index_lost" };
      if (!meta) {
        meta = { namespace, revision: "empty", epoch: crypto.randomUUID(), sources: [], indexState: "needs_checkpoint", lost: false }; await this.store.put("index", meta);
        await this.container.deny(); await this.container.start();
        const health = await this.container.request("/health", {});
        const h = health as { namespace?: { installationId: string; generation: string }; ready?: boolean; poisoned?: boolean };
        if (bytes(health) > 4096 || h.namespace?.installationId !== this.scope.installationId || h.namespace.generation !== this.scope.generation || !h.ready || h.poisoned) throw 0;
      }
      const operationId = await bridgeHash([this.scope, path, wire, path === "/search" ? meta.revision : null]);
      const prior = await this.store.get<Receipt>(`receipt:${operationId}`);
      if (prior) return await this.guard.check(actor, permits) ? { ...prior, indexState: meta.indexState ?? "needs_checkpoint" } : { state: "blocked", reason: "source_denied", operationId };
      await this.store.put(`access:${operationId}`, { actor, permits });
      active = { epoch: crypto.randomUUID(), operationId, token: await this.guard.issue(permits[0].source, this.clock() + 300000),
        period: new Date(this.clock()).toISOString().slice(0, 10), actor, permits, until: this.clock() + 250000 };
      await this.store.put("active", active); this.activeEpoch = active.epoch; await this.container.intercept(active.epoch);
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("engine_timeout")); }, 250000); });
      const value = await Promise.race([this.container.request(path, { operationId, ...wire }, controller.signal), deadline]);
      if (!await this.authorize(active.epoch)) { await this.stop(active); return { state: "blocked", reason: "source_denied", operationId }; }
      if (bytes(value) > 65536 || !(value as { ok: boolean }).ok) throw 0;
      const result = (value as { result: unknown }).result;
      if (path === "/search") {
        const parsed = searchResult.parse(result), refs = wire.allowedSources as Ref[];
        if (parsed.candidates.length > (wire.limit as number) || [...parsed.candidates, ...parsed.missing].some(item => !refs.some(ref => ref.id === item.id && ref.version === item.version && ref.hash === item.hash))) throw 0;
      } else {
        const parsed = refSchema.extend({ state: z.literal("completed"), chunks: counter, relations: counter, nodes: counter, edges: counter }).strict().parse(result);
        const source = wire.source as Ref; if (parsed.id !== source.id || parsed.version !== source.version || parsed.hash !== source.hash || !parsed.chunks) throw 0;
        const f = permits[0].source.source;
        meta = { ...meta, revision: await bridgeHash([meta.revision, operationId]), indexState: "needs_checkpoint",
          sources: [...(meta.sources ?? []).filter(ref => ref.id !== f.id), { id: f.id, revision: f.revision, version: f.version, hash: f.hash }] }; await this.store.put("index", meta);
      }
      const receipt: Receipt = { state: "complete", operationId, result, indexRevision: meta.revision, indexState: meta.indexState ?? "needs_checkpoint" };
      await this.store.put(`receipt:${operationId}`, receipt);
      if (!await this.authorize(active.epoch)) { await this.stop(active); return { state: "blocked", reason: "source_denied", operationId }; }
      this.activeEpoch = null; await this.container.deny(); await this.guard.revoke(active.token); await this.store.put("active", null);
      return await this.guard.check(actor, permits) ? receipt : { state: "blocked", reason: "source_denied", operationId };
    } catch {
      await this.stop(active).catch(() => {}); return { state: "uncertain", reason: "engine_operation_uncertain", ...(active ? { operationId: active.operationId } : {}) };
    } finally { clearTimeout(timer); controller.abort(); this.busy = false; }
  }
}
