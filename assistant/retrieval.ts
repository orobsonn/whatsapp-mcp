import { z } from "zod";
import { storedMediaEvidence, type MediaEvidence } from "./media-evidence";
import { SourceAccess, type SourceRead, type TrustedActor } from "./access";
import type { SourceScope } from "./sources";
import type { EntityRef } from "./relations";
import type { OriginFence, OriginGuard } from "./origin-guard";
import type { Ref, EngineSearch as EngineRequest } from "./engine";
export type { Ref, EngineRequest };
// Host39's typed EnginePort is structurally compatible; unknown deliberately
// requires runtime validation of every candidate and missing reference here.
export interface EnginePort { search(input: EngineRequest): Promise<unknown> }
export type RetrievalInput = { query: string; projectId?: string; entities?: EntityRef[]; limit?: number };
export type RetrievedSource = SourceRead & { origin?: OriginFence; mediaEvidence?: MediaEvidence };
export type EngineReceipt = { state: "complete" | "blocked" | "uncertain"; operationId: string; indexRevision?: string; indexState?: "needs_checkpoint" | "checkpoint_confirmed" };
export type RetrievalResult = { sources: RetrievedSource[]; engineReceipt?: EngineReceipt; coverage: { inventoryComplete: boolean; engine: string; gaps: string[] } };
const label = z.string().min(1).max(256), entity = z.object({ kind: z.enum(["person", "project", "mission"]), id: label }).strict();
const inputSchema = z.object({ query: z.string().min(1).max(2048), projectId: label.optional(), entities: z.array(entity).max(8).optional(), limit: z.number().int().min(1).max(10).default(10) });
const refSchema = z.object({ id: label, version: z.number().int().positive().max(2147483647), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const engineSchema = z.object({ state: z.literal("complete"), operationId: z.string().regex(/^[a-f0-9]{64}$/), indexRevision: z.union([z.literal("empty"), z.string().regex(/^[a-f0-9]{64}$/)]),
  indexState: z.enum(["needs_checkpoint", "checkpoint_confirmed"]), result: z.object({
    candidates: z.array(refSchema.extend({ via: z.array(z.enum(["chunks", "graph"])).min(1).max(2), relationCount: z.number().int().nonnegative().max(1000000) }).strict()).max(10),
    missing: z.array(refSchema).max(64),
  }).strict(),
}).strict();
const stop = new Set("a o as os de da do das dos e que qual quais quem como quando para por em no na nos nas com um uma se eu".split(" "));
const tokens = (text: string) => [...new Set(text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter((word) => word.length > 1 && !stop.has(word));
const key = (ref: Ref) => JSON.stringify([ref.id, ref.version, ref.hash]);
const object = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
function keysOnly(value: Record<string, unknown>, allowed: string[]) {
  for (const key in value) if (Object.hasOwn(value, key) && !allowed.includes(key)) return false;
  return true;
}
function boundedResult(raw: unknown) {
  if (!object(raw) || !keysOnly(raw, ["state", "operationId", "indexRevision", "indexState", "result"]) ||
    typeof raw.operationId !== "string" || raw.operationId.length !== 64 || typeof raw.indexRevision !== "string" || raw.indexRevision.length > 128 ||
    !object(raw.result) || !keysOnly(raw.result, ["candidates", "missing"]) || !Array.isArray(raw.result.candidates) || raw.result.candidates.length > 10 ||
    !Array.isArray(raw.result.missing) || raw.result.missing.length > 64) throw new Error("engine_invalid");
  for (const row of [...raw.result.candidates, ...raw.result.missing]) {
    if (!object(row) || !keysOnly(row, ["id", "version", "hash", ...(row.via === undefined ? [] : ["via", "relationCount"])]) || typeof row.id !== "string" || row.id.length > 256 || typeof row.hash !== "string" || row.hash.length !== 64 ||
      (row.via !== undefined && (!Array.isArray(row.via) || row.via.length > 2))) throw new Error("engine_invalid");
  }
  return engineSchema.parse(raw);
}
export function ownActor(actor: TrustedActor): TrustedActor {
  if (actor.kind === "owner" || actor.kind === "extractor") return Object.freeze({ kind: actor.kind });
  const copy = { kind: actor.kind, provider: actor.provider, address: actor.address, conversationId: actor.conversationId,
    conversationKind: actor.conversationKind, action: actor.action, ...(actor.mandateId ? { mandateId: actor.mandateId } : {}) };
  if ([copy.provider, copy.address, copy.conversationId, copy.action, copy.mandateId ?? ""].some((value) => typeof value !== "string" || value.length > 256)) throw new Error("retrieval_actor");
  return Object.freeze(copy);
}
export function normalizeRetrievalInput(input: RetrievalInput) {
  if (!input || typeof input.query !== "string" || input.query.length > 2048 || (input.entities && input.entities.length > 8) ||
    (input.projectId !== undefined && (typeof input.projectId !== "string" || input.projectId.length > 256))) throw new Error("retrieval_input");
  const request = inputSchema.parse(input);
  if (new TextEncoder().encode(request.query).length > 2048 || !request.query.trim() || tokens(request.query).length > 32) throw new Error("retrieval_input");
  return request;
}
// Outputs are fenced observations, never permission to publish or execute.
// Coverage describes this bounded authorized pack, not the existence of facts.
export class Retrieval {
  private readonly scope: SourceScope;
  private readonly access: SourceAccess;
  constructor(private readonly db: D1Database, scope: SourceScope, private readonly engine?: EnginePort,
    private readonly origin?: OriginGuard, private readonly clock = Date.now, private readonly timeoutMs = 2000) {
    this.scope = Object.freeze({ ...scope }); this.access = new SourceAccess(db, this.scope, clock);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("retrieval_deadline");
  }
  private async relationScore(source: SourceRead, terms: string[], entities: EntityRef[], gap: (reason: string) => void) {
    const rows = await this.db.prepare(`SELECT claims_json FROM assistant_relation_batches WHERE installation_id=? AND generation=?
      AND source_id=? AND source_revision=? AND source_version=? AND source_hash=? ORDER BY operation_key LIMIT 17`)
      .bind(this.scope.installationId, this.scope.generation, source.id, source.fence.source.revision, source.fence.source.version, source.fence.source.hash).all<{ claims_json: string }>();
    if (rows.results.length > 16 || rows.results.reduce((sum, row) => sum + row.claims_json.length, 0) > 65536) { gap("relation_limit"); return { score: 0, linked: false }; }
    let score = 0, linked = false;
    for (const row of rows.results) {
      const claims: unknown = JSON.parse(row.claims_json);
      if (!Array.isArray(claims) || claims.length > 32) { gap("relation_invalid"); continue; }
      for (const claim of claims) {
        if (!object(claim) || typeof claim.quote !== "string" || claim.quote.length > 4096 || !source.text?.includes(claim.quote) || typeof claim.predicate !== "string" || claim.predicate.length > 256) continue;
        const matches = entities.some((wanted) => [claim.subject, claim.object].some((ref) => object(ref) && ref.kind === wanted.kind && ref.id === wanted.id));
        linked ||= matches;
        if (terms.some((term) => tokens(`${claim.predicate} ${claim.quote}`).includes(term))) score++;
      }
    }
    return { score, linked };
  }
  async evidence(source: SourceRead) {
    return storedMediaEvidence(this.db, this.scope, { id: source.id, revision: source.fence.source.revision, version: source.fence.source.version, hash: source.fence.source.hash });
  }
  async scoreOriginal(source: SourceRead, input: RetrievalInput) {
    const request = normalizeRetrievalInput(input), terms = tokens(request.query), words = new Set(tokens((source.text ?? "") + " " + ((await this.evidence(source))?.text ?? "")));
    const gaps: string[] = []; let relations = { score: 0, linked: false };
    try { relations = await this.relationScore(source, terms, request.entities ?? [], reason => gaps.push(reason)); } catch { gaps.push("relation_unavailable"); }
    return { score: terms.filter(term => words.has(term)).length + relations.score * 2, linked: !request.entities?.length || relations.linked, gaps };
  }
  async search(actor: TrustedActor, input: RetrievalInput): Promise<RetrievalResult> {
    const request = normalizeRetrievalInput(input); actor = ownActor(actor);
    const terms = tokens(request.query);
    const gaps = new Set<string>(), gap = (reason: string) => { gaps.add(reason); };
    const coverage = { inventoryComplete: true, engine: "not_run", gaps: [] as string[] };
    let engineReceipt: EngineReceipt | undefined;
    const pack: { source: SourceRead; origin?: OriginFence; mediaEvidence?: MediaEvidence; score: number; linked: boolean }[] = [];
    let scanned = 0, after = "", finished = false;
    while (scanned < 256 && !finished) {
      const take = Math.min(32, 256 - scanned);
      const ids = await this.db.prepare(`SELECT id FROM assistant_sources WHERE installation_id=? AND generation=? AND status='active'
        AND id>? AND (? IS NULL OR project_id=?) ORDER BY id LIMIT ?`)
        .bind(this.scope.installationId, this.scope.generation, after, request.projectId ?? null, request.projectId ?? null, take).all<{ id: string }>();
      for (const row of ids.results) {
        scanned++; after = row.id;
        const source = await this.access.read(actor, row.id);
        if (!source) continue;
        if (request.projectId && source.fence.source.projectId !== request.projectId) { gap("source_changed"); continue; }
        if (source.text === null || source.text.length > 32768 || new TextEncoder().encode(source.text).length > 32768) { gap("source_text_limit"); continue; }
        let origin: OriginFence | undefined;
        if (source.fence.source.origin === "whatsapp") {
          const fence = await this.origin?.fence(source.id);
          if (!fence || !await this.origin!.check(fence)) { gap("origin_stale"); continue; }
          origin = fence;
        }
        if (pack.length === 64) { gap("source_limit"); coverage.inventoryComplete = false; finished = true; break; }
        const mediaEvidence = await this.evidence(source);
        if (mediaEvidence) gap("media_semantic_unsearched");
        if (mediaEvidence?.pages.some(page => page.state === "unreadable")) gap("media_unreadable_pages");
        const words = new Set(tokens(source.text + " " + (mediaEvidence?.text ?? "")));
        let relations = { score: 0, linked: false };
        try { relations = await this.relationScore(source, terms, request.entities ?? [], gap); } catch { gap("relation_unavailable"); }
        pack.push({ source, origin, ...(mediaEvidence ? { mediaEvidence } : {}), score: terms.filter((term) => words.has(term)).length + relations.score * 2, linked: relations.linked });
      }
      if (ids.results.length < take) finished = true;
    }
    if (!finished) { gap("inventory_limit"); coverage.inventoryComplete = false; }
    if (pack.length && this.engine) {
      const allowedSources = pack.map(({ source }) => ({ id: source.id, version: source.fence.source.version, hash: source.fence.source.hash }));
      const engineRequest: EngineRequest = { query: request.query, allowedSources, limit: request.limit, actor,
        permits: pack.map(({ source, origin }) => ({ source: source.fence, ...(origin ? { origin } : {}) })) };
      // Copies belong to this request; an adapter cannot mutate the local pack.
      const owned = JSON.parse(JSON.stringify(engineRequest)) as EngineRequest;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([this.engine.search(owned), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("deadline")), this.timeoutMs); })]);
        if (object(raw) && ["blocked", "uncertain"].includes(raw.state) && keysOnly(raw, ["state", "reason", "operationId"]) &&
          typeof raw.reason === "string" && raw.reason.length <= 80 && (raw.operationId === undefined || (typeof raw.operationId === "string" && /^[a-f0-9]{64}$/.test(raw.operationId)))) {
          if (raw.operationId) engineReceipt = { state: raw.state, operationId: raw.operationId };
          throw new Error("engine_unavailable");
        }
        let response: ReturnType<typeof boundedResult> | undefined;
        try {
          response = boundedResult(raw);
          const permitted = new Set(allowedSources.map(key)), seen = new Set<string>();
          if (response.result.candidates.length > request.limit || (response.result.missing.length && response.result.candidates.length)) throw new Error("engine_invalid");
          for (const candidate of response.result.candidates) if (new Set(candidate.via).size !== candidate.via.length) throw new Error("engine_invalid");
          for (const ref of [...response.result.candidates, ...response.result.missing]) {
            if (!permitted.has(key(ref)) || seen.has(ref.id)) throw new Error("engine_invalid");
            seen.add(ref.id);
          }
        } catch { coverage.engine = "invalid"; gap("engine_invalid"); response = undefined; }
        if (response) {
          engineReceipt = { state: "complete", operationId: response.operationId, indexRevision: response.indexRevision, indexState: response.indexState };
          coverage.engine = response.result.missing.length ? "partial" : "complete";
          if (response.result.missing.length) gap("index_missing");
          response.result.candidates.forEach((ref, index) => { pack.find((item) => item.source.id === ref.id)!.score += 1 / (index + 1); });
        }
      } catch { coverage.engine = "unavailable"; gap("engine_unavailable"); }
      finally { clearTimeout(timer); }
    } else if (pack.length) { coverage.engine = "unavailable"; gap("engine_unavailable"); }
    const selected = pack.filter((item) => item.score > 0 && (!request.entities?.length || item.linked)).sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id));
    const result: RetrievedSource[] = [];
    let bytes = 0;
    for (const item of selected) {
      // Recheck every lane, including pure lexical/relations, after ranking.
      const current = await this.access.read(actor, item.source.id, item.source.fence.source.revision);
      if (!current || JSON.stringify(current.fence) !== JSON.stringify(item.source.fence)) { gap("source_changed"); continue; }
      if (item.origin && !await this.origin!.check(item.origin)) { gap("origin_stale"); continue; }
      const mediaEvidence = await this.evidence(current);
      if (JSON.stringify(mediaEvidence) !== JSON.stringify(item.mediaEvidence ?? null)) { gap("media_changed"); continue; }
      const size = new TextEncoder().encode((current.text ?? "") + JSON.stringify(mediaEvidence ?? "")).length;
      if (bytes + size > 65536) { gap("context_bytes_limit"); continue; }
      if (result.length === request.limit) { gap("result_limit"); break; }
      bytes += size; result.push({ ...current, ...(item.origin ? { origin: item.origin } : {}), ...(mediaEvidence ? { mediaEvidence } : {}) });
    }
    // Sequential checks are not a publication transaction. The episode/broker
    // must revalidate the whole pack before inference and publication (#44).
    return { sources: result, ...(engineReceipt ? { engineReceipt } : {}), coverage: { ...coverage, gaps: [...gaps].sort() } };
  }
}
