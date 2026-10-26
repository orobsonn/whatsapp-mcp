import { z } from "zod";
import { bridgeHash } from "./ingress";
import type { TrustedActor } from "./access";
import type { SourceScope } from "./sources";
import { canonicalSnapshotTables, financialTables } from "./retention-snapshot-contract";

const chunkBytes = 24576;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.object({ version: z.literal(2), scope: digest, schema: digest, table: z.number().int().nonnegative().safe(),
  row: z.number().int().safe().nullable(), offset: z.number().int().nonnegative().safe(), hash: digest.nullable() }).strict();
const installationWide = new Set(["assistant_budget_accounts", "assistant_budget_reservations", "assistant_retention_barriers", "assistant_retention_installation_gate", "assistant_retention_runtime_hold", "assistant_retention_active_generation"]);
type CursorState = z.infer<typeof stateSchema>;
const encode = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
};
const cursor = (value: CursorState) => encode(new TextEncoder().encode(JSON.stringify(value)));

/** Authenticated, bounded export of canonical and operational state. The table
 * catalog comes from the database schema, never a message, query or model.
 * Chunks preserve large receipts instead of silently dropping their bodies. */
export class AssistantExport {
  private readonly scope: Readonly<SourceScope>;
  private catalogCache?: { tables: string[]; hash: string };
  constructor(private readonly db: D1Database, scope: SourceScope, private readonly actor: TrustedActor, private readonly purpose: "all" | "canonical_snapshot_candidate" = "all") {
    this.scope = Object.freeze({ ...scope });
    this.actor = Object.freeze({ ...actor });
    if (![scope.installationId, scope.generation].every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value))) throw new Error("export_namespace");
  }
  private owner() { if (this.actor.kind !== "owner") throw new Error("owner_required"); }
  private async catalog() {
    // The archive Worker has two transport tables using this prefix. They belong
    // to its source namespace, never to the assistant's restorable DB catalog.
    const catalogRows = (await this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name GLOB 'assistant_*' AND name NOT IN ('assistant_capture_changes','assistant_bridge_cursors') ORDER BY name LIMIT 129")
      .all<{ name: string; sql: string }>()).results;
    if (catalogRows.length > 128 || catalogRows.some(row => !/^assistant_[a-z0-9_]+$/.test(row.name) || /WITHOUT\s+ROWID/i.test(row.sql))) throw new Error("export_schema_unsupported");
    const rows = this.purpose === "all" ? catalogRows : catalogRows.filter(row => canonicalSnapshotTables.has(row.name) || financialTables.has(row.name));
    if (this.purpose !== "all" && [...canonicalSnapshotTables, ...financialTables].some(name => !rows.some(row => row.name === name))) throw new Error("snapshot_schema_incomplete");
    const hash = await bridgeHash(rows);
    if (this.catalogCache?.hash === hash) return this.catalogCache;
    const metadata = rows.length ? await this.db.batch(rows.map(row => this.db.prepare(`PRAGMA table_info("${row.name}")`))) : [];
    const unsupported = metadata.flatMap((result, index) => {
      const names = new Set(result.results.map(row => z.object({ name: z.string() }).parse(row).name.toLowerCase()));
      return !["installation_id", "generation"].every(name => names.has(name)) || ["rowid", "_rowid_", "oid", "__export_row"].some(name => names.has(name)) ? [rows[index].name] : [];
    });
    if (unsupported.length) throw new Error("export_schema_unsupported:" + unsupported.join(","));
    return this.catalogCache = { tables: rows.map(row => row.name), hash };
  }
  async snapshotMetadata() {
    this.owner(); if (this.purpose !== "canonical_snapshot_candidate") throw new Error("snapshot_export_purpose");
    const catalog = await this.catalog(), results = await this.db.batch(catalog.tables.map(table => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE installation_id=? ${installationWide.has(table) ? "" : "AND generation=?"}`).bind(this.scope.installationId, ...(installationWide.has(table) ? [] : [this.scope.generation]))));
    const counts = Object.fromEntries(results.map((result, index) => [catalog.tables[index], z.object({ n: z.number().int().nonnegative().safe() }).parse(result.results[0]).n]));
    if (Object.values(counts).reduce((sum, count) => sum + count, 0) > 100000) throw new Error("snapshot_capacity");
    return { tables: catalog.tables, schemaHash: catalog.hash, counts };
  }
  async page(raw: unknown = {}) {
    this.owner();
    const input = z.object({ cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(raw);
    const catalog = await this.catalog(), scope = await bridgeHash(this.scope);
    let state: CursorState = { version: 2, scope, schema: catalog.hash, table: 0, row: null, offset: 0, hash: null };
    if (input.cursor) {
      try {
        state = stateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(input.cursor), char => char.charCodeAt(0)))));
        if (state.scope !== scope || state.schema !== catalog.hash || state.table > catalog.tables.length || (state.offset === 0) !== (state.hash === null) || (state.offset > 0 && state.row === null)) throw 0;
      } catch { throw new Error("export_cursor"); }
    }
    const parts: { table: string; row: number; hash: string; offset: number; totalBytes: number; encoding: "base64-json-utf8"; data: string }[] = [];
    let encodedBytes = 0;
    while (state.table < catalog.tables.length && parts.length < input.limit) {
      const table = catalog.tables[state.table];
      const allGenerations = installationWide.has(table);
      const stored = await this.db.prepare(`SELECT rowid AS __export_row,* FROM ${table} WHERE installation_id=? ${allGenerations ? "" : "AND generation=?"}
        AND (? IS NULL OR rowid${state.offset ? "=" : ">"}?) ORDER BY rowid LIMIT 1`)
        .bind(this.scope.installationId, ...(allGenerations ? [] : [this.scope.generation]), state.row, state.row).first<Record<string, unknown> & { __export_row: number }>();
      if (!stored) {
        if (state.offset) throw new Error("export_changed");
        state = { ...state, table: state.table + 1, row: null }; continue;
      }
      const { __export_row: row, ...rawRecord } = stored;
      if (!Number.isSafeInteger(row)) throw new Error("export_rowid_unsafe");
      const record = Object.fromEntries(Object.entries(rawRecord).map(([key, value]) => {
        if (value instanceof ArrayBuffer) return [key, { blobBase64: encode(new Uint8Array(value)) }];
        // D1 JSON results expose SQLite BLOBs as byte arrays. Preserve the
        // binary value explicitly so restore never mistakes it for JSON text.
        if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return [key, { blobBase64: encode(Uint8Array.from(value)) }];
        if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("export_type_unsupported");
        return [key, value];
      }));
      const serialized = JSON.stringify(record), bytes = new TextEncoder().encode(serialized), hash = await bridgeHash(record);
      if (state.offset && (state.hash !== hash || state.offset >= bytes.length)) throw new Error("export_changed");
      const end = Math.min(bytes.length, state.offset + chunkBytes);
      const part = { table, row, hash, offset: state.offset, totalBytes: bytes.length, encoding: "base64-json-utf8" as const, data: encode(bytes.subarray(state.offset, end)) };
      const partBytes = new TextEncoder().encode(JSON.stringify(part)).length;
      if (encodedBytes + partBytes > 98304) break;
      parts.push(part); encodedBytes += partBytes;
      state = { ...state, row, offset: end === bytes.length ? 0 : end, hash: end === bytes.length ? null : hash };
    }
    const complete = state.table === catalog.tables.length;
    return { schema: 2, ...(this.purpose === "all" ? {} : { purpose: this.purpose }), namespace: this.scope, financialScope: "installation_all_generations_all_periods", schemaHash: catalog.hash, parts, coverage: complete ? "end_of_listing" : "page",
      consistency: "live_paginated_not_snapshot", ...(complete ? {} : { nextCursor: cursor(state) }) };
  }
}
