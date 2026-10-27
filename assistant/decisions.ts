import { z } from "zod";
import { decisionSubject, type DecisionSubject, jobRequest, boundEpisode, sourceRef, sourceFence, validatedProposal } from "./agent/contracts";
import { SourceAccess, type AccessGuard, type TrustedActor, type SourceFence } from "./access";
import { workIntentGuard } from "./control";
import { conversationGuard, type ConversationFence } from "./conversations";
import { Episodes } from "./agent/episodes";
import type { SemanticEnginePort } from "./engine";
import { RetrievalRuns } from "./retrieval-runs";
import type { OncePlanReader } from "./owner-once-guard";
import type { OriginGuard } from "./origin-guard";
import type { EpisodeSearch, ValidatedProposal } from "./agent/controller";
import { bridgeHash } from "./ingress";
import type { SourceScope } from "./sources";
import {outgoingGuard,type OutgoingPort} from './outgoing';
export { decisionSubject, type DecisionSubject };
export const journalPhase = z.enum(["not_evaluated", "pending", "uncertain", "failed", "cancelled", "proposed", "silence", "waiting_context"]);
export const journalReason = z.enum(["budget_blocked", "waiting_context", "source_changed", "publication_rejected", "dispatch_uncertain", "model_uncertain", "cancelled", "invariant_failure"]);
export type JournalPhase = z.infer<typeof journalPhase>;
export type JournalReason = z.infer<typeof journalReason>;
type Scope = SourceScope & { sourceEpoch?: string; sourceGeneration?: string };
const ns = "installation_id=? AND generation=?";
const keys = (scope: SourceScope) => [scope.installationId, scope.generation];
/** Called only by the trusted enqueuer after owning/hash-binding the request. */
export async function seedDecisionJob(db: D1Database, scope: Scope, jobId: string, now: number) {
  const ledger = await db.prepare(`SELECT request_json,request_hash FROM assistant_job_ledger WHERE ${ns} AND job_id=?`).bind(...keys(scope), jobId).first<{ request_json: string; request_hash: string }>();
  if (!ledger || await bridgeHash(JSON.parse(ledger.request_json)) !== ledger.request_hash) throw new Error("decision_subject_invalid");
  const request = jobRequest.parse(JSON.parse(ledger.request_json)), subject = request.subject;
  const previous = await db.prepare(`SELECT request_hash,subject_json FROM assistant_decision_jobs WHERE ${ns} AND job_id=?`).bind(...keys(scope), jobId).first<{request_hash:string;subject_json:string}>();
  if (previous) {
    if (previous.request_hash !== ledger.request_hash || previous.subject_json !== JSON.stringify(subject)) throw new Error("decision_subject_conflict");
    return; // Preserve the original coalesced observation on exact redelivery.
  }
  let guard: AccessGuard, chatId = request.fence.source.conversationId, coalesced: number | null = null, observedRevision: number | null = null, watermark: number | null = null;
  if (subject.kind === "owner_request") {
    if (subject.sourceId !== request.sourceId || subject.sourceRevision !== request.sourceRevision) throw new Error("decision_subject_invalid");
    guard = { sql: `EXISTS(SELECT 1 FROM assistant_sources WHERE ${ns} AND id=? AND revision=? AND origin='owner_note' AND status='active' AND current_version IS NOT NULL)`, values: [...keys(scope), request.sourceId, request.sourceRevision] };
  } else if (subject.kind === "capture_event") {
    if (subject.sourceEpoch !== scope.sourceEpoch || subject.sourceGeneration !== scope.sourceGeneration) throw new Error("decision_subject_invalid");
    chatId = subject.chatId;
    const sql = `SELECT r.coalesced,r.observed_revision,r.observed_watermark FROM assistant_capture_inbox i JOIN assistant_conversation_replay r
      ON r.installation_id=i.installation_id AND r.generation=i.generation AND r.source_epoch=i.source_epoch AND r.source_generation=i.source_generation AND r.chat_id=i.chat_id AND r.sequence=i.sequence
      WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=? AND i.chat_id=? AND i.sequence=? AND i.metadata_hash=?
      AND i.operation='upsert' AND i.application_state='applied' AND r.state='applied' AND r.canonical_id=? AND r.observed_revision=?`;
    const values = [...keys(scope), subject.sourceEpoch, subject.sourceGeneration, subject.chatId, subject.sequence, subject.metadataHash, request.sourceId, request.sourceRevision];
    const observed = await db.prepare(sql).bind(...values).first<{ coalesced: number; observed_revision: number; observed_watermark: number }>();
    if (!observed) throw new Error("decision_subject_invalid");
    coalesced = observed.coalesced; observedRevision = observed.observed_revision; watermark = observed.observed_watermark;
    guard = { sql: `EXISTS(${sql})`, values };
  } else {
    guard = { sql: `EXISTS(SELECT 1 FROM assistant_jobs j JOIN assistant_fup_occurrences o ON o.installation_id=j.installation_id AND o.generation=j.generation AND o.id=j.occurrence_id
      JOIN assistant_follow_ups f ON f.installation_id=o.installation_id AND f.generation=o.generation AND f.id=o.follow_up_id AND f.version=o.follow_up_version
      WHERE j.installation_id=? AND j.generation=? AND j.id=? AND j.kind='follow_up' AND o.id=? AND f.id=? AND f.version=? AND f.source_id=? AND f.source_revision=?)`,
      values: [...keys(scope), jobId, subject.occurrenceId, subject.followUpId, subject.followUpVersion, request.sourceId, request.sourceRevision] };
    const target = await db.prepare(`SELECT conversation_id FROM assistant_follow_ups WHERE ${ns} AND id=? AND version=?`).bind(...keys(scope), subject.followUpId, subject.followUpVersion).first<{ conversation_id: string }>();
    chatId = target?.conversation_id ?? null;
  }
  const subjectJson = JSON.stringify(subject), subjectHash = await bridgeHash(subject), seedHash = await bridgeHash([ledger.request_hash, subject, coalesced, observedRevision, watermark]);
  const capture = subject.kind === "capture_event" ? subject : null;
  await db.prepare(`INSERT INTO assistant_decision_jobs(installation_id,generation,job_id,request_hash,subject_kind,subject_json,subject_hash,seed_hash,seeded_at,source_epoch,source_generation,chat_id,sequence,metadata_hash,coalesced,observed_revision,observed_watermark)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} ON CONFLICT DO NOTHING`).bind(...keys(scope), jobId, ledger.request_hash, subject.kind, subjectJson, subjectHash, seedHash, now,
    capture?.sourceEpoch ?? null, capture?.sourceGeneration ?? null, chatId, capture?.sequence ?? null, capture?.metadataHash ?? null, coalesced, observedRevision, watermark, ...guard.values).run();
  const stored = await db.prepare(`SELECT seed_hash FROM assistant_decision_jobs WHERE ${ns} AND job_id=?`).bind(...keys(scope), jobId).first<{ seed_hash: string }>();
  if (stored?.seed_hash !== seedHash) throw new Error("decision_subject_conflict");
}
export type DecisionMetadata = { id: string; subject?: DecisionSubject; jobId?: string; episodeId?: string; phase: JournalPhase; reason?: JournalReason; freshness: "unchecked" | "current" | "stale" | "unavailable"; recordedAt: number | null; effects: { mode: "shadow"; external: "none" }; capture?: { operation: string; applicationState: string; replayState: string | null } };
type ReviewAdmission = { hash: string; build: (guard: AccessGuard) => D1PreparedStatement[]; results: D1Result[] | null };
type Plan = { proposal: ValidatedProposal; statements: D1PreparedStatement[]; publicationIndex: number; journalGuard: AccessGuard };
type Options = { clock?: () => number; origin?: OriginGuard; search?: EpisodeSearch; semantic?: { mode: "required" | "lexical_fallback"; engine: SemanticEnginePort }; timeoutMs?: number;outgoing?:OutgoingPort; ownerOncePlan?: OncePlanReader };
type MetadataRow = { family: string; key: string; sort: number; recorded: number | null; job_id: string | null; episode_id: string | null; subject_json: string | null; phase: string; reason: string | null; coalesced: number | null; observed_revision: number | null; observed_watermark: number | null; operation: string | null; application_state: string; replay_state: string | null };
const committed = `j.state='shadow_completed' AND e.state='settled' AND d.request_hash=l.request_hash AND d.binding_hash=e.binding_hash AND d.proposal_json=e.result_json AND d.proposal_json IS NOT NULL AND d.publication_nonce=e.search_nonce AND d.publication_nonce IS NOT NULL`;
const invalidRequest = `CASE WHEN json_valid(l.request_json) THEN json_extract(l.request_json,'$.runtime') IS NOT 'flue' ELSE 1 END`;
const jsonCursor = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const readCursor = (value: string): unknown => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
/** Owner read model and host-only writers. No router, model, sender or free SQL input. */
export class DecisionJournal {
  private readonly scope: Readonly<Scope>;
  private readonly actor: TrustedActor;
  private readonly clock: () => number;
  constructor(private readonly db: D1Database, scope: Scope, actor: TrustedActor, private readonly options: Options = {}) {
    this.scope = Object.freeze({ ...scope }); this.actor = Object.freeze({ ...actor }); this.clock = options.clock ?? Date.now;
    if (!scope.installationId || !scope.generation || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5000))) throw new Error("decision_configuration");
  }
  private owner() { if (this.actor.kind !== "owner") throw new Error("owner_required"); }
  private sql(sql: string, ...values: (string | number | null)[]) { return this.db.prepare(sql).bind(...values); }
  private metadata(row: MetadataRow): DecisionMetadata & { observation?: { coalesced: boolean; revision: number | null; watermark: number | null } } {
    let subject: DecisionSubject | undefined, invalid = false;
    try { if (row.subject_json) subject = decisionSubject.parse(JSON.parse(row.subject_json)); } catch { invalid = true; }
    const phase = journalPhase.safeParse(row.phase), reason = journalReason.safeParse(row.reason);
    return { id: row.family + ":" + row.key, ...(subject ? { subject } : {}), ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.episode_id ? { episodeId: row.episode_id } : {}),
      phase: invalid || !phase.success ? "failed" : phase.data, ...(invalid || !phase.success ? { reason: "invariant_failure" as const } : reason.success ? { reason: reason.data } : {}),
      freshness: invalid ? "unavailable" : "unchecked", recordedAt: row.recorded, effects: { mode: "shadow", external: "none" },
      ...(row.operation === null ? {} : { capture: { operation: row.operation, applicationState: row.application_state, replayState: row.replay_state } }),
      ...(row.coalesced === null ? {} : { observation: { coalesced: row.coalesced === 1, revision: row.observed_revision, watermark: row.observed_watermark } }) };
  }
  private view() {
    // Start with received events, preserving every anti-JOIN and negative state.
    return `SELECT 'capture' family,json_array(i.source_epoch,i.source_generation,i.sequence) key,i.received_at sort,i.received_at recorded,h.job_id,NULL episode_id,
      COALESCE(h.subject_json,json_object('kind','capture_event','sourceEpoch',i.source_epoch,'sourceGeneration',i.source_generation,'chatId',i.chat_id,'sequence',i.sequence,'metadataHash',i.metadata_hash)) subject_json,
      CASE WHEN l.job_id IS NOT NULL AND (${invalidRequest}) THEN 'failed' WHEN j.state='cancelled' THEN 'cancelled' WHEN j.state='failed' THEN 'failed' WHEN l.state='uncertain' THEN 'uncertain'
       WHEN i.application_state='blocked' OR r.state='gap' THEN 'waiting_context' WHEN h.job_id IS NOT NULL THEN 'pending' ELSE 'not_evaluated' END phase,
      CASE WHEN l.job_id IS NOT NULL AND (${invalidRequest}) THEN 'invariant_failure' WHEN j.state='cancelled' THEN 'cancelled' WHEN j.state='failed' THEN 'invariant_failure' WHEN i.application_state='blocked' OR r.state='gap' THEN 'waiting_context' ELSE NULL END reason,
      COALESCE(h.coalesced,r.coalesced) coalesced,COALESCE(h.observed_revision,r.observed_revision) observed_revision,COALESCE(h.observed_watermark,r.observed_watermark) observed_watermark,i.chat_id,i.operation,i.application_state,r.state replay_state
      FROM assistant_capture_inbox i LEFT JOIN assistant_conversation_replay r ON r.installation_id=i.installation_id AND r.generation=i.generation AND r.source_epoch=i.source_epoch AND r.source_generation=i.source_generation AND r.chat_id=i.chat_id AND r.sequence=i.sequence
      LEFT JOIN assistant_decision_jobs h ON h.installation_id=i.installation_id AND h.generation=i.generation AND h.source_epoch=i.source_epoch AND h.source_generation=i.source_generation AND h.chat_id=i.chat_id AND h.sequence=i.sequence
      LEFT JOIN assistant_jobs j ON j.installation_id=h.installation_id AND j.generation=h.generation AND j.id=h.job_id
      LEFT JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      WHERE i.installation_id=? AND i.generation=? AND NOT EXISTS(SELECT 1 FROM assistant_shadow_decisions d WHERE d.installation_id=h.installation_id AND d.generation=h.generation AND d.job_id=h.job_id)
      UNION ALL SELECT 'job',j.id,COALESCE(h.seeded_at,0),h.seeded_at,j.id,NULL,h.subject_json,
      CASE WHEN h.job_id IS NULL OR (${invalidRequest}) THEN 'failed' WHEN j.state='cancelled' THEN 'cancelled' WHEN j.state='failed' THEN 'failed' WHEN l.state='uncertain' THEN 'uncertain' ELSE 'pending' END,
      CASE WHEN h.job_id IS NULL OR (${invalidRequest}) THEN 'invariant_failure' WHEN j.state='cancelled' THEN 'cancelled' WHEN j.last_error='waiting_context' THEN 'waiting_context' WHEN j.state='failed' THEN 'invariant_failure' ELSE NULL END,NULL,NULL,NULL,h.chat_id,NULL,NULL,NULL
      FROM assistant_jobs j JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      LEFT JOIN assistant_decision_jobs h ON h.installation_id=j.installation_id AND h.generation=j.generation AND h.job_id=j.id
      WHERE j.installation_id=? AND j.generation=? AND (h.job_id IS NOT NULL OR CASE WHEN json_valid(l.request_json) THEN json_extract(l.request_json,'$.runtime')='flue' ELSE 1 END) AND (h.job_id IS NULL OR h.subject_kind<>'capture_event')
      AND NOT EXISTS(SELECT 1 FROM assistant_shadow_decisions d WHERE d.installation_id=j.installation_id AND d.generation=j.generation AND d.job_id=j.id)
      UNION ALL SELECT 'decision',d.id,d.recorded_at,d.recorded_at,d.job_id,d.episode_id,h.subject_json,
      CASE WHEN d.proposal_json IS NULL THEN d.outcome WHEN ${committed} THEN d.outcome ELSE 'pending' END,
      CASE WHEN d.proposal_json IS NOT NULL AND NOT(${committed}) THEN 'publication_rejected' ELSE d.reason END,h.coalesced,h.observed_revision,h.observed_watermark,h.chat_id,NULL,NULL,NULL
      FROM assistant_shadow_decisions d JOIN assistant_decision_jobs h ON h.installation_id=d.installation_id AND h.generation=d.generation AND h.job_id=d.job_id AND h.request_hash=d.request_hash
      LEFT JOIN assistant_jobs j ON j.installation_id=d.installation_id AND j.generation=d.generation AND j.id=d.job_id
      LEFT JOIN assistant_job_ledger l ON l.installation_id=d.installation_id AND l.generation=d.generation AND l.job_id=d.job_id
      LEFT JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id WHERE d.installation_id=? AND d.generation=?`;
  }
  private viewKeys() { return [...keys(this.scope), ...keys(this.scope), ...keys(this.scope)]; }
  /** Metadata only, all phases, no paginated prefix or remote-content claim. */
  async metadataCounts(): Promise<Record<string, number>> {
    this.owner(); const counts: Record<string, number> = Object.fromEntries(journalPhase.options.map(phase => [phase, 0]));
    const rows = await this.sql(`WITH items AS(${this.view()}) SELECT phase,COUNT(*) n FROM items GROUP BY phase`, ...this.viewKeys()).all<{ phase: string; n: number }>();
    for (const row of rows.results) counts[journalPhase.safeParse(row.phase).success ? row.phase : "failed"] += row.n;
    return counts;
  }
  async list(input: { cursor?: string; limit?: number; conversationId?: string; state?: JournalPhase } = {}) {
    this.owner();
    const owned = z.object({ cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20), conversationId: z.string().min(1).max(256).optional(), state: journalPhase.optional() }).strict().parse(input);
    const filter = JSON.stringify([this.scope, owned.conversationId ?? null, owned.state ?? null]); let after: [number, string, string] | null = null;
    if (owned.cursor) { try { const value = z.tuple([z.literal(1), z.string(), z.number().int(), z.string().max(32), z.string().max(2048)]).parse(readCursor(owned.cursor)); if (value[1] !== filter) throw 0; after = [value[2], value[3], value[4]]; } catch { throw new Error("decision_cursor"); } }
    const rows = await this.sql(`WITH items AS(${this.view()}) SELECT * FROM items WHERE (? IS NULL OR chat_id=?) AND (? IS NULL OR phase=?)
      ${after ? "AND (sort,family,key)>(?,?,?)" : ""} ORDER BY sort,family,key LIMIT ?`, ...this.viewKeys(), owned.conversationId ?? null, owned.conversationId ?? null, owned.state ?? null, owned.state ?? null, ...(after ?? []), owned.limit + 1).all<MetadataRow>();
    const more = rows.results.length > owned.limit, page = rows.results.slice(0, owned.limit), last = page.at(-1);
    return { items: page.map(row => this.metadata(row)), ...(more && last ? { nextCursor: jsonCursor([1, filter, last.sort, last.family, last.key]) } : {}), coverage: { kind: "page" as const, remoteFreshness: "unchecked" as const } };
  }
  async record(jobId: string, leaseGeneration: number, phase: "failed" | "uncertain" | "cancelled" | "waiting_context", reason: JournalReason, episodeId: string | null = null) {
    journalReason.parse(reason); journalPhase.parse(phase);
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new Error("decision_observation");
    const id = await bridgeHash([...keys(this.scope), jobId, leaseGeneration, episodeId, phase, reason]);
    await this.sql(`INSERT INTO assistant_shadow_decisions(installation_id,generation,id,job_id,request_hash,lease_generation,episode_id,outcome,reason,dependencies_json,receipts_json,recorded_at)
      SELECT installation_id,generation,?,job_id,request_hash,?,?,?,?, '[]','[]',? FROM assistant_decision_jobs WHERE ${ns} AND job_id=? ON CONFLICT DO NOTHING`,
      id, leaseGeneration, episodeId, phase, reason, this.clock(), ...keys(this.scope), jobId).run();
    return id;
  }
  private publicationGate(id: string, value: ValidatedProposal, hash: string): AccessGuard {
    return { sql: `EXISTS(SELECT 1 FROM assistant_shadow_decisions d JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id
      WHERE d.installation_id=? AND d.generation=? AND d.id=? AND d.job_id=? AND d.request_hash=? AND d.episode_id=? AND d.binding_hash=? AND d.pack_hash=? AND d.proposal_hash=? AND d.publication_nonce=e.search_nonce AND d.publication_nonce IS NOT NULL)`,
      values: [...keys(this.scope), id, value.binding.jobId, value.binding.requestHash, value.binding.episodeId, value.binding.bindingHash, value.binding.allowedPackHash, hash] };
  }
  /** Same-plan attestation, INSERT and inverse gate; never an optional fallback. */
  async publish(build: (gate: (proposal: ValidatedProposal) => Promise<AccessGuard>) => Promise<Plan>) {
    let identity: { id: string; hash: string; value: ValidatedProposal } | undefined;
    const plan = await build(async proposal => {
      const value = validatedProposal.parse(proposal), hash = await bridgeHash(value), id = await bridgeHash([...keys(this.scope), value.binding.episodeId, "publication"]);
      identity = { id, hash, value }; return this.publicationGate(id, value, hash);
    });
    if (!identity) throw new Error("decision_publication_required");
    const { id, hash, value } = identity, json = JSON.stringify(value);
    const episode = await new Episodes(this.db, this.scope, this.clock).get(value.binding.episodeId);
    if (!episode) throw new Error("decision_publication_required");
    const bound = boundEpisode(episode), refs = JSON.stringify(bound.binding.context.sources.map(row => row.fence.source).map(({id,revision,version,hash}) => ({id,revision,version,hash})));
    const receipts = await this.sql(`SELECT operation_key FROM assistant_episode_calls WHERE ${ns} AND episode_id=? AND state='complete' ORDER BY ordinal`, ...keys(this.scope), episode.id).all<{ operation_key: string }>();
    const previous = await this.sql(`SELECT proposal_hash FROM assistant_shadow_decisions WHERE ${ns} AND id=?`, ...keys(this.scope), id).first<{ proposal_hash: string }>();
    if (previous && previous.proposal_hash !== hash) throw new Error("decision_conflict");
    const insert = this.sql(`INSERT INTO assistant_shadow_decisions(installation_id,generation,id,job_id,request_hash,lease_generation,episode_id,outcome,binding_hash,pack_hash,proposal_hash,dependencies_json,receipts_json,proposal_json,recorded_at,publication_nonce)
      SELECT e.installation_id,e.generation,?,?,?, ?,e.id,?,?,?,?,?,?,?, ?,e.search_nonce FROM assistant_episodes e
      JOIN assistant_decision_jobs h ON h.installation_id=e.installation_id AND h.generation=e.generation AND h.job_id=e.job_id AND h.request_hash=e.request_hash
      WHERE e.installation_id=? AND e.generation=? AND e.id=? AND (${plan.journalGuard.sql})
      ON CONFLICT(installation_id,generation,id) DO UPDATE SET publication_nonce=excluded.publication_nonce
      WHERE assistant_shadow_decisions.proposal_hash=excluded.proposal_hash AND assistant_shadow_decisions.binding_hash=excluded.binding_hash AND assistant_shadow_decisions.job_id=excluded.job_id AND assistant_shadow_decisions.request_hash=excluded.request_hash AND assistant_shadow_decisions.episode_id=excluded.episode_id RETURNING id`,
      id, episode.job_id, episode.request_hash, bound.binding.lease.lease_generation, value.decision === "no_reply" ? "silence" : value.decision, episode.binding_hash, value.binding.allowedPackHash, hash, refs, JSON.stringify(receipts.results.map(row => row.operation_key)), json, this.clock(), ...keys(this.scope), episode.id, ...plan.journalGuard.values);
    try {
      const statements = [...plan.statements]; statements.splice(plan.publicationIndex, 0, insert);
      const results = await this.db.batch(statements);
      return results[plan.publicationIndex + 1].results.length === 1 ? { state: "shadow_completed", decisionId: id, proposal: value } : { state: "blocked", decisionId: id };
    } catch {
      // Commit ACK loss is reconciled from exact durable identity, never Flue.
      const recovered = await this.committed(id, hash);
      return recovered ? { state: "shadow_completed", decisionId: id } : { state: "uncertain", decisionId: id };
    }
  }
  private async committed(id: string, hash?: string) {
    return !!await this.sql(`SELECT 1 FROM assistant_shadow_decisions d JOIN assistant_jobs j ON j.installation_id=d.installation_id AND j.generation=d.generation AND j.id=d.job_id
      JOIN assistant_job_ledger l ON l.installation_id=d.installation_id AND l.generation=d.generation AND l.job_id=d.job_id
      JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id
      WHERE d.installation_id=? AND d.generation=? AND d.id=? ${hash ? "AND d.proposal_hash=?" : ""} AND ${committed}`, ...keys(this.scope), id, ...(hash ? [hash] : [])).first();
  }
  async publishedEpisode(episodeId: string) {
    const row = await this.sql(`SELECT id FROM assistant_shadow_decisions WHERE ${ns} AND episode_id=? AND proposal_json IS NOT NULL`, ...keys(this.scope), episodeId).first<{ id: string }>();
    return row && await this.committed(row.id) ? { state: "shadow_completed", decisionId: row.id } : { state: "blocked" };
  }
  get(id: string) { return this.read(id); }
  /** Host-only atomic read admission. Remote checks run immediately before a
   * single batch; its one-use attestation is always removed in that same batch.
   * SQL builders are trusted code, never RPC/model/message input. */
  async admitReview(id: string, hash: string, build: (guard: AccessGuard) => D1PreparedStatement[]): Promise<D1Result[] | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("decision_hash");
    const admission: ReviewAdmission = { hash, build, results: null };
    await this.read(id, admission); return admission.results;
  }
  private async read(id: string, admission?: ReviewAdmission): Promise<DecisionMetadata & { proposal?: ValidatedProposal } | { state: "unavailable" }> {
    this.owner();
    if (typeof id !== "string" || id.length > 2048) throw new Error("decision_id");
    const prefixed = id.includes(":") ? id : "decision:" + id, separator = prefixed.indexOf(":"), family = prefixed.slice(0,separator), key = prefixed.slice(separator+1);
    const row = await this.sql(`WITH items AS(${this.view()}) SELECT * FROM items WHERE family=? AND key=? LIMIT 1`, ...this.viewKeys(), family, key).first<MetadataRow>();
    if (!row) return { state: "unavailable" };
    const metadata = this.metadata(row);
    if (family !== "decision" || !["proposed","silence","waiting_context"].includes(metadata.phase)) return metadata;
    try {
      const stored = await this.sql(`SELECT d.proposal_json,d.proposal_hash,d.publication_nonce,d.dependencies_json,l.request_json,l.request_hash,d.episode_id FROM assistant_shadow_decisions d
        JOIN assistant_job_ledger l ON l.installation_id=d.installation_id AND l.generation=d.generation AND l.job_id=d.job_id WHERE d.installation_id=? AND d.generation=? AND d.id=?`, ...keys(this.scope), key)
        .first<{ proposal_json: string | null; proposal_hash: string; publication_nonce: string; dependencies_json: string; request_json: string; request_hash: string; episode_id: string }>();
      if (!stored?.proposal_json || !await this.committed(key)) return metadata;
      const value = validatedProposal.parse(JSON.parse(stored.proposal_json)), refs = z.array(sourceRef).max(10).parse(JSON.parse(stored.dependencies_json));
      if (new TextEncoder().encode(stored.proposal_json).length > 32768 || await bridgeHash(value) !== stored.proposal_hash || await bridgeHash(JSON.parse(stored.request_json)) !== stored.request_hash) throw 0;
      const request = jobRequest.parse(JSON.parse(stored.request_json)), raw = await new Episodes(this.db, this.scope, this.clock).get(stored.episode_id);
      if (!raw) throw 0; const episode = boundEpisode(raw), binding = episode.binding;
      const actual = binding.context.sources.map(row => row.fence.source).map(({id,revision,version,hash}) => ({id,revision,version,hash}));
      if (JSON.stringify(actual) !== JSON.stringify(refs) || JSON.stringify(value) !== JSON.stringify(episode.result) || value.binding.bindingHash !== episode.binding_hash || JSON.stringify(metadata.subject) !== JSON.stringify(request.subject) || JSON.stringify(request.subject) !== JSON.stringify(binding.subject)) throw 0;
      if(JSON.stringify(request.outgoing)!==JSON.stringify(binding.outgoing)||JSON.stringify(value.outgoing)!==JSON.stringify(binding.outgoing))throw 0;
      const access = new SourceAccess(this.db, this.scope), now = this.clock(), ownerFences: SourceFence[] = [];
      const search = this.options.search ?? new RetrievalRuns(this.db, this.scope, { purpose: binding.purpose, origin: this.options.origin, clock: this.clock, semantic: this.options.semantic, ownerOncePlan: this.options.ownerOncePlan });
      for (const source of binding.context.sources) {
        const current = await access.read({ kind: "owner" }, source.id, source.fence.source.revision, now);
        if (!current) return { ...metadata, freshness: "stale" };
        ownerFences.push(current.fence);
      }
      const localGuards = async (at: number) => {
        const selected = await search.guard(binding.actor, binding.search, at);
        // Do not admit a grant/deadline using a clock sampled before search awaited.
        at=this.clock();
        const guards: AccessGuard[] = [selected, access.guard(binding.actor, request.fence, at)];
        if (request.conversation) guards.push(conversationGuard(request.conversation));
        for (let index = 0; index < binding.context.sources.length; index++) guards.push(access.guard(binding.actor, binding.context.sources[index].fence, at), access.guard({ kind: "owner" }, ownerFences[index], at));
        if(binding.work.kind==='follow_up')guards.push(workIntentGuard(binding.work.fence,at));
        if (binding.work.kind === "follow_up"&&!binding.outgoing) {if(!binding.work.target.fence)throw 0;guards.push(conversationGuard(binding.work.target.fence), {
          sql: `EXISTS(SELECT 1 FROM assistant_conversation_modes WHERE ${ns} AND conversation_id=? AND kind=? AND revision=? AND effective_mode=?)`,
          values: [...keys(this.scope), binding.work.target.fence.chatId, binding.work.target.policy.kind, binding.work.target.policy.revision, binding.work.target.policy.mode] });}
        if(binding.outgoing){if(binding.work.kind!=='follow_up')throw 0;guards.push(outgoingGuard(this.scope,{id:binding.work.fence.followUpId,version:binding.work.fence.version},binding.outgoing,at,request.sourceId));}
        return guards;
      };
      const origins = binding.context.sources.flatMap(source => source.origin ? [source.origin] : []);
      if (request.fence.source.origin === "whatsapp" && !origins.some(ref => ref.canonicalId === request.sourceId)) {
        const origin = await this.options.origin?.fence(request.sourceId); if (!origin) return { ...metadata, freshness: "unavailable" }; origins.push(origin);
      }
      if (origins.length && !this.options.origin) return { ...metadata, freshness: "unavailable" };
      const deadline = Date.now() + (this.options.timeoutMs ?? 4000);
      for (let offset = 0; offset < origins.length; offset += 2) {
        if (Date.now() >= deadline) return { ...metadata, freshness: "unavailable" };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const checks = Promise.all(origins.slice(offset,offset+2).map(async ref => {
          const current = await this.options.origin!.fence(ref.canonicalId);
          // Schema parsing owns/reorders fields; property order is not identity.
          if (!current || Object.keys(ref).some(key => ref[key as keyof typeof ref] !== current[key as keyof typeof current])) return false;
          return this.options.origin!.check(current);
        })).catch(() => [false]);
        let results: boolean[];
        try { results = await Promise.race([checks, new Promise<boolean[]>(resolve => { timer = setTimeout(() => resolve([false]), Math.max(1, deadline - Date.now())); })]); }
        finally { clearTimeout(timer); }
        if (results.some(value => !value) || Date.now() > deadline) return { ...metadata, freshness: "unavailable" };
      }
      // A single final D1 transaction sees all local predicates coherently;
      // separate SELECTs preserve depth100 and <=100 bindings per statement.
      if(binding.outgoing&&(!this.options.outgoing||!await this.options.outgoing.check(binding.outgoing)))return {...metadata,freshness:'stale'};
      const guards = await localGuards(this.clock());
      const detail = { ...metadata, freshness: "current" as const, proposal: value };
      if (new TextEncoder().encode(JSON.stringify(detail)).length > 32768) throw 0;
      if (admission) {
        if (stored.proposal_hash !== admission.hash || guards.some(guard => guard.values.length > 97)) return { ...metadata, freshness: "stale" };
        const token = crypto.randomUUID(), gate: AccessGuard = { sql: `EXISTS(SELECT 1 FROM assistant_telegram_read_admissions WHERE ${ns} AND token=?)`, values: [...keys(this.scope), token] };
        const insert = this.sql(`INSERT INTO assistant_telegram_read_admissions SELECT d.installation_id,d.generation,?,d.id,d.proposal_hash,d.publication_nonce FROM assistant_shadow_decisions d
          JOIN assistant_jobs j ON j.installation_id=d.installation_id AND j.generation=d.generation AND j.id=d.job_id
          JOIN assistant_job_ledger l ON l.installation_id=d.installation_id AND l.generation=d.generation AND l.job_id=d.job_id
          JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id
          WHERE d.installation_id=? AND d.generation=? AND d.id=? AND d.proposal_hash=? AND d.publication_nonce=? AND ${committed}`,
          token, ...keys(this.scope), key, admission.hash, stored.publication_nonce);
        const gates = guards.map(guard => this.sql(`DELETE FROM assistant_telegram_read_admissions WHERE ${ns} AND token=? AND NOT(${guard.sql})`, ...keys(this.scope), token, ...guard.values));
        const actions = admission.build(gate), offset = 1 + gates.length;
        const results = await this.db.batch([insert, ...gates, ...actions, this.sql(`SELECT 1 WHERE ${gate.sql}`, ...gate.values), this.sql(`DELETE FROM assistant_telegram_read_admissions WHERE ${ns} AND token=?`, ...keys(this.scope), token)]);
        if (results[offset + actions.length].results.length !== 1) return { ...metadata, freshness: "stale" };
        admission.results = results.slice(offset, offset + actions.length); return detail;
      }
      const final = await this.db.batch(guards.map(guard => this.sql(`SELECT 1 WHERE ${guard.sql}`, ...guard.values)));
      if (!final.every(result => result.results.length === 1) || !await this.committed(key)) return { ...metadata, freshness: "stale" };
      return detail;
    } catch { return { ...metadata, freshness: "unavailable", reason: "invariant_failure" }; }
  }
}
