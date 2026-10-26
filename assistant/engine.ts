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
export type InitialIngestAdmission = {itemId:string;owner:string};
export type InitialIngestCheckInput = {actor:TrustedActor;source:{fence:SourceFence}};
export type InitialIngestTicket = {itemId:string;inputHash:string;indexEpoch:string;operationId:string};
type InitialIngest = {ticket:InitialIngestTicket;state:'reserved'|'attempting'|'complete'|'uncertain'};
const initialTicketSchema=z.object({itemId:z.string().regex(/^[a-f0-9]{64}$/),inputHash:z.string().regex(/^[a-f0-9]{64}$/),indexEpoch:z.string().uuid(),operationId:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const initialStateSchema=z.object({ticket:initialTicketSchema,state:z.enum(['reserved','attempting','complete','uncertain'])}).strict();
const sameInitial=(a:InitialIngestTicket,b:InitialIngestTicket)=>a.itemId===b.itemId&&a.inputHash===b.inputHash&&a.indexEpoch===b.indexEpoch&&a.operationId===b.operationId;
export type EngineSearchOutcome = { state: "complete"; operationId: string; result: { candidates: (Ref & { via: string[]; relationCount: number })[]; missing: Ref[] }; indexRevision: string; indexState: "needs_checkpoint" | "checkpoint_confirmed" }
  | { state: "blocked" | "uncertain"; reason: string; operationId?: string };
export interface EnginePort { search(input: EngineSearch): Promise<EngineSearchOutcome> }
export type SearchTicket = { alias: string; requestHash: string; operationId: string; indexEpoch: string; indexRevision: string };
export type PreparedSearch = { state: "prepared"; ticket: SearchTicket } | { state: "blocked"; reason: string };
type TicketRecord = { ticket: SearchTicket; input: EngineSearch; state: "prepared" | "attempting" };
export interface SemanticEnginePort { prepare(alias: string, input: EngineSearch): Promise<PreparedSearch>; submit(ticket: SearchTicket): Promise<EngineSearchOutcome>; lookupTicket(ticket: SearchTicket): Promise<EngineSearchOutcome> }
export interface EngineStore { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>;
  list?<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction?<T>(operation: (store: EngineStore) => Promise<T>): Promise<T>;
  putFenced?(key: string, value: unknown, indexEpoch: string, owner: string): Promise<void> }
export interface ContainerPort {
  readonly running: boolean;
  start(check?:()=>Promise<void>): Promise<void>;
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
  checkInitialAdmission?(admission:InitialIngestAdmission,input:InitialIngestCheckInput,indexEpoch?:string):Promise<boolean>;
}
type Active = { epoch: string; operationId: string; token: string; period: string; actor: TrustedActor; permits: EnginePermit[]; until: number; coverage?: CoverageProof; searchIndex?: { epoch: string; revision: string }; mode?: "replay_only"; indexEpoch?: string; owner?: string;initial?:{admission:InitialIngestAdmission;indexEpoch:string} };
type Meta = { namespace: string; revision: string; lost: boolean; epoch?: string; sources?: SourceStamp[]; indexState?: "needs_checkpoint" | "checkpoint_confirmed" };
type Receipt = { state: "complete"; operationId: string; result: unknown; indexRevision: string; indexState: "needs_checkpoint" | "checkpoint_confirmed" };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/);
const refSchema = z.object({ id: identifier, version: z.number().int().positive().max(2147483647), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const counter = z.number().int().nonnegative().safe();
const searchAdmissionSchema = z.object({ token: z.string().min(1).max(256), alias: z.string().max(256).nullable(), requestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
const searchResult = z.object({ candidates: z.array(refSchema.extend({ via: z.array(z.enum(["chunks", "graph"])).max(2), relationCount: counter })).max(10), missing: z.array(refSchema).max(64) }).strict();
export const searchTicketSchema = z.object({alias:z.string().min(1).max(256),requestHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:z.string().regex(/^[a-f0-9]{64}$/),indexEpoch:z.string().min(1).max(256),indexRevision:z.union([z.literal("empty"),z.string().regex(/^[a-f0-9]{64}$/)])}).strict();
export function parseSearchTicket(input:unknown):SearchTicket {return searchTicketSchema.parse(input);}
export class CogneeEngine implements EnginePort {
  private busy = false;
  private submitOwner: symbol | null = null;
  private submitReturned = false;
  private submitEffects = new Set<Promise<unknown>>();
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
  private async initialInput(input:EngineIngest,itemId:string){
    if(!/^[a-f0-9]{64}$/.test(itemId)||bytes(input)>65536||!input.source.text?.trim())throw Error('initial_input');
    const owned=await this.ingestInput(input),inputHash=await bridgeHash(canonical(owned.input));return {...owned,inputHash};
  }
  private async initialState(store:EngineStore=this.store):Promise<InitialIngest|undefined>{
    const raw=await store.get('initial-ingest-v1');return raw===undefined?undefined:initialStateSchema.parse(raw);
  }
  private async pristine(store:EngineStore){
    if(this.container.running||!store.list)return false;
    for(const key of ['index','active','checkpoint','rebuild','maintenance','quarantine']){const value=await store.get(key);if(value!==undefined)return false;}
    for(const prefix of ['access:','receipt:','search-ticket:','search-operation:','search-operation-history-v1'])if((await store.list({prefix,limit:1})).size)return false;
    return !this.container.running;
  }
  /** Metadata reservation only: no index, process, permit or model operation. */
  async reserveInitialIngest(input:EngineIngest,admission:InitialIngestAdmission):Promise<{state:'reserved';ticket:InitialIngestTicket}|{state:'blocked'|'uncertain';reason:string}>{
    if(this.busy||!this.store.transaction)return {state:'blocked',reason:'initial_ingest_busy'};this.busy=true;
    try{admission={...admission};const owned=await this.initialInput(input,admission.itemId);
      if(!await this.guard.check(owned.input.actor,[{source:owned.input.source.fence,...(owned.input.origin?{origin:owned.input.origin}:{})}])||!await this.guard.checkInitialAdmission?.(admission,owned.input))return {state:'blocked',reason:'initial_ingest_denied'};
      return await this.store.transaction(async tx=>{const prior=await this.initialState(tx);
        if(prior){if(prior.state!=='reserved'||prior.ticket.itemId!==admission.itemId||prior.ticket.inputHash!==owned.inputHash)return {state:'uncertain' as const,reason:'initial_ingest_exists'};
          return await this.pristine(tx)?{state:'reserved' as const,ticket:prior.ticket}:{state:'blocked' as const,reason:'initial_index_not_pristine'};}
        if(!await this.pristine(tx))return {state:'blocked' as const,reason:'initial_index_not_pristine'};
        const indexEpoch=crypto.randomUUID(),operationId=await bridgeHash([this.scope,indexEpoch,'/ingest',{source:owned.source},null]);
        if(this.container.running)return {state:'blocked' as const,reason:'initial_index_not_pristine'};
        const ticket={itemId:admission.itemId,inputHash:owned.inputHash,indexEpoch,operationId};await tx.put('initial-ingest-v1',{ticket,state:'reserved'} satisfies InitialIngest);return {state:'reserved' as const,ticket};});
    }catch{return {state:'uncertain',reason:'initial_reservation_unknown'};}finally{this.busy=false;}
  }
  async initialIngestReceipt(input:EngineIngest,itemId:string,indexEpoch:string):Promise<Receipt|{state:'uncertain'}>{
    try{const owned=await this.initialInput(input,itemId),slot=await this.initialState();
      if(!slot||slot.ticket.itemId!==itemId||slot.ticket.inputHash!==owned.inputHash||slot.ticket.indexEpoch!==indexEpoch)return {state:'uncertain'};
      const result=await this.ingestReceipt(owned.input,indexEpoch);if(result.state!=='complete'||result.operationId!==slot.ticket.operationId)return {state:'uncertain'};return result;
    }catch{return {state:'uncertain'};}
  }
  async commitInitialIngest(input:EngineIngest,ticket:InitialIngestTicket,admission:InitialIngestAdmission):Promise<unknown>{
    try{ticket=initialTicketSchema.parse(ticket);admission={...admission};const owned=await this.initialInput(input,admission.itemId);
      if(ticket.itemId!==admission.itemId||ticket.inputHash!==owned.inputHash)return {state:'blocked',reason:'initial_input_changed'};
      const slot=await this.initialState();if(!slot||!sameInitial(slot.ticket,ticket))return {state:'blocked',reason:'initial_ticket_changed'};
      if(slot.state!=='reserved')return this.initialIngestReceipt(owned.input,admission.itemId,ticket.indexEpoch);
      return this.ingestSource(owned.input,undefined,undefined,{ticket,admission});
    }catch{return {state:'blocked',reason:'initial_input_changed'};}
  }
  async ingestForRebuild(input: EngineIngest, indexEpoch: string, owner: string): Promise<unknown> {
    if (!this.busy || !this.rebuilding) return { state: "blocked", reason: "rebuild_fenced" };
    return this.ingestSource(input, indexEpoch, owner);
  }
  private async ingestInput(input: EngineIngest) {
    input = JSON.parse(JSON.stringify(input)) as EngineIngest;
    const s = input.source, f = s.fence.source;
    if (s.id !== f.id || !s.text || await sourceTextHash(s.text) !== f.hash) throw 0;
    const source = refSchema.extend({ text: z.string().min(1), occurredAt: counter, authorId: identifier.optional(), projectId: identifier.optional() }).strict().parse({ id: s.id, version: f.version, hash: f.hash, text: s.text, occurredAt: s.occurredAt,
      ...(s.authorId !== null ? { authorId: s.authorId } : {}), ...(f.projectId !== null ? { projectId: f.projectId } : {}) });
    return { input, source };
  }
  private async ingestSource(input: EngineIngest, rebuildEpoch?: string, rebuildOwner?: string,initial?:{ticket:InitialIngestTicket;admission:InitialIngestAdmission}): Promise<unknown> {
    try {
      const owned = await this.ingestInput(input), s = owned.input.source;
      return this.run("/ingest", { source: owned.source }, owned.input.actor, [{ source: s.fence, ...(owned.input.origin ? { origin: owned.input.origin } : {}) }], rebuildEpoch, rebuildOwner,undefined,undefined,initial?{...initial,input:owned.input}:undefined);
    } catch { return { state: "blocked", reason: "invalid_source" }; }
  }
  /** Exact existing receipt only. Never starts, ingests or changes an epoch. */
  async ingestReceipt(input: EngineIngest, indexEpoch: string): Promise<Receipt | { state: "uncertain" }> {
    try {
      const owned = await this.ingestInput(input), meta = await this.store.get<Meta>("index");
      if (!meta || meta.epoch !== indexEpoch || meta.lost || !await this.guard.check(owned.input.actor,[{source:owned.input.source.fence,...(owned.input.origin?{origin:owned.input.origin}:{})}])) return {state:"uncertain"};
      const id = await bridgeHash([this.scope,indexEpoch,"/ingest",{source:owned.source},null]);
      return this.lookup(id);
    } catch { return {state:"uncertain"}; }
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
  /** One metadata upgrade, before any new search effect. Old aliases and direct
   * calls may already have admitted the same operation without its receipt.
   * Absence of that receipt cannot prove no execution occurred. */
  private async searchHistory(store: EngineStore): Promise<string | null> {
    const seal = await store.get<unknown>("search-operation-history-v1");
    if (seal !== undefined) return z.object({ version: z.literal(1) }).strict().safeParse(seal).success ? null : "operation_history_invalid";
    if (!store.list) return "operation_history_unavailable";
    const tickets = await store.list<unknown>({ prefix: "search-ticket:", limit: 257 });
    const accesses = await store.list<unknown>({ prefix: "access:", limit: 257 });
    if (tickets.size > 256 || accesses.size > 256) return "operation_history_capacity";
    const legacy: { operationId: string; alias: string | null; requestHash: string | null }[] = [];
    try {
      for (const raw of tickets.values()) {
        const row = z.object({ ticket: searchTicketSchema, state: z.enum(["prepared", "attempting"]) }).parse(raw);
        if (row.state === "attempting") legacy.push({ operationId: row.ticket.operationId, alias: row.ticket.alias, requestHash: row.ticket.requestHash });
      }
      for (const key of accesses.keys()) {
        const operationId = key.slice("access:".length); if (!/^[a-f0-9]{64}$/.test(operationId)) return "operation_history_invalid";
        const receipt = await store.get<Receipt>("receipt:" + operationId);
        if (receipt?.state !== "complete" || receipt.operationId !== operationId) legacy.push({ operationId, alias: null, requestHash: null });
      }
    } catch { return "operation_history_invalid"; }
    for (const item of legacy) {
      const prior = await store.get("search-operation:" + item.operationId);
      if (prior !== undefined && !searchAdmissionSchema.safeParse(prior).success) return "operation_history_invalid";
    }
    for (const item of legacy) if (await store.get("search-operation:" + item.operationId) === undefined) await store.put("search-operation:" + item.operationId, { token: crypto.randomUUID(), alias: item.alias, requestHash: item.requestHash });
    await store.put("search-operation-history-v1", { version: 1 }); return null;
  }
  private async admitSearch(store: EngineStore, operationId: string, token: string, ticket?: SearchTicket): Promise<string | null> {
    const history = await this.searchHistory(store); if (history) return history;
    const prior = await store.get("search-operation:" + operationId);
    if (prior !== undefined) return searchAdmissionSchema.safeParse(prior).success ? "engine_operation_uncertain" : "operation_history_invalid";
    await store.put("search-operation:" + operationId, { token, alias: ticket?.alias ?? null, requestHash: ticket?.requestHash ?? null }); return null;
  }
  private async observeSearchClaim(store: EngineStore, operationId: string) {
    const raw = await store.get("search-operation:" + operationId);
    return { reason: raw !== undefined && !searchAdmissionSchema.safeParse(raw).success ? "operation_history_invalid" : null, claimed: raw !== undefined };
  }
  async lookupTicket(ticket: SearchTicket): Promise<EngineSearchOutcome> {
    const row = await this.ticketRecord(ticket);
    if (!row) return {state:"blocked",reason:"ticket_denied"};
    if (!await this.ticketCurrent(ticket)) return {state:"blocked",reason:"index_changed",operationId:ticket.operationId};
    if (!await this.guard.check(row.input.actor,row.input.permits) || !await this.coverageValid(row.input.coverage)) return {state:"blocked",reason:"source_denied",operationId:ticket.operationId};
    // The ticket owns the current principal/proof. A shared exact receipt may
    // have been produced under an earlier proof, whose revocation is unrelated.
    const receipt = await this.store.get<Receipt>(`receipt:${ticket.operationId}`);
    if (receipt?.state === "complete" && receipt.operationId===ticket.operationId && receipt.indexRevision===ticket.indexRevision && await this.ticketCurrent(ticket) && await this.coverageValid(row.input.coverage)) return receipt as EngineSearchOutcome;
    if (!this.store.transaction) return { state: "blocked", reason: "operation_history_unavailable", operationId: ticket.operationId };
    const sealed = z.object({ version: z.literal(1) }).strict().safeParse(await this.store.get("search-operation-history-v1")).success;
    // The seal and operation claims are monotonic. Once migrated, lookup only
    // observes metadata; it does not need to open another write transaction.
    const admission = sealed ? await this.observeSearchClaim(this.store,ticket.operationId) : await this.store.transaction(async store => { const reason = await this.searchHistory(store), claim = await this.observeSearchClaim(store,ticket.operationId); return {...claim,reason:reason??claim.reason}; });
    if (admission.reason) return { state: "blocked", reason: admission.reason, operationId: ticket.operationId };
    return {state:"uncertain",reason:row.state === "prepared" && !admission.claimed ? "not_submitted" : "engine_operation_uncertain",operationId:ticket.operationId};
  }
  private async submitBlocked(ticket: SearchTicket, store = this.store): Promise<string | null> {
    if (!await this.ticketCurrent(ticket, store)) return "index_changed";
    if (await store.get<Active>("active")) return "restart_uncertain";
    if (await store.get<boolean>("maintenance")) return "checkpoint_pending";
    if (this.quarantined || await store.get<boolean>("quarantine")) return "index_lost";
    return this.container.running ? null : "index_lost";
  }
  private releaseSubmit(owner: symbol) {
    if (this.submitOwner === owner && this.submitReturned && !this.submitEffects.size) {
      this.submitOwner = null; this.busy = false;
    }
  }
  private async submitEffect<T>(owner: symbol, effect: () => Promise<T>): Promise<T> {
    if (this.submitOwner !== owner) throw new Error("submit_fenced");
    const pending = effect(); this.submitEffects.add(pending);
    try { return await pending; }
    finally { this.submitEffects.delete(pending); this.releaseSubmit(owner); }
  }
  async submit(ticket: SearchTicket): Promise<EngineSearchOutcome> {
    // Acquire before the first await and hand the same ownership into run.
    // A refused concurrent caller never releases the active owner's lock.
    if (this.busy) return {state:"blocked",reason:"busy"};
    const owner = Symbol("semantic-submit"); this.busy = true; this.submitOwner = owner; this.submitReturned = false;
    try {
      const row = await this.ticketRecord(ticket);
      if (!row || !this.store.transaction) return {state:"blocked",reason:"ticket_denied"};
      ticket = row.ticket; // Own the parsed identity across all subsequent awaits.
      if (!await this.guard.check(row.input.actor,row.input.permits) || !await this.coverageValid(row.input.coverage)) return {state:"blocked",reason:"source_denied",operationId:ticket.operationId};
      const blocked = await this.submitBlocked(ticket);
      if (blocked) return {state:"blocked",reason:blocked,operationId:ticket.operationId};
      const key="search-ticket:"+await bridgeHash([this.scope,ticket.alias]);
      const admissionToken = crypto.randomUUID();
      const claimed = await this.store.transaction<{ claimed: boolean; reason?: string }>(async store => {
        const current=await store.get<TicketRecord>(key);
        if (!current || JSON.stringify(current.ticket) !== JSON.stringify(ticket) || current.state !== "prepared") return {claimed:false};
        // Recheck every operational gate at the last point before admission.
        const reason = await this.submitBlocked(ticket,store);
        if (reason) return {claimed:false,reason};
        if (await store.get("receipt:" + ticket.operationId) !== undefined) return { claimed: false };
        const denied = await this.admitSearch(store, ticket.operationId, admissionToken, ticket);
        if (denied) return { claimed: false, reason: denied };
        await store.put(key,{...current,state:"attempting"}); return {claimed:true};
      });
      if (!claimed.claimed) return claimed.reason ? {state:claimed.reason === "engine_operation_uncertain" ? "uncertain" : "blocked",reason:claimed.reason,operationId:ticket.operationId} : this.lookupTicket(ticket);
      return await this.run("/search",{query:row.input.query,allowedSources:row.input.allowedSources,limit:row.input.limit},row.input.actor,row.input.permits,undefined,undefined,{ticket,coverage:row.input.coverage,admissionToken},owner) as EngineSearchOutcome;
    } finally { this.submitReturned = true; this.releaseSubmit(owner); }
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
    if(active.initial&&(!active.permits[0]||!await this.guard.checkInitialAdmission?.(active.initial.admission,{actor:active.actor,source:{fence:active.permits[0].source}},active.initial.indexEpoch)))return null;
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
  private async run(path: "/ingest" | "/search", wire: Record<string, unknown>, actor: TrustedActor, permits: EnginePermit[], rebuildEpoch?: string, rebuildOwner?: string, prepared?: {ticket:SearchTicket;coverage?:CoverageProof;admissionToken:string}, submitOwner?: symbol,initial?:{ticket:InitialIngestTicket;admission:InitialIngestAdmission;input:EngineIngest}): Promise<unknown> {
    const nested = (!!rebuildEpoch && this.busy && this.rebuilding) || (!!submitOwner && this.busy && this.submitOwner === submitOwner);
    if (this.busy && !nested) return { state: "blocked", reason: "busy" }; if (!nested) this.busy = true;
    let active: Active | undefined, timer: ReturnType<typeof setTimeout> | undefined; const controller = new AbortController();
    const write = (key: string, value: unknown) => rebuildEpoch ? this.store.putFenced ? this.store.putFenced(key, value, rebuildEpoch, rebuildOwner!) : Promise.reject(new Error("rebuild_fenced")) : this.store.put(key, value);
    const initialCheck=async()=>{if(!initial)return;const slot=await this.initialState();
      if(!slot||slot.state!=='attempting'||!sameInitial(slot.ticket,initial.ticket)||!await this.guard.check(actor,permits)||!await this.guard.checkInitialAdmission?.(initial.admission,initial.input,initial.ticket.indexEpoch))throw Error('initial_ingest_fenced');};
    try {
      let initialSlot:InitialIngest|undefined;
      try{initialSlot=await this.initialState();}catch{return {state:'blocked',reason:'initial_state_invalid'};}
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
      const rawMeta=await this.store.get<unknown>("index");
      if(rawMeta!==undefined&&(!rawMeta||typeof rawMeta!=='object'||Array.isArray(rawMeta)))return {state:'blocked',reason:'index_lost'};
      let meta = rawMeta as Meta|undefined; const namespace = JSON.stringify(this.scope);
      if(!initial&&!rebuildEpoch&&initialSlot&&initialSlot.state!=='complete'&&(!meta||meta.epoch===initialSlot.ticket.indexEpoch))return {state:'blocked',reason:'initial_ingest_reserved'};
      if (meta && (meta.namespace !== namespace || meta.lost || !this.container.running)) return { state: "blocked", reason: "index_lost" };
      if (!meta) {
        if(initial&&!await this.guard.checkInitialAdmission?.(initial.admission,initial.input,initial.ticket.indexEpoch))return {state:'blocked',reason:'initial_ingest_denied'};
        meta = { namespace, revision: "empty", epoch: initial?.ticket.indexEpoch??crypto.randomUUID(), sources: [], indexState: "needs_checkpoint", lost: false };
        const next=meta,claimed=this.store.transaction?await this.store.transaction(async tx=>{
          if(await tx.get('index')!==undefined)return false;let slot:InitialIngest|undefined;try{slot=await this.initialState(tx);}catch{return false;}
          if(initial){if(!slot||slot.state!=='reserved'||!sameInitial(slot.ticket,initial.ticket)||!await this.pristine(tx))return false;await tx.put('initial-ingest-v1',{...slot,state:'attempting'} satisfies InitialIngest);}
          else if(slot)return false;await tx.put('index',next);return true;
        }):!initial&&!initialSlot?(await this.store.put('index',next),true):false;
        if(!claimed)return {state:'blocked',reason:'initial_index_not_pristine'};
        await initialCheck();await this.container.deny();await initialCheck();if(initial&&this.container.running)throw Error('initial_process_not_stopped');await this.container.start(initial?initialCheck:undefined);await initialCheck();
        const health = await this.container.request("/health", {});
        const h = health as { namespace?: { installationId: string; generation: string }; ready?: boolean; poisoned?: boolean };
        if (bytes(health) > 4096 || h.namespace?.installationId !== this.scope.installationId || h.namespace.generation !== this.scope.generation || !h.ready || h.poisoned) throw 0;
      }
      const operationId = await bridgeHash([this.scope, meta.epoch, path, wire, path === "/search" ? meta.revision : null]);
      if(initial&&operationId!==initial.ticket.operationId)throw Error('initial_operation_changed');
      const prior = await this.store.get<Receipt>(`receipt:${operationId}`);
      if (prior) return await this.guard.check(actor, permits) && await this.coverageValid(prepared?.coverage) ? { ...prior, indexState: meta.indexState ?? "needs_checkpoint" } : { state: "blocked", reason: "source_denied", operationId };
      if (path === "/search") {
        if (prepared) {
          const claim = searchAdmissionSchema.safeParse(await this.store.get("search-operation:" + operationId));
          if (operationId !== prepared.ticket.operationId || !claim.success || claim.data.token !== prepared.admissionToken || claim.data.alias !== prepared.ticket.alias || claim.data.requestHash !== prepared.ticket.requestHash) return { state: "uncertain", reason: "engine_operation_uncertain", operationId };
        } else {
          if (!this.store.transaction) return { state: "blocked", reason: "operation_history_unavailable", operationId };
          const denied = await this.store.transaction(store => this.admitSearch(store, operationId, crypto.randomUUID()));
          if (denied) return { state: denied === "engine_operation_uncertain" ? "uncertain" : "blocked", reason: denied, operationId };
        }
        if (!await this.guard.check(actor, permits) || !await this.coverageValid(prepared?.coverage)) return { state: "blocked", reason: "source_denied", operationId };
      }
      await write(`access:${operationId}`, { actor, permits, ...(prepared?.coverage ? {coverage:prepared.coverage} : {}) });
      active = { epoch: crypto.randomUUID(), operationId, token: await this.guard.issue(permits[0].source, this.clock() + 300000),
        ...(initial?{initial:{admission:initial.admission,indexEpoch:initial.ticket.indexEpoch}}:{}),
        ...(prepared ? {searchIndex:{epoch:prepared.ticket.indexEpoch,revision:prepared.ticket.indexRevision},...(prepared.coverage ? {coverage:prepared.coverage}: {})} : {}),
        period: new Date(this.clock()).toISOString().slice(0, 10), actor, permits, until: this.clock() + 250000,
        ...(rebuildEpoch ? { mode: "replay_only" as const, indexEpoch: rebuildEpoch, owner: rebuildOwner } : {}) };
      await write("active", active); this.activeEpoch = active.epoch; await this.container.intercept(active.epoch);
      if (rebuildEpoch && !await this.authorize(active.epoch)) throw new Error("rebuild_fenced");
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("engine_timeout")); }, 250000); });
      const request = async() => {await initialCheck();return this.container.request(path, { operationId, ...wire }, controller.signal);};
      const value = await Promise.race([submitOwner ? this.submitEffect(submitOwner,request) : request(), deadline]);
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
      if(initial){const slot=await this.initialState();if(slot?.state==='attempting'&&slot.ticket.operationId===operationId)await this.store.put('initial-ingest-v1',{...slot,state:'complete'} satisfies InitialIngest);}
      if (!await this.authorize(active.epoch)) { if (!rebuildEpoch) await this.stop(active); return { state: "blocked", reason: "source_denied", operationId }; }
      this.activeEpoch = null; await this.container.deny(); await this.guard.revoke(active.token); await write("active", null);
      return await this.guard.check(actor, permits) && await this.coverageValid(prepared?.coverage) && (!prepared || await this.ticketCurrent(prepared.ticket)) ? receipt : { state: "blocked", reason: "source_denied", operationId };
    } catch {
      if(initial){try{const slot=await this.initialState();if(slot?.state==='attempting'&&slot.ticket.operationId===initial.ticket.operationId)await this.store.put('initial-ingest-v1',{...slot,state:'uncertain'} satisfies InitialIngest);}catch{/* Persisted attempting is already fail closed. */}}
      if (!rebuildEpoch) await this.stop(active).catch(() => {});
      else if (this.activeEpoch === active?.epoch) this.activeEpoch = null;
      return { state: "uncertain", reason: "engine_operation_uncertain", ...(active ? { operationId: active.operationId } : {}) };
    } finally { clearTimeout(timer); controller.abort(); if (!nested) this.busy = false; }
  }
}
function canonical(value:unknown):unknown{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])])):value;}
