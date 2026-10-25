import { z } from "zod";
import type { SourceScope } from "./sources";
import type { TrustedActor, AccessGuard } from "./access";
import { bridgeHash } from "./ingress";
const id = z.string().min(1).max(256), version = z.number().int().min(0).max(2147483646);
const time = z.number().int().nonnegative().safe(), revision = version.refine(n => n > 0);
const reference = z.object({ id, revision }).strict();
const base = { operationId: id, id, expectedVersion: version };
const actions = z.enum(["reply_text", "reply_audio", "ask_clarification", "future_contact", "read_github", "read_calendar", "propose_calendar_change"]);
const schema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("project.put"), name: z.string().min(1).max(512) }).strict(),
  z.object({ ...base, kind: z.literal("mandate.put"), conversationId: id, policyRevision: revision, project: reference.optional(),
    purpose: z.string().min(1).max(2048), expiresAt: time, status: z.enum(["draft", "active"]).default("draft"),
    actions: z.array(actions).max(7), sources: z.array(reference).max(32) }).strict(),
  z.object({ ...base, kind: z.literal("mandate.revoke"), expectedVersion: revision }).strict(),
  z.object({ ...base, kind: z.literal("fup.put"), conversationId: id, policyRevision: revision, source: reference,
    project: reference.optional(), mission: reference.optional(), recipientId: id.optional(),
    mandate: z.object({ id, version: revision }).strict().optional(), purpose: z.string().min(1).max(2048),
    dueAt: time.optional(), windowEnd: time.optional(), timezone: id.default("UTC"), precision: z.enum(["unset", "exact", "day", "window"]).default("unset"),
    condition: z.string().min(1).max(2048).optional(), recurrenceLimit: z.number().int().min(1).max(100).default(1),
    state: z.enum(["scheduled", "awaiting_condition", "awaiting_approval"]).default("awaiting_approval") }).strict(),
  z.object({ ...base, kind: z.literal("fup.pause"), expectedVersion: revision }).strict(),
  z.object({ ...base, kind: z.literal("fup.cancel"), expectedVersion: revision }).strict(),
]);
export type OwnerCommand = z.input<typeof schema>;
export type CommandReceipt = { operationId: string; kind: OwnerCommand["kind"]; id: string; version: number; shadow: true };
const ns = "installation_id=? AND generation=?";
const scoped = (alias: string) => `${alias}.installation_id=? AND ${alias}.generation=?`;
type Value = string | number | null;
function bounded(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 512 || depth > 5) throw new Error("control_input");
  if (typeof value === "string") { if (value.length > 4096) throw new Error("control_input"); return; }
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return;
  if (Array.isArray(value)) { if (value.length > 32) throw new Error("control_input"); for (const child of value) bounded(child, depth + 1, budget); return; }
  if (typeof value !== "object") throw new Error("control_input");
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key)) { if (++count > 24 || key.length > 64) throw new Error("control_input"); bounded((value as Record<string, unknown>)[key], depth + 1, budget); }
}
function command(input: unknown) {
  try {
    bounded(input); const result = schema.parse(input);
    if (new TextEncoder().encode(JSON.stringify(result)).length > 16384) throw 0;
    if (result.kind === "mandate.put") {
      if (new Set(result.actions).size !== result.actions.length || new Set(result.sources.map(ref => ref.id)).size !== result.sources.length || (result.status === "active" && (!result.actions.length || !result.sources.length))) throw 0;
      result.actions.sort(); result.sources.sort((a, b) => a.id.localeCompare(b.id));
    }
    if (result.kind === "fup.put") {
      new Intl.DateTimeFormat("en", { timeZone: result.timezone });
      if ((result.state === "scheduled" && result.dueAt === undefined) || (result.dueAt === undefined) !== (result.precision === "unset") || (result.windowEnd !== undefined && (result.dueAt === undefined || result.windowEnd < result.dueAt)) || (result.state === "awaiting_condition" && !result.condition)) throw 0;
    }
    return result;
  } catch { throw new Error("control_input"); }
}
/** Internal host API only. A supplied owner principal is NOT OAuth proof; #46
 * must derive it from the exclusive authenticated MCP service binding. No HTTP. */
