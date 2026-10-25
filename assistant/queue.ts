import { SourceAccess, type SourceFence, type TrustedActor } from "./access";
export type JobScope = Readonly<{ installationId: string; generation: string }>;
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
  kind: JobKind; dedupeKey: string; sourceId: string; sourceRevision: number; request: string; maxAttempts?: number;
};
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
  constructor(private readonly db: D1Database, scope: JobScope, actor: TrustedActor = { kind: "owner" }) {
    if (!scope.installationId || !scope.generation) throw new Error("unconfigured_job_scope");
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
  async enqueue(input: NewJob, now: number): Promise<Job> {
    input = Object.freeze({ ...input });
    integer(now); integer(input.sourceRevision, 1); integer(input.maxAttempts ?? 3, 1);
    if (!input.dedupeKey || input.dedupeKey.length > 256 || !input.sourceId || typeof input.request !== "string") {
      throw new Error("invalid_job_request");
    }
    const source = await this.access.read(this.actor, input.sourceId, input.sourceRevision, now);
    if (!source) throw new Error("source_access_denied");
    const request = JSON.stringify({ kind: input.kind, sourceId: input.sourceId, sourceRevision: input.sourceRevision,
      input: input.request, actor: this.actor, fence: source.fence });
    if (new TextEncoder().encode(request).length > 32768) throw new Error("job_request_too_large");
    const hash = await digest(request);
    await this.db.batch([
      this.statement(`INSERT INTO assistant_jobs(installation_id,generation,id,kind,dedupe_key,source_id,source_revision,next_attempt_at,max_attempts)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(installation_id,generation,dedupe_key) DO NOTHING`,
      crypto.randomUUID(), input.kind, input.dedupeKey, input.sourceId, input.sourceRevision, now, input.maxAttempts ?? 3),
      this.raw(`INSERT INTO assistant_job_ledger(installation_id,generation,job_id,request_hash,request_json)
        SELECT installation_id,generation,id,?,? FROM assistant_jobs
        WHERE installation_id=? AND generation=? AND dedupe_key=? ON CONFLICT DO NOTHING`, hash, request,
      this.scope.installationId, this.scope.generation, input.dedupeKey),
    ]);
    const row = await this.statement(`SELECT j.*,l.request_hash FROM assistant_jobs j JOIN assistant_job_ledger l
      ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      WHERE j.installation_id=? AND j.generation=? AND j.dedupe_key=?`, input.dedupeKey).first<Job & { request_hash: string }>();
    if (!row || row.request_hash !== hash) throw new Error("dedupe_request_conflict");
    return row;
  }
  async claim(now: number, leaseMs = 30000): Promise<JobLease | null> {
    integer(now); integer(leaseMs, 1); integer(now + leaseMs);
    await this.db.batch([
      this.statement(`UPDATE assistant_job_ledger SET state='uncertain' WHERE installation_id=? AND generation=? AND state='attempting'
        AND EXISTS(SELECT 1 FROM assistant_jobs j WHERE j.installation_id=assistant_job_ledger.installation_id
          AND j.generation=assistant_job_ledger.generation AND j.id=job_id AND j.state='processing'
          AND j.lease_until<=? AND j.attempts>=j.max_attempts)`, now),
      this.statement(`UPDATE assistant_jobs SET state='failed',lease_until=NULL,last_error='attempt_limit_exhausted'
        WHERE installation_id=? AND generation=? AND state='processing' AND lease_until<=? AND attempts>=max_attempts`, now),
    ]);
    // SQLite chooses and updates one row in the same mutation; generation fences all later writes.
    return this.raw(`UPDATE assistant_jobs SET state='processing',attempts=attempts+1,
      lease_generation=lease_generation+1,lease_until=? WHERE installation_id=? AND generation=? AND id=(
        SELECT id FROM assistant_jobs WHERE installation_id=? AND generation=? AND attempts<max_attempts
        AND ((state='pending' AND next_attempt_at<=?) OR (state='processing' AND lease_until<=?))
        ORDER BY next_attempt_at,id LIMIT 1) RETURNING *`, now + leaseMs,
    this.scope.installationId, this.scope.generation, this.scope.installationId, this.scope.generation, now, now).first<JobLease>();
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
      const request = JSON.parse(ledger.request_json) as { actor: TrustedActor; fence: SourceFence; sourceId: string; sourceRevision: number };
      if (request.sourceId !== lease.source_id || request.sourceRevision !== lease.source_revision
        || request.fence.source.id !== lease.source_id || request.fence.source.revision !== lease.source_revision) return null;
      return { ledger, guard: this.access.guard(request.actor, request.fence, now) };
    } catch { return null; } // Legacy/malformed requests cannot acquire new authority.
  }
  async admit(lease: JobLease, now: number) {
    lease = Object.freeze({ ...lease }); integer(now);
    const auth = await this.authorization(lease, now);
    if (!auth) return null;
    return this.raw(`UPDATE assistant_job_ledger SET state='attempting',admitted_lease_generation=?
      WHERE installation_id=? AND generation=? AND job_id=? AND state='prepared' AND request_hash=? AND request_json=? AND EXISTS(
        SELECT 1 FROM assistant_jobs WHERE assistant_jobs.installation_id=assistant_job_ledger.installation_id
        AND assistant_jobs.generation=assistant_job_ledger.generation AND assistant_jobs.id=job_id
        AND source_id=? AND source_revision=? AND ${liveLease} AND ${auth.guard.sql})
      RETURNING request_hash,request_json,admitted_lease_generation,state`,
    lease.lease_generation, this.scope.installationId, this.scope.generation, lease.id, auth.ledger.request_hash, auth.ledger.request_json,
    lease.source_id, lease.source_revision, lease.lease_generation, now, ...auth.guard.values).first<Ledger>();
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
  async complete(lease: JobLease, result: string, now: number) {
    integer(now);
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
    return this.publish(lease, now);
  }
  async publish(lease: JobLease, now: number) {
    lease = Object.freeze({ ...lease }); integer(now);
    const auth = await this.authorization(lease, now);
    if (!auth) return false;
    return !!await this.statement(`UPDATE assistant_jobs SET state='shadow_completed',lease_until=NULL,last_error=NULL
      WHERE installation_id=? AND generation=? AND id=? AND ${liveLease} AND source_id=? AND source_revision=?
      AND ${auth.guard.sql} AND EXISTS(SELECT 1 FROM assistant_job_ledger l WHERE l.installation_id=assistant_jobs.installation_id
      AND l.generation=assistant_jobs.generation AND l.job_id=assistant_jobs.id AND l.state='complete'
      AND l.request_hash=? AND l.request_json=?) RETURNING id`,
    lease.id, lease.lease_generation, now, lease.source_id, lease.source_revision, ...auth.guard.values,
    auth.ledger.request_hash, auth.ledger.request_json).first();
  }
}
