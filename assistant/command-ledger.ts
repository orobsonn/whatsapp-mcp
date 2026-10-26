import type { SourceScope } from "./sources";
export type CommandValue = string | number | null;
/** One token gates every mutation in the same D1 batch. A receipt is never
 * inferred from today's resource: it records the originally admitted result. */
export class CommandLedger {
  readonly token = crypto.randomUUID();
  constructor(private readonly db: D1Database, private readonly scope: SourceScope,
    readonly operationId: string, private readonly hash: string) {}
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private read() {
    return this.db.prepare(`SELECT request_hash,result_json FROM assistant_owner_commands
      WHERE installation_id=? AND generation=? AND operation_id=?`).bind(...this.keys(), this.operationId)
      .first<{ request_hash: string; result_json: string }>();
  }
  async recover<T>(): Promise<T | null> {
    const row = await this.read();
    if (!row) return null;
    if (row.request_hash !== this.hash) throw new Error("control_operation_conflict");
    return JSON.parse(row.result_json) as T;
  }
  admit(result: unknown, now: number, condition: string, values: CommandValue[]) {
    return this.db.prepare(`INSERT INTO assistant_owner_commands SELECT ?,?,?,?,?,?,?
      WHERE ${condition} ON CONFLICT DO NOTHING`).bind(...this.keys(), this.operationId,
      this.hash, this.token, JSON.stringify(result), now, ...values);
  }
  statement(sql: string, ...values: CommandValue[]) {
    const gate = `EXISTS(SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id=? AND token=?)`;
    return this.db.prepare(sql.replaceAll("$gate", gate)).bind(...values, ...this.keys(), this.operationId, this.token);
  }
}
