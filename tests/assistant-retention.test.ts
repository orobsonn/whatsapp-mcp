import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { AssistantExport } from "../assistant/retention";
import type { TrustedActor } from "../assistant/access";
import { InferenceBudget } from "../assistant/budget";
const owner = { kind: "owner" } as const;
let scope: { installationId: string; generation: string }, archive: AssistantExport;
beforeEach(async () => {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS assistant_export_fixture(installation_id TEXT,generation TEXT,id TEXT,body TEXT)").run();
  scope = { installationId: crypto.randomUUID(), generation: "synthetic-g" };
  archive = new AssistantExport(env.DB, scope, owner);
});
const record = (body: string, id = "fixture", namespace = scope) => env.DB.prepare("INSERT INTO assistant_export_fixture VALUES(?,?,?,?)").bind(namespace.installationId, namespace.generation, id, body).run();
const bytes = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0));
test("owner authentication is fixed before any database read and namespace input is owned", async () => {
  const actor = { kind: "extractor" } as TrustedActor, denied = new AssistantExport(env.DB, scope, actor);
  (actor as { kind: string }).kind = "owner";
  await expect(denied.page()).rejects.toThrow("owner_required");
  const original = { ...scope }, reader = new AssistantExport(env.DB, scope, owner);
  await record("Synthetic owned body"); scope.installationId = "another-installation";
  expect((await reader.page()).namespace).toEqual(original);
});
test("paginates every record beyond 1000 without crossing installation or operational generation", async () => {
  const rows = Array.from({ length: 1051 }, (_, id) => ({ id: String(id), body: "Synthetic export body " + id }));
  await env.DB.prepare("INSERT INTO assistant_export_fixture SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.body') FROM json_each(?)").bind(scope.installationId, scope.generation, JSON.stringify(rows)).run();
  await record("OTHER_NAMESPACE", "other", { ...scope, installationId: "another" });
  await record("OLD_GENERATION", "old", { ...scope, generation: "old" });
  const found: string[] = []; let cursor: string | undefined, pages = 0;
  do {
    const page = await archive.page({ cursor, limit: 50 }); pages++;
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(131072);
    expect(page.consistency).toBe("live_paginated_not_snapshot");
    for (const part of page.parts) if (part.table === "assistant_export_fixture") {
      expect(part.offset).toBe(0); found.push(JSON.parse(new TextDecoder().decode(bytes(part.data))).id);
    }
    cursor = page.nextCursor;
  } while (cursor && pages < 100);
  expect(cursor).toBeUndefined(); expect(new Set(found).size).toBe(1051); expect(found).toHaveLength(1051);
  expect(found).not.toContain("other"); expect(found).not.toContain("old");
}, 90000);
test("chunks a large multibyte receipt losslessly under the MCP response bound", async () => {
  const body = "á🐳".repeat(20000); await record(body);
  const collected: Uint8Array[] = []; let cursor: string | undefined, total = 0, rowHash = "";
  do {
    const page = await archive.page({ cursor, limit: 3 });
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(131072);
    for (const part of page.parts.filter(part => part.table === "assistant_export_fixture")) {
      expect(part.offset).toBe(total); if (rowHash) expect(part.hash).toBe(rowHash); rowHash = part.hash;
      const chunk = bytes(part.data); total += chunk.length; collected.push(chunk);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const complete = new Uint8Array(total); let offset = 0;
  for (const chunk of collected) { complete.set(chunk, offset); offset += chunk.length; }
  expect(collected.length).toBeGreaterThan(3);
  expect(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(complete)).body).toBe(body);
});
test("a changed row cannot splice the second half into an earlier receipt", async () => {
  await record("A".repeat(80000)); const first = await archive.page({ limit: 1 });
  expect(first.parts[0].table).toBe("assistant_export_fixture");
  await env.DB.prepare("UPDATE assistant_export_fixture SET body=? WHERE installation_id=? AND generation=?").bind("B".repeat(80000), scope.installationId, scope.generation).run();
  await expect(archive.page({ cursor: first.nextCursor, limit: 1 })).rejects.toThrow("export_changed");
});
test("cursor scope and database schema are fixed rather than accepted from caller authority", async () => {
  await record("A".repeat(80000)); const first = await archive.page({ limit: 1 });
  await expect(new AssistantExport(env.DB, { ...scope, generation: "other" }, owner).page({ cursor: first.nextCursor })).rejects.toThrow("export_cursor");
  await env.DB.prepare("CREATE TABLE assistant_export_added(installation_id TEXT,generation TEXT,id TEXT)").run();
  await expect(archive.page({ cursor: first.nextCursor })).rejects.toThrow("export_cursor");
});
test("negative rowids are exported rather than skipped at the initial cursor", async () => {
  await env.DB.prepare("INSERT INTO assistant_export_fixture(rowid,installation_id,generation,id,body) VALUES(-3,?,?,'negative','Synthetic negative row')").bind(scope.installationId, scope.generation).run();
  const page = await archive.page();
  expect(page.parts.filter(part => part.table === "assistant_export_fixture").map(part => JSON.parse(new TextDecoder().decode(bytes(part.data))).id)).toEqual(["negative"]);
});
test("financial reservations include old generations and periods while unrelated installation money stays outside", async () => {
  const old = new InferenceBudget(env.DB, { ...scope, generation: "old-financial", period: "old-period" });
  await old.configure(100); await old.reserve("uncertain-old", "a".repeat(64), 40); await old.uncertain("uncertain-old");
  const other = new InferenceBudget(env.DB, { installationId: "other-install", generation: "old-financial", period: "old-period" });
  await other.configure(100); await other.reserve("other-money", "b".repeat(64), 80);
  const records = []; let cursor: string | undefined;
  do { const page = await archive.page({ cursor }); expect(page.financialScope).toBe("installation_all_generations_all_periods"); records.push(...page.parts.map(part => ({ table: part.table, record: JSON.parse(new TextDecoder().decode(bytes(part.data))) }))); cursor = page.nextCursor; } while (cursor);
  expect(records.filter(row => row.table === "assistant_budget_reservations").map(row => row.record)).toEqual([expect.objectContaining({ generation: "old-financial", state: "uncertain", ceiling_units: 40 })]);
  expect(JSON.stringify(records)).not.toContain("other-money");
});
test("installation-wide restore diagnostics survive a generation change without exporting another installation", async () => {
  for (const installation of [scope.installationId, "unrelated-private-installation"]) {
    await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold VALUES(?,?,?,1,?)").bind(installation, "restore-operation", "restored-generation", 1).run();
    await env.DB.prepare("INSERT INTO assistant_retention_active_generation VALUES(?,?,?,?,?,1)").bind(installation, "restored-generation", "a".repeat(64), "b".repeat(64), "activation-command").run();
  }
  const records: { table: string; record: Record<string, unknown> }[] = []; let cursor: string | undefined;
  do { const page = await archive.page({ cursor }); records.push(...page.parts.map(part => ({ table: part.table, record: JSON.parse(new TextDecoder().decode(bytes(part.data))) }))); cursor = page.nextCursor; } while (cursor);
  expect(records.filter(row => row.table === "assistant_retention_runtime_hold").map(row => row.record)).toEqual([expect.objectContaining({ installation_id: scope.installationId, active: 1, target_generation: "restored-generation" })]);
  expect(records.filter(row => row.table === "assistant_retention_active_generation").map(row => row.record)).toEqual([expect.objectContaining({ installation_id: scope.installationId, generation: "restored-generation" })]);
  expect(JSON.stringify(records)).not.toContain("unrelated-private-installation");
});
test("an unknown installation-only table is still rejected instead of receiving implicit global scope", async () => {
  await env.DB.prepare("CREATE TABLE assistant_export_unknown_installation_scope(installation_id TEXT,body TEXT)").run();
  try { await expect(archive.page()).rejects.toThrow("export_schema_unsupported:assistant_export_unknown_installation_scope"); }
  finally { await env.DB.prepare("DROP TABLE assistant_export_unknown_installation_scope").run(); }
});
test("schema columns cannot shadow the internal row cursor", async () => {
  await env.DB.prepare("CREATE TABLE assistant_export_shadow(installation_id TEXT,generation TEXT,rowid TEXT,body TEXT)").run();
  try { await expect(archive.page()).rejects.toThrow("export_schema_unsupported"); }
  finally { await env.DB.prepare("DROP TABLE assistant_export_shadow").run(); }
});
test("large binary columns are encoded without an unbounded argument expansion", async () => {
  const body = new Uint8Array(160000).fill(42);
  await env.DB.prepare("INSERT INTO assistant_export_fixture VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "binary", body).run();
  const collected: Uint8Array[] = []; let cursor: string | undefined;
  do { const page = await archive.page({ cursor }); collected.push(...page.parts.filter(part => part.table === "assistant_export_fixture").map(part => bytes(part.data))); cursor = page.nextCursor; } while (cursor);
  const complete = new Uint8Array(collected.reduce((size, part) => size + part.length, 0)); let offset = 0;
  for (const part of collected) { complete.set(part, offset); offset += part.length; }
  expect(bytes(JSON.parse(new TextDecoder().decode(complete)).body.blobBase64)).toEqual(body);
});
test("source archive transport tables are outside the host assistant catalog", async () => {
  await env.DB.prepare("INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,operation) VALUES(?,?,?,?,'upsert')").bind("source-epoch", scope.generation, "source-chat", "source-record").run();
  await env.DB.prepare("INSERT INTO assistant_bridge_cursors(epoch,generation,installation_id,target_generation) VALUES(?,?,?,?)").bind("source-epoch", scope.generation, scope.installationId, scope.generation).run();
  await record("Synthetic own assistant body");
  const tables: string[] = []; let cursor: string | undefined;
  do { const page = await archive.page({ cursor }); tables.push(...page.parts.map(part => part.table)); cursor = page.nextCursor; } while (cursor);
  expect(tables).toContain("assistant_export_fixture"); expect(tables).not.toContain("assistant_capture_changes"); expect(tables).not.toContain("assistant_bridge_cursors");
});
