import type { SourceScope } from "./sources";
/** Host-only freshness check over every installation-scoped assistant table.
 * An old generation containing only project/control metadata is still used. */
export async function namespaceOccupied(db: D1Database, scope: SourceScope) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'assistant_*' AND name NOT IN ('assistant_capture_changes','assistant_bridge_cursors','assistant_retention_runtime_hold') ORDER BY name LIMIT 129").all<{ name: string }>()).results;
  if (tables.length > 128 || tables.some(row => !/^assistant_[a-z0-9_]+$/.test(row.name))) throw new Error("restore_schema_unsupported");
  const metadata = await db.batch(tables.map(row => db.prepare(`PRAGMA table_info("${row.name}")`)));
  if (metadata.some(result => { const columns = new Set(result.results.map(row => (row as { name: string }).name)); return !columns.has("installation_id") || !columns.has("generation"); })) throw new Error("restore_schema_unsupported");
  if (!tables.length) throw new Error("restore_schema_incomplete");
  const results = await db.batch(tables.map(row => db.prepare(`SELECT 1 AS occupied WHERE EXISTS(SELECT 1 FROM ${row.name} WHERE installation_id=? AND generation=?)`).bind(scope.installationId, scope.generation)));
  return results.some(result => result.results.length > 0);
}
