export type BudgetScope = { installationId: string; generation: string; period: string };
type State = "reserved" | "uncertain" | "settled";
type Reservation = { period: string; request_hash: string; ceiling_units: number; state: State; actual_units: number | null };
const namespace = "installation_id=? AND generation=?";
const charge = "CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END";
function identifier(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function units(value: number, zero = false): void {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error("invalid_budget_units");
}
function requestKey(key: string, hash?: string): void {
  if (!identifier(key) || (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))) throw new Error("invalid_budget_request");
}

/** Host-only microUSD ledger. No expiry frees an uncertain reservation. */
export class InferenceBudget {
  private readonly scope: Readonly<BudgetScope>;
  constructor(private readonly db: D1Database, scope: BudgetScope) {
    if (!scope || ![scope.installationId, scope.generation, scope.period].every(identifier)) throw new Error("invalid_budget_scope");
    this.scope = Object.freeze({ ...scope });
  }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private reservation(key: string) {
    return this.db.prepare(`SELECT period,request_hash,ceiling_units,state,actual_units FROM assistant_budget_reservations
      WHERE ${namespace} AND operation_key=?`).bind(...this.keys(), key).first<Reservation>();
  }
  async configure(cap: number): Promise<void> {
    units(cap, true);
    await this.db.prepare(`INSERT INTO assistant_budget_accounts(installation_id,generation,period,cap_units)
      VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).bind(...this.keys(), this.scope.period, cap).run();
    if ((await this.status()).cap !== cap) throw new Error("budget_configuration_conflict");
  }
  async reserve(key: string, hash: string, ceiling: number): Promise<{ created: boolean; state: State }> {
    requestKey(key, hash); units(ceiling);
    const inserted = await this.db.prepare(`INSERT INTO assistant_budget_reservations
      (installation_id,generation,operation_key,period,request_hash,ceiling_units)
      SELECT a.installation_id,a.generation,?,a.period,?,? FROM assistant_budget_accounts a
      WHERE a.installation_id=? AND a.generation=? AND a.period=?
      AND NOT EXISTS(SELECT 1 FROM assistant_budget_accounts b WHERE b.installation_id=a.installation_id AND b.generation=a.generation AND b.blocked=1)
      AND ?<=a.cap_units-COALESCE((SELECT SUM(${charge}) FROM assistant_budget_reservations r
        WHERE r.installation_id=a.installation_id AND r.generation=a.generation AND r.period=a.period),0)
      ON CONFLICT DO NOTHING RETURNING state`)
      .bind(key, hash, ceiling, ...this.keys(), this.scope.period, ceiling).all<{ state: State }>();
    if (inserted.results.length === 1) return { created: true, state: inserted.results[0].state };
    const existing = await this.reservation(key);
    if (existing) {
      if (existing.request_hash !== hash || existing.ceiling_units !== ceiling) throw new Error("reservation_conflict");
      return { created: false, state: existing.state };
    }
    if ((await this.status()).blocked) throw new Error("budget_blocked");
    throw new Error("budget_exhausted");
  }
  async uncertain(key: string): Promise<void> {
    requestKey(key);
    await this.db.prepare(`UPDATE assistant_budget_reservations SET state='uncertain'
      WHERE ${namespace} AND operation_key=? AND state='reserved' RETURNING state`).bind(...this.keys(), key).all();
    if (!(await this.reservation(key))) throw new Error("reservation_missing");
  }
  async settle(key: string, hash: string, actual: number): Promise<void> {
    requestKey(key, hash); units(actual, true);
    // Both writes share a transaction; a losing actual never blocks an account.
    await this.db.batch([
      this.db.prepare(`UPDATE assistant_budget_reservations SET state='settled',actual_units=?
        WHERE ${namespace} AND operation_key=? AND request_hash=? AND state IN ('reserved','uncertain') RETURNING period`)
        .bind(actual, ...this.keys(), key, hash),
      this.db.prepare(`UPDATE assistant_budget_accounts SET blocked=1 WHERE ${namespace}
        AND period=(SELECT period FROM assistant_budget_reservations WHERE ${namespace}
          AND operation_key=? AND request_hash=? AND state='settled' AND actual_units=? AND actual_units>ceiling_units)
        RETURNING period`).bind(...this.keys(), ...this.keys(), key, hash, actual),
    ]);
    const stored = await this.reservation(key);
    if (!stored) throw new Error("reservation_missing");
    if (stored.request_hash !== hash || stored.state !== "settled" || stored.actual_units !== actual) throw new Error("settlement_conflict");
  }
  async status(): Promise<{ cap: number; committed: number; blocked: boolean }> {
    const row = await this.db.prepare(`SELECT cap_units AS cap,
      COALESCE((SELECT SUM(${charge}) FROM assistant_budget_reservations WHERE ${namespace} AND period=?),0) AS committed,
      EXISTS(SELECT 1 FROM assistant_budget_accounts WHERE ${namespace} AND blocked=1) AS blocked
      FROM assistant_budget_accounts WHERE ${namespace} AND period=?`)
      .bind(...this.keys(), this.scope.period, ...this.keys(), ...this.keys(), this.scope.period)
      .first<{ cap: number; committed: number; blocked: number }>();
    if (!row) throw new Error("budget_unconfigured");
    if (!Number.isSafeInteger(row.committed)) throw new Error("unsafe_budget_total");
    return { cap: row.cap, committed: row.committed, blocked: row.blocked === 1 };
  }
}