export class OwnerControl {
  private readonly scope: SourceScope;
  private readonly principal: TrustedActor;
  constructor(private readonly db: D1Database, scope: SourceScope, principal: TrustedActor, private readonly clock = Date.now) {
    if (![scope.installationId, scope.generation].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)) throw new Error("control_scope");
    this.scope = Object.freeze({ installationId: scope.installationId, generation: scope.generation }); this.principal = Object.freeze({ ...principal });
  }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private stored(operationId: string) { return this.db.prepare(`SELECT request_hash,result_json FROM assistant_owner_commands WHERE ${ns} AND operation_id=?`).bind(...this.keys(), operationId).first<{ request_hash: string; result_json: string }>(); }
  async execute(input: unknown): Promise<CommandReceipt> {
    if (this.principal.kind !== "owner") throw new Error("owner_required");
    const item = command(input), hash = await bridgeHash(item), previous = await this.stored(item.operationId);
    const recover = (row: NonNullable<typeof previous>) => {
      if (row.request_hash !== hash) throw new Error("control_operation_conflict"); return JSON.parse(row.result_json) as CommandReceipt;
    };
    if (previous) return recover(previous);
    const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error("control_clock");
    const token = crypto.randomUUID(), result: CommandReceipt = { operationId: item.operationId, kind: item.kind, id: item.id, version: item.expectedVersion + 1, shadow: true };
    const conditions: string[] = [], values: Value[] = [];
    const require = (sql: string, ...binds: Value[]) => { conditions.push(sql); values.push(...binds); };
    const table = item.kind === "project.put" ? "assistant_projects" : item.kind.startsWith("mandate.") ? "assistant_mandates" : "assistant_follow_ups";
    if (item.expectedVersion === 0) require(`NOT EXISTS(SELECT 1 FROM ${table} WHERE ${ns} AND id=?)`, ...this.keys(), item.id);
    else if (item.kind === "project.put") require(`EXISTS(SELECT 1 FROM assistant_project_revisions WHERE ${ns} AND project_id=? AND revision=?)`, ...this.keys(), item.id, item.expectedVersion);
    else require(`(SELECT MAX(version) FROM ${table} WHERE ${ns} AND id=?)=?`, ...this.keys(), item.id, item.expectedVersion);
    if (item.kind === "mandate.put" || item.kind === "fup.put") {
      require(`EXISTS(SELECT 1 FROM assistant_conversation_policies WHERE ${ns} AND conversation_id=? AND revision=? AND excluded=0 AND (kind='private' OR group_mode<>'ignore'))`, ...this.keys(), item.conversationId, item.policyRevision);
      const refs = item.kind === "mandate.put" ? item.sources : [item.source];
      require(`NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(
        SELECT 1 FROM assistant_sources s WHERE ${scoped("s")} AND s.id=json_extract(r.value,'$.id')
        AND s.revision=json_extract(r.value,'$.revision') AND s.status='active' AND s.current_version IS NOT NULL))`, JSON.stringify(refs), ...this.keys());
      if (item.project) require(`EXISTS(SELECT 1 FROM assistant_project_revisions WHERE ${ns} AND project_id=? AND revision=?)`, ...this.keys(), item.project.id, item.project.revision);
      if (item.kind === "mandate.put") require("?>?", item.expiresAt, now);
      else {
        if (item.mission) require(`EXISTS(SELECT 1 FROM assistant_missions WHERE ${ns} AND id=? AND revision=? AND state='active')`, ...this.keys(), item.mission.id, item.mission.revision);
        if (item.recipientId) require(`EXISTS(SELECT 1 FROM assistant_people WHERE ${ns} AND id=?)`, ...this.keys(), item.recipientId);
        if (item.mandate) require(`EXISTS(SELECT 1 FROM assistant_mandates m WHERE ${scoped("m")} AND m.id=? AND m.version=? 
          AND m.version=(SELECT MAX(version) FROM assistant_mandates latest WHERE latest.installation_id=m.installation_id AND latest.generation=m.generation AND latest.id=m.id) 
          AND m.status='active' AND m.conversation_id=? AND m.project_id IS ? AND m.issued_at<=? AND m.expires_at>?)`, ...this.keys(), item.mandate.id, item.mandate.version, item.conversationId, item.project?.id ?? null, now, now);
      }
    }
    // The unique command token is admitted only under all current conditions.
    // It remains true after our own updates, so later statements share one gate.
    const gate = `EXISTS(SELECT 1 FROM assistant_owner_commands WHERE ${ns} AND operation_id=? AND token=?)`;
    const gated = (sql: string, ...binds: Value[]) => this.db.prepare(sql.replaceAll("$gate", gate)).bind(...binds, ...this.keys(), item.operationId, token);
    const batch = [this.db.prepare(`INSERT INTO assistant_owner_commands SELECT ?,?,?,?,?,?,? WHERE ${conditions.join(" AND ")} ON CONFLICT DO NOTHING`).bind(...this.keys(), item.operationId, hash, token, JSON.stringify(result), now, ...values)];
    if (item.kind === "project.put") {
      batch.push(item.expectedVersion === 0
        ? gated("INSERT INTO assistant_projects(installation_id,generation,id,name) SELECT ?,?,?,? WHERE $gate", ...this.keys(), item.id, item.name)
        : gated(`UPDATE assistant_projects SET name=? WHERE ${ns} AND id=? AND $gate`, item.name, ...this.keys(), item.id));
      batch.push(item.expectedVersion === 0
        ? gated("INSERT INTO assistant_project_revisions SELECT ?,?,?,? WHERE $gate", ...this.keys(), item.id, result.version)
        : gated(`UPDATE assistant_project_revisions SET revision=? WHERE ${ns} AND project_id=? AND $gate`, result.version, ...this.keys(), item.id));
    } else if (item.kind === "mandate.put") {
      batch.push(gated("INSERT INTO assistant_mandates SELECT ?,?,?,?,?,?,?,?,?,? WHERE $gate", ...this.keys(), item.id, result.version, item.conversationId, item.project?.id ?? null, item.purpose, item.status, now, item.expiresAt));
      for (const action of item.actions) batch.push(gated("INSERT INTO assistant_mandate_actions SELECT ?,?,?,?,? WHERE $gate", ...this.keys(), item.id, result.version, action));
      for (const ref of item.sources) batch.push(gated("INSERT INTO assistant_mandate_sources SELECT ?,?,?,?,? WHERE $gate", ...this.keys(), item.id, result.version, ref.id));
    } else if (item.kind === "mandate.revoke") {
      batch.push(gated(`INSERT INTO assistant_mandates SELECT installation_id,generation,id,?,conversation_id,project_id,purpose,'revoked',issued_at,expires_at FROM assistant_mandates WHERE ${ns} AND id=? AND version=? AND $gate`, result.version, ...this.keys(), item.id, item.expectedVersion));
    } else {
      if (item.kind === "fup.put") batch.push(gated(`INSERT INTO assistant_follow_ups(
        installation_id,generation,id,version,mission_id,project_id,recipient_id,source_id,source_revision,origin,
        conversation_id,purpose,due_at,window_end,timezone,precision,condition_text,mandate_id,mandate_version,
        recurrence_limit,state,next_evaluation_at) SELECT ?,?,?,?,?,?,?,?,?,'owner_request',?,?,?,?,?,?,?,?,?,?,?,? WHERE $gate`,
        ...this.keys(), item.id, result.version, item.mission?.id ?? null, item.project?.id ?? null, item.recipientId ?? null, item.source.id, item.source.revision,
        item.conversationId, item.purpose, item.dueAt ?? null, item.windowEnd ?? null, item.timezone, item.precision, item.condition ?? null, item.mandate?.id ?? null, item.mandate?.version ?? null, item.recurrenceLimit, item.state, item.dueAt ?? now));
      else batch.push(gated(`INSERT INTO assistant_follow_ups SELECT installation_id,generation,id,?,mission_id,project_id,
        recipient_id,source_id,source_revision,origin,conversation_id,purpose,due_at,window_end,timezone,precision,
        condition_text,reason,external_event_ref,mandate_id,mandate_version,recurrence_limit,?,next_evaluation_at
        FROM assistant_follow_ups WHERE ${ns} AND id=? AND version=? AND $gate`, result.version, item.kind === "fup.pause" ? "paused" : "cancelled", ...this.keys(), item.id, item.expectedVersion));
      // Preserve paid truth. Only live work is invalidated; ledgers and receipts
      // are never deleted or rewritten, including an executor's late answer.
      batch.push(gated(`UPDATE assistant_jobs SET state='cancelled',lease_until=NULL,last_error='work_superseded' WHERE ${ns} AND state IN ('pending','processing') 
        AND occurrence_id IN (SELECT id FROM assistant_fup_occurrences WHERE ${ns} 
        AND follow_up_id=? AND follow_up_version<=?) AND $gate`, ...this.keys(), ...this.keys(), item.id, item.expectedVersion));
      batch.push(gated(`UPDATE assistant_fup_occurrences SET state='cancelled' WHERE ${ns} AND follow_up_id=? AND follow_up_version<=? AND state IN ('pending','blocked','paused') AND $gate`, ...this.keys(), item.id, item.expectedVersion));
    }
    await this.db.batch(batch);
    const stored = await this.stored(item.operationId); if (!stored) throw new Error("control_precondition"); return recover(stored);
  }
}
export type WorkFence = Readonly<SourceScope & {
  kind: "follow_up"; jobId: string; occurrenceId: string; occurrenceState: string;
  followUpId: string; version: number; state: string; sourceId: string; sourceRevision: number;
  missionId: string | null; missionRevision: number | null; mandateId: string | null; mandateVersion: number | null;
}>;
const workFrom = `FROM assistant_jobs j JOIN assistant_fup_occurrences o ON o.installation_id=j.installation_id AND o.generation=j.generation AND o.id=j.occurrence_id
 JOIN assistant_follow_ups f ON f.installation_id=o.installation_id AND f.generation=o.generation AND f.id=o.follow_up_id AND f.version=o.follow_up_version
 AND j.source_id=f.source_id AND j.source_revision=f.source_revision
 JOIN assistant_sources s ON s.installation_id=f.installation_id AND s.generation=f.generation AND s.id=f.source_id AND s.revision=f.source_revision AND s.status='active' AND s.current_version IS NOT NULL
 LEFT JOIN assistant_missions m ON m.installation_id=f.installation_id AND m.generation=f.generation AND m.id=f.mission_id`;
