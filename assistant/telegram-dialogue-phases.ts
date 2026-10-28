import { z } from "zod";
import { SourceAccess, type SourceFence, type AccessGuard } from "./access";
import { sourceFence, originFence } from "./agent/contracts";
import type { RuntimeIdentity } from "./agent/controller";
import { CogneeModelBroker, type BrokerConfig, type ModelAdapter, type ModelAdmission, type ModelOperation } from "./model-broker";
import { JobQueue, type JobLease } from "./queue";
import { TelegramOwnerInbox, type TelegramOwnerTurn } from "./telegram-owner-inbox";
import type { OwnerAffinity } from "./mcp";
import { checkOriginsWithin, type OriginGuard } from "./origin-guard";
import type { ReplyDependency } from "./telegram-owner-replies";
import { bridgeHash } from "./ingress";
import { sourceTextHash } from "./sources";
import { jsonStatement } from "./d1-statement";

type Phase = "intent" | "answer";
type Context = { lease: JobLease; episodeId: string; bindingHash: string; deadlineAt: number; source: SourceFence; identity: RuntimeIdentity; config: BrokerConfig };
type Scope = OwnerAffinity & { period: string };
type Row = { request_id: string; phase: Phase; episode_id: string; ordinal: number; operation_key: string; request_hash: string; config_hash: string;
  payload_hash: string; body_json: string | null; deps_json: string; state: string; freeze_token: string; run_token: string | null; claim_nonce: string | null; result_json: string | null; result_hash: string | null; purged: number };
type Result = { state: "complete"; operationKey: string; body: unknown } | { state: "blocked" | "uncertain" | "in_progress" };
const ns = "installation_id=? AND generation=? AND request_id=? AND phase=?";
const nowSQL = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const owner = { kind: "owner" } as const;
const merge = (...guards: AccessGuard[]): AccessGuard => ({ sql: guards.map(g => `(${g.sql})`).join(" AND "), values: guards.flatMap(g => g.values) });
const depsSchema = z.array(z.object({ source: sourceFence, origin: originFence.optional() }).strict()).max(10);

/** Private execution only. A completed model phase is NOT a validated intent,
 * command receipt, native completion or permission to send a Telegram reply. */
