import type { SourceFence, SourceRead, TrustedActor } from "./access";
import type { OriginFence } from "./origin-guard";
import { bridgeHash } from "./ingress";
import { sourceTextHash } from "./sources";
import { z } from "zod";
import type { CheckpointPlan, CheckpointState, SourceStamp } from "./checkpoints";
import type { RebuildState } from "./rebuild";
import type { CoverageProof } from "./retrieval-runs";
export type Ref = { id: string; version: number; hash: string };
export type EnginePermit = { source: SourceFence; origin?: OriginFence };
export type EngineSearch = { query: string; allowedSources: Ref[]; limit: number; actor: TrustedActor; permits: EnginePermit[]; coverage?: CoverageProof };
export type EngineRequest = EngineSearch;
export type EngineIngest = { source: SourceRead; actor: TrustedActor; origin?: OriginFence };
export type EngineSearchOutcome = { state: "complete"; operationId: string; result: { candidates: (Ref & { via: string[]; relationCount: number })[]; missing: Ref[] }; indexRevision: string; indexState: "needs_checkpoint" | "checkpoint_confirmed" }
  | { state: "blocked" | "uncertain"; reason: string; operationId?: string };
export interface EnginePort { search(input: EngineSearch): Promise<EngineSearchOutcome> }
export type SearchTicket = { alias: string; requestHash: string; operationId: string; indexEpoch: string; indexRevision: string };
export type PreparedSearch = { state: "prepared"; ticket: SearchTicket } | { state: "blocked"; reason: string };
type TicketRecord = { ticket: SearchTicket; input: EngineSearch; state: "prepared" | "attempting" };
export interface SemanticEnginePort { prepare(alias: string, input: EngineSearch): Promise<PreparedSearch>; submit(ticket: SearchTicket): Promise<EngineSearchOutcome>; lookupTicket(ticket: SearchTicket): Promise<EngineSearchOutcome> }
export interface EngineStore { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>;
  transaction?<T>(operation: (store: EngineStore) => Promise<T>): Promise<T>;
  putFenced?(key: string, value: unknown, indexEpoch: string, owner: string): Promise<void> }
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
  checkCoverage?(proof: CoverageProof): Promise<boolean>;
  issue(source: SourceFence, expiresAt: number): Promise<string>;
  revoke(token: string): Promise<void>;
}
type Active = { epoch: string; operationId: string; token: string; period: string; actor: TrustedActor; permits: EnginePermit[]; until: number; coverage?: CoverageProof; searchIndex?: { epoch: string; revision: string }; mode?: "replay_only"; indexEpoch?: string; owner?: string };
type Meta = { namespace: string; revision: string; lost: boolean; epoch?: string; sources?: SourceStamp[]; indexState?: "needs_checkpoint" | "checkpoint_confirmed" };
type Receipt = { state: "complete"; operationId: string; result: unknown; indexRevision: string; indexState: "needs_checkpoint" | "checkpoint_confirmed" };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/);
const refSchema = z.object({ id: identifier, version: z.number().int().positive().max(2147483647), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const counter = z.number().int().nonnegative().safe();
const searchResult = z.object({ candidates: z.array(refSchema.extend({ via: z.array(z.enum(["chunks", "graph"])).max(2), relationCount: counter })).max(10), missing: z.array(refSchema).max(64) }).strict();
export const searchTicketSchema = z.object({alias:z.string().min(1).max(256),requestHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:z.string().regex(/^[a-f0-9]{64}$/),indexEpoch:z.string().min(1).max(256),indexRevision:z.union([z.literal("empty"),z.string().regex(/^[a-f0-9]{64}$/)])}).strict();
export function parseSearchTicket(input:unknown):SearchTicket {return searchTicketSchema.parse(input);}
export class CogneeEngine implements EnginePort {
  private busy = false;
  private quarantined = false;
  private activeEpoch: string | null = null;
  private rebuilding = false;
  private maintaining = false;
  private maintenanceReturned = false;
  private maintenanceEffects = new Set<Promise<unknown>>();
  private scope: Readonly<{ installationId: string; generation: string }>;
  constructor(scope: { installationId: string; generation: string }, private store: EngineStore, private container: ContainerPort,
    private guard: EngineGuard, private clock = Date.now) { this.scope = Object.freeze({ installationId: scope.installationId, generation: scope.generation }); }
  async ingest(input: EngineIngest): Promise<unknown> {
    return this.ingestSource(input);
  }
  async ingestForRebuild(input: EngineIngest, indexEpoch: string, owner: string): Promise<unknown> {
    if (!this.busy || !this.rebuilding) return { state: "blocked", reason: "rebuild_fenced" };
    return this.ingestSource(input, indexEpoch, owner);
  }
  private async ingestSource(input: EngineIngest, rebuildEpoch?: string, rebuildOwner?: string): Promise<unknown> {
    try {
      input = JSON.parse(JSON.stringify(input)) as EngineIngest;
      const s = input.source, f = s.fence.source;
      if (s.id !== f.id || !s.text || await sourceTextHash(s.text) !== f.hash) throw 0;
      const source = refSchema.extend({ text: z.string().min(1), occurredAt: counter, authorId: identifier.optional(), projectId: identifier.optional() }).strict().parse({ id: s.id, version: f.version, hash: f.hash, text: s.text, occurredAt: s.occurredAt,
        ...(s.authorId !== null ? { authorId: s.authorId } : {}), ...(f.projectId !== null ? { projectId: f.projectId } : {}) });
      return this.run("/ingest", { source }, input.actor, [{ source: s.fence, ...(input.origin ? { origin: input.origin } : {}) }], rebuildEpoch, rebuildOwner);
    } catch { return { state: "blocked", reason: "invalid_source" }; }
  }
  private validateSearch(input: EngineSearch) {
    input = JSON.parse(JSON.stringify(input)) as EngineSearch;
    if (bytes(input)>65536 || !input.query.trim() || new TextEncoder().encode(input.query).length > 2048 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10 || input.allowedSources.length > 64) throw 0;
    const refs = z.array(refSchema).parse(input.allowedSources);
    if (refs.length !== input.permits.length || new Set(refs.map(ref => ref.id)).size !== refs.length || refs.some((ref, i) => {
      const f = input.permits[i].source.source; return ref.id !== f.id || ref.version !== f.version || ref.hash !== f.hash;
    })) throw 0;
    return input;
  }
  private async coverageValid(proof?: CoverageProof) { return !proof || !!this.guard.checkCoverage && await this.guard.checkCoverage(proof); }
  private async ticketCurrent(ticket: SearchTicket, store = this.store) {
    const meta = await store.get<Meta>("index");
    return !!meta && !meta.lost && meta.namespace === JSON.stringify(this.scope) && meta.epoch === ticket.indexEpoch && meta.revision === ticket.indexRevision && !await store.get<boolean>("maintenance");
  }
  async prepare(alias: string, input: EngineSearch): Promise<PreparedSearch> {
    try {
      input = this.validateSearch(input);
      if(input.coverage && (input.coverage.actor!==JSON.stringify(input.actor) || input.coverage.inputHash!==await bridgeHash([input.actor,input.query,input.allowedSources,input.limit])))throw 0;
      if (!alias || alias.length > 256 || !input.allowedSources.length || !this.store.transaction || !await this.guard.check(input.actor,input.permits) || !await this.coverageValid(input.coverage)) throw 0;
      const requestHash = await bridgeHash(input), key = "search-ticket:" + await bridgeHash([this.scope,alias]);
      return await this.store.transaction(async store => {
        const prior = await store.get<TicketRecord>(key);
        if (prior) return prior.ticket.requestHash === requestHash ? { state: "prepared", ticket: prior.ticket } : { state: "blocked", reason: "ticket_conflict" };
        const meta = await store.get<Meta>("index");
        if (!meta?.epoch || !await this.ticketCurrent({ indexEpoch: meta.epoch,indexRevision: meta.revision } as SearchTicket,store)) return { state: "blocked", reason: "index_unavailable" };
        const wire = {query:input.query,allowedSources:input.allowedSources,limit:input.limit};
        const ticket = {alias,requestHash,operationId:await bridgeHash([this.scope,meta.epoch,"/search",wire,meta.revision]),indexEpoch:meta.epoch,indexRevision:meta.revision};
        await store.put(key,{ticket,input,state:"prepared"} satisfies TicketRecord); return {state:"prepared",ticket};
      });
    } catch { return {state:"blocked",reason:"invalid_search"}; }
  }
  private async ticketRecord(ticket: SearchTicket): Promise<TicketRecord | undefined> {
    try{ticket=parseSearchTicket(ticket);}catch{return;}
    const row = await this.store.get<TicketRecord>("search-ticket:"+await bridgeHash([this.scope,ticket.alias]));
    return row && JSON.stringify(row.ticket) === JSON.stringify(ticket) ? row : undefined;
  }
  async lookupTicket(ticket: SearchTicket): Promise<EngineSearchOutcome> {
    const row = await this.ticketRecord(ticket);
    if (!row) return {state:"blocked",reason:"ticket_denied"};
    if (!await this.ticketCurrent(ticket)) return {state:"blocked",reason:"index_changed",operationId:ticket.operationId};
    if (!await this.guard.check(row.input.actor,row.input.permits) || !await this.coverageValid(row.input.coverage)) return {state:"blocked",reason:"source_denied",operationId:ticket.operationId};
    // The ticket owns the current principal/proof. A shared exact receipt may
    // have been produced under an earlier proof, whose revocation is unrelated.
    const receipt = await this.store.get<Receipt>(`receipt:${ticket.operationId}`);
    return receipt?.state === "complete" && receipt.operationId===ticket.operationId && receipt.indexRevision===ticket.indexRevision && await this.ticketCurrent(ticket) && await this.coverageValid(row.input.coverage) ? receipt as EngineSearchOutcome : {state:"uncertain",reason:row.state === "prepared" ? "not_submitted" : "engine_operation_uncertain",operationId:ticket.operationId};
  }
  async submit(ticket: SearchTicket): Promise<EngineSearchOutcome> {
    const row = await this.ticketRecord(ticket);
    if (!row || !this.store.transaction) return {state:"blocked",reason:"ticket_denied"};
    if (!await this.ticketCurrent(ticket)) return {state:"blocked",reason:"index_changed",operationId:ticket.operationId};
    if (!await this.guard.check(row.input.actor,row.input.permits) || !await this.coverageValid(row.input.coverage)) return {state:"blocked",reason:"source_denied",operationId:ticket.operationId};
    const claimed = await this.store.transaction(async store => {
      const key="search-ticket:"+await bridgeHash([this.scope,ticket.alias]), current=await store.get<TicketRecord>(key);
      if (!current || current.state !== "prepared" || !await this.ticketCurrent(ticket,store)) return false;
      await store.put(key,{...current,state:"attempting"}); return true;
    });
    if (!claimed) return this.lookupTicket(ticket);
    return this.run("/search",{query:row.input.query,allowedSources:row.input.allowedSources,limit:row.input.limit},row.input.actor,row.input.permits,undefined,undefined,{ticket,coverage:row.input.coverage}) as Promise<EngineSearchOutcome>;
  }
  async search(input: EngineSearch): Promise<EngineSearchOutcome> {
    try {
      input=this.validateSearch(input);
      if (!input.allowedSources.length) return { state: "complete", operationId: await bridgeHash([this.scope, "empty", input.query]), result: { candidates: [], missing: [] }, indexRevision: "empty", indexState: "needs_checkpoint" };
      return await this.run("/search", { query: input.query, allowedSources: input.allowedSources, limit: input.limit }, input.actor, input.permits) as EngineSearchOutcome;
    } catch { return {state:"blocked",reason:"invalid_search"}; }
  }
  async lookup(id: string): Promise<Receipt | { state: "uncertain" }> {
    if (!/^[a-f0-9]{64}$/.test(id) || await this.store.get<boolean>("maintenance")) return { state: "uncertain" };
    const receipt = await this.store.get<Receipt>(`receipt:${id}`), auth = await this.store.get<Pick<Active, "actor" | "permits" | "coverage">>(`access:${id}`);
    return receipt && auth && await this.guard.check(auth.actor, auth.permits) && await this.coverageValid(auth.coverage) ? receipt : { state: "uncertain" };
  }
  /** Named host lifecycle only. Normal calls cannot interleave with destruction
   * or reuse the rebuild capability; immutable callback epochs remain separate. */
  async rebuildExclusive<T>(operation: () => Promise<T>): Promise<T | { state: "blocked" | "uncertain"; reason: string }> {
    if (this.busy) return { state: "blocked", reason: "busy" };
    this.busy = true; this.rebuilding = true; this.activeEpoch = null;
    try { return await operation(); }
    catch { return { state: "uncertain", reason: "rebuild_operation_uncertain" }; }
    finally { this.rebuilding = false; this.busy = false; }
  }
  async destroyForRebuild(check: () => Promise<boolean>) {
    if (!this.busy || !this.rebuilding) throw new Error("rebuild_fenced");
    this.activeEpoch = null;
    const active = await this.store.get<Active>("active");
    if (active) await this.guard.revoke(active.token).catch(() => {});
    if (!await check()) throw new Error("rebuild_fenced");
    await this.container.destroy();
    if (this.container.running) throw new Error("rebuild_destroy_uncertain");
  }
  async freshForRebuild(epoch: string, owner: string, check: () => Promise<boolean>) {
    if (!this.busy || !this.rebuilding || this.container.running) throw new Error("rebuild_fenced");
    const meta = await this.store.get<Meta>("index");
    if (!meta || meta.epoch !== epoch || !await this.store.get<boolean>("maintenance")) throw new Error("rebuild_fenced");
    await this.container.deny(); if (!await check()) throw new Error("rebuild_fenced"); await this.container.start();
    const health = await this.container.request("/health", {}) as { namespace?: { installationId: string; generation: string }; ready?: boolean; poisoned?: boolean };
    if (bytes(health) > 4096 || health.namespace?.installationId !== this.scope.installationId || health.namespace.generation !== this.scope.generation || !health.ready || health.poisoned) throw new Error("rebuild_health");
    if (!this.store.putFenced) throw new Error("rebuild_fenced");
    await this.store.putFenced("index", { ...meta, lost: false }, epoch, owner);
    await this.store.putFenced("active", null, epoch, owner); await this.store.putFenced("quarantine", false, epoch, owner); this.quarantined = false;
  }
  /** Host-only lifecycle exclusion. Callback contains trusted checkpoint code,
   * never a model tool, URL or caller-supplied command. Persisted gate survives DO restart. */
  async maintain<T>(operation: (plan: CheckpointPlan | null) => Promise<{ value: T; restored?: CheckpointPlan }>, recovering = false): Promise<T | { state: "blocked" | "uncertain" | "rebuild_required"; reason: string }> {
    if (this.busy) return { state: "blocked", reason: "busy" }; this.busy = true; this.activeEpoch = null;
    this.maintaining = true; this.maintenanceReturned = false;
    try {
      const active = await this.store.get<Active>("active");
      if (active && !recovering) return { state: "blocked", reason: "restart_uncertain" };
      const meta = await this.store.get<Meta>("index");
      if (!recovering && (!meta?.epoch || !meta.sources || meta.lost || !this.container.running)) return { state: "rebuild_required", reason: "index_lost" };
      const outcome = await operation(meta?.epoch && meta.sources ? { indexEpoch: meta.epoch, indexRevision: meta.revision, sources: JSON.parse(JSON.stringify(meta.sources)) } : null);
      if (outcome.restored) {
        const checkpoint = await this.store.get<CheckpointState>("checkpoint"), current = await this.store.get<Meta>("index");
        if (!this.container.running || checkpoint?.phase !== "confirmed" || !checkpoint.confirmed ||
          checkpoint.confirmed.manifest.indexEpoch !== outcome.restored.indexEpoch || checkpoint.confirmed.manifest.indexRevision !== outcome.restored.indexRevision ||
          current?.epoch !== outcome.restored.indexEpoch || current.revision !== outcome.restored.indexRevision || current.lost ||
          await this.store.get<boolean>("maintenance") !== false || await this.store.get<boolean>("quarantine") !== false) throw 0;
        // Persistent publication belongs to the checkpoint store's owner/epoch
        // transaction. The lifecycle envelope must never rewrite its result.
        this.quarantined = false;
      }
      return outcome.value;
    } catch { return { state: "uncertain", reason: "checkpoint_operation_uncertain" }; }
    finally { this.maintenanceReturned = true; this.releaseMaintenance(); }
  }
  private releaseMaintenance() {
    if (this.maintenanceReturned && !this.maintenanceEffects.size) { this.maintaining = false; this.busy = false; }
  }
  /** The underlying promise outlives a caller's timeout. Keep physical lifecycle
   * exclusion until it settles; a timed-out destroy cannot race a fresh boot. */
  async checkpointEffect<T>(effect: () => Promise<T>): Promise<T> {
    if (!this.busy || !this.maintaining) throw new Error("checkpoint_fenced");
    const pending = effect(); this.maintenanceEffects.add(pending);
    try { return await pending; }
    finally { this.maintenanceEffects.delete(pending); this.releaseMaintenance(); }
  }
  async authorize(epoch: string): Promise<{ token: string; period: string; mode?: "replay_only"; coverage?: CoverageProof } | null> {
    if (!epoch || epoch !== this.activeEpoch) return null;
    const active = await this.store.get<Active>("active");
    if (!active || active.epoch !== epoch || active.until <= this.clock() || !await this.guard.check(active.actor, active.permits) || !await this.coverageValid(active.coverage)) return null;
    if (active.searchIndex && !await this.ticketCurrent({ indexEpoch: active.searchIndex.epoch,indexRevision: active.searchIndex.revision } as SearchTicket)) return null;
    const maintenance = await this.store.get<boolean>("maintenance");
    if (maintenance && active.mode !== "replay_only") return null;
    if (active.mode === "replay_only") {
      const run = await this.store.get<RebuildState>("rebuild");
      if (!maintenance || run?.phase !== "materializing" || run.indexEpoch !== active.indexEpoch || run.owner !== active.owner) return null;
    }
    const current = await this.store.get<Active>("active");
    return current?.epoch === epoch ? { token: active.token, period: active.period, ...(active.mode ? { mode: active.mode } : {}), ...(active.coverage ? {coverage:active.coverage} : {}) } : null;
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
  private async run(path: "/ingest" | "/search", wire: Record<string, unknown>, actor: TrustedActor, permits: EnginePermit[], rebuildEpoch?: string, rebuildOwner?: string, prepared?: {ticket:SearchTicket;coverage?:CoverageProof}): Promise<unknown> {
    const nested = !!rebuildEpoch && this.busy && this.rebuilding;
    if (this.busy && !nested) return { state: "blocked", reason: "busy" }; if (!nested) this.busy = true;
    let active: Active | undefined, timer: ReturnType<typeof setTimeout> | undefined; const controller = new AbortController();
    const write = (key: string, value: unknown) => rebuildEpoch ? this.store.putFenced ? this.store.putFenced(key, value, rebuildEpoch, rebuildOwner!) : Promise.reject(new Error("rebuild_fenced")) : this.store.put(key, value);
    try {
      if (bytes({ wire, actor, permits }) > 65536 || permits.some(p => p.source.installationId !== this.scope.installationId || p.source.generation !== this.scope.generation)
        || !await this.guard.check(actor, permits) || !await this.coverageValid(prepared?.coverage)) return { state: "blocked", reason: "source_denied" };
      if (prepared && !await this.ticketCurrent(prepared.ticket)) return {state:"blocked",reason:"index_changed",operationId:prepared.ticket.operationId};
      const previous = await this.store.get<Active>("active");
      if (previous) { if (!rebuildEpoch) await this.stop(previous); return { state: "blocked", reason: "restart_uncertain" }; }
      if (rebuildEpoch) {
        const rebuild = await this.store.get<RebuildState>("rebuild"), source = permits[0]?.source.source, expected = rebuild?.sources[rebuild.next];
        if (!nested || path !== "/ingest" || rebuild?.phase !== "materializing" || rebuild.indexEpoch !== rebuildEpoch || rebuild.owner !== rebuildOwner ||
          !expected || expected.id !== source.id || expected.revision !== source.revision || expected.version !== source.version || expected.hash !== source.hash) return { state: "blocked", reason: "rebuild_fenced" };
      } else if (await this.store.get<boolean>("maintenance")) return { state: "blocked", reason: "checkpoint_pending" };
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
      const operationId = await bridgeHash([this.scope, meta.epoch, path, wire, path === "/search" ? meta.revision : null]);
      const prior = await this.store.get<Receipt>(`receipt:${operationId}`);
      if (prior) return await this.guard.check(actor, permits) && await this.coverageValid(prepared?.coverage) ? { ...prior, indexState: meta.indexState ?? "needs_checkpoint" } : { state: "blocked", reason: "source_denied", operationId };
      await write(`access:${operationId}`, { actor, permits, ...(prepared?.coverage ? {coverage:prepared.coverage} : {}) });
      active = { epoch: crypto.randomUUID(), operationId, token: await this.guard.issue(permits[0].source, this.clock() + 300000),
        ...(prepared ? {searchIndex:{epoch:prepared.ticket.indexEpoch,revision:prepared.ticket.indexRevision},...(prepared.coverage ? {coverage:prepared.coverage}: {})} : {}),
        period: new Date(this.clock()).toISOString().slice(0, 10), actor, permits, until: this.clock() + 250000,
        ...(rebuildEpoch ? { mode: "replay_only" as const, indexEpoch: rebuildEpoch, owner: rebuildOwner } : {}) };
      await write("active", active); this.activeEpoch = active.epoch; await this.container.intercept(active.epoch);
      if (rebuildEpoch && !await this.authorize(active.epoch)) throw new Error("rebuild_fenced");
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("engine_timeout")); }, 250000); });
      const value = await Promise.race([this.container.request(path, { operationId, ...wire }, controller.signal), deadline]);
      if (!await this.authorize(active.epoch)) { if (!rebuildEpoch) await this.stop(active); return { state: "blocked", reason: "source_denied", operationId }; }
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
          sources: [...(meta.sources ?? []).filter(ref => ref.id !== f.id), { id: f.id, revision: f.revision, version: f.version, hash: f.hash }] }; await write("index", meta);
      }
      const receipt: Receipt = { state: "complete", operationId, result, indexRevision: meta.revision, indexState: meta.indexState ?? "needs_checkpoint" };
      await write(`receipt:${operationId}`, receipt);
      if (!await this.authorize(active.epoch)) { if (!rebuildEpoch) await this.stop(active); return { state: "blocked", reason: "source_denied", operationId }; }
      this.activeEpoch = null; await this.container.deny(); await this.guard.revoke(active.token); await write("active", null);
      return await this.guard.check(actor, permits) && await this.coverageValid(prepared?.coverage) && (!prepared || await this.ticketCurrent(prepared.ticket)) ? receipt : { state: "blocked", reason: "source_denied", operationId };
    } catch {
      if (!rebuildEpoch) await this.stop(active).catch(() => {});
      else if (this.activeEpoch === active?.epoch) this.activeEpoch = null;
      return { state: "uncertain", reason: "engine_operation_uncertain", ...(active ? { operationId: active.operationId } : {}) };
    } finally { clearTimeout(timer); controller.abort(); if (!nested) this.busy = false; }
  }
}
