import { z } from "zod";
import { DecisionJournal, journalPhase } from "./decisions";
import { SourceAccess, type SourceFence, type TrustedActor } from "./access";
import { CommandLedger } from "./command-ledger";
import { bridgeHash } from "./ingress";
import type { SourceScope } from "./sources";
import type { OriginGuard } from "./origin-guard";

const id = z.string().min(1).max(256), entryId = z.string().min(1).max(2048), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const assessmentLabel = z.enum(["correct", "unsupported", "missed_silence", "unknown"]);
const humanAction = z.enum(["none_observed", "replied", "declined", "rescheduled", "other"]);
export const evaluationCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evaluation.expose"), operationId: id, entryId }).strict(),
  z.object({ kind: z.literal("evaluation.assess"), operationId: id, exposureId: hash, basis: z.literal("owner_report"), label: assessmentLabel,
    humanAction: humanAction.optional(), evidence: z.object({ sourceId: id, revision: z.number().int().positive().safe() }).strict().optional() }).strict(),
]);
export const evaluationQuery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evaluation.sample"), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20), conversationId: id.optional(), state: journalPhase.optional() }).strict(),
  z.object({ kind: z.literal("evaluation.metrics") }).strict(),
  z.object({ kind: z.literal("evaluation.exposure"), id: hash }).strict(),
]);
type Scope = SourceScope & { sourceEpoch?: string; sourceGeneration?: string };
type Exposure = { id: string; entry_id: string; observation_hash: string; metadata_json: string; opened_at: number };
const ns = "installation_id=? AND generation=?";
const safe = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("evaluation_unsafe_total"); return value; };
/** Journal observations and explicit owner labels; no inference, notifier or action capability. */
export class Evaluation {
  private readonly scope: Readonly<Scope>;
  private readonly actor: TrustedActor;
  constructor(private readonly db: D1Database, scope: Scope, actor: TrustedActor,
    private readonly journal: Pick<DecisionJournal, "list" | "get">, private readonly options: { clock?: () => number; origin?: OriginGuard } = {}) {
    if (!scope.installationId || !scope.generation) throw new Error("evaluation_configuration");
    this.scope = Object.freeze({ ...scope }); this.actor = Object.freeze({ ...actor });
  }
  private owner() { if (this.actor.kind !== "owner") throw new Error("owner_required"); }
  private now() { return safe((this.options.clock ?? Date.now)()); }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private sql(text: string, ...values: (string | number | null)[]) { return this.db.prepare(text).bind(...values); }
  private async observation(entry: string) {
    const detail = await this.journal.get(entry);
    if (!("id" in detail)) throw new Error("evaluation_entry_unavailable");
    // No source/proposal bodies or quotes. Opaque IDs/request keys remain
    // potentially personal metadata; this projection is not anonymization.
    const metadata = { id: detail.id, jobId: detail.jobId ?? null, episodeId: detail.episodeId ?? null, phase: detail.phase,
      reason: detail.reason ?? null, recordedAt: detail.recordedAt, subject: detail.subject ?? null,
      proposalHash: "proposal" in detail && detail.proposal ? await bridgeHash(detail.proposal) : null };
    return { metadata, hash: await bridgeHash(metadata), freshness: detail.freshness };
  }
  async sample(input: { cursor?: string; limit?: number; conversationId?: string; state?: z.infer<typeof journalPhase> } = {}) {
    this.owner();
    const page = await this.journal.list(input), counts = Object.fromEntries(journalPhase.options.map(phase => [phase, 0])) as Record<z.infer<typeof journalPhase>, number>;
    for (const item of page.items) counts[item.phase]++;
    return { ...page, counts, population: "journal_entries_in_this_page", snapshot: "not_atomic", remoteFreshness: "unchecked",
      coverage: { ...page.coverage, observedEntries: page.items.length, proposalOrSilenceEntries: counts.proposed + counts.silence,
        proposalOrSilenceFraction: page.items.length ? (counts.proposed + counts.silence) / page.items.length : null,
        state: page.items.length ? "observed_page" : "unknown", globalCoverage: "unknown" } };
  }
  async execute(input: unknown) {
    this.owner(); const command = evaluationCommand.parse(input), now = this.now(), ledger = new CommandLedger(this.db, this.scope, command.operationId, await bridgeHash(["owner-evaluation-v1", command]));
    const previous = await ledger.recover(); if (previous) return previous;
    if (command.kind === "evaluation.expose") {
      const observed = await this.observation(command.entryId), exposureId = await bridgeHash([...this.keys(), "evaluation-exposure", command.operationId]);
      const receipt = { kind: command.kind, id: exposureId, openedAt: now, observation: "server_registered_exposure", contentFreshnessAtExposure: observed.freshness };
      await this.db.batch([ledger.admit(receipt, now, "1=1", []), ledger.statement(`INSERT INTO assistant_evaluation_exposures SELECT ?,?,?,?,?,?,? WHERE $gate`, ...this.keys(), exposureId, observed.metadata.id, observed.hash, JSON.stringify(observed.metadata), now)]);
    } else {
      const exposure = await this.sql(`SELECT * FROM assistant_evaluation_exposures WHERE ${ns} AND id=?`, ...this.keys(), command.exposureId).first<Exposure>();
      if (!exposure || now < exposure.opened_at) throw new Error("evaluation_exposure_unavailable");
      const access = new SourceAccess(this.db, this.scope), evidence = command.evidence ? await access.read({ kind: "owner" }, command.evidence.sourceId, command.evidence.revision, now) : null;
      if (command.evidence && !evidence) throw new Error("evaluation_evidence_unavailable");
      if (evidence?.fence.source.origin === "whatsapp") {
        const origin = await this.options.origin?.fence(evidence.id);
        if (!origin || !await this.options.origin!.check(origin)) throw new Error("evaluation_evidence_unavailable");
      }
      const gate = evidence ? access.guard({ kind: "owner" }, evidence.fence, this.now()) : { sql: "1=1", values: [] };
      const assessmentId = await bridgeHash([...this.keys(), "owner-assessment", command.operationId]), elapsedWallMs = now - exposure.opened_at;
      const receipt = { kind: command.kind, id: assessmentId, exposureId: exposure.id, basis: "owner_assessment_at_exposure", elapsedWallMs, measurement: "elapsed_wall_not_active_review" };
      await this.db.batch([
        ledger.admit(receipt, now, `${gate.sql} AND NOT EXISTS(SELECT 1 FROM assistant_evaluation_assessments WHERE ${ns} AND exposure_id=?)`, [...gate.values, ...this.keys(), exposure.id]),
        ledger.statement(`INSERT INTO assistant_evaluation_assessments SELECT ?,?,?,?,?,?,'owner_report',?,?,?,? WHERE $gate`, ...this.keys(), assessmentId, exposure.id, exposure.entry_id, command.label, command.humanAction ?? null, evidence ? JSON.stringify(evidence.fence) : null, now, elapsedWallMs),
      ]);
    }
    const receipt = await ledger.recover(); if (!receipt) throw new Error("evaluation_precondition"); return receipt;
  }
  async exposure(id: string) {
    this.owner(); hash.parse(id);
    const row = await this.sql(`SELECT * FROM assistant_evaluation_exposures WHERE ${ns} AND id=?`, ...this.keys(), id).first<Exposure>();
    if (!row) return { state: "unavailable" };
    let freshness: "current" | "stale" | "unchecked" = "unchecked";
    try { const current = await this.observation(row.entry_id); freshness = current.hash !== row.observation_hash || current.freshness === "stale" || current.freshness === "unavailable" ? "stale" : current.freshness === "current" ? "current" : "unchecked"; } catch { freshness = "stale"; }
    const assessment = await this.sql(`SELECT id,label,human_action,evidence_fence_json,reviewed_at,elapsed_wall_ms FROM assistant_evaluation_assessments WHERE ${ns} AND exposure_id=?`, ...this.keys(), id)
      .first<{ id: string; label: string; human_action: string | null; evidence_fence_json: string | null; reviewed_at: number; elapsed_wall_ms: number }>();
    let evidence: { state: string; sourceId?: string; revision?: number } | undefined;
    if (assessment?.evidence_fence_json) {
      const fence = JSON.parse(assessment.evidence_fence_json) as SourceFence, access = new SourceAccess(this.db, this.scope);
      let valid = await access.revalidate({ kind: "owner" }, fence);
      if (valid && fence.source.origin === "whatsapp") { const origin = await this.options.origin?.fence(fence.source.id); valid = !!origin && !!await this.options.origin?.check(origin); }
      valid = valid && await access.revalidate({ kind: "owner" }, fence);
      evidence = valid ? { state: "available", sourceId: fence.source.id, revision: fence.source.revision } : { state: "unavailable" };
    }
    return { id: row.id, entryId: row.entry_id, openedAt: row.opened_at, freshness, basis: "owner_assessment_at_exposure",
      ...(assessment ? { assessment: { id: assessment.id, label: assessment.label, humanAction: assessment.human_action, reportedBy: "authenticated_owner", verification: "owner_report_not_provider_receipt", reviewedAt: assessment.reviewed_at, elapsedWallMs: assessment.elapsed_wall_ms, measurement: "elapsed_wall_not_active_review", ...(evidence ? { evidence } : {}) } } : {}) };
  }
  async metrics() {
    this.owner();
    const labels = (await this.sql(`SELECT a.label,COUNT(*) n,AVG(a.elapsed_wall_ms) meanElapsedWallMs FROM assistant_evaluation_assessments a WHERE a.${ns.replace(" AND ", " AND a.")}
      AND NOT EXISTS(SELECT 1 FROM assistant_evaluation_assessments newer WHERE newer.installation_id=a.installation_id AND newer.generation=a.generation AND newer.entry_id=a.entry_id AND (newer.reviewed_at,newer.id)>(a.reviewed_at,a.id)) GROUP BY a.label`, ...this.keys()).all<{ label: string; n: number; meanElapsedWallMs: number }>()).results;
    const assessed = safe(labels.reduce((total, row) => total + safe(row.n), 0)), correct = labels.find(row => row.label === "correct")?.n ?? 0,
      unknown = labels.find(row => row.label === "unknown")?.n ?? 0, known = assessed - unknown;
    const comparisons = (await this.sql(`SELECT json_extract(e.metadata_json,'$.phase') phase,a.human_action humanAction,COUNT(*) n
      FROM assistant_evaluation_assessments a JOIN assistant_evaluation_exposures e ON e.installation_id=a.installation_id AND e.generation=a.generation AND e.id=a.exposure_id
      WHERE a.${ns.replace(" AND ", " AND a.")} AND a.human_action IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM assistant_evaluation_assessments newer WHERE newer.installation_id=a.installation_id AND newer.generation=a.generation AND newer.entry_id=a.entry_id AND (newer.reviewed_at,newer.id)>(a.reviewed_at,a.id)) GROUP BY phase,a.human_action`, ...this.keys()).all()).results;
    const money = await this.sql(`SELECT COUNT(*) reservations,COALESCE(SUM(CASE WHEN state='settled' THEN actual_units ELSE 0 END),0) settled,
      COALESCE(SUM(CASE WHEN state='reserved' THEN ceiling_units ELSE 0 END),0) reserved,COALESCE(SUM(CASE WHEN state='uncertain' THEN ceiling_units ELSE 0 END),0) uncertain,
      COALESCE(SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END),0) committed FROM assistant_budget_reservations WHERE installation_id=?`, this.scope.installationId)
      .first<Record<string, number>>();
    for (const value of Object.values(money!)) safe(value);
    const latency = await this.sql(`SELECT COUNT(*) denominator,AVG(d.recorded_at-h.seeded_at) mean FROM assistant_shadow_decisions d
      JOIN assistant_decision_jobs h ON h.installation_id=d.installation_id AND h.generation=d.generation AND h.job_id=d.job_id
      JOIN assistant_jobs j ON j.installation_id=d.installation_id AND j.generation=d.generation AND j.id=d.job_id
      JOIN assistant_job_ledger l ON l.installation_id=d.installation_id AND l.generation=d.generation AND l.job_id=d.job_id AND l.request_hash=d.request_hash
      JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id
      WHERE d.installation_id=? AND d.generation=? AND d.proposal_json IS NOT NULL AND j.state='shadow_completed' AND e.state='settled'
      AND d.request_hash=h.request_hash AND d.binding_hash=e.binding_hash AND d.proposal_json=e.result_json AND d.publication_nonce=e.search_nonce AND d.publication_nonce IS NOT NULL AND d.recorded_at>=h.seeded_at`, ...this.keys()).first<{ denominator: number; mean: number | null }>();
    safe(latency!.denominator);
    return { observedAt: this.now(), quality: { population: "latest_owner_assessment_per_entry", freshness: "unchecked_historical", basis: "owner_assessment_at_exposure", observations: assessed, unknownCount: unknown, denominator: known,
      correctFraction: known ? correct / known : null, labels, reviewMeasurement: "elapsed_wall_not_active_review", currentCorrectness: "unknown" },
      cost: { unit: "microUSD", scope: "installation_all_generations_all_periods", ...money, invoice: "not_observed", globalCap: "not_inferred" },
      latency: { population: "historical_committed_publications", measurement: "seed_to_committed_decision_wall_ms", denominator: latency!.denominator, meanMs: latency!.mean, modelInferenceLatency: "not_measured" },
      humanActions: { attribution: "explicit_owner_reports_only", fromMeAndSimulations: "not_used", comparisonPopulation: "latest_owner_assessment_at_exposure", comparisons } };
  }
}