const workLive = `j.kind='follow_up' AND j.state IN ('pending','processing') AND o.state IN ('pending','blocked') AND f.state IN ('scheduled','awaiting_condition','awaiting_approval')
 AND f.version=(SELECT MAX(version) FROM assistant_follow_ups latest WHERE latest.installation_id=f.installation_id AND latest.generation=f.generation AND latest.id=f.id)
 AND (f.mission_id IS NULL OR m.state='active') AND (f.mandate_id IS NULL OR EXISTS(SELECT 1 FROM assistant_mandates grant_ WHERE grant_.installation_id=f.installation_id AND grant_.generation=f.generation AND grant_.id=f.mandate_id
 AND grant_.version=f.mandate_version AND grant_.version=(SELECT MAX(version) FROM assistant_mandates latest WHERE latest.installation_id=grant_.installation_id AND latest.generation=grant_.generation AND latest.id=grant_.id) AND grant_.status='active' AND grant_.issued_at<=? AND grant_.expires_at>?))`;
/** Null always denies a follow_up job, including a missing occurrence. This is
 * an evaluation fence, never a delegation: awaiting approval stays unapproved. */
export async function captureWorkFence(db: D1Database, scope: SourceScope, job: { id: string; kind: "follow_up" }, now = Date.now()): Promise<WorkFence | null> {
  if (!job || job.kind !== "follow_up" || typeof job.id !== "string" || !Number.isSafeInteger(now) || now < 0) return null;
  const keys = [scope.installationId, scope.generation];
  const row = await db.prepare(`SELECT j.id AS jobId,o.id AS occurrenceId,o.state AS occurrenceState,f.id AS followUpId,f.version,f.state,
    f.source_id AS sourceId,f.source_revision AS sourceRevision,f.mission_id AS missionId,m.revision AS missionRevision,
    f.mandate_id AS mandateId,f.mandate_version AS mandateVersion ${workFrom} WHERE ${scoped("j")} AND j.id=? AND ${workLive}`).bind(...keys, job.id, now, now).first<Omit<WorkFence, keyof SourceScope | "kind">>();
  return row ? Object.freeze({ installationId: keys[0], generation: keys[1], kind: "follow_up", ...row }) : null;
}
/** Compose this predicate into the same mutation that admits/publishes a result.
 * Lease, complete source-pack ACL and conversation/origin fences remain separate. */
export function workGuard(fence: WorkFence, now = Date.now()): AccessGuard {
  if (!fence || fence.kind !== "follow_up" || !Number.isSafeInteger(now) || now < 0) return { sql: "0", values: [] };
  const copy = { ...fence };
  return { sql: `EXISTS(SELECT 1 ${workFrom} WHERE ${scoped("j")} AND j.id=? AND o.id=? AND o.state=? AND f.id=? AND f.version=? AND f.state=? AND f.source_id=? AND f.source_revision=?
      AND f.mission_id IS ? AND m.revision IS ? AND f.mandate_id IS ? AND f.mandate_version IS ? AND ${workLive})`,
    values: [copy.installationId, copy.generation, copy.jobId, copy.occurrenceId, copy.occurrenceState, copy.followUpId, copy.version, copy.state, copy.sourceId, copy.sourceRevision, copy.missionId, copy.missionRevision, copy.mandateId, copy.mandateVersion, now, now] };
}
