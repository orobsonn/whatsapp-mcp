import { decisionSubject, type DecisionSubject } from "./agent/contracts";
import { seedDecisionJob } from "./decisions";
import { dueFollowUpGuard } from "./followups";
import {outgoingProof,outgoingGuard} from './outgoing';
import { SourceAccess,normalizeSourceRefs,type SourceSelectionRef, type AccessGuard, type SourceFence, type TrustedActor } from "./access";
import { conversationGuard, jobConversationFence, type ConversationFence } from "./conversations";
export type JobScope = Readonly<{ installationId: string; generation: string; sourceEpoch?: string; sourceGeneration?: string }>;
export type JobKind = "extraction" | "reasoning" | "follow_up" | "review" | "maintenance";
export type Job = {
  id: string; kind: JobKind; state: "pending" | "processing" | "shadow_completed" | "failed" | "cancelled";
  attempts: number; max_attempts: number; lease_generation: number; lease_until: number | null;
  source_id: string; source_revision: number; last_error: string | null;
};
export type JobLease = Job & { lease_until: number };
export type Ledger = {
  request_hash: string; request_json: string; admitted_lease_generation: number | null; state: "prepared" | "attempting" | "uncertain" | "complete";
};
export type NewJob = {
  kind: JobKind; dedupeKey: string; sourceId: string; sourceRevision: number; request: string; maxAttempts?: number; runtime?: "flue" | "flue_owner_dialogue"; subject?: DecisionSubject;contextMode?:'conversation_manifest';sourceRefs?:SourceSelectionRef[];
};
/** Trusted coordinator's atomic admission, never decoded from NewJob or text. */
export type JobAdmission = { id: string; guard: AccessGuard; statements: D1PreparedStatement[] };
export type RuntimeGuardPlan = { guard: AccessGuard; statements: D1PreparedStatement[] };
export type RuntimeJobGuard = (lease: Readonly<JobLease>, now: number) => Promise<AccessGuard | RuntimeGuardPlan | null>;
const liveLease = `state='processing' AND lease_generation=? AND lease_until>?`;
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function integer(value: number, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("invalid_job_limit");
}

