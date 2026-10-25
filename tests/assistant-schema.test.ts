import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
// @ts-expect-error Vite loads SQL as text; the app TypeScript config has no raw module declaration.
import schema from "../assistant/migrations/0001_sources.sql?raw";

const hash = "a".repeat(64);
async function migrate() {
  // D1 exec() treats each line as a statement; prepare the shipped DDL blocks
  // instead, retaining trigger bodies as one statement.
  const statements = schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/)
    .filter((statement: string) => statement.trim());
  if (statements.length) await env.DB.batch(statements.map((sql: string) => env.DB.prepare(sql)));
}
beforeEach(migrate);

async function source(id: string, installation = "synthetic-installation") {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_sources
      (installation_id,generation,id,origin,origin_key,title,conversation_id,project_id)
      VALUES(?,'g1',?,'owner_note',?,'Same display name','conversation-a','project-a')`)
      .bind(installation, id, id),
    env.DB.prepare(`INSERT INTO assistant_source_versions
      (installation_id,generation,source_id,version,author_id,original_text,content_hash,occurred_at)
      VALUES(?,'g1',?,1,'synthetic-author','Original synthetic statement',?,100)`)
      .bind(installation, id, hash),
    env.DB.prepare(`INSERT INTO assistant_source_changes
      (installation_id,generation,source_id,revision,version,kind,changed_at)
      VALUES(?,'g1',?,1,1,'created',100)`).bind(installation, id),
  ]);
}

it("creates the canonical source schema on a new database", async () => {
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_sources'").first())
    .toEqual({ name: "assistant_sources" });
});

it("keeps homonymous sources and same IDs in different installations separate", async () => {
  await source("same-a");
  await source("same-b");
  await source("same-a", "another-synthetic-installation");
  const rows = await env.DB.prepare(`SELECT installation_id,id,audience FROM assistant_sources
    WHERE id IN ('same-a','same-b') ORDER BY installation_id,id`).all();
  expect(rows.results).toHaveLength(3);
  expect(rows.results.every((row) => row.audience === "owner")).toBe(true);
});

it("rejects duplicate versions and changing or deleting an immutable version", async () => {
  await source("immutable");
  await expect(env.DB.prepare(`INSERT INTO assistant_source_versions
    SELECT * FROM assistant_source_versions WHERE source_id='immutable'`).run()).rejects.toThrow();
  await expect(env.DB.prepare(`INSERT OR REPLACE INTO assistant_source_versions
    SELECT * FROM assistant_source_versions WHERE source_id='immutable'`).run()).rejects.toThrow();
  await expect(env.DB.prepare(`UPDATE assistant_source_versions SET original_text='changed'
    WHERE source_id='immutable'`).run()).rejects.toThrow();
  await expect(env.DB.prepare(`DELETE FROM assistant_source_versions
    WHERE source_id='immutable'`).run()).rejects.toThrow();
});

it("requires a version to belong to a source in the same installation and generation", async () => {
  await source("scoped");
  await expect(env.DB.prepare(`INSERT INTO assistant_source_versions
    (installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
    VALUES('other-installation','g1','scoped',1,'Synthetic text',?,100)`)
    .bind(hash).run()).rejects.toThrow();
  await expect(env.DB.prepare(`UPDATE assistant_sources SET current_version=99
    WHERE id='scoped'`).run()).rejects.toThrow();
  await expect(env.DB.prepare(`UPDATE assistant_sources SET current_version=NULL
    WHERE id='scoped' AND status='active'`).run()).rejects.toThrow();
});

it("atomically corrects then withdraws a source with explicit revision increments and changes", async () => {
  await source("revisioned");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_source_versions
      (installation_id,generation,source_id,version,author_id,original_text,content_hash,occurred_at)
      SELECT installation_id,generation,id,2,'synthetic-author','Corrected synthetic statement',?,200
      FROM assistant_sources WHERE id='revisioned' AND revision=1 AND status='active'`).bind("b".repeat(64)),
    env.DB.prepare(`UPDATE assistant_sources SET revision=revision+1,current_version=2
      WHERE id='revisioned' AND revision=1 AND status='active'`),
    env.DB.prepare(`INSERT INTO assistant_source_changes
      (installation_id,generation,source_id,revision,version,kind,changed_at)
      SELECT installation_id,generation,id,revision,current_version,'corrected',200
      FROM assistant_sources WHERE id='revisioned' AND revision=2`),
  ]);
  await env.DB.batch([
    env.DB.prepare(`UPDATE assistant_sources SET revision=revision+1,status='withdrawn'
      WHERE id='revisioned' AND revision=2 AND status='active'`),
    env.DB.prepare(`INSERT INTO assistant_source_changes
      (installation_id,generation,source_id,revision,version,kind,changed_at)
      SELECT installation_id,generation,id,revision,current_version,'withdrawn',300
      FROM assistant_sources WHERE id='revisioned' AND revision=3 AND status='withdrawn'`),
  ]);
  expect(await env.DB.prepare("SELECT revision,current_version,status FROM assistant_sources WHERE id='revisioned'").first())
    .toEqual({ revision: 3, current_version: 2, status: "withdrawn" });
  expect((await env.DB.prepare("SELECT revision,kind FROM assistant_source_changes WHERE source_id='revisioned' ORDER BY sequence").all()).results)
    .toEqual([{ revision: 1, kind: "created" }, { revision: 2, kind: "corrected" }, { revision: 3, kind: "withdrawn" }]);
  expect(await env.DB.prepare("SELECT original_text FROM assistant_source_versions WHERE source_id='revisioned' AND version=1").first())
    .toEqual({ original_text: "Original synthetic statement" });
});

