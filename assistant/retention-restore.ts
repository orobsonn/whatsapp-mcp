import { z } from "zod";
import { SourceAccess, type TrustedActor } from "./access";
import { CommandLedger } from "./command-ledger";
import { SourceController, sourceTextHash, type SourceScope } from "./sources";
import { bridgeHash } from "./ingress";
import { WithdrawalBarrier } from "./retention-barrier";
import { RetentionPurge } from "./retention-purge";
import { retirementKeys, type RetirementAuthorityPort, type SourceRetirementGuard } from "./retention-authority";
import { restoreCommand, type ProvenRestoreRow, type RestoreSourcePair } from "./retention-restore-contract";
import { canonicalSnapshotTables, financialTables, verifyManifest, type SnapshotManifest, type SnapshotRecord } from "./retention-snapshot-contract";
import { verifySnapshotMembership } from "./retention-membership";
import { namespaceOccupied } from "./retention-namespace";
import { financialStart, financialStep, type FinancialCursor } from "./retention-financial";
import { OriginGuard, type SnapshotReader, type OriginRef } from "./origin-guard";
import { CaptureMaterializer } from "./materialize";
import { receiveCapture } from "./ingress";
import { AssistantExport } from "./retention";
import type { SnapshotAuthorityPort } from "./retention-snapshot";
import type { RestoreTicket } from "./retention-snapshot-authority";
type Value = string | number | null;
export interface RestoreAuthorityPort extends SnapshotAuthorityPort, RetirementAuthorityPort {
  restoreTicket(operationId: string): Promise<RestoreTicket | null>;
  reserveRestore(input: { operationId: string; sourceOperationId: string; snapshotSeal: string; targetGeneration: string; currentGeneration: string; quiescenceToken: string }): Promise<RestoreTicket>;
}
type Session = { snapshot_seal: string; ticket_hash: string; token: string; request_hash: string; manifest_json: string; state: string; report_json: string | null; expected_rows: number; progress_json: string; released: number; catchup_cursor: number; activation_json: string };
type Gate = { token: string; operation_id: string; request_hash: string; generation: string; state: string; target_generation: string | null; mutation_revision: number; financial_revision: number };
type Progress = { phase: "mirror" | "sources" | "rows" | "finance" | "ready"; after?: [string, string] | null; sourceAfter?: string | null; rowAfter?: number; chain?: string; count?: number; skipped?: number; missing?: number; mutation?: number; financial?: number; finance?: FinancialCursor };
type Receipt = { leaf_index: number; table_name: string; source_row: number; source_hash: string; source_id: string | null; state: string };
const label = z.string().min(1).max(256), positive = z.number().int().positive().safe();
/** Canonical import into a fresh, inactive generation in the SAME live D1.
 * Every row has external-snapshot membership before any SQL write; #37 is read
 * and preserved, never imported. No runtime activation or effect latch exists. */