export class OwnerDialoguePhases {
  private readonly scope: Readonly<Scope>;
  private readonly context: Readonly<Context>;
  private readonly queue: JobQueue;
  private readonly access: SourceAccess;
  private readonly lifetime: AbortSignal;
  private readonly checkpoint: Promise<string>;
  constructor(private readonly db: D1Database, scope: Scope, raw: Context, private readonly inbox: TelegramOwnerInbox,
    private readonly turn: TelegramOwnerTurn, private readonly adapter: ModelAdapter,
    private readonly options: { origin?: Pick<OriginGuard, "check" | "localGuard">; signal?: AbortSignal } = {}) {
    this.scope = Object.freeze({ ...scope }); this.context = Object.freeze(JSON.parse(JSON.stringify(raw)));
    const c = this.context, frame = inbox.replyFence(turn);
    if (["installationId", "generation", "sourceEpoch", "sourceGeneration"].some(key => frame[key as keyof OwnerAffinity] !== scope[key as keyof OwnerAffinity])
      || c.identity.profile !== "owner-dialogue" || !c.identity.runtimeId || !c.identity.submissionId || !/^[a-f0-9]{64}$/.test(c.episodeId) || !/^[a-f0-9]{64}$/.test(c.bindingHash)
      || !Number.isSafeInteger(c.deadlineAt) || c.deadlineAt <= Date.now() || c.deadlineAt > Date.now() + 60000 || c.deadlineAt > turn.deadlineAt
      || c.source.actor !== "owner" || c.source.source.origin !== "owner_request" || c.lease.source_id !== c.source.source.id || c.lease.source_revision !== c.source.source.revision) throw Error("dialogue_phase_context");
    this.checkpoint = (async () => {
      const id = "request:" + await bridgeHash(["telegram-owner-request-v1", scope.installationId, scope.generation, JSON.stringify(["telegram-owner-request-v1", frame.botInstance, turn.updateId])]);
      if (id !== c.source.source.id || c.source.source.hash !== await sourceTextHash(turn.text)) throw Error("dialogue_phase_context");
      return (await inbox.checkpoint(turn)).fingerprint;
    })();
    this.queue = new JobQueue(db, this.scope, owner, async () => inbox.guard(turn)); this.access = new SourceAccess(db, scope);
    this.lifetime = AbortSignal.any([AbortSignal.timeout(Math.max(1, c.deadlineAt - Date.now())), ...(options.signal ? [options.signal] : [])]);
  }
  private keys(phase: Phase) { return [this.scope.installationId, this.scope.generation, this.context.source.source.id, phase]; }
  private read(phase: Phase) { return this.db.prepare(`SELECT * FROM assistant_telegram_dialogue_phases WHERE ${ns}`).bind(...this.keys(phase)).first<Row>(); }
  async inspect(phase: Phase) {
    const row = await this.read(phase); return row ? { state: row.state, ordinal: row.ordinal, operationKey: row.operation_key, purged: row.purged === 1 } : null;
  }
  private dependencies(input: unknown): ReplyDependency[] {
    const deps = depsSchema.parse(input), seen = new Set<string>();
    if (new TextEncoder().encode(JSON.stringify(deps)).length > 32768) throw Error("dialogue_phase_dependencies");
    for (const dep of deps) {
      const s = dep.source;
      if (s.actor !== "owner" || s.installationId !== this.scope.installationId || s.generation !== this.scope.generation || !["owner_note", "whatsapp"].includes(s.source.origin)
        || seen.has(s.source.id) || (s.source.origin === "whatsapp" ? !this.options.origin || !dep.origin || dep.origin.canonicalId !== s.source.id || dep.origin.revision !== s.source.revision || dep.origin.version !== s.source.version
          || dep.origin.installationId !== this.scope.installationId || dep.origin.generation !== this.scope.generation || dep.origin.sourceEpoch !== this.scope.sourceEpoch || dep.origin.sourceGeneration !== this.scope.sourceGeneration : !!dep.origin)) throw Error("dialogue_phase_dependencies");
      seen.add(s.source.id);
    }
    return deps.sort((a, b) => a.source.source.id.localeCompare(b.source.source.id));
  }
  private remote(deps: ReplyDependency[]) { return checkOriginsWithin(deps.flatMap(d => d.origin ? [d.origin] : []), proof => this.options.origin!.check(proof)); }
  private async extra(deps: ReplyDependency[]): Promise<AccessGuard> {
    const c = this.context;
    return merge({ sql: `EXISTS(SELECT 1 FROM assistant_episodes e JOIN assistant_job_ledger l ON l.installation_id=e.installation_id AND l.generation=e.generation AND l.job_id=e.job_id
      WHERE e.installation_id=? AND e.generation=? AND e.id=? AND e.binding_hash=? AND e.job_id=? AND e.profile='owner' AND e.runtime_id=? AND e.submission_id=?
      AND e.state IN ('dispatching','accepted','running') AND e.deadline=? AND e.deadline>${nowSQL} AND e.max_calls=2 AND e.transport_attempts=1
      AND l.state IN ('prepared','attempting') AND json_extract(e.binding_json,'$.kind')='telegram_owner_dialogue'
      AND json_extract(e.binding_json,'$.source.source.id')=? AND json_extract(e.binding_json,'$.checkpoint.fingerprint')=?
      AND json_extract(e.binding_json,'$.period')=? AND json_extract(e.binding_json,'$.config')=?)`,
      values: [this.scope.installationId, this.scope.generation, c.episodeId, c.bindingHash, c.lease.id, c.identity.runtimeId, c.identity.submissionId, c.deadlineAt,
        c.source.source.id, await this.checkpoint, this.scope.period, JSON.stringify(c.config)] },
      ...deps.flatMap(dep => [this.access.guard(owner, dep.source, Date.now()), ...(dep.origin ? [this.options.origin!.localGuard(dep.origin)] : [])]));
  }
  private async authority(deps: ReplyDependency[]) {
    if (this.lifetime.aborted || !await this.remote(deps)) return null;
    const plan = await this.queue.currentPlan(this.context.lease, Date.now());
    return plan ? { statements: plan.statements, guard: merge(plan.guard, await this.extra(deps)) } : null;
  }
  private async current(row: Row, deps: ReplyDependency[]) {
    const auth = await this.authority(deps); if (!auth) return false;
    const guard = merge(auth.guard, { sql: `EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases WHERE ${ns} AND payload_hash=? AND purged=0 AND state IN ('frozen','invoking','attempting','complete'))`, values: [...this.keys(row.phase), row.payload_hash] });
    return (await this.db.batch([...auth.statements, jsonStatement(this.db, `SELECT 1 WHERE ${guard.sql}`, guard.values)])).at(-1)!.results.length === 1;
  }
  private async freeze(phase: Phase, operation: ModelOperation, deps: ReplyDependency[]): Promise<Row | null> {
    const auth = await this.authority(deps); if (!auth) return null;
    const c = this.context, ordinal = phase === "intent" ? 1 : 2, depsJSON = JSON.stringify(deps);
    const hash = await bridgeHash([phase, c.episodeId, c.bindingHash, c.deadlineAt, this.scope.period, operation, depsJSON]);
    const token = crypto.randomUUID(), order: AccessGuard = phase === "intent" ? { sql: "1", values: [] } : { sql: `EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases WHERE ${ns} AND episode_id=? AND state='complete' AND purged=0)`, values: [...this.keys("intent"), c.episodeId] };
    const guard = merge(auth.guard, order);
    await this.db.batch([...auth.statements,
      jsonStatement(this.db, `INSERT INTO assistant_telegram_dialogue_phases(installation_id,generation,request_id,phase,episode_id,binding_hash,ordinal,period,operation_key,request_hash,config_hash,payload_hash,body_json,deps_json,deadline_at,freeze_token,state)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'frozen' WHERE (${guard.sql}) ON CONFLICT DO NOTHING`,
        [...this.keys(phase), c.episodeId, c.bindingHash, ordinal, this.scope.period, operation.operationKey, operation.requestHash, operation.configHash, hash, operation.body, depsJSON, c.deadlineAt, token, ...guard.values]),
      this.db.prepare(`INSERT INTO assistant_episode_calls(installation_id,generation,episode_id,ordinal,payload_hash,token,operation_key,broker_hash)
        SELECT installation_id,generation,episode_id,ordinal,payload_hash,?,operation_key,request_hash FROM assistant_telegram_dialogue_phases
        WHERE ${ns} AND freeze_token=? ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), ...this.keys(phase), token),
    ]);
    const row = await this.read(phase); if (row && row.payload_hash !== hash) throw Error("dialogue_phase_conflict"); return row;
  }
  private async uncertain(row: Row, runToken?: string) {
    await this.db.batch([
      this.db.prepare(`UPDATE assistant_telegram_dialogue_phases SET state='uncertain' WHERE ${ns} AND operation_key=? AND request_hash=? AND purged=0
        AND ((state IN ('invoking','attempting') AND run_token=?) OR (state='frozen' AND EXISTS(SELECT 1 FROM assistant_budget_reservations r
        WHERE r.installation_id=assistant_telegram_dialogue_phases.installation_id AND r.generation=assistant_telegram_dialogue_phases.generation AND r.operation_key=assistant_telegram_dialogue_phases.operation_key AND r.request_hash=assistant_telegram_dialogue_phases.request_hash)))`)
        .bind(...this.keys(row.phase), row.operation_key, row.request_hash, runToken ?? null),
      this.db.prepare(`UPDATE assistant_episode_calls SET state='uncertain' WHERE installation_id=? AND generation=? AND episode_id=? AND ordinal=? AND state IN ('prepared','attempting')
        AND EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases WHERE ${ns} AND state='uncertain' AND operation_key=?)`)
        .bind(this.scope.installationId, this.scope.generation, row.episode_id, row.ordinal, ...this.keys(row.phase), row.operation_key),
    ]);
  }
  private admission(row: Row, runToken: string, deps: ReplyDependency[]): ModelAdmission {
    return { uncertain: () => this.uncertain(row, runToken), prepare: async request => {
      if (request.recovered || request.key !== row.operation_key || request.hash !== row.request_hash || this.lifetime.aborted || !await this.remote(deps)) return null;
      const plan = await this.queue.admissionPlan(this.context.lease, Date.now()); if (!plan) return null;
      const guard = merge(plan.executionGuard, await this.extra(deps)), nonce = crypto.randomUUID();
      const witness: AccessGuard = { sql: `EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases WHERE ${ns} AND state='attempting' AND run_token=? AND claim_nonce=? AND operation_key=? AND request_hash=? AND purged=0)`,
        values: [...this.keys(row.phase), runToken, nonce, row.operation_key, row.request_hash] };
      return { statements: [...plan.statements, plan.statement,
        jsonStatement(this.db, `UPDATE assistant_telegram_dialogue_phases SET state='attempting',claim_nonce=? WHERE ${ns} AND state='invoking' AND run_token=? AND payload_hash=? AND purged=0 AND (${guard.sql})`,
          [nonce, ...this.keys(row.phase), runToken, row.payload_hash, ...guard.values]),
        jsonStatement(this.db, `UPDATE assistant_episode_calls SET state='attempting',claim_nonce=? WHERE installation_id=? AND generation=? AND episode_id=? AND ordinal=?
          AND payload_hash=? AND operation_key=? AND broker_hash=? AND state='prepared' AND (${witness.sql})`,
          [nonce, this.scope.installationId, this.scope.generation, row.episode_id, row.ordinal, row.payload_hash, row.operation_key, row.request_hash, ...witness.values])],
        guard: merge(witness, { sql: `EXISTS(SELECT 1 FROM assistant_episode_calls WHERE installation_id=? AND generation=? AND episode_id=? AND ordinal=? AND claim_nonce=? AND state='attempting')`,
          values: [this.scope.installationId, this.scope.generation, row.episode_id, row.ordinal, nonce] }) };
    } };
  }
  async run(phase: Phase, payload: unknown, inputDeps: ReplyDependency[] = []): Promise<Result> {
    if (!["intent", "answer"].includes(phase) || this.lifetime.aborted) return { state: "blocked" };
    const owned = JSON.stringify(payload); if (!owned || new TextEncoder().encode(owned).length > 65536) throw Error("dialogue_phase_payload");
    const deps = this.dependencies(inputDeps); if (phase === "intent" && deps.length) throw Error("dialogue_phase_dependencies");
    let row: Row | null = null, runToken: string | undefined;
    const config = { ...this.context.config, extractionConfig: this.context.config.extractionConfig + ":" + phase };
    const broker = new CogneeModelBroker(this.db, this.scope, config, async request => {
      if (!row || !await this.current(row, deps) || this.lifetime.aborted) throw Error("dialogue_phase_denied");
      return this.adapter(Object.freeze({ ...request, signal: AbortSignal.any([request.signal, this.lifetime]) }));
    }, Date.now, { prepare: request => row && runToken ? this.admission(row, runToken, deps).prepare(request) : Promise.resolve(null), uncertain: () => row ? this.uncertain(row, runToken) : Promise.resolve() });
    const auth = await this.authority(deps); if (!auth) return { state: "blocked" };
    const token = await broker.issuePermit(this.context.source.source.id, this.context.source.source.revision, this.context.deadlineAt);
    const operation = await broker.describe(token, "/v1/chat/completions", JSON.parse(owned));
    row = await this.freeze(phase, operation, deps); if (!row || row.purged || row.state === "cancelled") return { state: "blocked" };
    if (row.state === "uncertain") return { state: "uncertain" };
    if (row.state === "complete") {
      if (!await this.current(row, deps)) return { state: "blocked" };
      const result = await broker.replay(token, operation.path, JSON.parse(operation.body));
      return result.state === "complete" && await bridgeHash(JSON.stringify(result.body)) === row.result_hash && await this.current(row, deps)
        ? { state: "complete", operationKey: row.operation_key, body: result.body } : { state: "blocked" };
    }
    if (row.state !== "frozen") return { state: "in_progress" };
    if (await this.db.prepare("SELECT 1 FROM assistant_budget_reservations WHERE installation_id=? AND generation=? AND operation_key=? AND request_hash=?")
      .bind(this.scope.installationId, this.scope.generation, row.operation_key, row.request_hash).first()) {
      await this.uncertain(row); const current = await this.read(phase);
      // Another invocation may have acquired this phase after our frozen read.
      // Only its persisted outcome can justify reporting an uncertain attempt.
      return { state: current?.state === "uncertain" ? "uncertain" : current?.purged || current?.state === "cancelled" ? "blocked" : "in_progress" };
    }
    const claim = await this.authority(deps); if (!claim) return { state: "blocked" }; runToken = crypto.randomUUID();
    const claimed = await this.db.batch([...claim.statements, jsonStatement(this.db, `UPDATE assistant_telegram_dialogue_phases SET state='invoking',run_token=?
      WHERE ${ns} AND state='frozen' AND payload_hash=? AND purged=0 AND (${claim.guard.sql}) RETURNING phase`, [runToken, ...this.keys(phase), row.payload_hash, ...claim.guard.values])]);
    if (!claimed.at(-1)!.results.length) return { state: "in_progress" };
    try {
      // Re-describe before invoke/reserve; a model/config/prompt drift cannot
      // create a different paid operation and only then fail admission.
      if (JSON.stringify(await broker.describe(token, operation.path, JSON.parse(operation.body))) !== JSON.stringify(operation)) throw Error("dialogue_phase_conflict");
      const result = await broker.invoke(token, operation.path, JSON.parse(operation.body));
      if (result.state !== "complete" || !await this.current(row, deps)) { await this.uncertain(row, runToken); return { state: "uncertain" }; }
      const body = JSON.stringify(result.body), hash = await bridgeHash(body), current = await this.authority(deps);
      if (!current) { await this.uncertain(row, runToken); return { state: "uncertain" }; }
      await this.db.batch([...current.statements,
        jsonStatement(this.db, `UPDATE assistant_telegram_dialogue_phases SET state='complete',result_json=?,result_hash=? WHERE ${ns} AND state='attempting' AND run_token=? AND purged=0
          AND EXISTS(SELECT 1 FROM assistant_model_receipts WHERE installation_id=? AND generation=? AND operation_key=? AND request_hash=? AND state='complete' AND response_json=?) AND (${current.guard.sql})`,
          [body, hash, ...this.keys(phase), runToken, this.scope.installationId, this.scope.generation, row.operation_key, row.request_hash, body, ...current.guard.values]),
        this.db.prepare(`UPDATE assistant_episode_calls SET state='complete' WHERE installation_id=? AND generation=? AND episode_id=? AND ordinal=? AND state='attempting'
          AND EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases WHERE ${ns} AND state='complete' AND run_token=? AND result_hash=?)`)
          .bind(this.scope.installationId, this.scope.generation, row.episode_id, row.ordinal, ...this.keys(phase), runToken, hash),
      ]);
      const saved = await this.read(phase);
      if (saved?.state !== "complete" || !await this.current(saved, deps)) { await this.uncertain(row, runToken); return { state: "uncertain" }; }
      return { state: "complete", operationKey: row.operation_key, body: result.body };
    } catch { await this.uncertain(row, runToken); return { state: "uncertain" }; }
  }
}
