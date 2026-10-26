import { z } from "zod";
import type { TrustedActor } from "./access";
import type { SourceScope } from "./sources";
import { bridgeHash } from "./ingress";
import { AssistantExport } from "./retention";
import { financialStart, financialStep, type FinancialCursor } from "./retention-financial";
import { manifestFor, packetFor, snapshotExportPage, snapshotPageSeed, snapshotRowSeed, verifyManifest, type SnapshotManifest } from "./retention-snapshot-contract";
import { appendSnapshotFrontier, snapshotRoot } from "./retention-membership";
const label = z.string().min(1).max(256), integer = z.number().int().nonnegative().safe();
export const snapshotCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot.begin"), operationId: label }).strict(),
  z.object({ kind: z.literal("snapshot.page"), operationId: label, index: integer, cursor: z.string().min(1).max(4096).nullable() }).strict(),
  z.object({ kind: z.literal("snapshot.seal"), operationId: label }).strict(),
  z.object({ kind: z.literal("snapshot.cancel"), operationId: label }).strict(),
  z.object({ kind: z.literal("snapshot.advance"), operationId: label }).strict(),
]);
export type SnapshotAuthorityReceipt = { state: "sealed_snapshot"; installationId: string; generation: string; operationId: string; seal: string; authorityRevision: number };
export interface SnapshotAuthorityPort {
  observe(): Promise<{ state: "sealed"; revision: number }>;
  recordSnapshot(manifest: SnapshotManifest): Promise<SnapshotAuthorityReceipt>;
  snapshotReceipt(operationId: string): Promise<SnapshotAuthorityReceipt | null>;
}
type Gate = { generation: string; operation_id: string; request_hash: string; token: string; state: string; target_generation: string | null; mutation_revision: number; financial_revision: number; started_at: number };
type Session = { request_hash: string; token: string; state: string; schema_hash: string; tables_json: string; expected_counts_json: string; mutation_revision: number; financial_revision: number; financial_hash: string; authority_revision: number; page_index: number; next_cursor: string | null; page_chain: string; row_chain: string; counts_json: string; row_count: number; started_at: number; manifest_json: string | null; seal: string | null; frontier_json: string; financial_cursor: string };
type PageReceipt = { input_cursor: string | null; output_cursor: string | null; page_hash: string; chain: string; row_chain: string; counts_json: string; row_count: number; frontier_json: string };
type ProgressResult = { state: string; operationId: string; index: number; cursor: string | null; financeProgress?: Record<string, number> };
/** Actual producer of the canonical bundle. Only its external receipt turns
 * candidate pages into a sealed artifact. No body copy is persisted in D1. */
