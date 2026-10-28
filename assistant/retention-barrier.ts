import { bridgeHash } from "./ingress";
import type { SourceScope } from "./sources";
import type { SourceRetirementGuard } from "./retention-authority";
import type { AccessGuard } from "./access";
type Barrier = { source_id: string; origin: string; origin_key: string; base_revision: number; source_version: number; operation_id: string; request_hash: string; state: string; external_state: string };
/** Local withdrawal is committed before any external await. The original CAS,
 * identity and operation survive an uncertain DO/D1 acknowledgement. */
export class WithdrawalBarrier {
  private readonly scope: SourceScope;
  constructor(private readonly db: D1Database, scope: SourceScope, private readonly retirement?: SourceRetirementGuard) { this.scope = Object.freeze({ ...scope }); }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private sql(query: string, ...values: (string | number | null)[]) { return this.db.prepare(query).bind(...values); }
  private read(id: string) { return this.sql(`SELECT * FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=?`, ...this.keys(), id).first<Barrier>(); }
  async begin(id: string, expected: number, operationId: string, requestHash: string, now: number, admission?: AccessGuard) {
    const token = crypto.randomUUID();
    try { await this.db.batch([
      this.sql(`INSERT INTO assistant_retention_barriers SELECT installation_id,generation,id,origin,origin_key,revision,current_version,?,?,?,'pending_withdraw','pending',? FROM assistant_sources
       WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active' AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=assistant_sources.installation_id AND b.generation=assistant_sources.generation AND b.source_id=assistant_sources.id)
       ${admission ? `AND (${admission.sql})` : ""} ON CONFLICT DO NOTHING`, operationId, requestHash, token, now, ...this.keys(), id, expected, ...(admission?.values ?? [])),
      this.sql(`UPDATE assistant_sources SET status='withdrawn',revision=revision+1 WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active'
       AND EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=assistant_sources.installation_id AND b.generation=assistant_sources.generation AND b.source_id=assistant_sources.id AND b.claim_token=?)`, ...this.keys(), id, expected, token),
      this.sql(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
       SELECT s.installation_id,s.generation,s.id,s.revision,s.current_version,'withdrawn',? FROM assistant_sources s JOIN assistant_retention_barriers b ON b.installation_id=s.installation_id AND b.generation=s.generation AND b.source_id=s.id
       WHERE s.installation_id=? AND s.generation=? AND s.id=? AND s.status='withdrawn' AND s.revision=? AND b.claim_token=? ON CONFLICT DO NOTHING`, now, ...this.keys(), id, expected + 1, token),
    ]); } catch (error) { const row = await this.read(id); if (!row || row.operation_id !== operationId || row.request_hash !== requestHash) throw error; }
    const row = await this.read(id);
    if (!row || row.base_revision !== expected) throw new Error("source_revision_conflict");
    if (row.operation_id !== operationId || row.request_hash !== requestHash) throw new Error("control_operation_conflict");
    const blocked = await this.sql(`SELECT 1 FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND status='withdrawn' AND revision=?`, ...this.keys(), id, expected + 1).first();
    if (!blocked) throw new Error("retention_barrier_uncertain");
    if (row.state !== "retired") await this.retirement?.withdraw(row.origin, row.origin_key, id);
    return { id, revision: expected + 1, version: row.source_version };
  }
  finish(id: string, operationId: string, requestHash: string) {
    return this.sql(`UPDATE assistant_retention_barriers SET state='retired',external_state=? WHERE installation_id=? AND generation=? AND source_id=? AND operation_id=? AND request_hash=?`, this.retirement ? "recorded" : "not_configured", ...this.keys(), id, operationId, requestHash);
  }
  /** Already withdrawn capture/import tombstones also need durable external
   * recording before body purge. This never revives or increments the source. */
  async adopt(id: string, now: number) {
    const hash = await bridgeHash(["adopt-source-withdraw", id]), operationId = "adopt:" + hash;
    await this.sql(`INSERT INTO assistant_retention_barriers SELECT installation_id,generation,id,origin,origin_key,revision-1,COALESCE(current_version,0),?,?,?,'pending_withdraw','pending',? FROM assistant_sources
      WHERE installation_id=? AND generation=? AND id=? AND status='withdrawn' AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=assistant_sources.installation_id AND b.generation=assistant_sources.generation AND b.source_id=assistant_sources.id) ON CONFLICT DO NOTHING`, operationId, hash, crypto.randomUUID(), now, ...this.keys(), id).run();
    const row = await this.read(id); if (!row) throw new Error("source_withdrawal_required");
    if (row.state !== "retired" || row.external_state !== "recorded") {
      if (!this.retirement) throw new Error("retention_authority_unconfigured");
      await this.retirement.withdraw(row.origin, row.origin_key, id);
      await this.finish(id, row.operation_id, row.request_hash).run();
    }
  }
  async direct(id: string, expected: number, now: number) {
    const hash = await bridgeHash(["direct-source-withdraw", id, expected]), operationId = "direct:" + hash;
    const result = await this.begin(id, expected, operationId, hash, now);
    try { await this.finish(id, operationId, hash).run(); }
    catch { const row = await this.read(id); if (row?.state !== "retired" || row.operation_id !== operationId || row.request_hash !== hash) throw new Error("retention_withdraw_uncertain"); }
    return result;
  }
}
