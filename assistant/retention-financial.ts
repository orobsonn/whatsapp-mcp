import { bridgeHash } from "./ingress";
import { financialTables } from "./retention-snapshot-contract";
export type FinancialCursor = { table: number; after: number | null; hash: string; counts: Record<string, number>; done: boolean };
export async function financialStart(installationId: string): Promise<FinancialCursor> {
  return { table: 0, after: null, hash: await bridgeHash(["retention-live-finance-v1", installationId]), counts: {}, done: false };
}
/** At most two queries and 256 rows per command. The caller persists this
 * metadata together with its session CAS; a retry resumes the same cursor. */
export async function financialStep(db: D1Database, installationId: string, input: FinancialCursor): Promise<FinancialCursor> {
  const state: FinancialCursor = structuredClone(input), tables = [...financialTables].sort();
  for (let page = 0; page < 2 && state.table < tables.length; page++) {
    const table = tables[state.table];
    const rows = (await db.prepare(`SELECT rowid AS __finance_row,* FROM ${table} WHERE installation_id=? AND (? IS NULL OR rowid>?) ORDER BY rowid LIMIT 128`).bind(installationId, state.after, state.after).all<Record<string, unknown> & { __finance_row: number }>()).results;
    for (const { __finance_row: row, ...record } of rows) {
      if (!Number.isSafeInteger(row) || Object.values(record).some(value => typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("financial_inventory_corrupt");
      state.hash = await bridgeHash([state.hash, table, row, await bridgeHash(record)]);
      state.counts[table] = (state.counts[table] ?? 0) + 1;
      if (state.counts[table] > 100000) throw new Error("financial_inventory_capacity");
      state.after = row;
    }
    if (rows.length < 128) { state.counts[table] ??= 0; state.table++; state.after = null; }
  }
  state.done = state.table === tables.length; return state;
}
/** Metadata proof over live #37, installation-wide and across every generation
 * and period. Never creates caps, frees reservations or imports snapshot money. */
export async function financialInventory(db: D1Database, installationId: string) {
  let chain = await bridgeHash(["retention-live-finance-v1", installationId]); const counts: Record<string, number> = {};
  for (const table of [...financialTables].sort()) {
    let after: number | null = null, count = 0;
    for (;;) {
      const rows: (Record<string, unknown> & { __finance_row: number })[] = (await db.prepare(`SELECT rowid AS __finance_row,* FROM ${table} WHERE installation_id=? AND (? IS NULL OR rowid>?) ORDER BY rowid LIMIT 128`).bind(installationId, after, after).all<Record<string, unknown> & { __finance_row: number }>()).results;
      if (!rows.length) break;
      for (const { __finance_row: row, ...record } of rows) {
        if (!Number.isSafeInteger(row) || Object.values(record).some(value => typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("financial_inventory_corrupt");
        chain = await bridgeHash([chain, table, row, await bridgeHash(record)]); count++; if (count > 100000) throw new Error("financial_inventory_capacity"); after = row;
      }
    }
    counts[table] = count;
  }
  return { hash: chain, counts, scope: "installation_all_generations_all_periods" as const, currency: "microUSD" as const };
}
