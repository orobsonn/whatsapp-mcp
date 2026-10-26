import { SourceAccess, type AccessGuard, type AccessRow, type TrustedActor } from "./access";
import type { SourceScope } from "./sources";
import { Retrieval, normalizeRetrievalInput, ownActor, type RetrievalInput, type RetrievedSource, validateEngineResult } from "./retrieval";
import { checkOriginsWithin, type OriginGuard, type OriginFence } from "./origin-guard";
import { conversationGuard, jobConversationFence, type ConversationFence } from "./conversations";
import { z } from "zod";
import { searchTicketSchema, parseSearchTicket, type EngineSearch, type SearchTicket, type SemanticEnginePort } from "./engine";
import { bridgeHash } from "./ingress";
const semanticConfigurationSchema=z.object({version:z.literal("rrf-60-v1"),mode:z.enum(["required","lexical_fallback"])}).strict();
const semanticRef=z.object({id:z.string().min(1).max(256),version:z.number().int().positive().max(2147483647),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const semanticBinding=z.discriminatedUnion("state",[
  z.object({state:z.literal("searched"),ticket:searchTicketSchema,configuration:semanticConfigurationSchema,
    receipt:z.object({operationId:z.string().regex(/^[a-f0-9]{64}$/),indexRevision:z.union([z.literal("empty"),z.string().regex(/^[a-f0-9]{64}$/)]),indexState:z.enum(["needs_checkpoint","checkpoint_confirmed"])}).strict(),
    candidates:z.array(semanticRef.extend({via:z.array(z.enum(["chunks","graph"])).min(1).max(2),relationCount:z.number().int().nonnegative().max(1000000)}).strict()).max(10),missing:z.array(semanticRef).max(64)}).strict(),
  z.object({state:z.enum(["not_run_capacity","inventory_changed"]),configuration:semanticConfigurationSchema}).strict(),
  z.object({state:z.enum(["blocked","uncertain"]),ticket:searchTicketSchema,configuration:semanticConfigurationSchema}).strict(),
  z.object({state:z.literal("invalid_or_unavailable"),ticket:searchTicketSchema.nullable(),configuration:semanticConfigurationSchema}).strict(),
  z.object({state:z.literal("empty_inventory"),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),configuration:semanticConfigurationSchema}).strict(),
]);
/** Shared strict host/episode contract. No rejected engine metadata is carried. */
export const semanticRankingSchema=z.object({engine:z.enum(["complete","partial","not_run_capacity","unavailable"]),gaps:z.array(z.enum(["semantic_unsearched","index_missing","semantic_pending","inventory_changed"])).max(4),binding:semanticBinding}).strict();
type ReadCoverageFence = { kind: "owner_read"; chatId: string; snapshot: string };
type SearchScope = SourceScope & { sourceEpoch?: string; sourceGeneration?: string };
type Selected = { id: string; revision: number; version: number; hash: string };
export type SearchFence = Readonly<SourceScope & { runId: string; runToken: string; requestHash: string; checkpoint: number; actor: string; selected: Selected[]; allowedPackHash: string; purpose: "automation" | "owner_read"; ranking?: z.infer<typeof semanticRankingSchema> }>;
export type SearchResult = { state: "pending" | "ready" | "waiting_context"; sources: RetrievedSource[]; coverage: { inventoryComplete: boolean; engine: string; gaps: string[] }; fence?: SearchFence };
export type SearchProgress = { runId: string; checkpoint: number; state: "pending" | "ready" | "waiting_context"; gaps: string[] };
type Run = { id: string; actor_json: string; request_json: string; request_hash: string; run_token: string; checkpoint: number; state: SearchProgress["state"];
  steps_used: number; evaluations: number; page_size: number; max_steps: number; max_evaluations: number; active_step: string | null; pack_hash: string | null; pack_json: string | null };
type Step = { token: string; request_hash: string; page_json: string; state: string; lease_until: number; lease_generation: number; result_json: string | null };
type InventoryRow = AccessRow & { fingerprint: string; inboxes: string };
type Item = { id: string; fingerprint: string; score: number; linked: number; state: string; origin: OriginFence | null; conversation: ConversationFence | ReadCoverageFence | null };
export type CoverageProof = { scope: SearchScope; runId: string; runToken: string; requestHash: string; checkpoint: number; actor: string; purpose: "automation" | "owner_read"; configuration: {version:string;mode:"required"|"lexical_fallback"}; inputHash:string; manifestHash: string };
type SemanticRow = { proof_json:string; ticket_json:string|null;outcome_json:string|null };
type Options = { semantic?: {mode:"required"|"lexical_fallback";engine:SemanticEnginePort}; clock?: () => number; origin?: Pick<OriginGuard, "fence" | "check">; pageSize?: number; maxEvaluations?: number; maxSteps?: number; leaseMs?: number; purpose?: "automation" | "owner_read" };
const ns = "installation_id=? AND generation=?";
const baseGaps = ["index_capacity", "index_missing"];
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const hashId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// Keep SQL expression depth logarithmic when the complete 64-source proof
// contains distinct conversation fences (D1 rejects a left-deep AND chain).
function balancedAnd(parts:string[]):string {
  if(!parts.length)return "1";if(parts.length===1)return `(${parts[0]})`;
  const middle=Math.floor(parts.length/2);return `(${balancedAnd(parts.slice(0,middle))} AND ${balancedAnd(parts.slice(middle))})`;
}
function compressed(sql: string, values: AccessGuard["values"]): AccessGuard {
  let index = 0;
  return { sql: `EXISTS(SELECT 1 FROM (SELECT ? value) search_guard_args WHERE ${sql.replace(/\?/g, () => `json_extract(search_guard_args.value,'$[${index++}]')`)})`, values: [JSON.stringify(values)] };
}
/** Durable canonical inventory, not a complete remote archive or semantic index.
 * Step receipts are immutable observations; result()/check() establish currency. */
export class RetrievalRuns {
  private readonly scope: SearchScope;
  private readonly access: SourceAccess;
  private readonly scorer: Retrieval;
  private readonly clock: () => number;
  private readonly options: Readonly<Options>;
  private readonly purpose: "automation" | "owner_read";
  private readonly limits: { pageSize: number; maxEvaluations: number; maxSteps: number };
  constructor(private readonly db: D1Database, scope: SearchScope, options: Options = {}) {
    if (!identifier(scope.installationId) || !identifier(scope.generation) || ((scope.sourceEpoch !== undefined || scope.sourceGeneration !== undefined) && (!identifier(scope.sourceEpoch) || !identifier(scope.sourceGeneration)))) throw new Error("retrieval_run_scope");
    this.scope = Object.freeze({ installationId: scope.installationId, generation: scope.generation, ...(scope.sourceEpoch ? { sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration } : {}) }); this.options = Object.freeze({ ...options, ...(options.semantic ? {semantic:Object.freeze({...options.semantic})} : {}) }); this.clock = options.clock ?? Date.now;
    if (options.semantic && !["required","lexical_fallback"].includes(options.semantic.mode)) throw new Error("retrieval_run_configuration");
    this.purpose = options.purpose ?? "automation"; if (!["automation","owner_read"].includes(this.purpose)) throw new Error("retrieval_run_purpose");
    this.access = new SourceAccess(db, this.scope, this.clock); this.scorer = new Retrieval(db, this.scope);
    this.limits = { pageSize: options.pageSize ?? 64, maxEvaluations: options.maxEvaluations ?? 4096, maxSteps: options.maxSteps ?? 80 };
    for (const [key, maximum] of [["pageSize", 64], ["maxEvaluations", 4096], ["maxSteps", 80]] as const) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > maximum) throw new Error("retrieval_run_limits");
    if (options.leaseMs !== undefined && (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1 || options.leaseMs > 180000)) throw new Error("retrieval_run_limits");
  }
  private readCoverageQuery(chatId: string): AccessGuard {
    const nominal = !!this.scope.sourceEpoch;
    const where = `installation_id=? AND generation=? AND chat_id=?${nominal ? " AND source_epoch=? AND source_generation=?" : ""}`;
    const values = [...this.keys(), chatId, ...(nominal ? [this.scope.sourceEpoch!, this.scope.sourceGeneration!] : [])];
    return { sql: `SELECT json_array(c.watermark,c.kind,c.access_state,p.kind,COALESCE(p.revision,0),COALESCE(p.effective_mode,CASE WHEN c.kind='private' THEN 'attend' ELSE 'ignore' END),
      (SELECT COALESCE(MAX(sequence),0) FROM assistant_capture_inbox WHERE ${where})) snapshot
      FROM assistant_origin_conversations c LEFT JOIN assistant_conversation_modes p ON p.installation_id=c.installation_id AND p.generation=c.generation AND p.conversation_id=c.chat_id
      WHERE c.installation_id=? AND c.generation=? AND c.chat_id=? ${nominal ? "AND c.source_epoch=? AND c.source_generation=?" : "AND 0"}
      AND c.access_state='available' AND c.kind IS NOT NULL AND (p.kind IS NULL OR p.kind=c.kind)
      AND COALESCE(p.effective_mode,CASE WHEN c.kind='private' THEN 'attend' ELSE 'ignore' END)<>'ignore'
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE ${where} AND (application_state<>'applied' OR sequence>c.watermark))`, values: [...values, ...values, ...values] };
  }
  private async readCoverage(chatId: string): Promise<ReadCoverageFence | null> {
    const query = this.readCoverageQuery(chatId), row = await this.statement(query.sql,...query.values).first<{snapshot:string}>();
    // An unobserved owner note needs no automatic decision cursor. Once any
    // nominal capture appears, absence is no longer a valid read fence.
    if (row) return {kind:"owner_read",chatId,snapshot:row.snapshot};
    const guard = this.readAbsence(chatId);
    const absent = await this.statement(`SELECT 1 WHERE ${guard.sql}`,...guard.values).first();
    return !absent ? null : {kind:"owner_read",chatId,snapshot:"unobserved"};
  }
  private readAbsence(chatId: string): AccessGuard {
    const nominal=!!this.scope.sourceEpoch, where=`${ns} AND chat_id=?${nominal ? " AND source_epoch=? AND source_generation=?" : ""}`;
    const values=[...this.keys(),chatId,...(nominal ? [this.scope.sourceEpoch!,this.scope.sourceGeneration!] : [])];
    return {sql:`NOT EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE ${where}) AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE ${where})`,values:[...values,...values]};
  }
  private contextGuard(value: ConversationFence | ReadCoverageFence): AccessGuard {
    if (!("kind" in value)) return this.purpose === "automation" ? conversationGuard(value) : {sql:"0",values:[]};
    if (this.purpose !== "owner_read" || value.kind !== "owner_read") return {sql:"0",values:[]};
    if (value.snapshot === "unobserved") return this.readAbsence(value.chatId);
    const query=this.readCoverageQuery(value.chatId); return {sql:`EXISTS(SELECT 1 FROM (${query.sql}) WHERE snapshot=?)`,values:[...query.values,value.snapshot]};
  }
  private semanticConfiguration() { return {version:"rrf-60-v1",mode:this.options.semantic!.mode}; }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private statement(sql: string, ...values: (string | number | null)[]) { return this.db.prepare(sql).bind(...values); }
  private async load(actor: TrustedActor, id: string): Promise<Run> {
    if (!hashId(id)) throw new Error("retrieval_run_denied");
    const row = await this.statement(`SELECT * FROM assistant_retrieval_runs WHERE ${ns} AND id=? AND actor_json=?`, ...this.keys(), id, JSON.stringify(actor)).first<Run>();
    if (!row || (JSON.stringify(JSON.parse(row.request_json).scope) !== JSON.stringify(this.scope) || JSON.parse(row.request_json).purpose !== this.purpose)) throw new Error("retrieval_run_denied");
    if (JSON.stringify(JSON.parse(row.request_json).semantic) !== JSON.stringify(this.options.semantic ? this.semanticConfiguration() : undefined)) throw new Error("retrieval_run_configuration"); return row;
  }
  private inventory(actor: TrustedActor, run: Run, now: number) { return this.access.inventory(actor, JSON.parse(run.request_json).input.projectId, now, { ...this.scope, includePaused: this.purpose === "owner_read" }); }
  private progress(run: Run): SearchProgress {
    return { runId: run.id, checkpoint: run.checkpoint, state: run.state, gaps: [...baseGaps, ...(run.state === "waiting_context" ? [run.steps_used >= run.max_steps || run.evaluations >= run.max_evaluations ? "search_limit" : "origin_unavailable"] : [])] };
  }
  async start(actor: TrustedActor, key: string, input: RetrievalInput): Promise<SearchProgress> {
    actor = ownActor(actor); if (actor.kind === "extractor" || (this.purpose === "owner_read" && actor.kind !== "owner") || !identifier(key)) throw new Error("retrieval_run_denied");
    const request = { input: normalizeRetrievalInput(input), scope: this.scope, purpose: this.purpose, limits: this.limits, ...(this.options.semantic ? {semantic:this.semanticConfiguration()} : {}) }, actorJson = JSON.stringify(actor);
    const id = await bridgeHash([this.keys(), actorJson, key]), requestHash = await bridgeHash(request);
    await this.statement(`INSERT INTO assistant_retrieval_runs(installation_id,generation,id,actor_json,request_json,request_hash,run_token,page_size,max_steps,max_evaluations)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, ...this.keys(), id, actorJson, JSON.stringify(request), requestHash, crypto.randomUUID(), this.limits.pageSize, this.limits.maxSteps, this.limits.maxEvaluations).run();
    const run = await this.load(actor, id); if (run.request_hash !== requestHash) throw new Error("retrieval_run_conflict"); return this.progress(run);
  }
  private storedStep(runId: string, stepId: string) { return this.statement(`SELECT * FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=?`, ...this.keys(), runId, stepId).first<Step>(); }
  async step(actor: TrustedActor, input: { runId: string; stepId: string; expectedCheckpoint: number }): Promise<SearchProgress> {
    actor = ownActor(actor);
    if (!input || Object.keys(input).some(key => !["runId", "stepId", "expectedCheckpoint"].includes(key))) throw new Error("retrieval_step_input");
    input = Object.freeze({ runId: input.runId, stepId: input.stepId, expectedCheckpoint: input.expectedCheckpoint });
    if (!identifier(input.stepId) || !Number.isSafeInteger(input.expectedCheckpoint) || input.expectedCheckpoint < 0) throw new Error("retrieval_step_input");
    let run = await this.load(actor, input.runId);
    const requestHash = await bridgeHash([run.run_token, run.request_hash, input]), token = crypto.randomUUID();
    let step = await this.storedStep(run.id, input.stepId), owned = false;
    if (step && step.request_hash !== requestHash) throw new Error("retrieval_step_conflict");
    if (step?.state === "complete") return JSON.parse(step.result_json!);
    if (run.checkpoint !== input.expectedCheckpoint) throw new Error("retrieval_step_conflict");
    if (run.steps_used >= run.max_steps || run.evaluations >= run.max_evaluations) return { ...this.progress(run), state: "waiting_context", gaps: [...baseGaps, "search_limit"] };
    const now = this.clock(), until = now + (this.options.leaseMs ?? 180000);
    if (!step) {
      const inventory = this.inventory(actor, run, now), take = Math.min(run.page_size, run.max_evaluations - run.evaluations);
      const batch = [this.statement(`WITH current AS (${inventory.sql})
        INSERT INTO assistant_retrieval_steps(installation_id,generation,run_id,step_id,request_hash,token,expected_checkpoint,page_json,state,lease_until)
        SELECT ?,?,?,?,?,?,?,COALESCE((SELECT json_group_array(json_object('id',id,'fingerprint',fingerprint)) FROM (
          SELECT c.id,c.fingerprint FROM current c LEFT JOIN assistant_retrieval_items i ON i.installation_id=? AND i.generation=? AND i.run_id=? AND i.source_id=c.id
          WHERE i.source_id IS NULL OR i.fingerprint<>c.fingerprint OR i.state<>'ready'
          ORDER BY CASE WHEN i.source_id IS NULL OR i.fingerprint<>c.fingerprint THEN 0 ELSE 1 END,c.id LIMIT ?)),'[]'),'prepared',?
        FROM assistant_retrieval_runs r WHERE r.${ns.replace(" AND ", " AND r.")} AND r.id=? AND r.checkpoint=? AND r.active_step IS NULL AND r.steps_used=? AND r.evaluations=? ON CONFLICT DO NOTHING`,
        ...inventory.values, ...this.keys(), run.id, input.stepId, requestHash, token, input.expectedCheckpoint, ...this.keys(), run.id, take, until,
        ...this.keys(), run.id, input.expectedCheckpoint, run.steps_used, run.evaluations),
      this.statement(`UPDATE assistant_retrieval_runs SET active_step=?,steps_used=steps_used+1,evaluations=evaluations+(SELECT json_array_length(page_json) FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=? AND token=?)
        WHERE ${ns} AND id=? AND checkpoint=? AND active_step IS NULL AND EXISTS(SELECT 1 FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=? AND token=?)`,
        input.stepId, ...this.keys(), run.id, input.stepId, token, ...this.keys(), run.id, input.expectedCheckpoint, ...this.keys(), run.id, input.stepId, token)];
      await this.db.batch(batch); step = await this.storedStep(run.id, input.stepId); owned = step?.token === token;
    } else if (step.lease_until <= now) {
      if (JSON.parse(step.page_json).length > run.max_evaluations - run.evaluations) {
        // Recovery must retain the admitted page, rather than silently shrinking it.
        // Its full retry cost no longer fits, so persist a terminal limit receipt.
        await this.db.batch([
          this.statement(`UPDATE assistant_retrieval_runs SET state='waiting_context' WHERE ${ns} AND id=? AND active_step=? AND checkpoint=? AND EXISTS(SELECT 1 FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=? AND token=? AND state='prepared' AND lease_until<=?)`, ...this.keys(), run.id, input.stepId, input.expectedCheckpoint, ...this.keys(), run.id, input.stepId, step.token, now),
          this.statement(`UPDATE assistant_retrieval_steps SET state='complete',result_json=json_object('runId',run_id,'checkpoint',expected_checkpoint,'state','waiting_context','gaps',json('["index_capacity","index_missing","search_limit"]')) WHERE ${ns} AND run_id=? AND step_id=? AND token=? AND state='prepared' AND lease_until<=? AND EXISTS(SELECT 1 FROM assistant_retrieval_runs WHERE ${ns} AND id=? AND state='waiting_context' AND active_step=?)`, ...this.keys(), run.id, input.stepId, step.token, now, ...this.keys(), run.id, input.stepId),
        ]);
        const receipt = await this.storedStep(run.id,input.stepId); if (!receipt?.result_json) throw new Error("retrieval_step_busy"); return JSON.parse(receipt.result_json);
      }
      const result = await this.db.batch([
        this.statement(`UPDATE assistant_retrieval_steps SET token=?,lease_until=?,lease_generation=lease_generation+1 WHERE ${ns} AND run_id=? AND step_id=? AND state='prepared' AND lease_until<=? AND EXISTS(SELECT 1 FROM assistant_retrieval_runs r WHERE r.installation_id=assistant_retrieval_steps.installation_id AND r.generation=assistant_retrieval_steps.generation AND r.id=run_id AND r.active_step=step_id AND r.steps_used<r.max_steps AND r.evaluations+json_array_length(page_json)<=r.max_evaluations) RETURNING token`, token, until, ...this.keys(), run.id, input.stepId, now),
        this.statement(`UPDATE assistant_retrieval_runs SET steps_used=steps_used+1,evaluations=evaluations+(SELECT json_array_length(page_json) FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=? AND token=?)
          WHERE ${ns} AND id=? AND active_step=? AND EXISTS(SELECT 1 FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=? AND token=?)`,
          ...this.keys(), run.id, input.stepId, token, ...this.keys(), run.id, input.stepId, ...this.keys(), run.id, input.stepId, token),
      ]); owned = result[0].results.length === 1; step = await this.storedStep(run.id, input.stepId);
    }
    if (!step || !owned) throw new Error("retrieval_step_busy");
    run = await this.load(actor, run.id);
    const inventory = this.inventory(actor, run, this.clock());
    const rows = await this.statement(`WITH current AS (${inventory.sql}) SELECT c.* FROM current c JOIN json_each(?) p ON c.id=json_extract(p.value,'$.id') AND c.fingerprint=json_extract(p.value,'$.fingerprint') ORDER BY c.id`, ...inventory.values, step.page_json).all<InventoryRow>();
    const evaluated: Item[] = [];
    for (const row of rows.results) {
      const source = this.access.fromRow(actor, row); let origin: OriginFence | null = null, conversation: ConversationFence | ReadCoverageFence | null = null, state = "ready";
      if (JSON.parse(row.inboxes).some((frame: unknown[]) => Number(frame[4]) > 0)) state = "origin_unavailable";
      if (source.text === null || source.text.length > 32768 || new TextEncoder().encode(source.text).length > 32768) state = "source_text_limit";
      if (source.fence.source.origin === "whatsapp") {
        origin = await this.options.origin?.fence(source.id) ?? null;
        if (!origin || !await this.options.origin!.check(origin)) state = "origin_unavailable";
      }
      const chatId = actor.kind === "interlocutor" ? actor.conversationId : source.fence.source.conversationId;
      if (chatId) {
        conversation = this.purpose === "owner_read" ? await this.readCoverage(chatId) : await jobConversationFence(this.db, origin ?? this.scope, chatId, source.fence.source.origin === "whatsapp", source.id);
        if (!conversation) state = "origin_unavailable";
      }
      const scored = state === "ready" ? await this.scorer.scoreOriginal(source, JSON.parse(run.request_json).input) : { score: 0, linked: false, gaps: [] };
      if (scored.gaps.length) state = "relation_unavailable";
      evaluated.push({ id: row.id, fingerprint: row.fingerprint, score: scored.score, linked: scored.linked ? 1 : 0, state, origin, conversation });
    }
    const finalNow = this.clock(), current = this.inventory(actor, run, finalNow);
    const gate = `EXISTS(SELECT 1 FROM assistant_retrieval_steps s JOIN assistant_retrieval_runs r ON r.installation_id=s.installation_id AND r.generation=s.generation AND r.id=s.run_id
      WHERE s.${ns.replace(" AND ", " AND s.")} AND s.run_id=? AND s.step_id=? AND s.token=? AND s.lease_generation=? AND s.lease_until>? AND s.state='prepared' AND r.active_step=s.step_id)`;
    const gateValues = [...this.keys(), run.id, input.stepId, token, step.lease_generation, finalNow];
    const params = JSON.stringify(evaluated);
    // Every evaluated row is checked against the current authorized fingerprint.
    // No 64-source list of individual predicates/bindings is assembled.
    const batch = [this.statement(`WITH current AS (${current.sql}) DELETE FROM assistant_retrieval_items WHERE ${ns} AND run_id=? AND NOT EXISTS(SELECT 1 FROM current WHERE current.id=source_id AND current.fingerprint=assistant_retrieval_items.fingerprint) AND ${gate}`, ...current.values, ...this.keys(), run.id, ...gateValues),
      this.statement(`WITH current AS (${current.sql}) INSERT INTO assistant_retrieval_items
        SELECT ?,?,?,c.id,c.fingerprint,json_extract(p.value,'$.score'),json_extract(p.value,'$.linked'),json_extract(p.value,'$.state'),json_extract(p.value,'$.origin'),json_extract(p.value,'$.conversation')
        FROM json_each(?) p JOIN current c ON c.id=json_extract(p.value,'$.id') AND c.fingerprint=json_extract(p.value,'$.fingerprint') WHERE ${gate}
        ON CONFLICT(installation_id,generation,run_id,source_id) DO UPDATE SET fingerprint=excluded.fingerprint,score=excluded.score,linked=excluded.linked,state=excluded.state,origin_json=excluded.origin_json,conversation_json=excluded.conversation_json`,
        ...current.values, ...this.keys(), run.id, params, ...gateValues),
      this.statement(`WITH current AS (${current.sql}) UPDATE assistant_retrieval_runs SET checkpoint=checkpoint+1,pack_hash=NULL,pack_json=NULL,
        state=CASE WHEN NOT EXISTS(SELECT 1 FROM current c WHERE NOT EXISTS(SELECT 1 FROM assistant_retrieval_items i WHERE i.installation_id=assistant_retrieval_runs.installation_id AND i.generation=assistant_retrieval_runs.generation AND i.run_id=assistant_retrieval_runs.id AND i.source_id=c.id AND i.fingerprint=c.fingerprint))
          THEN CASE WHEN EXISTS(SELECT 1 FROM assistant_retrieval_items i WHERE i.installation_id=assistant_retrieval_runs.installation_id AND i.generation=assistant_retrieval_runs.generation AND i.run_id=assistant_retrieval_runs.id AND i.state<>'ready') THEN 'waiting_context' ELSE 'ready' END
          WHEN steps_used>=max_steps OR evaluations>=max_evaluations THEN 'waiting_context' ELSE 'pending' END WHERE ${ns} AND id=? AND checkpoint=? AND ${gate}`, ...current.values, ...this.keys(), run.id, input.expectedCheckpoint, ...gateValues),
      this.statement(`UPDATE assistant_retrieval_steps SET state='complete',result_json=(SELECT json_object('runId',r.id,'checkpoint',r.checkpoint,'state',r.state,'gaps',json(CASE WHEN r.state='waiting_context' THEN CASE WHEN r.steps_used>=r.max_steps OR r.evaluations>=r.max_evaluations THEN '["index_capacity","index_missing","search_limit"]' ELSE '["index_capacity","index_missing","origin_unavailable"]' END ELSE '["index_capacity","index_missing"]' END)) FROM assistant_retrieval_runs r WHERE r.${ns.replace(" AND ", " AND r.")} AND r.id=? AND r.checkpoint=?)
        WHERE ${ns} AND run_id=? AND step_id=? AND token=? AND lease_generation=? AND lease_until>? AND state='prepared'`, ...this.keys(), run.id, input.expectedCheckpoint + 1, ...this.keys(), run.id, input.stepId, token, step.lease_generation, finalNow),
      this.statement(`UPDATE assistant_retrieval_runs SET active_step=NULL WHERE ${ns} AND id=? AND active_step=? AND EXISTS(SELECT 1 FROM assistant_retrieval_steps WHERE ${ns} AND run_id=? AND step_id=? AND token=? AND state='complete' AND result_json IS NOT NULL)`, ...this.keys(), run.id, input.stepId, ...this.keys(), run.id, input.stepId, token)];
    await this.db.batch(batch);
    const completed = await this.storedStep(run.id, input.stepId); if (!completed?.result_json) throw new Error("retrieval_step_stale"); return JSON.parse(completed.result_json);
  }
  private coverage(actor: TrustedActor, run: Run, now: number, inventory?: AccessGuard): AccessGuard {
    const current = inventory ?? this.inventory(actor, run, now);
    return { sql: `EXISTS(WITH current AS (${current.sql}) SELECT 1 FROM assistant_retrieval_runs r WHERE r.${ns.replace(" AND ", " AND r.")} AND r.id=? AND r.run_token=? AND r.request_hash=? AND r.actor_json=? AND r.checkpoint=? AND json_extract(r.request_json,'$.scope')=? AND json_extract(r.request_json,'$.purpose')=? AND r.state='ready'
      AND NOT EXISTS(SELECT 1 FROM current c WHERE NOT EXISTS(SELECT 1 FROM assistant_retrieval_items i WHERE i.installation_id=r.installation_id AND i.generation=r.generation AND i.run_id=r.id AND i.source_id=c.id AND i.fingerprint=c.fingerprint AND i.state='ready'))
      AND NOT EXISTS(SELECT 1 FROM assistant_retrieval_items i WHERE i.installation_id=r.installation_id AND i.generation=r.generation AND i.run_id=r.id AND (i.state<>'ready' OR NOT EXISTS(SELECT 1 FROM current c WHERE c.id=i.source_id AND c.fingerprint=i.fingerprint))))`,
      values: [...current.values, ...this.keys(), run.id, run.run_token, run.request_hash, run.actor_json, run.checkpoint, JSON.stringify(this.scope), this.purpose] };
  }
  private semanticRow(runId:string) { return this.statement(`SELECT * FROM assistant_retrieval_semantic WHERE ${ns} AND run_id=?`,...this.keys(),runId).first<SemanticRow>(); }
  /** Internal host proof. Rebuild from canonical inventory on every admission,
   * including cache hits; caller SQL/authority is never accepted. */
  async proofGuard(proof:CoverageProof): Promise<AccessGuard> {
    try {
      if (!this.options.semantic || JSON.stringify(proof.scope)!==JSON.stringify(this.scope) || proof.purpose!==this.purpose || JSON.stringify(proof.configuration)!==JSON.stringify(this.semanticConfiguration())) throw 0;
      const actor=ownActor(JSON.parse(proof.actor)),run=await this.load(actor,proof.runId);
      if (run.run_token!==proof.runToken || run.request_hash!==proof.requestHash || run.checkpoint!==proof.checkpoint || run.actor_json!==proof.actor) throw 0;
      const coverage=this.coverage(actor,run,this.clock());
      const rows=await this.statement(`SELECT source_id,fingerprint,conversation_json FROM assistant_retrieval_items WHERE ${ns} AND run_id=? ORDER BY source_id`,...this.keys(),run.id).all<{source_id:string;fingerprint:string;conversation_json:string|null}>();
      if (rows.results.length>64 || await bridgeHash(rows.results.map(row=>[row.source_id,row.fingerprint]))!==proof.manifestHash) throw 0;
      const allowed=rows.results.map(row=>{const ref=JSON.parse(row.fingerprint);return {id:ref[0],version:ref[2],hash:ref[3]};});
      if(await bridgeHash([actor,JSON.parse(run.request_json).input.query,allowed,10])!==proof.inputHash)throw 0;
      const locals=[...new Set(rows.results.map(row=>row.conversation_json).filter((value):value is string=>!!value))].map(value=>this.contextGuard(JSON.parse(value)));
      return compressed(balancedAnd([coverage.sql,`EXISTS(SELECT 1 FROM assistant_retrieval_semantic WHERE ${ns} AND run_id=? AND proof_json=?)`,...locals.map(local=>local.sql)]),[...coverage.values,...this.keys(),run.id,JSON.stringify(proof),...locals.flatMap(local=>local.values)]);
    } catch {return {sql:"0",values:[]};}
  }
  async checkProof(proof:CoverageProof) {
    const guard=await this.proofGuard(proof);
    if (!await this.statement(`SELECT 1 WHERE ${guard.sql}`,...guard.values).first()) return false;
    const rows=await this.statement(`SELECT origin_json FROM assistant_retrieval_items WHERE ${ns} AND run_id=?`,...this.keys(),proof.runId).all<{origin_json:string|null}>();
    const origins=rows.results.filter(row=>row.origin_json).map(row=>JSON.parse(row.origin_json!) as OriginFence);
    if(!await checkOriginsWithin(origins,fence=>this.options.origin ? this.options.origin.check(fence) : Promise.resolve(false)))return false;
    const fresh=await this.proofGuard(proof); return !!await this.statement(`SELECT 1 WHERE ${fresh.sql}`,...fresh.values).first();
  }
  private async semanticRequest(actor:TrustedActor,run:Run):Promise<{proof:CoverageProof;input:EngineSearch}|{reason:"capacity"|"stale"}> {
    const inventory=this.inventory(actor,run,this.clock());
    const rows=await this.statement(`WITH current AS (${inventory.sql}) SELECT c.*,i.origin_json FROM current c JOIN assistant_retrieval_items i ON i.installation_id=? AND i.generation=? AND i.run_id=? AND i.source_id=c.id AND i.fingerprint=c.fingerprint ORDER BY c.id LIMIT 65`,...inventory.values,...this.keys(),run.id).all<InventoryRow & {origin_json:string|null}>();
    if(rows.results.length>64) {
      const gate=this.coverage(actor,run,this.clock());
      await this.statement(`INSERT INTO assistant_retrieval_semantic(installation_id,generation,run_id,proof_json) SELECT ?,?,?,? WHERE ${gate.sql} ON CONFLICT DO NOTHING`,...this.keys(),run.id,JSON.stringify({state:"not_run_capacity",checkpoint:run.checkpoint,configuration:this.semanticConfiguration()}),...gate.values).run();
      return {reason:"capacity"};
    }
    const proof:CoverageProof={scope:this.scope,runId:run.id,runToken:run.run_token,requestHash:run.request_hash,checkpoint:run.checkpoint,actor:run.actor_json,purpose:this.purpose,configuration:this.semanticConfiguration(),inputHash:await bridgeHash([actor,JSON.parse(run.request_json).input.query,rows.results.map(row=>({id:row.id,version:row.version,hash:row.content_hash})),10]),manifestHash:await bridgeHash(rows.results.map(row=>[row.id,row.fingerprint]))};
    const input:EngineSearch={query:JSON.parse(run.request_json).input.query,limit:10,actor,coverage:proof,allowedSources:[],permits:[]};
    for(const row of rows.results){const source=this.access.fromRow(actor,row);input.allowedSources.push({id:source.id,version:source.fence.source.version,hash:source.fence.source.hash});input.permits.push({source:source.fence,...(row.origin_json ? {origin:JSON.parse(row.origin_json)} : {})});}
    const gate=this.coverage(actor,run,this.clock());
    await this.statement(`INSERT INTO assistant_retrieval_semantic(installation_id,generation,run_id,proof_json) SELECT ?,?,?,? WHERE ${gate.sql} ON CONFLICT DO NOTHING`,...this.keys(),run.id,JSON.stringify(proof),...gate.values).run();
    const prior=await this.semanticRow(run.id);
    return prior?.proof_json===JSON.stringify(proof) && await this.checkProof(proof) ? {proof,input} : {reason:"stale"};
  }
  /** Scheduler presearch hook. May take the engine deadline; never run inside
   * an episode lease. Persistent ticket/claim survives process death. */
  async advanceSemantic(actor:TrustedActor,runId:string):Promise<void> {
    actor=ownActor(actor);const run=await this.load(actor,runId);
    if(!this.options.semantic || run.state!=="ready") return;
    const outcome=await this.semanticOutcome(actor,run);
    if(outcome.engine!=="pending")return;
    const row=await this.semanticRow(run.id);
    if(!row?.ticket_json || row.outcome_json) return;
    const ticket=JSON.parse(row.ticket_json) as SearchTicket;
    // Only EngineStore's durable prepared->attempting CAS can admit effects.
    const result=await this.options.semantic.engine.submit(ticket);
    await this.saveSemantic(run,JSON.parse(row.proof_json),result);
  }
  private async saveSemantic(run:Run,proof:CoverageProof,outcome:unknown) {
    const gate=await this.proofGuard(proof),row=await this.semanticRow(run.id);
    let safe:unknown={state:"blocked",reason:"semantic_invalid_result"};
    try {
      if(new TextEncoder().encode(JSON.stringify(outcome)).length>65536)throw 0;
      const state=(outcome as {state?:string}).state;
      if(state==="complete"){
        const refs=await this.statement(`SELECT fingerprint FROM assistant_retrieval_items WHERE ${ns} AND run_id=? ORDER BY source_id LIMIT 65`,...this.keys(),run.id).all<{fingerprint:string}>();
        const allowed=refs.results.map(row=>{const ref=JSON.parse(row.fingerprint);return {id:ref[0],version:ref[2],hash:ref[3]};});
        const result=validateEngineResult(outcome,allowed,10),ticket=parseSearchTicket(JSON.parse(row!.ticket_json!));
        if(result.operationId!==ticket.operationId || result.indexRevision!==ticket.indexRevision)throw 0;
        safe=result;
      }else if(state==="blocked" || state==="uncertain") safe={state,reason:state==="blocked"?"semantic_blocked":"semantic_uncertain"};
    }catch{/* Rejected data stays outside the persistent ranking and episode. */}
    await this.statement(`UPDATE assistant_retrieval_semantic SET outcome_json=? WHERE ${ns} AND run_id=? AND (outcome_json IS NULL OR (json_extract(outcome_json,'$.state')='uncertain' AND ?='complete')) AND ${gate.sql}`,JSON.stringify(safe),...this.keys(),run.id,(safe as {state:string}).state,...gate.values).run();
  }
  private async semanticOutcome(actor:TrustedActor,run:Run):Promise<{engine:string;gaps:string[];candidates:string[];binding:unknown;pending:boolean}> {
    const fallback=this.options.semantic!.mode==="lexical_fallback";
    const failed=(engine:string,gaps:string[],binding:unknown=null,pending=false)=>({engine,gaps,candidates:[] as string[],binding,pending:pending||!fallback});
    const request=await this.semanticRequest(actor,run);
    if("reason" in request) return failed(request.reason==="capacity"?"not_run_capacity":"unavailable",["semantic_unsearched"],{configuration:this.semanticConfiguration(),state:request.reason==="capacity"?"not_run_capacity":"inventory_changed"});
    if(!request.input.allowedSources.length)return {engine:"complete",gaps:[],candidates:[],binding:{configuration:this.semanticConfiguration(),state:"empty_inventory",manifestHash:request.proof.manifestHash},pending:false};
    let row=(await this.semanticRow(run.id))!;
    // Only metadata-only preparation refusal is recoverable without a ticket.
    // The proof/request are reconstructed above; the stable alias is unchanged.
    const prepareBlocked = (value:string|null) => value === JSON.stringify({state:"blocked",reason:"semantic_prepare_blocked"});
    if(!row.ticket_json && (!row.outcome_json || prepareBlocked(row.outcome_json))){
      const raw=await this.options.semantic!.engine.prepare(run.id,request.input);
      let prepared: {state:"prepared";ticket:SearchTicket}|{state:"blocked";reason:string}={state:"blocked",reason:"semantic_prepare_blocked"};
      try {if(new TextEncoder().encode(JSON.stringify(raw)).length>4096)throw 0;if(raw.state==="prepared") {const ticket=parseSearchTicket(raw.ticket);if(ticket.alias!==run.id || ticket.requestHash!==await bridgeHash(request.input))throw 0;prepared={state:"prepared",ticket};}}catch{/* No rejected metadata crosses this boundary. */}
      const gate=await this.proofGuard(request.proof);
      await this.statement(`UPDATE assistant_retrieval_semantic SET ticket_json=?,outcome_json=? WHERE ${ns} AND run_id=? AND ticket_json IS NULL AND (outcome_json IS NULL OR outcome_json=?) AND ${gate.sql}`,prepared.state==="prepared"?JSON.stringify(prepared.ticket):null,prepared.state==="blocked"?JSON.stringify(prepared):null,...this.keys(),run.id,JSON.stringify({state:"blocked",reason:"semantic_prepare_blocked"}),...gate.values).run();
      row=(await this.semanticRow(run.id))!;
    }
    if(row.ticket_json){
      const observed=await this.options.semantic!.engine.lookupTicket(JSON.parse(row.ticket_json));
      // A generic blocked result is not evidence of no attempt. Only the same
      // current ticket's strict prepared lookup can reopen a pre-admission refusal.
      const ticket=parseSearchTicket(JSON.parse(row.ticket_json));
      if(observed.state==="uncertain" && observed.reason==="not_submitted" && observed.operationId===ticket.operationId && row.outcome_json===JSON.stringify({state:"blocked",reason:"semantic_blocked"})) {
        const gate=await this.proofGuard(request.proof);
        await this.statement(`UPDATE assistant_retrieval_semantic SET outcome_json=NULL WHERE ${ns} AND run_id=? AND ticket_json=? AND outcome_json=? AND ${gate.sql}`,...this.keys(),run.id,row.ticket_json,row.outcome_json,...gate.values).run();
        row=(await this.semanticRow(run.id))!;
      }
      if(observed.state==="complete" || (observed.state==="blocked")) {await this.saveSemantic(run,request.proof,observed);row=(await this.semanticRow(run.id))!;}
      if(!row.outcome_json)return failed("pending",["semantic_pending"],{ticket:JSON.parse(row.ticket_json!),configuration:this.semanticConfiguration()},true);
      // Current engine epoch/revision is checked even for a persisted receipt.
      if(observed.state!=="complete")return failed("unavailable",["semantic_unsearched"],{ticket:JSON.parse(row.ticket_json!),configuration:this.semanticConfiguration(),state:observed.state==="blocked"?"blocked":"uncertain"});
    }
    if(!await this.checkProof(request.proof))return failed("unavailable",["inventory_changed"]);
    try {
      const response=validateEngineResult(JSON.parse(row.outcome_json!),request.input.allowedSources,10),ticket=JSON.parse(row.ticket_json!) as SearchTicket;
      if(response.operationId!==ticket.operationId || response.indexRevision!==ticket.indexRevision)throw 0;
      const binding={state:"searched",ticket,configuration:this.semanticConfiguration(),receipt:{operationId:response.operationId,indexRevision:response.indexRevision,indexState:response.indexState},candidates:response.result.candidates,missing:response.result.missing};
      return response.result.missing.length ? failed("partial",["index_missing","semantic_unsearched"],binding) : {engine:"complete",gaps:[],candidates:response.result.candidates.map(ref=>ref.id),binding,pending:false};
    } catch{return failed("unavailable",["semantic_unsearched"],{ticket:row.ticket_json?JSON.parse(row.ticket_json):null,configuration:this.semanticConfiguration(),state:"invalid_or_unavailable"});}
  }
  async result(actor: TrustedActor, runId: string): Promise<SearchResult> {
    actor = ownActor(actor); const run = await this.load(actor, runId), coverage = this.coverage(actor, run, this.clock());
    const unavailable = (gap: string, complete = false): SearchResult => ({ state: run.steps_used >= run.max_steps || run.evaluations >= run.max_evaluations || run.state === "waiting_context" || complete ? "waiting_context" : "pending", sources: [] as RetrievedSource[], coverage: { inventoryComplete: complete, engine: "not_run_capacity", gaps: [...baseGaps, gap] } });
    if (!await this.statement(`SELECT 1 WHERE ${coverage.sql}`, ...coverage.values).first()) return unavailable(run.steps_used >= run.max_steps || run.evaluations >= run.max_evaluations ? "search_limit" : run.state === "waiting_context" ? "origin_unavailable" : "inventory_changed");
    const semantic=this.options.semantic ? await this.semanticOutcome(actor,run) : null;
    if(semantic?.pending) return {state:"pending",sources:[],coverage:{inventoryComplete:true,engine:semantic.engine,gaps:semantic.gaps}};
    const current = this.inventory(actor, run, this.clock());
    const rows = await this.statement(`WITH current AS (${current.sql}) SELECT c.*,i.origin_json,i.conversation_json FROM current c JOIN assistant_retrieval_items i ON i.installation_id=? AND i.generation=? AND i.run_id=? AND i.source_id=c.id AND i.fingerprint=c.fingerprint WHERE i.state='ready' AND i.linked=1 AND (i.score>0 OR c.id IN (SELECT value FROM json_each(?))) ORDER BY i.score DESC,c.id LIMIT 74`, ...current.values, ...this.keys(), run.id, JSON.stringify(semantic?.candidates ?? [])).all<InventoryRow & { origin_json: string | null; conversation_json: string | null }>();
    if (!rows.results.length) return {state:"waiting_context",sources:[],coverage:{inventoryComplete:true,engine:semantic?.engine ?? "not_run_capacity",gaps:[...(semantic?.gaps ?? baseGaps),"no_matches"]}};
    if(semantic){
      const lexical=rows.results; // SQL order is the lexical lane; score-zero rows receive no lexical rank.
      const scores=await this.statement(`SELECT source_id,score FROM assistant_retrieval_items WHERE ${ns} AND run_id=?`,...this.keys(),run.id).all<{source_id:string;score:number}>();
      const positive=new Set(scores.results.filter(row=>row.score>0).map(row=>row.source_id));
      const lane=lexical.filter(row=>positive.has(row.id));
      const rank=(id:string)=>{const l=lane.findIndex(row=>row.id===id),m=semantic.candidates.indexOf(id);return (l<0?0:1/(60+l+1))+(m<0?0:1/(60+m+1));};
      rows.results.sort((a,b)=>rank(b.id)-rank(a.id)||a.id.localeCompare(b.id));
    }
    rows.results.splice(JSON.parse(run.request_json).input.limit);
    const sources: RetrievedSource[] = []; let bytes = 0;
    const selected: Selected[] = [];
    const selectedOrigins=rows.results.filter(row=>row.origin_json).map(row=>JSON.parse(row.origin_json!) as OriginFence);
    if(!await checkOriginsWithin(selectedOrigins,fence=>this.options.origin ? this.options.origin.check(fence) : Promise.resolve(false)))return unavailable("origin_unavailable");
    for (const row of rows.results) {
      const source = this.access.fromRow(actor, row); bytes += new TextEncoder().encode(source.text ?? "").length;
      if (bytes > 65536) return unavailable("context_bytes_limit", true);
      const origin = row.origin_json ? JSON.parse(row.origin_json) as OriginFence : undefined;
      if (row.conversation_json) { const guard = this.contextGuard(JSON.parse(row.conversation_json)); if (!await this.statement(`SELECT 1 WHERE ${guard.sql}`, ...guard.values).first()) return unavailable("conversation_changed"); }
      sources.push({ ...source, ...(origin ? { origin } : {}) });
      selected.push({ id: source.id, revision: source.fence.source.revision, version: source.fence.source.version, hash: source.fence.source.hash });
    }
    const selectedJson = JSON.stringify(selected), ranking=semantic ? semanticRankingSchema.parse({engine:semantic.engine,gaps:semantic.gaps,binding:semantic.binding}) : null, packHash = await bridgeHash([run.request_hash, run.actor_json, selected,...(ranking ? [ranking] : [])]);
    const fresh = this.coverage(actor, run, this.clock());
    const savePack=this.statement(`UPDATE assistant_retrieval_runs SET pack_json=?,pack_hash=? WHERE ${ns} AND id=? AND ${fresh.sql} ${ranking ? `AND EXISTS(SELECT 1 FROM assistant_retrieval_semantic WHERE ${ns} AND run_id=? AND ranking_json=?)` : ""} RETURNING id`,selectedJson,packHash,...this.keys(),run.id,...fresh.values,...(ranking ? [...this.keys(),run.id,JSON.stringify(ranking)] : []));
    const saved = ranking ? (await this.db.batch([this.statement(`UPDATE assistant_retrieval_semantic SET ranking_json=? WHERE ${ns} AND run_id=? AND ${fresh.sql}`,JSON.stringify(ranking),...this.keys(),run.id,...fresh.values),savePack])).at(-1)! : await savePack.all();
    if (!saved.results.length) return unavailable("inventory_changed");
    const fence: SearchFence = Object.freeze({ ...this.scope, runId: run.id, runToken: run.run_token, requestHash: run.request_hash, checkpoint: run.checkpoint, actor: run.actor_json, selected, allowedPackHash: packHash, purpose: this.purpose, ...(ranking ? {ranking} : {}) });
    return { state: "ready", sources, fence, coverage: { inventoryComplete: true, engine: semantic?.engine ?? "not_run_capacity", gaps: semantic?.gaps ?? baseGaps.slice() } };
  }
  guard(actor: TrustedActor, fence: SearchFence, now = this.clock()): AccessGuard {
    actor = ownActor(actor);
    if (!fence || fence.installationId !== this.scope.installationId || fence.generation !== this.scope.generation || fence.purpose !== this.purpose || (this.purpose === "owner_read" && actor.kind !== "owner") || fence.actor !== JSON.stringify(actor) || !hashId(fence.runId) || !hashId(fence.requestHash) || !hashId(fence.allowedPackHash) || !Array.isArray(fence.selected) || fence.selected.length > 10 || fence.selected.some(row => !row || Object.keys(row).length !== 4 || !identifier(row.id) || !hashId(row.hash) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.version) || row.version < 1) || !identifier(fence.runToken) || !Number.isSafeInteger(fence.checkpoint) || fence.checkpoint < 0) return { sql: "0", values: [] };
    const run = { id: fence.runId, run_token: fence.runToken, request_hash: fence.requestHash, actor_json: fence.actor, checkpoint: fence.checkpoint, request_json: "{}" } as Run;
    // Project narrowing belongs to the persisted request, not caller JSON.
    // Use the same inventory through a scalar project lookup bound to this run.
    const projected = this.access.inventory(actor, undefined, now, { ...this.scope, includePaused: this.purpose === "owner_read" });
    const inventory = { sql: `SELECT * FROM (${projected.sql}) WHERE ((SELECT json_extract(request_json,'$.input.projectId') FROM assistant_retrieval_runs WHERE ${ns} AND id=?) IS NULL OR project_id=(SELECT json_extract(request_json,'$.input.projectId') FROM assistant_retrieval_runs WHERE ${ns} AND id=?))`, values: [...projected.values, ...this.keys(), run.id, ...this.keys(), run.id] };
    const coverage = this.coverage(actor, run, now, inventory);
    if (!!fence.ranking !== !!this.options.semantic) return {sql:"0",values:[]};
    return compressed(`${coverage.sql} AND EXISTS(SELECT 1 FROM assistant_retrieval_runs WHERE ${ns} AND id=? AND pack_hash=? AND pack_json=? AND json_extract(request_json,'$.semantic') IS ?) ${fence.ranking ? `AND EXISTS(SELECT 1 FROM assistant_retrieval_semantic WHERE ${ns} AND run_id=? AND ranking_json=?)` : ""}`, [...coverage.values, ...this.keys(), run.id, fence.allowedPackHash, JSON.stringify(fence.selected), this.options.semantic ? JSON.stringify(this.semanticConfiguration()) : null,...(fence.ranking ? [...this.keys(),run.id,JSON.stringify(fence.ranking)] : [])]);
  }
  async check(actor: TrustedActor, fence: SearchFence): Promise<boolean> {
    actor = ownActor(actor);
    const snapshot = this.guard(actor, fence, this.clock());
    if (snapshot.sql === "0") return false;
    fence = { installationId: fence.installationId, generation: fence.generation, runId: fence.runId, runToken: fence.runToken, requestHash: fence.requestHash, checkpoint: fence.checkpoint, actor: fence.actor, allowedPackHash: fence.allowedPackHash, purpose: fence.purpose, ...(fence.ranking ? {ranking:fence.ranking} : {}), selected: fence.selected.map(({ id, revision, version, hash }) => ({ id, revision, version, hash })) };
    const guard = this.guard(actor, fence, this.clock()); if (!await this.statement(`SELECT 1 WHERE ${guard.sql}`, ...guard.values).first()) return false;
    const rows = await this.statement(`SELECT origin_json,conversation_json FROM assistant_retrieval_items WHERE ${ns} AND run_id=? AND source_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`, ...this.keys(), fence.runId, JSON.stringify(fence.selected)).all<{ origin_json: string | null; conversation_json: string | null }>();
    const origins=rows.results.filter(row=>row.origin_json).map(row=>JSON.parse(row.origin_json!) as OriginFence);
    if(!await checkOriginsWithin(origins,fence=>this.options.origin ? this.options.origin.check(fence) : Promise.resolve(false)))return false;
    for (const row of rows.results) {
      if (row.conversation_json) { const local = this.contextGuard(JSON.parse(row.conversation_json)); if (!await this.statement(`SELECT 1 WHERE ${local.sql}`, ...local.values).first()) return false; }
    }
    if(this.options.semantic){const run=await this.load(actor,fence.runId),semantic=await this.semanticOutcome(actor,run);if(semantic.pending)return false;const ranking=semanticRankingSchema.safeParse({engine:semantic.engine,gaps:semantic.gaps,binding:semantic.binding});if(!ranking.success || JSON.stringify(fence.ranking)!==JSON.stringify(ranking.data))return false;}
    const fresh = this.guard(actor, fence, this.clock()); return !!await this.statement(`SELECT 1 WHERE ${fresh.sql}`, ...fresh.values).first();
  }
}