it("rolls back a revision when publication fails", async () => {
  await source("rollback");
  await expect(env.DB.batch([
    env.DB.prepare("UPDATE assistant_sources SET revision=revision+1 WHERE id='rollback'"),
    env.DB.prepare("INSERT INTO assistant_source_versions SELECT * FROM assistant_source_versions WHERE source_id='rollback'"),
  ])).rejects.toThrow();
  expect(await env.DB.prepare("SELECT revision FROM assistant_sources WHERE id='rollback'").first())
    .toEqual({ revision: 1 });
});

it("purges withdrawn bodies while keeping tombstone and historical change metadata", async () => {
  await source("purge");
  await env.DB.batch([
    env.DB.prepare(`UPDATE assistant_sources SET status='withdrawn',current_version=NULL,revision=revision+1
      WHERE installation_id='synthetic-installation' AND generation='g1' AND id='purge' AND revision=1`),
    env.DB.prepare(`INSERT INTO assistant_source_changes
      (installation_id,generation,source_id,revision,version,kind,changed_at)
      VALUES('synthetic-installation','g1','purge',2,1,'withdrawn',300)`),
    env.DB.prepare(`DELETE FROM assistant_source_versions
      WHERE installation_id='synthetic-installation' AND generation='g1' AND source_id='purge'`),
  ]);
  expect(await env.DB.prepare("SELECT status,current_version,revision FROM assistant_sources WHERE id='purge'").first())
    .toEqual({ status: "withdrawn", current_version: null, revision: 2 });
  expect((await env.DB.prepare("SELECT version,kind FROM assistant_source_changes WHERE source_id='purge' ORDER BY sequence").all()).results)
    .toEqual([{ version: 1, kind: "created" }, { version: 1, kind: "withdrawn" }]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS bodies FROM assistant_source_versions WHERE source_id='purge'").first())
    .toEqual({ bodies: 0 });
  await expect(env.DB.prepare(`INSERT INTO assistant_source_versions
    (installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
    VALUES('synthetic-installation','g1','purge',1,'Stale synthetic publication',?,100)`)
    .bind(hash).run()).rejects.toThrow();
});

it("preserves records on migration replay and distinguishes read from applied progress", async () => {
  await source("replay");
  await migrate();
  expect(await env.DB.prepare("SELECT revision FROM assistant_sources WHERE id='replay'").first())
    .toEqual({ revision: 1 });
  await env.DB.prepare(`INSERT INTO assistant_change_cursors
    (installation_id,generation,consumer,read_sequence,applied_sequence)
    VALUES('synthetic-installation','g1','synthetic-extractor',5,2)`).run();
  expect(await env.DB.prepare("SELECT read_sequence,applied_sequence FROM assistant_change_cursors WHERE consumer='synthetic-extractor'").first())
    .toEqual({ read_sequence: 5, applied_sequence: 2 });
  await expect(env.DB.prepare("UPDATE assistant_change_cursors SET applied_sequence=6 WHERE consumer='synthetic-extractor'").run()).rejects.toThrow();
});