// Scope is supplied by the trusted host, never by model input or received text.
// The persisted trusted actor and source fence survive a controller restart.
export class JobQueue {
  private readonly scope: JobScope;
  private readonly actor: TrustedActor;
  private readonly access: SourceAccess;
  constructor(private readonly db: D1Database, scope: JobScope, actor: TrustedActor = { kind: "owner" }, private readonly runtimeGuard?: RuntimeJobGuard) {
    if (!scope.installationId || !scope.generation) throw new Error("unconfigured_job_scope");
    if ((scope.sourceEpoch !== undefined || scope.sourceGeneration !== undefined) &&
      [scope.sourceEpoch, scope.sourceGeneration].some(value => typeof value !== "string" || !value || value.length > 256)) throw new Error("unconfigured_job_origin");
    this.scope = Object.freeze({ ...scope });
    this.actor = Object.freeze({ ...actor });
    this.access = new SourceAccess(db, this.scope);
  }
  private statement(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(this.scope.installationId, this.scope.generation, ...values);
  }
  private raw(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...values);
  }
  operationKey(id: string, hash: string) {
    return JSON.stringify(["assistant-shadow", this.scope.installationId, this.scope.generation, id, hash]);
  }
  async enqueue(input: NewJob, now: number, admission?: JobAdmission): Promise<Job> {
    input = Object.freeze({ ...input, ...(input.subject ? { subject: decisionSubject.parse(input.subject) } : {}) });
    const dialogue = input.runtime === "flue_owner_dialogue";
    if (dialogue && (!admission || !this.runtimeGuard || this.actor.kind !== "owner")) throw new Error("owner_dialogue_admission_required");
    const reservedDialogue = typeof input.dedupeKey === "string" && input.dedupeKey.startsWith("telegram-owner-v1:");
    if (dialogue && (input.kind !== "reasoning" || input.maxAttempts !== 1 || input.request !== "telegram-owner-dialogue-v1" || !reservedDialogue || input.dedupeKey.length <= "telegram-owner-v1:".length || input.subject)
      || !dialogue && reservedDialogue) throw new Error("invalid_job_request");
    if (input.runtime === "flue" && !input.subject) throw new Error("decision_subject_required");
    if (input.subject && (input.runtime !== "flue" || (input.kind === "follow_up") !== (input.subject.kind === "fup_occurrence"))) throw new Error("decision_subject_invalid");
    integer(now); integer(input.sourceRevision, 1); integer(input.maxAttempts ?? 3, 1);
    if (!input.dedupeKey || input.dedupeKey.length > 256 || !input.sourceId || typeof input.request !== "string" || (input.runtime !== undefined && input.runtime !== "flue" && !dialogue)) {
      throw new Error("invalid_job_request");
    }
    const source = await this.access.read(this.actor, input.sourceId, input.sourceRevision, now);
    if (!source) throw new Error("source_access_denied");
    let manifest:SourceSelectionRef[]|undefined;
    if(input.contextMode!==undefined||input.sourceRefs!==undefined){
      if(input.contextMode!=='conversation_manifest'||input.runtime!=='flue'||input.kind!=='reasoning'||input.subject?.kind!=='capture_event'||this.actor.kind!=='interlocutor'||this.actor.conversationKind!=='private'||input.subject.chatId!==this.actor.conversationId||source.fence.source.origin!=='whatsapp'||source.fence.source.conversationId!==input.subject.chatId)throw Error('context_mode_denied');
      manifest=normalizeSourceRefs(input.sourceRefs??[]);let bytes=0;
      if(!manifest.some(ref=>ref.id===source.id&&ref.revision===source.fence.source.revision&&ref.version===source.fence.source.version&&ref.hash===source.fence.source.hash))throw Error('context_mode_denied');
      for(const ref of manifest){const row=await this.access.read(this.actor,ref.id,ref.revision,now);if(!row||row.fence.source.origin!=='whatsapp'||row.fence.source.conversationId!==input.subject.chatId||row.fence.source.version!==ref.version||row.fence.source.hash!==ref.hash||!row.text?.trim())throw Error('context_mode_denied');bytes+=new TextEncoder().encode(row.text).length;}if(bytes>8192)throw Error('context_mode_denied');
    }
    if (dialogue && source.fence.source.origin !== "owner_request") throw new Error("owner_dialogue_source_required");
    if (!dialogue && source.fence.source.origin === "owner_request") throw new Error("operational_source_requires_owner_dialogue");
    const chatId = this.actor.kind === "interlocutor" ? this.actor.conversationId : source.fence.source.conversationId;
    const conversation = chatId ? await jobConversationFence(this.db, this.scope, chatId, source.fence.source.origin === "whatsapp", source.id) : null;
    if (chatId && !conversation) throw new Error("conversation_not_ready");
    const fup=input.subject?.kind==='fup_occurrence'?input.subject:null;
    const storedOutgoing=fup?await this.statement(`SELECT json_extract(body_json,'$.outgoing') outgoing FROM assistant_fup_provenance WHERE installation_id=? AND generation=? AND fup_id=? AND version=?`,fup.followUpId,fup.followUpVersion).first<string>('outgoing'):null;
    const outgoing=storedOutgoing?outgoingProof.parse(JSON.parse(storedOutgoing)):undefined;
    const request = JSON.stringify({ kind: input.kind, sourceId: input.sourceId, sourceRevision: input.sourceRevision,...(outgoing?{outgoing}:{}),
      input: input.request, actor: this.actor, fence: source.fence, conversation,...(manifest?{contextMode:input.contextMode,sourceRefs:manifest}:{}), ...(input.runtime ? { runtime: input.runtime, subject: input.subject } : {}), ...(dialogue ? { dialogueKey: input.dedupeKey } : {}) });
    if (new TextEncoder().encode(request).length > 32768) throw new Error("job_request_too_large");
    const hash = await digest(request);
    const due=input.kind==="follow_up" ? input.subject?.kind==="fup_occurrence" ? dueFollowUpGuard(this.scope,{id:input.subject.followUpId,version:input.subject.followUpVersion},{id:input.sourceId,revision:input.sourceRevision},now,input.subject.occurrenceId) : {sql:"0",values:[]} : null;
    if(due&&outgoing&&fup){const gate=outgoingGuard(this.scope,{id:fup.followUpId,version:fup.followUpVersion},outgoing,now,input.sourceId);due.sql+=` AND (${gate.sql})`;due.values.push(...gate.values);}
    const gates = [...(due ? [due] : []), ...(admission ? [admission.guard] : [])];
    const gate = gates.map(part => `(${part.sql})`).join(" AND "), gateValues = gates.flatMap(part => part.values);
    await this.db.batch([
      ...(admission?.statements ?? []),
      this.statement(`INSERT INTO assistant_jobs(installation_id,generation,id,kind,dedupe_key,source_id,source_revision,next_attempt_at,max_attempts,occurrence_id)
        SELECT ?,?,?,?,?,?,?,?,?,? ${gate ? `WHERE ${gate}` : ""} ${due ? `AND NOT EXISTS(SELECT 1 FROM assistant_jobs WHERE installation_id=? AND generation=? AND occurrence_id=?)` : ""} ON CONFLICT(installation_id,generation,dedupe_key) DO NOTHING`,
      admission?.id ?? crypto.randomUUID(), input.kind, input.dedupeKey, input.sourceId, input.sourceRevision, now, input.maxAttempts ?? 3, input.subject?.kind === "fup_occurrence" ? input.subject.occurrenceId : null,
      ...gateValues,...(due?[this.scope.installationId,this.scope.generation,input.subject?.kind==="fup_occurrence"?input.subject.occurrenceId:null]:[])),
      this.raw(`INSERT INTO assistant_job_ledger(installation_id,generation,job_id,request_hash,request_json)
        SELECT installation_id,generation,id,?,? FROM assistant_jobs
        WHERE installation_id=? AND generation=? AND dedupe_key=? ${dialogue ? "AND id=? AND source_id=? AND source_revision=? AND kind='reasoning' AND max_attempts=1" : admission ? `AND (${admission.guard.sql})` : ""} ON CONFLICT DO NOTHING`, hash, request,
      this.scope.installationId, this.scope.generation, input.dedupeKey,...(dialogue ? [admission!.id, input.sourceId, input.sourceRevision] : admission?.guard.values ?? [])),
    ]);
    const row = await this.statement(`SELECT j.*,l.request_hash FROM assistant_jobs j JOIN assistant_job_ledger l
      ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      WHERE j.installation_id=? AND j.generation=? AND j.dedupe_key=?`, input.dedupeKey).first<Job & { request_hash: string }>();
    if (!row) throw new Error(admission ? "job_admission_changed" : "dedupe_request_conflict");
    if (row.request_hash !== hash) throw new Error("dedupe_request_conflict");
    if (input.runtime === "flue") await seedDecisionJob(this.db, this.scope, row.id, now);
    return row;
  }
  async claim(now: number, leaseMs = 30000): Promise<JobLease | null> {
    integer(now); integer(leaseMs, 1); integer(now + leaseMs);
    await this.db.batch([
      this.statement(`UPDATE assistant_job_ledger SET state='uncertain' WHERE installation_id=? AND generation=? AND state='attempting'
        AND EXISTS(SELECT 1 FROM assistant_jobs j WHERE j.installation_id=assistant_job_ledger.installation_id
          AND j.generation=assistant_job_ledger.generation AND j.id=job_id AND j.state='processing'
          AND j.dedupe_key NOT GLOB 'telegram-owner-v1:*' AND j.lease_until<=? AND j.attempts>=j.max_attempts)`, now),
      this.statement(`UPDATE assistant_jobs SET state='failed',lease_until=NULL,last_error='attempt_limit_exhausted'
        WHERE installation_id=? AND generation=? AND state='processing' AND dedupe_key NOT GLOB 'telegram-owner-v1:*' AND lease_until<=? AND attempts>=max_attempts`, now),
    ]);
    // SQLite chooses and updates one row in the same mutation; generation fences all later writes.
    return this.raw(`UPDATE assistant_jobs SET state='processing',attempts=attempts+1,
      lease_generation=lease_generation+1,lease_until=? WHERE installation_id=? AND generation=? AND id=(
        SELECT id FROM assistant_jobs WHERE installation_id=? AND generation=? AND attempts<max_attempts
        AND dedupe_key NOT GLOB 'owner-once-v1:*' AND dedupe_key NOT GLOB 'telegram-owner-v1:*'
        AND ((state='pending' AND next_attempt_at<=?) OR (state='processing' AND lease_until<=?))
        ORDER BY next_attempt_at,id LIMIT 1) RETURNING *`, now + leaseMs,
    this.scope.installationId, this.scope.generation, this.scope.installationId, this.scope.generation, now, now).first<JobLease>();
  }
  /** Nominal presearch admission. Never claims a neighboring pending job. */
  async claimId(id: string, now: number, leaseMs = 90000, admission?: AccessGuard): Promise<JobLease | null> {
    integer(now);integer(leaseMs,1);integer(now+leaseMs);
    if(typeof id!=="string"||!id||id.length>256)throw new Error("invalid_job_id");
    const selected = await this.statement("SELECT dedupe_key FROM assistant_jobs WHERE installation_id=? AND generation=? AND id=?", id).first<{dedupe_key: string}>();
    // Explicit Owner plans never enter the global scheduler or gain a lease
    // from a bare job ID. Their trusted coordinator supplies a fresh SQL fence.
    if ((selected?.dedupe_key.startsWith("owner-once-v1:") || selected?.dedupe_key.startsWith("telegram-owner-v1:")) && !admission) return null;
    return this.raw(`UPDATE assistant_jobs SET state='processing',attempts=attempts+1,lease_generation=lease_generation+1,lease_until=?
      WHERE installation_id=? AND generation=? AND id=? AND state='pending' AND next_attempt_at<=? AND attempts<max_attempts
      AND EXISTS(SELECT 1 FROM assistant_job_ledger l WHERE l.installation_id=assistant_jobs.installation_id AND l.generation=assistant_jobs.generation AND l.job_id=assistant_jobs.id AND l.state='prepared')
      ${admission ? `AND (${admission.sql})` : ""} RETURNING *`,now+leaseMs,this.scope.installationId,this.scope.generation,id,now,...(admission?.values ?? [])).first<JobLease>();
  }
  get(id: string) {
    return this.statement("SELECT * FROM assistant_jobs WHERE installation_id=? AND generation=? AND id=?", id).first<Job>();
  }
  async list(limit = 100) {
    integer(limit, 1);
    if (limit > 100) throw new Error("invalid_job_limit");
    return (await this.statement("SELECT * FROM assistant_jobs WHERE installation_id=? AND generation=? ORDER BY next_attempt_at,id LIMIT ?", limit).all<Job>()).results;
  }
  ledger(id: string) {
    return this.statement("SELECT request_hash,request_json,admitted_lease_generation,state FROM assistant_job_ledger WHERE installation_id=? AND generation=? AND job_id=?", id).first<Ledger>();
  }
  async receipt(id: string) {
    const row = await this.statement("SELECT result FROM assistant_job_receipts WHERE installation_id=? AND generation=? AND job_id=?", id).first<{ result: string }>();
    return row?.result ?? null;
  }
  private async authorization(lease: JobLease, now: number) {
    const ledger = await this.ledger(lease.id);
    if (!ledger || await digest(ledger.request_json) !== ledger.request_hash) return null;
    try {
      const request = JSON.parse(ledger.request_json) as { actor: TrustedActor; fence: SourceFence; sourceId: string; sourceRevision: number; conversation?: ConversationFence | null; runtime?: string; input?: string; dialogueKey?: string; subject?: unknown; kind?: string };
      if (request.sourceId !== lease.source_id || request.sourceRevision !== lease.source_revision
        || request.fence.source.id !== lease.source_id || request.fence.source.revision !== lease.source_revision) return null;
      const dialogue = request.runtime === "flue_owner_dialogue";
      if (request.fence.source.origin === "owner_request" && !dialogue) return null;
      if (dialogue && (this.actor.kind !== "owner" || request.actor.kind !== "owner" || request.kind !== "reasoning" || request.conversation !== null || request.fence.source.origin !== "owner_request" || request.input !== "telegram-owner-dialogue-v1"
        || typeof request.dialogueKey !== "string" || !request.dialogueKey.startsWith("telegram-owner-v1:") || request.dialogueKey.length > 256 || request.subject !== undefined
        || lease.kind !== "reasoning" || lease.max_attempts !== 1)) return null;
      const chatId = request.actor.kind === "interlocutor" ? request.actor.conversationId : request.fence.source.conversationId;
      const guard = this.access.guard(request.actor, request.fence, now);
      const statements: D1PreparedStatement[] = [];
      if (request.runtime !== undefined) {
        if (request.runtime !== "flue" && !dialogue || !this.runtimeGuard) return null;
        const runtime = await this.runtimeGuard(lease, now);
        if (!runtime) return null;
        const current = "guard" in runtime ? runtime.guard : runtime;
        if (dialogue) {
          guard.sql += ` AND EXISTS(SELECT 1 FROM assistant_jobs WHERE installation_id=? AND generation=? AND id=? AND dedupe_key=? AND kind='reasoning' AND max_attempts=1 AND attempts=1
            AND lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`;
          guard.values.push(this.scope.installationId, this.scope.generation, lease.id, request.dialogueKey!);
        } else {
          guard.sql += ` AND EXISTS(SELECT 1 FROM assistant_decision_jobs WHERE installation_id=? AND generation=? AND job_id=? AND request_hash=? AND subject_json=?)`;
          guard.values.push(this.scope.installationId, this.scope.generation, lease.id, ledger.request_hash, JSON.stringify(decisionSubject.parse(request.subject)));
        }
        if ("guard" in runtime) statements.push(...runtime.statements);
        guard.sql = `(${guard.sql}) AND (${current.sql})`; guard.values.push(...current.values);
      }
      if (chatId) {
        const conversation = request.conversation;
        if (!conversation || conversation.installationId !== this.scope.installationId || conversation.generation !== this.scope.generation || conversation.chatId !== chatId) return null;
        if (conversation.sourceEpoch !== (this.scope.sourceEpoch ?? null) || conversation.sourceGeneration !== (this.scope.sourceGeneration ?? null)) return null;
        const current = conversationGuard(conversation);
        guard.sql = `(${guard.sql}) AND (${current.sql})`; guard.values.push(...current.values);
        if (request.fence.source.origin === "whatsapp") {
          guard.sql += ` AND EXISTS(SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND canonical_id=? AND source_epoch=? AND source_generation=?)`;
          guard.values.push(this.scope.installationId, this.scope.generation, request.sourceId, conversation.sourceEpoch, conversation.sourceGeneration);
        }
      }
      return { ledger, guard, statements };
    } catch { return null; } // Legacy/malformed requests cannot acquire new authority.
  }
  async admissionPlan(lease: JobLease, now: number) {
    lease = Object.freeze({ ...lease }); integer(now);
    const auth = await this.authorization(lease, now);
    if (!auth) return null;
    const statement = this.raw(`UPDATE assistant_job_ledger SET state='attempting',admitted_lease_generation=?
      WHERE installation_id=? AND generation=? AND job_id=? AND state='prepared' AND request_hash=? AND request_json=? AND EXISTS(
        SELECT 1 FROM assistant_jobs WHERE assistant_jobs.installation_id=assistant_job_ledger.installation_id
        AND assistant_jobs.generation=assistant_job_ledger.generation AND assistant_jobs.id=job_id
        AND source_id=? AND source_revision=? AND ${liveLease}) AND (${auth.guard.sql})
      RETURNING request_hash,request_json,admitted_lease_generation,state`,
    lease.lease_generation, this.scope.installationId, this.scope.generation, lease.id, auth.ledger.request_hash, auth.ledger.request_json,
    lease.source_id, lease.source_revision, lease.lease_generation, now, ...auth.guard.values);
    return { statements: auth.statements, statement, executionGuard: this.jobGuard(lease, auth, now, "attempting") };
  }
  async admissionStatement(lease: JobLease, now: number): Promise<D1PreparedStatement | null> {
    const plan = await this.admissionPlan(lease, now);
    // A caller must not accidentally omit a transactional authority prelude.
    return plan && !plan.statements.length ? plan.statement : null;
  }
  async admit(lease: JobLease, now: number) {
    const plan = await this.admissionPlan(lease, now); if (!plan) return null;
    if (!plan.statements.length) return plan.statement.first<Ledger>();
    return (await this.db.batch([...plan.statements, plan.statement])).at(-1)!.results[0] as Ledger | undefined ?? null;
  }
  private jobGuard(lease: JobLease, auth: { ledger: Ledger; guard: AccessGuard }, now: number, state: "attempting" | "complete" | null): AccessGuard {
    return { sql: `EXISTS(SELECT 1 FROM assistant_jobs j JOIN assistant_job_ledger l
      ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      JOIN (SELECT json(?) AS p) args WHERE j.installation_id=json_extract(p,'$.i') AND j.generation=json_extract(p,'$.g')
      AND j.id=json_extract(p,'$.id') AND j.state='processing' AND j.lease_generation=json_extract(p,'$.lease')
      AND j.lease_until>json_extract(p,'$.now') AND l.request_hash=json_extract(p,'$.hash')
      ${state === "attempting" ? "AND l.state='attempting' AND l.admitted_lease_generation=j.lease_generation" : state === "complete" ? "AND l.state='complete'" : ""}) AND (${auth.guard.sql})`,
      values: [JSON.stringify({ i: this.scope.installationId, g: this.scope.generation, id: lease.id,
        lease: lease.lease_generation, now, hash: auth.ledger.request_hash }), ...auth.guard.values] };
  }
  async isAuthorized(lease: JobLease, now: number) {
    const plan = await this.currentPlan(lease, now); if (!plan) return false;
    const statement = this.raw(`SELECT 1 WHERE ${plan.guard.sql}`, ...plan.guard.values);
    return (await this.db.batch([...plan.statements, statement])).at(-1)!.results.length === 1;
  }
  /** Host-only current fence for an atomic dependent admission, before or
   * after ledger admission. This plan itself neither claims nor executes. */
  async currentPlan(lease: JobLease, now: number): Promise<RuntimeGuardPlan | null> {
    const auth = await this.authorization(lease, now); if (!auth) return null;
    return { guard: this.jobGuard(lease, auth, now, null), statements: auth.statements };
  }
  async isCurrent(lease: JobLease, now: number) {
    return !!await this.statement(`SELECT id FROM assistant_jobs WHERE installation_id=? AND generation=? AND id=? AND ${liveLease}`,
      lease.id, lease.lease_generation, now).first();
  }
  async fail(lease: JobLease, error: string, now: number, retry = false, preparedOnly = false) {
    const result = await this.raw(`UPDATE assistant_jobs SET state=CASE WHEN ?=1 AND attempts<max_attempts THEN 'pending' ELSE 'failed' END,
      lease_until=NULL,last_error=?,next_attempt_at=? WHERE installation_id=? AND generation=? AND id=? AND ${liveLease}
      AND (?=0 OR EXISTS(SELECT 1 FROM assistant_job_ledger l WHERE l.installation_id=assistant_jobs.installation_id
        AND l.generation=assistant_jobs.generation AND l.job_id=assistant_jobs.id AND l.state='prepared')) RETURNING id`,
    retry ? 1 : 0, error, now, this.scope.installationId, this.scope.generation, lease.id, lease.lease_generation, now, preparedOnly ? 1 : 0).first();
    return !!result;
  }
  async uncertain(lease: JobLease) {
    await this.statement(`UPDATE assistant_job_ledger SET state='uncertain' WHERE installation_id=? AND generation=?
      AND job_id=? AND state='attempting' AND admitted_lease_generation=?`, lease.id, lease.lease_generation).run();
  }
  async recordResult(lease: JobLease, result: string, now: number) {
    integer(now);
    if (await this.statement(`SELECT 1 FROM assistant_jobs j LEFT JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      WHERE j.installation_id=? AND j.generation=? AND j.id=? AND (j.dedupe_key GLOB 'telegram-owner-v1:*'
      OR json_extract(CASE WHEN json_valid(l.request_json) THEN l.request_json ELSE '{}' END,'$.runtime')='flue_owner_dialogue')`, lease.id).first()) throw new Error("owner_dialogue_completion_required");
    if (typeof result !== "string" || new TextEncoder().encode(result).length > 32768) throw new Error("invalid_job_result");
    // Receipts may arrive late. Only the job publication is conditional on current lease/source.
    await this.db.batch([
      this.raw(`INSERT INTO assistant_job_receipts(installation_id,generation,job_id,request_hash,result,received_at)
        SELECT installation_id,generation,job_id,request_hash,?,? FROM assistant_job_ledger
        WHERE installation_id=? AND generation=? AND job_id=? AND state IN ('attempting','uncertain','complete')
        ON CONFLICT DO NOTHING`, result, now, this.scope.installationId, this.scope.generation, lease.id),
      this.statement(`UPDATE assistant_job_ledger SET state='complete' WHERE installation_id=? AND generation=? AND job_id=?
        AND EXISTS(SELECT 1 FROM assistant_job_receipts r WHERE r.installation_id=assistant_job_ledger.installation_id
        AND r.generation=assistant_job_ledger.generation AND r.job_id=assistant_job_ledger.job_id)`, lease.id),
    ]);
  }
  async complete(lease: JobLease, result: string, now: number) {
    await this.recordResult(lease, result, now);
    return this.publish(lease, now);
  }
  async publicationPlan(lease: JobLease, now: number, additional?: AccessGuard) {
    lease = Object.freeze({ ...lease }); integer(now);
    const auth = await this.authorization(lease, now);
    if (!auth) return null;
    // Dialogue completion must validate its native receipt, frozen phases and
    // typed reply/control outcome in the dedicated host coordinator. A generic
    // result string or additional SQL predicate cannot substitute that proof.
    if (JSON.parse(auth.ledger.request_json).runtime === "flue_owner_dialogue") return null;
    const statement = this.raw(`UPDATE assistant_jobs SET state='shadow_completed',lease_until=NULL,last_error=NULL
      WHERE installation_id=? AND generation=? AND id=? AND ${liveLease} AND source_id=? AND source_revision=?
      AND ${auth.guard.sql} ${JSON.parse(auth.ledger.request_json).runtime === "flue" ? `AND EXISTS(SELECT 1 FROM assistant_shadow_decisions d JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id
        WHERE d.installation_id=assistant_jobs.installation_id AND d.generation=assistant_jobs.generation AND d.job_id=assistant_jobs.id AND d.request_hash=? AND d.lease_generation=assistant_jobs.lease_generation
        AND d.binding_hash=e.binding_hash AND d.proposal_json=e.result_json AND d.publication_nonce=e.search_nonce AND d.publication_nonce IS NOT NULL)` : ""} ${additional ? `AND (${additional.sql})` : ""} AND EXISTS(SELECT 1 FROM assistant_job_ledger l WHERE l.installation_id=assistant_jobs.installation_id
      AND l.generation=assistant_jobs.generation AND l.job_id=assistant_jobs.id AND l.state='complete'
      AND l.request_hash=? AND l.request_json=?) RETURNING id`,
    this.scope.installationId, this.scope.generation, lease.id, lease.lease_generation, now, lease.source_id, lease.source_revision, ...auth.guard.values, ...(JSON.parse(auth.ledger.request_json).runtime === "flue" ? [auth.ledger.request_hash] : []), ...(additional?.values ?? []),
    auth.ledger.request_hash, auth.ledger.request_json);
    return { statements: auth.statements, statement, guard: this.jobGuard(lease, auth, now, "complete") };
  }
  async publicationStatement(lease: JobLease, now: number): Promise<D1PreparedStatement | null> {
    const plan = await this.publicationPlan(lease, now); return plan && !plan.statements.length ? plan.statement : null;
  }
  async publish(lease: JobLease, now: number) {
    const plan = await this.publicationPlan(lease, now); if (!plan) return false;
    if (!plan.statements.length) return !!await plan.statement.first();
    return (await this.db.batch([...plan.statements, plan.statement])).at(-1)!.results.length === 1;
  }
}
