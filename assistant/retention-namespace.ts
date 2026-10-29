import type { SourceScope } from "./sources";
/** Fixed host adapters: these children inherit ownership from their FK root. */
export const nativeConversationChildTables = new Set(["assistant_native_conversation_events", "assistant_native_reply_intents"]);
/** Host-only freshness check over every installation-scoped assistant table.
 * An old generation containing only project/control metadata is still used. */
export async function namespaceOccupied(db: D1Database, scope: SourceScope) {
  // Fixed external-content FTS tables are derived; unknown tables still deny.
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'assistant_*' AND name NOT IN ('assistant_capture_changes','assistant_bridge_cursors','assistant_retention_runtime_hold') AND name NOT IN ('assistant_archive_text','assistant_archive_text_data','assistant_archive_text_idx','assistant_archive_text_docsize','assistant_archive_text_config') ORDER BY name LIMIT 129").all<{ name: string }>()).results;
  if (tables.length > 128 || tables.some(row => !/^assistant_[a-z0-9_]+$/.test(row.name))) throw new Error("restore_schema_unsupported");
  const metadata = await db.batch(tables.map(row => db.prepare(`PRAGMA table_info("${row.name}")`)));
  if (metadata.some((result, index) => { const columns = new Set(result.results.map(row => (row as { name: string }).name)); return nativeConversationChildTables.has(tables[index].name) ? !columns.has("conversation_id") || !tables.some(row => row.name === "assistant_native_conversations") : !columns.has("installation_id") || !columns.has("generation") || tables[index].name === "assistant_native_conversations" && !columns.has("id"); })) throw new Error("restore_schema_unsupported");
  if (!tables.length) throw new Error("restore_schema_incomplete");
  const results = await db.batch(tables.map(row => db.prepare(nativeConversationChildTables.has(row.name)
    ? `SELECT 1 AS occupied WHERE EXISTS(SELECT 1 FROM ${row.name} c JOIN assistant_native_conversations p ON p.id=c.conversation_id WHERE p.installation_id=? AND p.generation=?)`
    : `SELECT 1 AS occupied WHERE EXISTS(SELECT 1 FROM ${row.name} WHERE installation_id=? AND generation=?)`).bind(scope.installationId, scope.generation)));
  return results.some(result => result.results.length > 0);
}
