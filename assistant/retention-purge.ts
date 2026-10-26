import { z } from "zod";
import type { TrustedActor } from "./access";
import type { SourceScope } from "./sources";
import { bridgeHash } from "./ingress";
import type { SourceRetirementGuard } from "./retention-authority";
import { WithdrawalBarrier } from "./retention-barrier";
import { canonicalSnapshotTables } from "./retention-snapshot-contract";
export type RestorePurgeGate = Readonly<{ token: string; operationId: string; targetGeneration: string }>;
const label = z.string().min(1).max(256);
export const purgeCommand = z.object({ kind: z.literal("source.purge"), operationId: label, sourceId: label }).strict();
const namespace = (alias: string) => `${alias}.installation_id=?1 AND ${alias}.generation=?2`;
const refs = (kind: string) => `SELECT id FROM assistant_retention_purge_refs WHERE installation_id=?1 AND generation=?2 AND purge_id=?3 AND kind='${kind}'`;
const gate = `EXISTS(SELECT 1 FROM assistant_retention_purge_grants WHERE installation_id=?1 AND generation=?2 AND source_id=?4 AND purge_id=?3)`;
const supportedTables = new Set(`sources source_versions source_changes change_cursors people provider_identities projects project_memberships conversation_policies mandates mandate_actions mandate_sources missions follow_ups fup_occurrences jobs capture_streams capture_inbox job_ledger job_receipts origin_conversations source_origins origin_versions materialization_results materialization_progress source_admissions budget_accounts budget_reservations relation_batches model_permits model_receipts conversations conversation_replay project_revisions owner_commands episodes episode_calls retrieval_runs retrieval_steps retrieval_items retrieval_semantic mission_versions policy_versions decision_jobs shadow_decisions telegram_links telegram_pairings telegram_updates fup_provenance media_receipts media_artifacts telegram_topics telegram_notifications telegram_reviews telegram_read_admissions retention_barriers retention_purges retention_purge_refs retention_purge_grants retention_object_claims retention_installation_gate retention_snapshot_sessions retention_snapshot_pages retention_restore_sessions retention_restore_rows retention_restore_grants retention_restored_work retention_generation_seals retention_quarantines routine_state routine_cycles routine_items routine_event_items routine_reviews routine_fup_results routine_ingestions telegram_summaries evaluation_exposures evaluation_assessments capture_changes bridge_cursors`.split(" ").map(name => "assistant_" + name));
/** A fixed, typed closure of the assistant contracts. SQL identifiers and JSON
 * paths below are host constants; neither a command nor source supplies SQL. */