export class CanonicalRestore {
  private readonly source: SourceScope; private readonly target: SourceScope; private readonly actor: TrustedActor; private readonly capture: Readonly<{ sourceEpoch: string; sourceGeneration: string }>;
  private columns = new Map<string, string[]>();
  constructor(private readonly db: D1Database, scope: SourceScope, targetGeneration: string, actor: TrustedActor, private readonly authority: RestoreAuthorityPort, private readonly retirement: SourceRetirementGuard,
    capture: { sourceEpoch: string; sourceGeneration: string }, private readonly clock = Date.now, private readonly origin?: OriginGuard, private readonly captureBinding?: { reader: SnapshotReader; secret: string }, private readonly activation?: { externalSeal: string; shadow: boolean }) {
    this.source = Object.freeze({ installationId: label.parse(scope.installationId), generation: label.parse(scope.generation) });
    this.target = Object.freeze({ installationId: scope.installationId, generation: label.parse(targetGeneration) }); this.actor = Object.freeze({ ...actor }); this.capture = Object.freeze({ ...capture });
  }
  private keys() { return [this.target.installationId, this.target.generation]; }
  private sql(query: string, ...values: Value[]) { return this.db.prepare(query).bind(...values); }
  private session(operationId: string) { return this.sql("SELECT * FROM assistant_retention_restore_sessions WHERE installation_id=? AND generation=? AND operation_id=?", ...this.keys(), operationId).first<Session>(); }
  private gate() { return this.sql("SELECT * FROM assistant_retention_installation_gate WHERE installation_id=?", this.target.installationId).first<Gate>(); }
  private own(gate: Gate | null, operationId: string, token: string) { if (!gate || gate.state !== "quiescing" || gate.operation_id !== operationId || gate.token !== token || gate.target_generation !== this.target.generation) throw new Error("restore_quiescence_lost"); return gate; }
  private rowReceipt(operationId: string, index: number) { return this.sql("SELECT * FROM assistant_retention_restore_rows WHERE installation_id=? AND generation=? AND operation_id=? AND leaf_index=?", ...this.keys(), operationId, index).first<Receipt>(); }
  private async requireSession(operationId: string) {
    const session = await this.session(operationId); if (!session) throw new Error("restore_not_prepared");
    const ticket = await this.authority.restoreTicket(operationId); if (!ticket || ticket.hash !== session.ticket_hash || ticket.targetGeneration !== this.target.generation || ticket.snapshotSeal !== session.snapshot_seal || ticket.quiescenceToken !== session.token) throw new Error("restore_authority_required");
    return { session, manifest: await verifyManifest(JSON.parse(session.manifest_json)), ticket };
  }
  async execute(raw: unknown): Promise<unknown> {
    if (this.actor.kind !== "owner") throw new Error("owner_required");
    // A source/current-version pair can contain three bounded canonical rows.
    // The private operator accepts one row only, never a batch of bodies.
    const serialized = JSON.stringify(raw); if (!serialized || new TextEncoder().encode(serialized).length > 16777216) throw new Error("restore_request_limit");
    const command = restoreCommand.parse(JSON.parse(serialized));
    if (command.kind === "restore.begin") return this.begin(command.operationId, command.manifest);
    if (command.kind === "restore.row") return this.apply(command.operationId, command.row, command.source);
    if (command.kind === "restore.finish") return this.finish(command.operationId);
    if (command.kind === "restore.advance") return this.advance(command.operationId);
    if (command.kind === "restore.pause") return this.pause(command.operationId);
    if (command.kind === "restore.resume") return this.resume(command.operationId);
    if (command.kind === "restore.release") return this.release(command.operationId);
    if (command.kind === "restore.catchup") return this.catchup(command.operationId);
    if (command.kind === "restore.activate_generation") return this.activate(command);
    if (command.kind === "restore.reprove_source") return this.reproveSource(command.operationId, command.sourceId, command.revision);
    if (command.kind === "restore.bind_identity") return this.bindIdentity(command);
    if (command.kind === "restore.status") {
      const session = await this.session(command.operationId), gate = await this.gate();
      if (!session) return { state: gate?.operation_id === command.operationId && gate.target_generation === this.target.generation ? "preparing_gate" : "absent", operationId: command.operationId, execution: "inactive" };
    }
    const { session } = await this.requireSession(command.operationId);
    return { state: session.state, operationId: command.operationId, targetGeneration: this.target.generation, ...(session.report_json ? { report: JSON.parse(session.report_json) } : {}) };
  }
  private async mirrorPage(after: [string, string] | null, operationId: string, session: Session) {
    const rows = (await this.sql(`SELECT generation,id FROM assistant_sources WHERE installation_id=? AND status='withdrawn' ${after ? "AND (generation,id)>(?,?)" : ""} ORDER BY generation,id LIMIT 8`, this.target.installationId, ...(after ?? [])).all<{ generation: string; id: string }>()).results;
    for (const row of rows) {
      await new WithdrawalBarrier(this.db, { installationId: this.target.installationId, generation: row.generation }, this.retirement).adopt(row.id, this.clock());
      if (row.generation === this.target.generation) {
        const purge = await new RetentionPurge(this.db, this.target, this.actor, this.clock, this.retirement, { token: session.token, operationId, targetGeneration: this.target.generation }).advance({ kind: "source.purge", operationId: "restore-filter:" + await bridgeHash([operationId, row.id]), sourceId: row.id });
        if (purge.state !== "complete") return { after, done: false };
        await this.sql("UPDATE assistant_retention_restore_rows SET state='skipped_retired' WHERE installation_id=? AND generation=? AND operation_id=? AND source_id=?", ...this.keys(), operationId, row.id).run();
      }
    }
    return { after: rows.length ? [rows.at(-1)!.generation, rows.at(-1)!.id] as [string, string] : after, done: rows.length < 8 };
  }
  private async begin(operationId: string, raw: unknown) {
    const manifest = await verifyManifest(raw), requestHash = await bridgeHash(["canonical-restore-v1", operationId, manifest.seal, this.source, this.target]), prior = await this.session(operationId);
    if (manifest.namespace.installationId !== this.source.installationId) throw new Error("restore_installation_affinity");
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("restore_operation_conflict"); await this.requireSession(operationId); return { state: prior.state, operationId, targetGeneration: this.target.generation }; }
    const snapshot = await this.authority.snapshotReceipt(manifest.operationId);
    if (!snapshot || snapshot.seal !== manifest.seal || snapshot.generation !== manifest.namespace.generation) throw new Error("restore_snapshot_authority_required");
    if (this.target.generation === this.source.generation || this.target.generation === manifest.namespace.generation) throw new Error("restore_new_external_generation_required");
    // Incompatibility is known before any freeze or external reservation.
    const metadata = await new AssistantExport(this.db, manifest.namespace, this.actor, "canonical_snapshot_candidate").snapshotMetadata();
    if (metadata.schemaHash !== manifest.schemaHash) throw new Error("restore_schema_adapter_required");
    const existingTicket = await this.authority.restoreTicket(operationId), priorGate = await this.gate();
    if (!existingTicket && await namespaceOccupied(this.db, this.target)) throw new Error("restore_generation_occupied");
    const matchingGate = priorGate?.operation_id === operationId && priorGate.request_hash === requestHash && priorGate.generation === this.source.generation && priorGate.target_generation === this.target.generation;
    if (priorGate?.state === "quiescing" && !matchingGate) throw new Error("restore_quiescence_owned_by_other_operation");
    const token = existingTicket?.quiescenceToken ?? (matchingGate ? priorGate!.token : crypto.randomUUID());
    try { await this.sql(`INSERT INTO assistant_retention_installation_gate(installation_id,generation,operation_id,request_hash,token,state,target_generation,started_at) VALUES(?,?,?,?,?,'quiescing',?,?)
      ON CONFLICT(installation_id) DO UPDATE SET generation=excluded.generation,operation_id=excluded.operation_id,request_hash=excluded.request_hash,token=excluded.token,state='quiescing',target_generation=excluded.target_generation,started_at=excluded.started_at WHERE assistant_retention_installation_gate.state='idle'`, this.source.installationId, this.source.generation, operationId, requestHash, token, this.target.generation, this.clock()).run(); }
    catch { this.own(await this.gate(), operationId, token); }
    const gate = this.own(await this.gate(), operationId, token);
    const ticket = await this.authority.reserveRestore({ operationId, sourceOperationId: manifest.operationId, snapshotSeal: manifest.seal, targetGeneration: this.target.generation, currentGeneration: this.source.generation, quiescenceToken: gate.token });
    await this.sql(`INSERT INTO assistant_retention_restore_sessions(installation_id,generation,operation_id,source_generation,snapshot_seal,ticket_hash,token,request_hash,manifest_json,state,expected_rows,created_at,progress_json)
      SELECT ?,?,?,?,?,?,?,?,?,'preparing',?,?,? WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND target_generation=? AND state='quiescing') ON CONFLICT DO NOTHING`,
      ...this.keys(), operationId, manifest.namespace.generation, manifest.seal, ticket.hash, gate.token, requestHash, JSON.stringify(manifest), manifest.rowCount, this.clock(), JSON.stringify({ phase: "mirror", after: null }), this.target.installationId, gate.token, this.target.generation).run();
    if (!(await this.session(operationId))) throw new Error("restore_begin_uncertain");
    return this.advance(operationId);
  }
  private async verified(manifest: SnapshotManifest, row: ProvenRestoreRow) {
    if (await bridgeHash(row.record.value) !== row.record.hash || row.record.value.installation_id !== this.source.installationId || (!financialTables.has(row.record.table) && row.record.value.generation !== manifest.namespace.generation)) throw new Error("restore_row_hash_or_namespace");
    await verifySnapshotMembership(manifest, row.record, row.proof); return row.record;
  }
  private async pair(manifest: SnapshotManifest, pair: RestoreSourcePair) {
    const header = await this.verified(manifest, pair.header), source = header.value;
    if (header.table !== "assistant_sources" || !["owner_note", "whatsapp"].includes(String(source.origin)) || typeof source.origin_key !== "string" || typeof source.id !== "string" || !["active", "withdrawn"].includes(String(source.status))) throw new Error("restore_source_header");
    positive.parse(source.revision);
    if (source.status === "active") {
      positive.parse(source.current_version);
      if (!pair.current) throw new Error("restore_current_version_missing"); const current = await this.verified(manifest, pair.current);
      if (current.table !== "assistant_source_versions" || current.value.source_id !== source.id || current.value.version !== source.current_version) throw new Error("restore_current_version_mismatch"); await this.content(current);
    }
    return header;
  }
  private async content(record: SnapshotRecord) {
    if (record.table !== "assistant_source_versions") return; positive.parse(record.value.version);
    if (typeof record.value.original_text === "string") { if (await sourceTextHash(record.value.original_text) !== record.value.content_hash) throw new Error("restore_source_content_hash"); }
    else if (record.value.original_text !== null || typeof record.value.original_object_key !== "string") throw new Error("restore_source_content");
  }
  private async retired(header: SnapshotRecord) {
    const source = header.value, keys = await retirementKeys(this.target.installationId, String(source.origin), String(source.origin_key), String(source.id));
    const local = await this.sql(`SELECT 1 FROM assistant_sources WHERE installation_id=? AND status='withdrawn' AND (id=? OR (origin=? AND origin_key=?)) UNION SELECT 1 FROM assistant_retention_barriers WHERE installation_id=? AND (source_id=? OR (origin=? AND origin_key=?)) LIMIT 1`,
      this.target.installationId, String(source.id), String(source.origin), String(source.origin_key), this.target.installationId, String(source.id), String(source.origin), String(source.origin_key)).first();
    const external = await this.authority.lookup(this.target.installationId, keys); if (external.state !== "sealed") throw new Error("retention_authority_unavailable");
    return source.status === "withdrawn" || !!local || external.blocked.length > 0;
  }
  private async retireTarget(operationId: string, session: Session, header: SnapshotRecord) {
    const source = header.value, id = String(source.id), current = await this.sql("SELECT revision,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?", ...this.keys(), id).first<{ revision: number; status: string }>();
    if (current?.status === "active") await new SourceController(this.db, this.target, this.actor, this.clock, this.retirement).withdraw(id, current.revision);
    else if (current) await new WithdrawalBarrier(this.db, this.target, this.retirement).adopt(id, this.clock());
    else {
      const hash = await bridgeHash(["restore-retirement-v1", session.ticket_hash, header.hash]), op = "restore-filter:" + operationId;
      await this.sql(`INSERT INTO assistant_retention_barriers SELECT ?,?,?,?,?,?,?,?,?,?,'pending_withdraw','pending',? WHERE NOT EXISTS(SELECT 1 FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=?)`, ...this.keys(), id, String(source.origin), String(source.origin_key), Number(source.revision), Number(source.current_version ?? 0), op, hash, session.token, this.clock(), ...this.keys(), id).run();
      await this.retirement.withdraw(String(source.origin), String(source.origin_key), id);
      await this.sql("UPDATE assistant_retention_barriers SET state='retired',external_state='recorded' WHERE installation_id=? AND generation=? AND source_id=?", ...this.keys(), id).run();
    }
    if (current) {
      const service = new RetentionPurge(this.db, this.target, this.actor, this.clock, this.retirement, { token: session.token, operationId, targetGeneration: this.target.generation });
      const result = await service.advance({ kind: "source.purge", operationId: "restore-filter:" + await bridgeHash([operationId, id]), sourceId: id });
      if (result.state !== "complete") return false;
      await this.sql("UPDATE assistant_retention_restore_rows SET state='skipped_retired' WHERE installation_id=? AND generation=? AND operation_id=? AND source_id=?", ...this.keys(), operationId, id).run();
    }
    return true;
  }
  private grant(table: string, action: "insert" | "update", operationId: string, token: string, attempt: string) {
    return this.sql(`INSERT INTO assistant_retention_restore_grants SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND operation_id=? AND token=? AND target_generation=? AND state='quiescing')
      AND EXISTS(SELECT 1 FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND table_name='restore_row_admission' AND action='insert') ON CONFLICT DO NOTHING`, ...this.keys(), attempt, token, table, action, this.target.installationId, operationId, token, this.target.generation, ...this.keys(), attempt);
  }
  private async statement(table: string, value: Record<string, unknown>, grantToken: string) {
    if (!canonicalSnapshotTables.has(table)) throw new Error("restore_table_adapter_required");
    let columns = this.columns.get(table);
    if (!columns) { columns = (await this.db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()).results.map(row => row.name); this.columns.set(table, columns); }
    if (columns.length !== Object.keys(value).length || Object.keys(value).some(key => !columns!.includes(key)) || Object.values(value).some(item => item !== null && typeof item !== "string" && typeof item !== "number")) throw new Error("restore_column_adapter_required");
    const data = { ...value, installation_id: this.target.installationId, generation: this.target.generation };
    return this.sql(`INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.map(() => "?").join(",")} WHERE EXISTS(SELECT 1 FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND table_name=? AND action='insert')`, ...columns.map(column => data[column as keyof typeof data] as Value), ...this.keys(), grantToken, table);
  }
  private async existing(table: string, value: Record<string, unknown>) {
    const metadata = (await this.db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string; pk: number }>()).results, keys = metadata.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => row.name);
    if (!keys.length) throw new Error("restore_table_adapter_required");
    const target = { ...value, installation_id: this.target.installationId, generation: this.target.generation };
    const row = await this.sql(`SELECT * FROM ${table} WHERE ${keys.map(key => `${key} IS ?`).join(" AND ")}`, ...keys.map(key => target[key as keyof typeof target] as Value)).first<Record<string, unknown>>();
    if (!row) return false;
    if (Object.keys(target).some(key => row[key] !== target[key as keyof typeof target])) throw new Error("restore_existing_row_conflict"); return true;
  }
  private async financial(record: SnapshotRecord) {
    const value = record.value, fields = record.table === "assistant_budget_accounts" ? ["installation_id", "generation", "period"] : ["installation_id", "generation", "operation_key"];
    if (fields.some(field => typeof value[field] !== "string")) return false;
    const row = await this.sql(`SELECT rowid AS __live_row,* FROM ${record.table} WHERE ${fields.map(field => `${field}=?`).join(" AND ")}`, ...fields.map(field => value[field] as string)).first<Record<string, unknown>>();
    if (!row || row.__live_row !== record.row) return false;
    if (record.table === "assistant_budget_accounts") return row.cap_units === value.cap_units && !(value.blocked === 1 && row.blocked !== 1);
    return ["period", "request_hash", "ceiling_units"].every(field => row[field] === value[field]) && (value.state === "settled" ? row.state === "settled" && row.actual_units === value.actual_units : value.state === "uncertain" ? ["uncertain", "settled"].includes(String(row.state)) : ["reserved", "uncertain", "settled"].includes(String(row.state)));
  }
  private async apply(operationId: string, proven: ProvenRestoreRow, pair?: RestoreSourcePair) {
    const { session, manifest } = await this.requireSession(operationId), record = await this.verified(manifest, proven), previous = await this.rowReceipt(operationId, proven.proof.index);
    if (previous && (previous.table_name !== record.table || previous.source_row !== record.row || previous.source_hash !== record.hash)) throw new Error("restore_row_conflict");
    if (previous && previous.state !== "financial_missing") return { state: previous.state, leaf: proven.proof.index, execution: "inactive" };
    if (session.state !== "importing" && !(session.state === "budget_blocked" && previous?.state === "financial_missing")) throw new Error("restore_not_importing"); this.own(await this.gate(), operationId, session.token);
    const attempt = crypto.randomUUID(), statements: D1PreparedStatement[] = [this.sql(`INSERT INTO assistant_retention_restore_grants SELECT ?,?,?,?,'restore_row_admission','insert'
      WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND operation_id=? AND token=? AND target_generation=? AND state='quiescing')
      AND EXISTS(SELECT 1 FROM assistant_retention_restore_sessions WHERE installation_id=? AND generation=? AND operation_id=? AND token=? AND state=?)`, ...this.keys(), attempt, session.token, this.target.installationId, operationId, session.token, this.target.generation, ...this.keys(), operationId, session.token, session.state)]; let state = "imported", sourceId: string | null = null;
    let header: SnapshotRecord | undefined;
    if (pair) { header = await this.pair(manifest, pair); sourceId = String(header.value.id); }
    let declared = record.table === "assistant_sources" ? record.value.id : record.value.canonical_id ?? record.value.source_id ?? record.value.proof_source_id;
    if (record.table === "assistant_fup_provenance") declared = JSON.parse(String(record.value.body_json))?.source?.id;
    if (record.table === "assistant_mission_versions") declared = JSON.parse(String(record.value.body_json))?.sourceId;
    if (declared !== undefined && (!header || declared !== sourceId)) throw new Error("restore_source_pair_required");
    if (header && await this.retired(header)) {
      if (!await this.retireTarget(operationId, session, header)) return { state: "pending", reason: "retirement_cleanup", leaf: proven.proof.index };
      state = "skipped_retired";
    } else if (financialTables.has(record.table)) state = await this.financial(record) ? "financial_live_verified" : "financial_missing";
    else {
      const write = async (table: string, value: Record<string, unknown>) => { if (!await this.existing(table, value)) { statements.push(this.grant(table, "insert", operationId, session.token, attempt), await this.statement(table, value, attempt)); } };
      if (header && pair?.current) { await write("assistant_sources", header.value); await write("assistant_source_versions", pair.current.record.value); }
      await this.content(record);
      const value = { ...record.value };
      if (record.table === "assistant_missions" && !["resolved", "cancelled"].includes(String(value.state))) { value.state = "paused"; value.next_evaluation_at = null; }
      if (record.table === "assistant_follow_ups" && !["closed", "cancelled"].includes(String(value.state))) value.state = "paused";
      if (record.table === "assistant_mandates" && value.status === "active") value.status = "draft";
      if (record.table === "assistant_origin_conversations") value.access_state = "unknown";
      if (record.table === "assistant_fup_provenance") {
        const body = JSON.parse(String(value.body_json)), history = { installation_id: this.target.installationId, generation: this.target.generation, kind: "follow_up", id: value.fup_id, version: value.version, source_id: sourceId, snapshot_seal: manifest.seal, source_generation: manifest.namespace.generation, original_command_id: value.command_operation_id, body_json: JSON.stringify(body) };
        await write("assistant_retention_restored_work", history); state = "historical_work";
      } else if (record.table === "assistant_sources") { if (!header || header.hash !== record.hash) throw new Error("restore_source_header_mismatch"); }
      else if (record.table === "assistant_source_versions" && pair?.current?.record.value.version === record.value.version) { if (pair.current.record.hash !== record.hash) throw new Error("restore_current_version_mismatch"); }
      else await write(record.table, value);
      const quarantine = async (kind: string, key: unknown[], fields: { source?: string; provider?: string; address?: string; mandate?: string; conversation?: string; version: number }) => {
        statements.push(this.sql(`INSERT INTO assistant_retention_quarantines SELECT ?,?,?,?,?,?,?,?,?,?,1,'snapshot_reproof_required',? WHERE EXISTS(SELECT 1 FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND table_name='restore_row_admission' AND action='insert') ON CONFLICT DO NOTHING`, ...this.keys(), kind, await bridgeHash(key), fields.source ?? null, fields.provider ?? null, fields.address ?? null, fields.mandate ?? null, fields.conversation ?? null, fields.version, manifest.seal, ...this.keys(), attempt));
      };
      if (header?.value.origin === "whatsapp") await quarantine("origin_source", [sourceId], { source: sourceId!, version: Number(header.value.revision) });
      if (record.table === "assistant_provider_identities") await quarantine("provider_identity", [value.provider, value.address], { source: String(value.proof_source_id), provider: String(value.provider), address: String(value.address), version: Number(value.proof_source_revision) });
      if (record.table === "assistant_mandates") await quarantine("mandate", [value.id], { mandate: String(value.id), version: Number(value.version) });
      if (record.table === "assistant_conversation_policies") await quarantine("policy", [value.conversation_id], { conversation: String(value.conversation_id), version: Number(value.revision) });
    }
    statements.push(this.sql(`INSERT INTO assistant_retention_restore_rows SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND table_name='restore_row_admission' AND action='insert') ON CONFLICT(installation_id,generation,operation_id,leaf_index) DO UPDATE SET state=excluded.state WHERE assistant_retention_restore_rows.state='financial_missing' AND assistant_retention_restore_rows.source_hash=excluded.source_hash`, ...this.keys(), operationId, proven.proof.index, record.table, record.row, record.hash, sourceId, state, ...this.keys(), attempt));
    statements.push(this.sql("DELETE FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=?", ...this.keys(), attempt));
    try { await this.db.batch(statements); }
    catch { const observed = await this.rowReceipt(operationId, proven.proof.index); if (!observed || observed.source_hash !== record.hash) throw new Error("restore_row_uncertain"); }
    const saved = await this.rowReceipt(operationId, proven.proof.index); if (!saved || saved.source_hash !== record.hash) throw new Error("restore_row_uncertain");
    return { state: saved.state, leaf: proven.proof.index, execution: "inactive" };
  }
  private async finish(operationId: string) {
    const { session, manifest } = await this.requireSession(operationId);
    if (session.report_json && session.state === "inactive_complete") return JSON.parse(session.report_json);
    this.own(await this.gate(), operationId, session.token);
    if (session.state !== "finalizing") {
      if (!["importing", "budget_blocked", "blocked"].includes(session.state)) throw new Error("restore_not_importing");
      await this.sql("UPDATE assistant_retention_restore_sessions SET state='finalizing',progress_json=? WHERE installation_id=? AND generation=? AND operation_id=? AND state=?", JSON.stringify({ phase: "mirror", after: null }), ...this.keys(), operationId, session.state).run();
      return this.advance(operationId);
    }
    const progress = JSON.parse(session.progress_json) as Progress;
    if (progress.phase !== "ready") return this.advance(operationId);
    const gate = this.own(await this.gate(), operationId, session.token), finance = progress.finance!;
    if (gate.mutation_revision !== progress.mutation || gate.financial_revision !== progress.financial) return this.restartFinal(operationId, session);
    const missingLive = await this.sql(`SELECT 1 FROM assistant_retention_restore_rows r WHERE r.installation_id=? AND r.generation=? AND r.operation_id=? AND r.state='financial_live_verified'
      AND ((r.table_name='assistant_budget_accounts' AND NOT EXISTS(SELECT 1 FROM assistant_budget_accounts a WHERE a.installation_id=r.installation_id AND a.rowid=r.source_row))
        OR (r.table_name='assistant_budget_reservations' AND NOT EXISTS(SELECT 1 FROM assistant_budget_reservations a WHERE a.installation_id=r.installation_id AND a.rowid=r.source_row))) LIMIT 1`, ...this.keys(), operationId).first();
    const missingFinancial = !!progress.missing || !!missingLive, pending = await this.sql("SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied' AND operation IN ('withdraw','access') LIMIT 1", this.target.installationId).first();
    const epoch = await this.sql("SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND (source_epoch<>? OR source_generation<>?) LIMIT 1", ...this.keys(), this.capture.sourceEpoch, this.capture.sourceGeneration).first();
    if (pending || epoch) return { state: "blocked", reason: pending ? "capture_withdrawal_catchup_required" : "capture_epoch_reproof_required", execution: "inactive", finance: missingFinancial ? "missing_live_history" : "preserved_live_all_generations" };
    const state = missingFinancial ? "budget_blocked" : "inactive_complete", report = { state, operationId, targetGeneration: this.target.generation, mode: "shadow", execution: "inactive", financial: missingFinancial ? "missing_live_history" : "preserved_live_all_generations", budget: "unconfigured_no_account_created", oauth: "credential_generation_unchanged", rows: progress.count!, skippedRetired: progress.skipped!, quarantine: "owner_reproof_required", externalCopies: "pending" };
    const seal = await bridgeHash(["restored-generation-v1", session.ticket_hash, manifest.seal, finance.hash, report]);
    const result = await this.sql(`INSERT INTO assistant_retention_generation_seals SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND operation_id=? AND target_generation=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?)
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied' AND operation IN ('withdraw','access'))
      AND NOT EXISTS(SELECT 1 FROM assistant_sources s JOIN assistant_retention_barriers b ON b.installation_id=s.installation_id AND (b.source_id=s.id OR (b.origin=s.origin AND b.origin_key=s.origin_key)) WHERE s.installation_id=? AND s.generation=? AND s.status='active') ON CONFLICT(installation_id,generation) DO UPDATE SET financial_hash=excluded.financial_hash,state=excluded.state,seal=excluded.seal,created_at=excluded.created_at WHERE assistant_retention_generation_seals.ticket_hash=excluded.ticket_hash AND assistant_retention_generation_seals.snapshot_seal=excluded.snapshot_seal RETURNING seal`,
      ...this.keys(), manifest.seal, session.ticket_hash, finance.hash, state, seal, this.clock(), this.target.installationId, session.token, operationId, this.target.generation, gate.mutation_revision, gate.financial_revision, this.target.installationId, ...this.keys()).first<{ seal: string }>();
    if (!result) return { state: "blocked", reason: "restore_changed_during_final_guard", execution: "inactive" };
    await this.sql("UPDATE assistant_retention_restore_sessions SET state=?,report_json=?,committed_rows=? WHERE installation_id=? AND generation=? AND operation_id=? AND ticket_hash=?", state, JSON.stringify({ ...report, seal }), progress.count!, ...this.keys(), operationId, session.ticket_hash).run();
    return { ...report, seal };
  }
  private async saveProgress(operationId: string, session: Session, progress: Progress, state = session.state) {
    await this.sql(`UPDATE assistant_retention_restore_sessions SET progress_json=?,state=? WHERE installation_id=? AND generation=? AND operation_id=? AND token=? AND progress_json=? AND state=?
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND operation_id=? AND token=? AND target_generation=? AND state='quiescing')`, JSON.stringify(progress), state, ...this.keys(), operationId, session.token, session.progress_json, session.state, this.target.installationId, operationId, session.token, this.target.generation).run();
    const saved = (await this.session(operationId))!;
    return { state: saved.state, phase: (JSON.parse(saved.progress_json) as Progress).phase, operationId, execution: "inactive" };
  }
  private restartFinal(operationId: string, session: Session) { return this.saveProgress(operationId, session, { phase: "mirror", after: null }); }
  private async advance(operationId: string): Promise<unknown> {
    const { session, manifest } = await this.requireSession(operationId), gate = this.own(await this.gate(), operationId, session.token), progress = JSON.parse(session.progress_json) as Progress;
    if (!["preparing", "finalizing"].includes(session.state)) return { state: session.state, operationId, execution: "inactive" };
    if (progress.phase === "mirror") {
      const page = await this.mirrorPage(progress.after ?? null, operationId, session);
      if (!page.done) return this.saveProgress(operationId, session, { phase: "mirror", after: page.after });
      if (session.state === "preparing") return this.saveProgress(operationId, session, { phase: "mirror", after: null }, "importing");
      const current = this.own(await this.gate(), operationId, session.token);
      return this.saveProgress(operationId, session, { phase: "sources", sourceAfter: null, mutation: current.mutation_revision, financial: current.financial_revision });
    }
    if (gate.mutation_revision !== progress.mutation || gate.financial_revision !== progress.financial) return this.restartFinal(operationId, session);
    if (progress.phase === "sources") {
      const rows = (await this.sql("SELECT * FROM assistant_sources WHERE installation_id=? AND generation=? AND status='active' AND (? IS NULL OR id>?) ORDER BY id LIMIT 8", ...this.keys(), progress.sourceAfter ?? null, progress.sourceAfter ?? null).all<Record<string, string | number | null>>()).results;
      for (const value of rows) {
        const header = { table: "assistant_sources", row: 0, hash: await bridgeHash(value), value };
        if (await this.retired(header)) { await this.retireTarget(operationId, session, header); return this.restartFinal(operationId, session); }
      }
      return this.saveProgress(operationId, session, rows.length === 8 ? { ...progress, sourceAfter: String(rows.at(-1)!.id) } : { ...progress, phase: "rows", rowAfter: -1, count: 0, skipped: 0, missing: 0, chain: await bridgeHash(["canonical-snapshot-rows-v1"]) });
    }
    if (progress.phase === "rows") {
      const rows = (await this.sql("SELECT * FROM assistant_retention_restore_rows WHERE installation_id=? AND generation=? AND operation_id=? AND leaf_index>? ORDER BY leaf_index LIMIT 128", ...this.keys(), operationId, progress.rowAfter!).all<Receipt>()).results;
      for (const row of rows) {
        if (row.leaf_index !== progress.count) return { state: "pending", reason: "restore_rows_incomplete", execution: "inactive" };
        progress.chain = await bridgeHash([progress.chain, row.table_name, row.source_row, row.source_hash]); progress.count!++; progress.rowAfter = row.leaf_index;
        if (row.state === "skipped_retired") progress.skipped!++; if (row.state === "financial_missing") progress.missing!++;
      }
      if (rows.length < 128) {
        if (progress.count !== manifest.rowCount) return { state: "pending", reason: "restore_rows_incomplete", execution: "inactive" };
        if (progress.chain !== manifest.rowChain) throw new Error("restore_full_membership_incomplete");
        progress.phase = "finance"; progress.finance = await financialStart(this.target.installationId);
      }
      return this.saveProgress(operationId, session, progress);
    }
    if (progress.phase === "finance") {
      progress.finance = await financialStep(this.db, this.target.installationId, progress.finance!);
      if (progress.finance.done) progress.phase = "ready";
      return this.saveProgress(operationId, session, progress);
    }
    return this.finish(operationId);
  }
  /** Pause releases only canonical writers. It never activates the new
   * namespace, inference or existing jobs; the durable execution hold remains. */
  private async pause(operationId: string) {
    const session = await this.session(operationId), gate = await this.gate();
    if (!gate || gate.operation_id !== operationId || gate.target_generation !== this.target.generation || session && session.token !== gate.token) throw new Error("restore_quiescence_lost");
    const attempt = crypto.randomUUID(), admitted = `EXISTS(SELECT 1 FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND gate_token=? AND table_name='restore_pause_admission' AND action='update')`, pin = [...this.keys(), attempt, gate.token];
    const results = await this.db.batch([
      this.sql(`INSERT INTO assistant_retention_restore_grants SELECT ?,?,?,?,'restore_pause_admission','update' WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND operation_id=? AND token=? AND target_generation=? AND generation=? AND request_hash=? AND state=?)`, ...this.keys(), attempt, gate.token, this.target.installationId, operationId, gate.token, this.target.generation, gate.generation, gate.request_hash, gate.state),
      this.sql(`INSERT INTO assistant_retention_runtime_hold SELECT ?,?,?,1,? WHERE ${admitted} ON CONFLICT(installation_id) DO UPDATE SET operation_id=excluded.operation_id,target_generation=excluded.target_generation,active=1`, this.target.installationId, operationId, this.target.generation, this.clock(), ...pin),
      this.sql(`UPDATE assistant_job_ledger SET state='uncertain' WHERE installation_id=? AND state='attempting' AND ${admitted}`, this.target.installationId, ...pin),
      this.sql(`UPDATE assistant_jobs SET state='cancelled',lease_until=NULL,last_error='restore_runtime_paused' WHERE installation_id=? AND state IN ('pending','processing') AND ${admitted}`, this.target.installationId, ...pin),
      this.sql(`UPDATE assistant_retention_restore_sessions SET state='paused' WHERE installation_id=? AND generation=? AND operation_id=? AND state NOT IN ('inactive_complete','budget_blocked') AND ${admitted}`, ...this.keys(), operationId, ...pin),
      this.sql(`UPDATE assistant_retention_installation_gate SET state='idle' WHERE installation_id=? AND operation_id=? AND token=? AND target_generation=? AND ${admitted}`, this.target.installationId, operationId, gate.token, this.target.generation, ...pin),
      this.sql("DELETE FROM assistant_retention_restore_grants WHERE installation_id=? AND generation=? AND token=? AND gate_token=?", ...pin),
    ]);
    if (results[0].meta.changes !== 1) throw new Error("restore_quiescence_lost");
    return { state: "paused", operationId, canonicalWriters: "released", runtime: "held", generation: "inactive", oauth: "credential_generation_unchanged" };
  }
  private async resume(operationId: string) {
    const { session } = await this.requireSession(operationId), gate = await this.gate();
    if (!await this.sql("SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND operation_id=? AND target_generation=? AND active=1", this.target.installationId, operationId, this.target.generation).first()) throw new Error("restore_paused_reproof_required");
    if (gate?.state === "quiescing" && (gate.operation_id !== operationId || gate.token !== session.token)) throw new Error("restore_quiescence_owned_by_other_operation");
    await this.sql("UPDATE assistant_retention_installation_gate SET state='quiescing',operation_id=?,request_hash=?,token=?,generation=?,target_generation=? WHERE installation_id=? AND state='idle'", operationId, session.request_hash, session.token, this.source.generation, this.target.generation, this.target.installationId).run();
    this.own(await this.gate(), operationId, session.token);
    await this.db.batch([
      this.sql("UPDATE assistant_retention_restore_sessions SET state='preparing',progress_json=?,released=0,activation_json='{}' WHERE installation_id=? AND generation=? AND operation_id=?", JSON.stringify({ phase: "mirror", after: null }), ...this.keys(), operationId),
      this.sql("UPDATE assistant_retention_generation_seals SET state='blocked' WHERE installation_id=? AND generation=? AND ticket_hash=?", ...this.keys(), session.ticket_hash),
    ]);
    return this.advance(operationId);
  }
  private async release(operationId: string) {
    const { session } = await this.requireSession(operationId);
    if (session.state !== "inactive_complete" || !session.report_json) throw new Error("restore_final_seal_required");
    const seal = await this.sql("SELECT seal FROM assistant_retention_generation_seals WHERE installation_id=? AND generation=? AND ticket_hash=? AND state='inactive_complete'", ...this.keys(), session.ticket_hash).first<string>("seal");
    if (!seal || seal !== JSON.parse(session.report_json).seal) throw new Error("restore_final_seal_required");
    if (session.released) return { state: "released_paused", operationId, execution: "held" };
    // Re-run all bounded final checks rather than trusting the interval since
    // finish. The final release batch uses the very same mutation/finance CAS.
    const progress = JSON.parse(session.progress_json) as Progress, gate = this.own(await this.gate(), operationId, session.token);
    if (gate.mutation_revision !== progress.mutation || gate.financial_revision !== progress.financial) {
      await this.sql("UPDATE assistant_retention_restore_sessions SET state='finalizing',progress_json=? WHERE installation_id=? AND generation=? AND operation_id=?", JSON.stringify({ phase: "mirror", after: null }), ...this.keys(), operationId).run();
      return { state: "pending", reason: "release_recheck_required" };
    }
    const guard = `EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND operation_id=? AND token=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?)
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied' AND operation IN ('withdraw','access'))
      AND NOT EXISTS(SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND (source_epoch<>? OR source_generation<>?))`;
    const values = [this.target.installationId, operationId, session.token, progress.mutation!, progress.financial!, this.target.installationId, ...this.keys(), this.capture.sourceEpoch, this.capture.sourceGeneration];
    await this.db.batch([
      this.sql(`INSERT INTO assistant_retention_runtime_hold SELECT ?,?,?,1,? WHERE ${guard} ON CONFLICT(installation_id) DO UPDATE SET operation_id=excluded.operation_id,target_generation=excluded.target_generation,active=1`, this.target.installationId, operationId, this.target.generation, this.clock(), ...values),
      this.sql(`UPDATE assistant_job_ledger SET state='uncertain' WHERE installation_id=? AND state='attempting' AND ${guard}`, this.target.installationId, ...values),
      this.sql(`UPDATE assistant_jobs SET state='cancelled',lease_until=NULL,last_error='restore_runtime_paused' WHERE installation_id=? AND state IN ('pending','processing') AND ${guard}`, this.target.installationId, ...values),
      this.sql(`UPDATE assistant_retention_restore_sessions SET released=1 WHERE installation_id=? AND generation=? AND operation_id=? AND ${guard}`, ...this.keys(), operationId, ...values),
      this.sql(`UPDATE assistant_retention_installation_gate SET state='idle' WHERE installation_id=? AND token=? AND ${guard}`, this.target.installationId, session.token, ...values),
    ]);
    if (!(await this.session(operationId))?.released) return { state: "blocked", reason: "release_guard_changed", execution: "inactive" };
    return { state: "released_paused", operationId, canonicalWriters: "released", execution: "held", oauth: "credential_generation_unchanged" };
  }
  private async reproveSource(operationId: string, sourceId: string, revision: number) {
    const { session } = await this.requireSession(operationId), gate = await this.gate();
    if (!this.origin || gate?.state !== "idle" || !await this.sql("SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1", this.target.installationId).first()) throw new Error("restore_paused_reproof_required");
    // A restored conversation is deliberately unknown. Obtain a current
    // observation without using the SourceAccess query blocked by quarantine.
    const metadata = await this.sql(`SELECT o.source_kind,o.source_id,o.chat_id,o.watermark,o.observation_hash,s.current_version,p.revision AS policy_revision,p.kind,p.effective_mode
      FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
      JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
      WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.canonical_id=? AND o.tombstoned=0 AND s.status='active' AND s.revision=? AND p.effective_mode<>'ignore'`, ...this.keys(), this.capture.sourceEpoch, this.capture.sourceGeneration, sourceId, revision).first<{ source_kind: OriginRef["sourceKind"]; source_id: string; chat_id: string; watermark: number; observation_hash: string; current_version: number; policy_revision: number; kind: string; effective_mode: string }>();
    if (!metadata) throw new Error("restore_origin_reproof_required");
    const currentScope = { ...this.target, ...this.capture }, observed = await this.origin.observe(currentScope, { sourceKind: metadata.source_kind, sourceId: metadata.source_id, chatId: metadata.chat_id });
    if (observed.state !== "available" || observed.hash !== metadata.observation_hash || observed.kind !== metadata.kind || observed.watermark! < metadata.watermark) throw new Error("restore_origin_reproof_required");
    await this.sql(`UPDATE assistant_origin_conversations SET access_state='available',watermark=? WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND chat_id=? AND watermark<=? AND (kind IS NULL OR kind=?) AND access_state<>'withdrawn'
      AND EXISTS(SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND canonical_id=? AND source_epoch=? AND source_generation=? AND source_kind=? AND source_id=? AND chat_id=? AND observation_hash=? AND tombstoned=0)
      AND EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND revision=? AND current_version=? AND status='active')
      AND EXISTS(SELECT 1 FROM assistant_conversation_modes WHERE installation_id=? AND generation=? AND conversation_id=? AND revision=? AND kind=? AND effective_mode=?)
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='idle')
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied')`, observed.watermark, ...this.keys(), this.capture.sourceEpoch, this.capture.sourceGeneration, metadata.chat_id, observed.watermark, observed.kind, ...this.keys(), sourceId, this.capture.sourceEpoch, this.capture.sourceGeneration, metadata.source_kind, metadata.source_id, metadata.chat_id, metadata.observation_hash, ...this.keys(), sourceId, revision, metadata.current_version, ...this.keys(), metadata.chat_id, metadata.policy_revision, metadata.kind, metadata.effective_mode, this.target.installationId, this.target.installationId).run();
    const fence = await this.origin.fence(sourceId);
    if (!fence || fence.generation !== this.target.generation || fence.sourceEpoch !== this.capture.sourceEpoch || fence.sourceGeneration !== this.capture.sourceGeneration || fence.revision !== revision || !await this.origin.check(fence)) throw new Error("restore_origin_reproof_required");
    await this.retirement.allow("whatsapp", (await this.sql("SELECT origin_key FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND revision=?", ...this.keys(), sourceId, revision).first<string>("origin_key"))!, sourceId);
    const proof = JSON.stringify(fence);
    await this.sql(`UPDATE assistant_retention_quarantines SET active=0,reason='fresh_origin_reproved' WHERE installation_id=? AND generation=? AND kind='origin_source' AND source_id=? AND version=? AND snapshot_seal=?
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='idle')
      AND EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied')
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers WHERE installation_id=? AND (source_id=? OR (origin='whatsapp' AND origin_key=(SELECT origin_key FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?))))
      AND EXISTS(SELECT 1 FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
        JOIN assistant_origin_conversations c ON c.installation_id=o.installation_id AND c.generation=o.generation AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id
        JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
        JOIN (SELECT json(?) f) WHERE o.installation_id=? AND o.generation=? AND o.canonical_id=? AND o.source_epoch=json_extract(f,'$.sourceEpoch') AND o.source_generation=json_extract(f,'$.sourceGeneration')
        AND o.source_kind=json_extract(f,'$.sourceKind') AND o.source_id=json_extract(f,'$.sourceId') AND o.chat_id=json_extract(f,'$.chatId') AND o.observation_hash=json_extract(f,'$.hash') AND o.tombstoned=0
        AND s.status='active' AND s.revision=json_extract(f,'$.revision') AND s.current_version=json_extract(f,'$.version')
        AND c.watermark=json_extract(f,'$.watermark') AND c.kind=json_extract(f,'$.conversationKind') AND c.access_state='available'
        AND p.revision=json_extract(f,'$.policyRevision') AND p.effective_mode=json_extract(f,'$.policyMode') AND p.kind=c.kind)`,
      ...this.keys(), sourceId, revision, session.snapshot_seal, this.target.installationId, this.target.installationId, this.target.installationId, this.target.installationId, sourceId, ...this.keys(), sourceId, proof, ...this.keys(), sourceId).run();
    const remaining = await this.sql("SELECT 1 FROM assistant_retention_quarantines WHERE installation_id=? AND generation=? AND kind='origin_source' AND source_id=? AND version=? AND active=1", ...this.keys(), sourceId, revision).first();
    if (remaining) throw new Error("restore_origin_reproof_changed");
    return { state: "source_reproved", sourceId, revision, identity: "explicit_owner_binding_required", mandates: "fresh_owner_revision_required", execution: "held" };
  }
  private async catchup(operationId: string) {
    const { session, ticket } = await this.requireSession(operationId), gate = await this.gate();
    if (gate?.state !== "idle" || !this.captureBinding || !await this.sql("SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1", this.target.installationId).first()) throw new Error("restore_paused_catchup_required");
    const sourceOrigin = { ...this.source, generation: ticket.currentGeneration, ...this.capture }, targetOrigin = { ...this.target, ...this.capture };
    const live = new CaptureMaterializer(this.db, () => sourceOrigin, this.captureBinding.reader, this.captureBinding.secret, this.clock);
    await live.drain(8); await live.retry(2);
    const admitted = await this.sql("SELECT COUNT(*) n FROM assistant_retention_restore_rows WHERE installation_id=? AND generation=? AND operation_id=?", ...this.keys(), operationId).first<number>("n");
    if (admitted !== session.expected_rows) return { state: "catchup_pending", reason: "target_import_incomplete_live_withdrawals_observed", execution: "held" };
    const rows = (await this.sql("SELECT * FROM assistant_capture_inbox WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND sequence>? ORDER BY sequence LIMIT 8", this.source.installationId, ticket.currentGeneration, this.capture.sourceEpoch, this.capture.sourceGeneration, session.catchup_cursor).all<{ sequence: number; previous_sequence: number; chat_id: string; source_id: string; source_kind: string; operation: string; recorded_at: number }>()).results;
    for (const row of rows) {
      const event = { protocol: 1, ...targetOrigin, sequence: row.sequence, previousSequence: row.previous_sequence, chatId: row.chat_id, sourceId: row.source_id, sourceKind: row.source_kind, operation: row.operation, recordedAt: row.recorded_at };
      const received = await receiveCapture(new Request("https://internal.invalid/capture", { method: "POST", headers: { Authorization: "Bearer " + this.captureBinding.secret }, body: JSON.stringify(event) }), { DB: this.db, INSTALLATION_ID: this.target.installationId, OPERATIONAL_GENERATION: this.target.generation, BRIDGE_SOURCE_EPOCH: this.capture.sourceEpoch, BRIDGE_SOURCE_GENERATION: this.capture.sourceGeneration, BRIDGE_SECRET: this.captureBinding.secret });
      if (!received.ok) throw new Error("restore_metadata_catchup_gap");
    }
    const target = new CaptureMaterializer(this.db, () => targetOrigin, this.captureBinding.reader, this.captureBinding.secret, this.clock);
    await target.drain(8); await target.retry(2);
    const after = rows.at(-1)?.sequence ?? session.catchup_cursor;
    await this.sql("UPDATE assistant_retention_restore_sessions SET catchup_cursor=? WHERE installation_id=? AND generation=? AND operation_id=? AND catchup_cursor=?", after, ...this.keys(), operationId, session.catchup_cursor).run();
    const pending = await this.sql("SELECT COUNT(*) n FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied'", this.target.installationId).first<number>("n");
    return { state: rows.length === 8 || pending ? "catchup_pending" : "catchup_observed", after, pending, execution: "held", coverage: "live_d1_metadata_only_remote_origins_revalidated" };
  }
  private async bindIdentity(input: Extract<z.infer<typeof restoreCommand>, { kind: "restore.bind_identity" }>) {
    const { session } = await this.requireSession(input.operationId), ledger = new CommandLedger(this.db, this.target, input.commandId, await bridgeHash(["owner-identity-after-restore-v1", input]));
    const previous = await ledger.recover(); if (previous) return previous;
    if (!session.released && session.state !== "paused") throw new Error("restore_paused_reproof_required");
    const access = new SourceAccess(this.db, this.target), proof = await access.read(this.actor, input.proof.sourceId, input.proof.revision, this.clock());
    // Exact owner assertion, never an identity inferred from names or fromMe.
    if (!proof || proof.fence.source.origin !== "whatsapp" || !this.origin) throw new Error("restore_identity_proof_required");
    const origin = await this.origin.fence(proof.id);
    if (!origin) throw new Error("restore_identity_proof_required");
    const sourceOrigin = await this.sql(`SELECT watermark FROM assistant_source_origins WHERE installation_id=? AND generation=? AND canonical_id=? AND source_epoch=? AND source_generation=? AND source_kind=? AND source_id=? AND chat_id=? AND observation_hash=? AND tombstoned=0`, ...this.keys(), proof.id, origin.sourceEpoch, origin.sourceGeneration, origin.sourceKind, origin.sourceId, origin.chatId, origin.hash).first<{watermark:number}>();
    if (!sourceOrigin || !await this.origin.check(origin)) throw new Error("restore_identity_proof_required");
    const expected = "absent" in input.expected ? "NOT EXISTS(SELECT 1 FROM assistant_provider_identities WHERE installation_id=? AND generation=? AND provider=? AND address=?)"
      : "EXISTS(SELECT 1 FROM assistant_provider_identities WHERE installation_id=? AND generation=? AND provider=? AND address=? AND person_id=? AND proof_source_id=? AND proof_source_revision=? AND verified_at=?)";
    const values = [...this.keys(), input.provider, input.address, ...("absent" in input.expected ? [] : [input.expected.personId, input.expected.proofSourceId, input.expected.proofRevision, input.expected.boundAt])];
    const guard = access.guard(this.actor, proof.fence, this.clock()), now = this.clock();
    const result = { state: "identity_bound", attribution: "owner_assertion_after_restore", operationId: input.commandId, provider: input.provider, address: input.address, personId: input.personId, proofSourceId: proof.id, proofRevision: proof.fence.source.revision, boundAt: now, execution: "held" };
    const condition = `${guard.sql} AND ${expected} AND EXISTS(SELECT 1 FROM assistant_people WHERE installation_id=? AND generation=? AND id=?)
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='idle') AND EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied')
      AND EXISTS(SELECT 1 FROM assistant_source_versions WHERE installation_id=? AND generation=? AND source_id=? AND version=? AND author_id=?)
      AND EXISTS(SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND canonical_id=? AND source_epoch=? AND source_generation=? AND source_kind=? AND source_id=? AND chat_id=? AND observation_hash=? AND watermark=? AND tombstoned=0)
      AND EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND chat_id=? AND watermark=? AND kind=? AND access_state='available')
      AND EXISTS(SELECT 1 FROM assistant_conversation_modes WHERE installation_id=? AND generation=? AND conversation_id=? AND revision=? AND kind=? AND effective_mode=?)`;
    await this.db.batch([
      ledger.admit(result, now, condition, [...guard.values, ...values, ...this.keys(), input.personId, this.target.installationId, this.target.installationId, this.target.installationId, ...this.keys(), proof.id, origin.version, input.address, ...this.keys(), proof.id, origin.sourceEpoch, origin.sourceGeneration, origin.sourceKind, origin.sourceId, origin.chatId, origin.hash, sourceOrigin.watermark, ...this.keys(), origin.sourceEpoch, origin.sourceGeneration, origin.chatId, origin.watermark, origin.conversationKind, ...this.keys(), origin.chatId, origin.policyRevision, origin.conversationKind, origin.policyMode]),
      ledger.statement(`INSERT INTO assistant_provider_identities SELECT ?,?,?,?,?,?,?,'owner_confirmed',? WHERE $gate ON CONFLICT(installation_id,generation,provider,address) DO UPDATE SET person_id=excluded.person_id,proof_source_id=excluded.proof_source_id,proof_source_revision=excluded.proof_source_revision,proof_kind=excluded.proof_kind,verified_at=excluded.verified_at`, ...this.keys(), input.provider, input.address, input.personId, proof.id, proof.fence.source.revision, now),
      ledger.statement("UPDATE assistant_retention_quarantines SET active=0,reason='owner_assertion_after_restore' WHERE installation_id=? AND generation=? AND kind='provider_identity' AND provider=? AND address=? AND $gate", ...this.keys(), input.provider, input.address),
    ]);
    const saved = await ledger.recover(); if (!saved) throw new Error("restore_identity_compare_and_swap_failed"); return saved;
  }
  /** Separate explicit owner action, only after external deployment points at
   * the restored generation. Neither import, finish nor release calls this. */
  private async activate(input: Extract<z.infer<typeof restoreCommand>, { kind: "restore.activate_generation" }>) {
    const { session, ticket } = await this.requireSession(input.operationId), hash = await bridgeHash(["restore-generation-activation-v1", input]), ledger = new CommandLedger(this.db, this.target, input.commandId, hash);
    const previous = await ledger.recover(); if (previous) return previous;
    if (this.source.generation !== this.target.generation || !this.activation?.shadow || this.activation.externalSeal !== input.expectedSeal || session.state !== "inactive_complete" || !session.released || !session.report_json || JSON.parse(session.report_json).seal !== input.expectedSeal) throw new Error("restore_external_activation_configuration");
    const now = this.clock(), period = new Date(now).toISOString().slice(0, 10);
    if (input.budget.period !== period) throw new Error("restore_current_budget_required");
    const gate = await this.gate(); if (!gate || gate.state !== "idle") throw new Error("restore_activation_quiesced");
    const raw = JSON.parse(session.activation_json) as { hash?: string; commandId?: string; financial?: number; cursor?: FinancialCursor };
    if (raw.commandId === input.commandId && raw.hash && raw.hash !== hash) throw new Error("restore_activation_operation_conflict");
    const start = raw.hash === hash && raw.financial === gate.financial_revision && raw.cursor ? raw.cursor : await financialStart(this.target.installationId);
    const cursor = await financialStep(this.db, this.target.installationId, start);
    const savedProgress = JSON.stringify({ hash, commandId: input.commandId, financial: gate.financial_revision, cursor });
    await this.sql("UPDATE assistant_retention_restore_sessions SET activation_json=? WHERE installation_id=? AND generation=? AND operation_id=? AND activation_json=? AND state='inactive_complete' AND released=1", savedProgress, ...this.keys(), input.operationId, session.activation_json).run();
    if (!cursor.done) return { state: "activation_pending", operationId: input.operationId, commandId: input.commandId, financialRows: cursor.counts, execution: "held" };
    await this.authority.observe(); // unavailable is never an empty tombstone set.
    const condition = `EXISTS(SELECT 1 FROM assistant_retention_generation_seals WHERE installation_id=? AND generation=? AND seal=? AND snapshot_seal=? AND ticket_hash=? AND state='inactive_complete')
      AND EXISTS(SELECT 1 FROM assistant_retention_restore_sessions WHERE installation_id=? AND generation=? AND operation_id=? AND token=? AND state='inactive_complete' AND released=1 AND activation_json=?)
      AND EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND operation_id=? AND target_generation=? AND active=1)
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='idle' AND financial_revision=?)
      AND (NOT EXISTS(SELECT 1 FROM assistant_retention_active_generation WHERE installation_id=?) OR EXISTS(SELECT 1 FROM assistant_retention_active_generation WHERE installation_id=? AND generation=?))
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied')
      AND NOT EXISTS(SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND (source_epoch<>? OR source_generation<>?))
      AND NOT EXISTS(SELECT 1 FROM assistant_sources s JOIN assistant_retention_barriers b ON b.installation_id=s.installation_id AND (b.source_id=s.id OR (b.origin=s.origin AND b.origin_key=s.origin_key)) WHERE s.installation_id=? AND s.generation=? AND s.status='active')
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q JOIN assistant_sources s ON s.installation_id=q.installation_id AND s.generation=q.generation AND s.id=q.source_id AND s.revision=q.version AND s.status='active' WHERE q.installation_id=? AND q.generation=? AND q.kind='origin_source' AND q.active=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q JOIN assistant_provider_identities i ON i.installation_id=q.installation_id AND i.generation=q.generation AND i.provider=q.provider AND i.address=q.address AND i.proof_source_id=q.source_id AND i.proof_source_revision=q.version WHERE q.installation_id=? AND q.generation=? AND q.kind='provider_identity' AND q.active=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q JOIN assistant_conversation_policies p ON p.installation_id=q.installation_id AND p.generation=q.generation AND p.conversation_id=q.conversation_id AND p.revision=q.version WHERE q.installation_id=? AND q.generation=? AND q.kind='policy' AND q.active=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q JOIN assistant_mandates m ON m.installation_id=q.installation_id AND m.generation=q.generation AND m.id=q.mandate_id AND m.version=q.version AND m.status='active' WHERE q.installation_id=? AND q.generation=? AND q.kind='mandate' AND q.active=1 AND m.version=(SELECT MAX(version) FROM assistant_mandates WHERE installation_id=m.installation_id AND generation=m.generation AND id=m.id))
      AND EXISTS(SELECT 1 FROM assistant_budget_accounts WHERE installation_id=? AND generation=? AND period=? AND cap_units=? AND blocked=0)
      AND NOT EXISTS(SELECT 1 FROM assistant_budget_accounts WHERE installation_id=? AND generation=? AND blocked=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_rows r WHERE r.installation_id=? AND r.generation=? AND r.operation_id=? AND (r.state='financial_missing'
        OR (r.table_name='assistant_budget_accounts' AND NOT EXISTS(SELECT 1 FROM assistant_budget_accounts a WHERE a.installation_id=r.installation_id AND a.rowid=r.source_row))
        OR (r.table_name='assistant_budget_reservations' AND NOT EXISTS(SELECT 1 FROM assistant_budget_reservations a WHERE a.installation_id=r.installation_id AND a.rowid=r.source_row))))`;
    const values = [...this.keys(), input.expectedSeal, session.snapshot_seal, session.ticket_hash, ...this.keys(), input.operationId, session.token, savedProgress,
      this.target.installationId, input.operationId, this.target.generation, this.target.installationId, gate.financial_revision,
      this.target.installationId, this.target.installationId, ticket.currentGeneration, this.target.installationId,
      ...this.keys(), this.capture.sourceEpoch, this.capture.sourceGeneration, ...this.keys(), ...this.keys(), ...this.keys(), ...this.keys(), ...this.keys(),
      ...this.keys(), period, input.budget.capMicroUsd, ...this.keys(), ...this.keys(), input.operationId];
    const result = { state: "generation_activated", attribution: "explicit_owner_after_restore", operationId: input.commandId, generation: this.target.generation, seal: input.expectedSeal,
      financialHashAtActivation: cursor.hash, financialScope: "installation_all_generations_all_periods", budget: { period, capMicroUsd: input.budget.capMicroUsd, automaticInitialization: false },
      jobs: "all_existing_pending_cancelled_only_future_jobs_admissible", routines: "environment_flags_unchanged", obligations: "restored_paused_not_resumed", oauth: "credential_generation_unchanged", channelConsent: "not_substituted", mode: "shadow" };
    await this.db.batch([
      ledger.admit(result, now, condition, values),
      ledger.statement("UPDATE assistant_job_ledger SET state='uncertain' WHERE installation_id=? AND state='attempting' AND $gate", this.target.installationId),
      ledger.statement("UPDATE assistant_jobs SET state='cancelled',lease_until=NULL,last_error='restore_activation_old_job_cancelled' WHERE installation_id=? AND state IN ('pending','processing') AND $gate", this.target.installationId),
      ledger.statement("INSERT INTO assistant_retention_active_generation SELECT ?,?,?,?,?,1 WHERE $gate ON CONFLICT(installation_id) DO UPDATE SET generation=excluded.generation,snapshot_seal=excluded.snapshot_seal,ticket_hash=excluded.ticket_hash,command_id=excluded.command_id,revision=assistant_retention_active_generation.revision+1", ...this.keys(), session.snapshot_seal, session.ticket_hash, input.commandId),
      ledger.statement("DELETE FROM assistant_retention_runtime_hold WHERE installation_id=? AND operation_id=? AND target_generation=? AND $gate", this.target.installationId, input.operationId, this.target.generation),
    ]);
    const saved = await ledger.recover(); if (!saved) throw new Error("restore_activation_guard_not_satisfied"); return saved;
  }
}