export class SnapshotProducer {
  private readonly scope: SourceScope;
  private readonly actor: TrustedActor;
  constructor(private readonly db: D1Database, scope: SourceScope, actor: TrustedActor, private readonly authority: SnapshotAuthorityPort, private readonly clock = Date.now) {
    this.scope = Object.freeze({ installationId: scope.installationId, generation: scope.generation }); this.actor = Object.freeze({ ...actor });
  }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private sql(query: string, ...values: (string | number | null)[]) { return this.db.prepare(query).bind(...values); }
  private session(operationId: string) { return this.sql("SELECT * FROM assistant_retention_snapshot_sessions WHERE installation_id=? AND generation=? AND operation_id=?", ...this.keys(), operationId).first<Session>(); }
  private gate() { return this.sql("SELECT * FROM assistant_retention_installation_gate WHERE installation_id=?", this.scope.installationId).first<Gate>(); }
  private pageReceipt(operationId: string, index: number) { return this.sql("SELECT * FROM assistant_retention_snapshot_pages WHERE installation_id=? AND generation=? AND operation_id=? AND page_index=?", ...this.keys(), operationId, index).first<PageReceipt>(); }
  private owned(gate: Gate | null, operationId: string, token?: string) {
    if (!gate || gate.state !== "quiescing" || gate.generation !== this.scope.generation || gate.operation_id !== operationId || gate.target_generation !== null || token && gate.token !== token) throw new Error("snapshot_quiescence_lost");
    return gate;
  }
  private unchanged(gate: Gate, session: Session) { if (gate.mutation_revision !== session.mutation_revision || gate.financial_revision !== session.financial_revision) throw new Error("snapshot_changed_live_not_sealed"); }
  async execute(raw: unknown) {
    if (this.actor.kind !== "owner") throw new Error("owner_required");
    const command = snapshotCommand.parse(raw);
    if (command.kind === "snapshot.begin") return this.begin(command.operationId);
    if (command.kind === "snapshot.page") return this.page(command.operationId, command.index, command.cursor);
    if (command.kind === "snapshot.seal") return this.seal(command.operationId);
    if (command.kind === "snapshot.advance") return this.advance(command.operationId);
    return this.cancel(command.operationId);
  }
  private async begin(operationId: string) {
    const requestHash = await bridgeHash(["snapshot-begin-v1", this.scope, operationId]), prior = await this.session(operationId);
    if (prior) {
      if (prior.request_hash !== requestHash) throw new Error("snapshot_operation_conflict");
      return { state: prior.state, operationId, index: prior.page_index, cursor: prior.next_cursor, schemaHash: prior.schema_hash, tables: JSON.parse(prior.tables_json), counts: JSON.parse(prior.expected_counts_json), authority: prior.state === "sealed" ? "receipt_required" : "unchecked" };
    }
    const token = crypto.randomUUID(), now = integer.parse(this.clock());
    await this.sql(`INSERT INTO assistant_retention_installation_gate(installation_id,generation,operation_id,request_hash,token,state,started_at) VALUES(?,?,?,?,?,'quiescing',?)
      ON CONFLICT(installation_id) DO UPDATE SET generation=excluded.generation,operation_id=excluded.operation_id,request_hash=excluded.request_hash,token=excluded.token,state='quiescing',target_generation=NULL,started_at=excluded.started_at
      WHERE assistant_retention_installation_gate.state='idle'`, ...this.keys(), operationId, requestHash, token, now).run();
    const gate = this.owned(await this.gate(), operationId); if (gate.request_hash !== requestHash) throw new Error("snapshot_operation_conflict");
    const external = await this.authority.observe(), finance = await financialStart(this.scope.installationId), metadata = await new AssistantExport(this.db, this.scope, this.actor, "canonical_snapshot_candidate").snapshotMetadata();
    const current = this.owned(await this.gate(), operationId, gate.token);
    if (current.mutation_revision !== gate.mutation_revision || current.financial_revision !== gate.financial_revision) throw new Error("snapshot_changed_live_not_sealed");
    const pageChain = await snapshotPageSeed(this.scope, metadata.schemaHash), rowChain = await snapshotRowSeed();
    await this.sql(`INSERT INTO assistant_retention_snapshot_sessions(installation_id,generation,operation_id,request_hash,token,state,schema_hash,tables_json,expected_counts_json,mutation_revision,financial_revision,financial_hash,authority_revision,page_chain,row_chain,started_at,financial_cursor)
      SELECT ?,?,?,?,?,'preparing',?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?) ON CONFLICT DO NOTHING`,
      ...this.keys(), operationId, requestHash, gate.token, metadata.schemaHash, JSON.stringify(metadata.tables), JSON.stringify(metadata.counts), gate.mutation_revision, gate.financial_revision, finance.hash, external.revision, pageChain, rowChain, gate.started_at, JSON.stringify(finance),
      this.scope.installationId, gate.token, gate.mutation_revision, gate.financial_revision).run();
    const saved = await this.session(operationId); if (!saved || saved.token !== gate.token) throw new Error("snapshot_begin_uncertain");
    return this.advance(operationId);
  }
  private async advance(operationId: string): Promise<ProgressResult | Awaited<ReturnType<SnapshotProducer["commitSeal"]>>> {
    const session = await this.session(operationId); if (!session) throw new Error("snapshot_not_prepared");
    if (!["preparing", "checking_finance"].includes(session.state)) return { state: session.state, operationId, index: session.page_index, cursor: session.next_cursor };
    this.unchanged(this.owned(await this.gate(), operationId, session.token), session);
    const cursor = await financialStep(this.db, this.scope.installationId, JSON.parse(session.financial_cursor) as FinancialCursor);
    if (cursor.done && session.state === "checking_finance" && cursor.hash !== session.financial_hash) throw new Error("snapshot_changed_live_not_sealed");
    const nextState = cursor.done && session.state === "preparing" ? "exporting" : session.state;
    await this.sql(`UPDATE assistant_retention_snapshot_sessions SET financial_cursor=?,financial_hash=?,state=? WHERE installation_id=? AND generation=? AND operation_id=? AND state=? AND financial_cursor=?
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?)`, JSON.stringify(cursor), session.state === "preparing" ? cursor.hash : session.financial_hash, nextState, ...this.keys(), operationId, session.state, session.financial_cursor, this.scope.installationId, session.token, session.mutation_revision, session.financial_revision).run();
    const saved = (await this.session(operationId))!;
    this.unchanged(this.owned(await this.gate(), operationId, session.token), session);
    if (cursor.done && session.state === "checking_finance") return this.seal(operationId);
    return { state: saved.state, operationId, index: saved.page_index, cursor: saved.next_cursor, financeProgress: cursor.counts };
  }
  private async page(operationId: string, index: number, inputCursor: string | null) {
    const session = await this.session(operationId); if (!session || session.state !== "exporting") throw new Error("snapshot_not_exporting");
    this.unchanged(this.owned(await this.gate(), operationId, session.token), session);
    const previous = await this.pageReceipt(operationId, index);
    if (index > session.page_index || index === session.page_index && inputCursor !== session.next_cursor || previous && inputCursor !== previous.input_cursor) throw new Error("snapshot_page_conflict");
    const parent = index ? await this.pageReceipt(operationId, index - 1) : null;
    if (index && !parent) throw new Error("snapshot_page_conflict");
    const page = snapshotExportPage.parse(await new AssistantExport(this.db, this.scope, this.actor, "canonical_snapshot_candidate").page({ ...(inputCursor ? { cursor: inputCursor } : {}), limit: 50 }));
    const packet = await packetFor(index, inputCursor, parent?.chain ?? await snapshotPageSeed(this.scope, session.schema_hash), page);
    let rowChain = parent?.row_chain ?? await snapshotRowSeed(), rowCount = parent?.row_count ?? 0, frontier: (string | null)[] = JSON.parse(parent?.frontier_json ?? "[]"); const counts = z.record(z.string(), integer).parse(JSON.parse(parent?.counts_json ?? "{}"));
    for (const part of page.parts) if (part.offset + atob(part.data).length === part.totalBytes) { rowChain = await bridgeHash([rowChain, part.table, part.row, part.hash]); frontier = await appendSnapshotFrontier(frontier, rowCount, part); rowCount++; counts[part.table] = (counts[part.table] ?? 0) + 1; }
    if (previous) { if (previous.page_hash !== packet.pageHash || previous.chain !== packet.chain || previous.row_chain !== rowChain) throw new Error("snapshot_replay_changed_live_not_sealed"); this.unchanged(this.owned(await this.gate(), operationId, session.token), session); return { state: "candidate_page", packet }; }
    const check = `EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?)`;
    try { await this.db.batch([
      this.sql(`INSERT INTO assistant_retention_snapshot_pages SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${check} ON CONFLICT DO NOTHING`, ...this.keys(), operationId, index, inputCursor, page.nextCursor ?? null, packet.pageHash, packet.chain, rowChain, JSON.stringify(counts), rowCount, JSON.stringify(frontier), this.scope.installationId, session.token, session.mutation_revision, session.financial_revision),
      this.sql(`UPDATE assistant_retention_snapshot_sessions SET page_index=page_index+1,next_cursor=?,page_chain=?,row_chain=?,counts_json=?,row_count=?,frontier_json=? WHERE installation_id=? AND generation=? AND operation_id=? AND page_index=? AND token=? AND ${check}
       AND EXISTS(SELECT 1 FROM assistant_retention_snapshot_pages WHERE installation_id=? AND generation=? AND operation_id=? AND page_index=? AND page_hash=?)`, page.nextCursor ?? null, packet.chain, rowChain, JSON.stringify(counts), rowCount, JSON.stringify(frontier), ...this.keys(), operationId, index, session.token, this.scope.installationId, session.token, session.mutation_revision, session.financial_revision, ...this.keys(), operationId, index, packet.pageHash),
    ]); } catch { const observed = await this.pageReceipt(operationId, index); if (observed?.page_hash !== packet.pageHash) throw new Error("snapshot_page_uncertain"); }
    const receipt = await this.pageReceipt(operationId, index); if (receipt?.page_hash !== packet.pageHash) throw new Error("snapshot_changed_live_not_sealed");
    return { state: "candidate_page", packet };
  }
  private async seal(operationId: string): Promise<ProgressResult | Awaited<ReturnType<SnapshotProducer["commitSeal"]>>> {
    let session = await this.session(operationId); if (!session || !["exporting", "checking_finance", "sealing", "sealed"].includes(session.state)) throw new Error("snapshot_not_exporting");
    if (session.state === "sealed") {
      const manifest = await verifyManifest(JSON.parse(session.manifest_json!)), receipt = await this.authority.snapshotReceipt(operationId) ?? await this.authority.recordSnapshot(manifest);
      if (receipt.seal !== manifest.seal) throw new Error("snapshot_authority_conflict");
      await this.sql("UPDATE assistant_retention_installation_gate SET state='idle' WHERE installation_id=? AND operation_id=? AND token=? AND target_generation IS NULL", this.scope.installationId, operationId, session.token).run();
      return { state: "sealed", manifest, receipt };
    }
    this.unchanged(this.owned(await this.gate(), operationId, session.token), session);
    if (session.state === "sealing") return this.commitSeal(operationId, session, await verifyManifest(JSON.parse(session.manifest_json!)));
    if (session.page_index < 1 || session.next_cursor !== null || !await this.pageReceipt(operationId, session.page_index - 1)) throw new Error("snapshot_pages_incomplete");
    if (session.state === "exporting") {
      await this.sql("UPDATE assistant_retention_snapshot_sessions SET state='checking_finance',financial_cursor=? WHERE installation_id=? AND generation=? AND operation_id=? AND state='exporting'", JSON.stringify(await financialStart(this.scope.installationId)), ...this.keys(), operationId).run();
      return this.advance(operationId);
    }
    if (!(JSON.parse(session.financial_cursor) as FinancialCursor).done) return this.advance(operationId);
    const metadata = await new AssistantExport(this.db, this.scope, this.actor, "canonical_snapshot_candidate").snapshotMetadata(), external = await this.authority.observe();
    const counts = z.record(z.string(), integer).parse(JSON.parse(session.counts_json)), expected = z.record(z.string(), integer).parse(JSON.parse(session.expected_counts_json));
    if (metadata.schemaHash !== session.schema_hash || external.revision !== session.authority_revision || metadata.tables.some(table => (counts[table] ?? 0) !== expected[table] || metadata.counts[table] !== expected[table])) throw new Error("snapshot_changed_live_not_sealed");
    const manifest = await manifestFor({ version: 1, kind: "sealed_canonical_snapshot", namespace: this.scope, operationId, quiescenceToken: session.token, schemaHash: session.schema_hash, tables: metadata.tables, counts: expected, rowCount: session.row_count, pageCount: session.page_index, pageChain: session.page_chain, rowChain: session.row_chain, rowRoot: await snapshotRoot(session.row_count, JSON.parse(session.frontier_json)), mutationRevision: session.mutation_revision, authorityRevision: session.authority_revision, financialHash: session.financial_hash, startedAt: session.started_at, sealedAt: integer.parse(this.clock()) });
    const saved = await this.sql(`UPDATE assistant_retention_snapshot_sessions SET state='sealing',manifest_json=?,seal=? WHERE installation_id=? AND generation=? AND operation_id=? AND state='checking_finance'
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?) RETURNING seal`, JSON.stringify(manifest), manifest.seal, ...this.keys(), operationId, this.scope.installationId, session.token, session.mutation_revision, session.financial_revision).first<{ seal: string }>();
    if (!saved) throw new Error("snapshot_seal_uncertain");
    return this.commitSeal(operationId, session, manifest);
  }
  private async commitSeal(operationId: string, session: Session, manifest: SnapshotManifest) {
    const receipt = await this.authority.snapshotReceipt(operationId) ?? await this.authority.recordSnapshot(manifest);
    if (receipt.seal !== manifest.seal) throw new Error("snapshot_authority_conflict");
    const result = await this.sql(`UPDATE assistant_retention_snapshot_sessions SET state='sealed' WHERE installation_id=? AND generation=? AND operation_id=? AND state='sealing' AND seal=?
      AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND token=? AND state='quiescing' AND mutation_revision=? AND financial_revision=?)
      AND NOT EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE installation_id=? AND application_state<>'applied' AND operation IN ('withdraw','access')) RETURNING seal`, ...this.keys(), operationId, manifest.seal, this.scope.installationId, session.token, session.mutation_revision, session.financial_revision, this.scope.installationId).first<{ seal: string }>();
    if (!result) {
      const observed = await this.session(operationId); if (observed?.state !== "sealed" || observed.seal !== manifest.seal) throw new Error("snapshot_changed_live_not_sealed");
    }
    // Releasing a producer never activates a restored generation. A restore
    // session has a different token/target and cannot be released by this CAS.
    await this.sql("UPDATE assistant_retention_installation_gate SET state='idle' WHERE installation_id=? AND operation_id=? AND token=? AND target_generation IS NULL", this.scope.installationId, operationId, session.token).run();
    return { state: "sealed", manifest, receipt };
  }
  private async cancel(operationId: string) {
    const session = await this.session(operationId), gate = this.owned(await this.gate(), operationId, session?.token);
    if (session?.state === "sealed") throw new Error("snapshot_already_sealed");
    await this.db.batch([
      this.sql("UPDATE assistant_retention_snapshot_sessions SET state='cancelled' WHERE installation_id=? AND generation=? AND operation_id=? AND state<>'sealed'", ...this.keys(), operationId),
      this.sql("UPDATE assistant_retention_installation_gate SET state='idle' WHERE installation_id=? AND operation_id=? AND token=? AND target_generation IS NULL", this.scope.installationId, operationId, gate.token),
    ]);
    return { state: "cancelled", operationId, effect: "canonical_writers_released_without_restore" };
  }
}