export class RetentionPurge {
  private readonly scope: SourceScope;
  private readonly actor: TrustedActor;
  private readonly restoreGate?: RestorePurgeGate;
  constructor(private readonly db: D1Database, scope: SourceScope, actor: TrustedActor, private readonly clock = Date.now, private readonly retirement?: SourceRetirementGuard, restoreGate?: RestorePurgeGate) { this.scope = Object.freeze({ ...scope }); this.actor = Object.freeze({ ...actor }); this.restoreGate = restoreGate ? Object.freeze({ ...restoreGate }) : undefined; }
  async advance(raw: unknown) {
    if (this.actor.kind !== "owner") throw new Error("owner_required");
    const command = purgeCommand.parse(raw), hash = await bridgeHash(command), args = [this.scope.installationId, this.scope.generation, command.operationId, command.sourceId];
    // D1 binds each placeholder occurrence, including repeated numbered ones.
    // Expand only these host-owned positional constants, with their values.
    const sql = (query: string, extra: (string | number | null)[] = []) => {
      const parameters: (string | number | null)[] = [], values = [...args, extra[0] ?? null, this.restoreGate?.token ?? null, this.restoreGate?.operationId ?? null, this.restoreGate?.targetGeneration ?? null];
      const prepared = query.replace(/\?([1-8])/g, (_match, index: string) => { parameters.push(values[Number(index) - 1]); return "?"; });
      return this.db.prepare(prepared).bind(...parameters);
    };
    const read = () => sql(`SELECT request_hash,source_id,state,report_json FROM assistant_retention_purges WHERE installation_id=?1 AND generation=?2 AND operation_id=?3 AND ?4 IS NOT NULL`).first<{ request_hash: string; source_id: string; state: string; report_json: string | null }>();
    let previous = await read();
    if (previous && (previous.request_hash !== hash || previous.source_id !== command.sourceId)) throw new Error("retention_operation_conflict");
    if (previous?.state === "complete") return JSON.parse(previous.report_json!);
    const catalog = (await this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'assistant_*' LIMIT 129").all<{ name: string }>()).results;
    if (catalog.length > 128 || catalog.some(row => !supportedTables.has(row.name) && !["assistant_retention_runtime_hold", "assistant_retention_active_generation"].includes(row.name))) return { state: "blocked", reason: "retention_schema_adapter_required", d1: "pending" };
    const restoring = catalog.some(row => row.name === "assistant_retention_installation_gate") ? await this.db.prepare("SELECT state,token,operation_id,target_generation FROM assistant_retention_installation_gate WHERE installation_id=?").bind(this.scope.installationId).first<{ state: string; token: string; operation_id: string; target_generation: string | null }>() : null;
    if (this.restoreGate && (restoring?.state !== "quiescing" || restoring.token !== this.restoreGate.token || restoring.operation_id !== this.restoreGate.operationId || restoring.target_generation !== this.scope.generation || this.restoreGate.targetGeneration !== this.scope.generation)) throw new Error("restore_purge_gate_lost");
    if (!this.restoreGate && restoring?.state === "quiescing") return { state: "blocked", reason: "canonical_writers_quiesced", d1: "pending" };
    await new WithdrawalBarrier(this.db, this.scope, this.retirement).adopt(command.sourceId, this.clock());
    const retired = await sql(`SELECT 1 FROM assistant_sources s JOIN assistant_retention_barriers b ON b.installation_id=s.installation_id AND b.generation=s.generation AND b.source_id=s.id
      WHERE ${namespace("s")} AND s.id=?4 AND s.status='withdrawn' AND b.state='retired' AND b.external_state='recorded' AND ?3 IS NOT NULL`).first();
    if (!retired) return { state: "blocked", reason: "external_withdrawal_required", logicalBlock: "unchecked", d1: "pending", r2: "pending", externalCopies: "pending" };
    if (!previous) {
      await this.db.prepare(`INSERT INTO assistant_retention_purges VALUES(?,?,?,?,?,'prepared',NULL,?) ON CONFLICT DO NOTHING`).bind(...args.slice(0, 3), hash, command.sourceId, this.clock()).run();
      previous = await read(); if (previous?.request_hash !== hash || previous.source_id !== command.sourceId) throw new Error("retention_operation_conflict");
    }
    const tables = new Set((await this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'assistant_routine_*'").all<{ name: string }>()).results.map(row => row.name));
    const routines = tables.has("assistant_routine_items");
    if (tables.size && !["assistant_routine_items", "assistant_routine_event_items", "assistant_routine_ingestions", "assistant_routine_state", "assistant_routine_cycles", "assistant_routine_fup_results"].every(table => tables.has(table))) return { state: "blocked", reason: "routines_schema_incomplete", d1: "pending" };
    const collect = (kind: string, query: string) => sql(`INSERT INTO assistant_retention_purge_refs SELECT ?1,?2,?3,'${kind}',found.id FROM (${query}) found WHERE found.id IS NOT NULL AND found.id NOT IN (${refs(kind)}) ORDER BY found.id LIMIT 128 ON CONFLICT DO NOTHING`);
    const collection = () => [
      collect("mission", `SELECT id FROM assistant_missions t WHERE ${namespace("t")} AND t.source_id=?4`),
      collect("mission_version", `SELECT json_array(id,revision) AS id FROM assistant_mission_versions t WHERE ${namespace("t")} AND json_extract(body_json,'$.sourceId')=?4`),
      collect("fup", `SELECT id FROM assistant_follow_ups t WHERE ${namespace("t")} AND (t.source_id=?4 OR t.mission_id IN (${refs("mission")}))`),
      collect("job", `SELECT id FROM assistant_jobs t WHERE ${namespace("t")} AND (t.source_id=?4 OR t.occurrence_id IN (SELECT id FROM assistant_fup_occurrences f WHERE ${namespace("f")} AND f.follow_up_id IN (${refs("fup")})))
       UNION SELECT job_id FROM assistant_episodes t WHERE ${namespace("t")} AND (EXISTS(SELECT 1 FROM json_each(t.binding_json,'$.context.sources') j WHERE json_extract(j.value,'$.id')=?4) OR json_extract(t.binding_json,'$.lease.source_id')=?4)
       UNION SELECT job_id FROM assistant_shadow_decisions t WHERE ${namespace("t")} AND EXISTS(SELECT 1 FROM json_each(t.dependencies_json) j WHERE json_extract(j.value,'$.id')=?4)`),
      collect("model", `SELECT operation_key AS id FROM assistant_model_receipts t WHERE ${namespace("t")} AND t.source_id=?4 UNION SELECT operation_key FROM assistant_episode_calls c JOIN assistant_episodes e ON e.installation_id=c.installation_id AND e.generation=c.generation AND e.id=c.episode_id WHERE ${namespace("e")} AND e.job_id IN (${refs("job")})`),
      collect("job", `SELECT e.job_id AS id FROM assistant_episode_calls c JOIN assistant_episodes e ON e.installation_id=c.installation_id AND e.generation=c.generation AND e.id=c.episode_id WHERE ${namespace("e")} AND c.operation_key IN (${refs("model")})`),
      collect("run", `SELECT run_id AS id FROM assistant_retrieval_items t WHERE ${namespace("t")} AND t.source_id=?4 UNION SELECT json_extract(binding_json,'$.runId') FROM assistant_episodes t WHERE ${namespace("t")} AND t.job_id IN (${refs("job")})
       UNION SELECT id FROM assistant_retrieval_runs t WHERE ${namespace("t")} AND EXISTS(SELECT 1 FROM json_each(t.pack_json) j WHERE json_extract(j.value,'$.id')=?4)`),
      collect("decision", `SELECT id FROM assistant_shadow_decisions t WHERE ${namespace("t")} AND t.job_id IN (${refs("job")})`),
      collect("command", `SELECT operation_id AS id FROM assistant_owner_commands t WHERE ${namespace("t")} AND (
         (json_extract(t.result_json,'$.kind') LIKE 'source.%' AND json_extract(t.result_json,'$.id')=?4)
         OR (json_extract(t.result_json,'$.kind') LIKE 'mission.%' AND (json_extract(t.result_json,'$.id') IN (${refs("mission")}) OR json_array(json_extract(t.result_json,'$.id'),json_extract(t.result_json,'$.revision')) IN (${refs("mission_version")})))
         OR (json_extract(t.result_json,'$.kind') LIKE 'fup.%' AND json_extract(t.result_json,'$.id') IN (${refs("fup")})))
       UNION SELECT t.command_operation_id FROM assistant_fup_provenance t JOIN assistant_owner_commands c ON c.installation_id=t.installation_id AND c.generation=t.generation AND c.operation_id=t.command_operation_id
         WHERE ${namespace("t")} AND t.fup_id IN (${refs("fup")}) AND json_extract(c.result_json,'$.kind') LIKE 'fup.%' AND json_extract(c.result_json,'$.id')=t.fup_id`),
      collect("object", `SELECT original_object_key AS id FROM assistant_source_versions t WHERE ${namespace("t")} AND t.source_id=?4`),
      ...(routines ? [collect("routine", `SELECT id FROM assistant_routine_items t WHERE ${namespace("t")} AND (t.source_id=?4 OR t.job_id IN (${refs("job")}) OR t.run_id IN (${refs("run")}) OR EXISTS(SELECT 1 FROM json_each(t.index_sources_json) j WHERE json_extract(j.value,'$.id')=?4))`)] : []),
      ...(routines ? [collect("run", `SELECT run_id AS id FROM assistant_routine_items t WHERE ${namespace("t")} AND t.id IN (${refs("routine")})`), collect("job", `SELECT job_id AS id FROM assistant_routine_items t WHERE ${namespace("t")} AND t.id IN (${refs("routine")})`)] : []),
    ];
    const observed = await this.db.batch(collection());
    if (observed.some(result => result.meta.changes > 0)) return { state: "pending", reason: "collecting_closure", logicalBlock: "withdrawn", d1: "pending", r2: "pending", externalCopies: "pending" };
    const count = await sql(`SELECT COUNT(*) FROM assistant_retention_purge_refs WHERE installation_id=?1 AND generation=?2 AND purge_id=?3 AND ?4 IS NOT NULL`).first<number>("COUNT(*)");
    // Known paid usage must have an exact financial reservation before its body
    // receipt disappears. Unknown attempts retain their entire reserved ceiling.
    const paid = `SELECT operation_key,request_hash,actual_units FROM assistant_model_receipts t WHERE ${namespace("t")} AND operation_key IN (${refs("model")})
      UNION ALL SELECT operation_key,request_hash,actual_units FROM assistant_media_receipts t WHERE ${namespace("t")} AND t.source_id=?4`;
    const financialInvalid = `EXISTS(SELECT 1 FROM (${paid}) p LEFT JOIN assistant_budget_reservations r ON r.installation_id=?1 AND r.generation=?2 AND r.operation_key=p.operation_key WHERE p.actual_units IS NOT NULL AND (r.operation_key IS NULL OR r.request_hash IS NOT p.request_hash OR (r.state='settled' AND r.actual_units IS NOT p.actual_units)))`;
    const del = (table: string, condition: string) => sql(`DELETE FROM ${table} AS t WHERE ${namespace("t")} AND (${condition}) AND ${gate}`);
    const sameSource = "t.source_id=?4", jobs = `t.job_id IN (${refs("job")})`, episodes = `SELECT id FROM assistant_episodes e WHERE ${namespace("e")} AND e.job_id IN (${refs("job")})`;
    const restoreToken = crypto.randomUUID(), restoreGuard = this.restoreGate ? "EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=?1 AND state='quiescing' AND token=?6 AND operation_id=?7 AND target_generation=?8 AND target_generation=?2)" : "1";
    const restoreGrants = this.restoreGate ? [...canonicalSnapshotTables].flatMap(table => ["update", "delete"].map(action => this.db.prepare(`INSERT INTO assistant_retention_restore_grants SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND operation_id=? AND target_generation=? AND state='quiescing')`).bind(...args.slice(0, 2), restoreToken, this.restoreGate!.token, table, action, this.scope.installationId, this.restoreGate!.token, this.restoreGate!.operationId, this.scope.generation))) : [];
    const statements = [...collection(), ...restoreGrants,
      sql(`INSERT INTO assistant_retention_purge_grants SELECT ?1,?2,?4,?3 WHERE (SELECT COUNT(*) FROM assistant_retention_purge_refs WHERE installation_id=?1 AND generation=?2 AND purge_id=?3)=?5 AND NOT(${financialInvalid}) AND EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=?1 AND generation=?2 AND id=?4 AND status='withdrawn') AND (${restoreGuard}) ON CONFLICT DO NOTHING`, [count]),
      sql(`UPDATE assistant_budget_reservations AS r SET state='settled',actual_units=(SELECT p.actual_units FROM (${paid}) p WHERE p.operation_key=r.operation_key AND p.request_hash=r.request_hash AND p.actual_units IS NOT NULL LIMIT 1)
       WHERE ${namespace("r")} AND r.state IN ('reserved','uncertain') AND EXISTS(SELECT 1 FROM (${paid}) p WHERE p.operation_key=r.operation_key AND p.request_hash=r.request_hash AND p.actual_units IS NOT NULL) AND ${gate}`),
      sql(`UPDATE assistant_budget_reservations AS r SET state='uncertain' WHERE ${namespace("r")} AND r.state='reserved' AND (r.operation_key IN (${refs("model")}) OR r.operation_key IN (SELECT operation_key FROM assistant_media_receipts t WHERE ${namespace("t")} AND t.source_id=?4)) AND ${gate}`),
      sql(`UPDATE assistant_budget_accounts AS a SET blocked=1 WHERE ${namespace("a")} AND EXISTS(SELECT 1 FROM assistant_budget_reservations r WHERE ${namespace("r")} AND r.period=a.period AND r.state='settled' AND r.actual_units>r.ceiling_units) AND ${gate}`),
      del("assistant_telegram_reviews", `t.notification_id IN (SELECT id FROM assistant_telegram_notifications n WHERE ${namespace("n")} AND n.decision_id IN (${refs("decision")}))`),
      del("assistant_telegram_notifications", `t.decision_id IN (${refs("decision")})`), del("assistant_telegram_read_admissions", `t.decision_id IN (${refs("decision")})`),
      del("assistant_shadow_decisions", `t.id IN (${refs("decision")})`), del("assistant_decision_jobs", jobs),
      del("assistant_episode_calls", `t.episode_id IN (${episodes})`), del("assistant_episodes", jobs), del("assistant_job_receipts", jobs), del("assistant_job_ledger", jobs), del("assistant_jobs", `t.id IN (${refs("job")})`),
      del("assistant_fup_provenance", `t.fup_id IN (${refs("fup")})`), del("assistant_fup_occurrences", `t.follow_up_id IN (${refs("fup")})`), del("assistant_follow_ups", `t.id IN (${refs("fup")})`), del("assistant_mission_versions", `t.id IN (${refs("mission")}) OR json_array(t.id,t.revision) IN (${refs("mission_version")})`), del("assistant_missions", `t.id IN (${refs("mission")})`),
      del("assistant_owner_commands", `t.operation_id IN (${refs("command")})`),
      del("assistant_retrieval_items", `t.run_id IN (${refs("run")})`), del("assistant_retrieval_steps", `t.run_id IN (${refs("run")})`), del("assistant_retrieval_semantic", `t.run_id IN (${refs("run")})`), del("assistant_retrieval_runs", `t.id IN (${refs("run")})`),
      del("assistant_relation_batches", sameSource), del("assistant_model_permits", sameSource), del("assistant_model_receipts", `t.operation_key IN (${refs("model")})`), del("assistant_media_artifacts", sameSource), del("assistant_media_receipts", sameSource), del("assistant_origin_versions", "t.canonical_id=?4"),
      ...(catalog.some(row => row.name === "assistant_retention_restored_work") ? [del("assistant_retention_restored_work", `t.source_id=?4 OR (t.kind='mission' AND t.id IN (${refs("mission")})) OR (t.kind='follow_up' AND t.id IN (${refs("fup")}))`)] : []),
      ...(routines ? [sql(`UPDATE assistant_routine_state AS t SET paused=1,state='uncertain',last_gap='retention_purged' WHERE ${namespace("t")} AND t.active_item_id IN (${refs("routine")}) AND ${gate}`), sql(`UPDATE assistant_routine_cycles AS t SET state='uncertain',last_gap='retention_purged' WHERE ${namespace("t")} AND t.active_item_id IN (${refs("routine")}) AND ${gate}`),
        del("assistant_routine_ingestions", `t.source_id=?4 OR t.item_id IN (${refs("routine")})`), del("assistant_routine_items", `t.id IN (${refs("routine")})`), sql(`UPDATE assistant_routine_event_items AS t SET item_id=NULL,outcome='retention_purged' WHERE ${namespace("t")} AND t.item_id IN (${refs("routine")}) AND ${gate}`), del("assistant_routine_fup_results", `t.follow_up_id IN (${refs("fup")})`)] : []),
      sql(`UPDATE assistant_sources SET current_version=NULL,title=NULL,conversation_id=NULL,project_id=NULL WHERE installation_id=?1 AND generation=?2 AND id=?4 AND status='withdrawn' AND ${gate}`),
      del("assistant_source_versions", sameSource),
      sql(`UPDATE assistant_retention_purges SET state='complete',report_json=json_object('state','complete','logicalBlock','withdrawn','d1','purged','d1Scope','current_namespace_source_closure','otherGenerations','pending','financial','preserved_installation_all_generations','r2','pending','externalCopies','pending','externalIndex','pending','retained','source_tombstone_and_financial_and_owner_assessment_metadata','identifiers','retained_metadata_not_anonymized','closureRefs',(SELECT COUNT(*) FROM assistant_retention_purge_refs WHERE installation_id=?1 AND generation=?2 AND purge_id=?3)) WHERE installation_id=?1 AND generation=?2 AND operation_id=?3 AND source_id=?4 AND ${gate}`),
      sql(`DELETE FROM assistant_retention_purge_grants WHERE installation_id=?1 AND generation=?2 AND source_id=?4 AND purge_id=?3`),
      ...(this.restoreGate ? [this.db.prepare("DELETE FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND gate_token=?").bind(this.scope.installationId, this.scope.generation, restoreToken, this.restoreGate.token)] : []),
    ];
    try { await this.db.batch(statements); }
    catch { const receipt = await read(); if (receipt?.state === "complete" && receipt.request_hash === hash) return JSON.parse(receipt.report_json!); throw new Error("retention_purge_uncertain"); }
    const receipt = await read();
    return receipt?.state === "complete" ? JSON.parse(receipt.report_json!) : { state: "pending", reason: "closure_changed_or_financial_proof_missing", logicalBlock: "withdrawn", d1: "pending", r2: "pending", externalCopies: "pending" };
  }
}
