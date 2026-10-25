import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
// @ts-expect-error Vite raw SQL import; no app config changes.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL import; no app config changes.
import work from "../assistant/migrations/0003_work.sql?raw";

async function migrate(sql: string) {
  const parts = sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part) => part.trim());
  if (parts.length) await env.DB.batch(parts.map((part) => env.DB.prepare(part)));
}
beforeEach(async () => { await migrate(sources); await migrate(work); });
const run = (sql: string) => env.DB.prepare(sql).run();
async function followUp(id: string, mission: string | null = null) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key)
      VALUES('work-test','g1',?,'owner_note',?)`).bind(`${id}-source`, `${id}-source`),
    env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
      VALUES('work-test','g1',?,1,'Synthetic follow-up request',?,10)`).bind(`${id}-source`, "a".repeat(64)),
  ]);
  await env.DB.prepare(`INSERT INTO assistant_follow_ups
    (installation_id,generation,id,version,mission_id,source_id,source_revision,origin,conversation_id,purpose,due_at,timezone,precision,state,next_evaluation_at)
    VALUES('work-test','g1',?,1,?,?,1,'owner_request','synthetic-chat','Synthetic return',100,'UTC','exact','scheduled',100)`)
    .bind(id, mission, `${id}-source`).run();
}

it("creates work tables without depending on the identity policy migration", async () => {
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='assistant_follow_ups'").first())
    .toEqual({ name: "assistant_follow_ups" });
});

it("persists a follow-up without a mission and preserves it on migration replay", async () => {
  await followUp("standalone");
  await migrate(work);
  expect(await env.DB.prepare("SELECT mission_id,version,state FROM assistant_follow_ups WHERE id='standalone'").first())
    .toEqual({ mission_id: null, version: 1, state: "scheduled" });
});

it("deduplicates occurrences per follow-up version and date", async () => {
  await followUp("occurrences");
  await run(`INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at)
    VALUES('work-test','g1','occurrence-a','occurrences',1,100)`);
  await expect(run(`INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at)
    VALUES('work-test','g1','occurrence-duplicate','occurrences',1,100)`)).rejects.toThrow();
  await run(`INSERT INTO assistant_follow_ups(installation_id,generation,id,version,source_id,source_revision,origin,conversation_id,purpose,timezone,next_evaluation_at)
    VALUES('work-test','g1','occurrences',2,'occurrences-source',1,'owner_request','synthetic-chat','Rescheduled return','UTC',200)`);
  await run(`INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at)
    VALUES('work-test','g1','occurrence-v2','occurrences',2,200)`);
  await expect(run(`INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at)
    VALUES('work-test','g1','occurrence-null','occurrences',2,NULL)`)).rejects.toThrow();
});

it("separates simulated job completion from the follow-up obligation", async () => {
  await followUp("shadow-fup");
  await run(`INSERT INTO assistant_missions(installation_id,generation,id,objective,source_id,source_revision)
    VALUES('work-test','g1','mission','Synthetic objective','shadow-fup-source',1)`);
  await run("UPDATE assistant_follow_ups SET mission_id='mission' WHERE id='shadow-fup'");
  await run(`INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at)
    VALUES('work-test','g1','shadow-occurrence','shadow-fup',1,100)`);
  await run(`INSERT INTO assistant_jobs(installation_id,generation,id,kind,dedupe_key,occurrence_id,next_attempt_at)
    VALUES('work-test','g1','shadow-job','follow_up','shadow-work','shadow-occurrence',100)`);
  await run("UPDATE assistant_jobs SET state='shadow_completed' WHERE id='shadow-job'");
  expect(await env.DB.prepare(`SELECT j.id AS job_id,o.follow_up_id,f.state,m.state AS mission_state FROM assistant_jobs j
    JOIN assistant_fup_occurrences o ON o.installation_id=j.installation_id AND o.generation=j.generation AND o.id=j.occurrence_id
    JOIN assistant_follow_ups f ON f.installation_id=o.installation_id AND f.generation=o.generation AND f.id=o.follow_up_id AND f.version=o.follow_up_version
    JOIN assistant_missions m ON m.installation_id=f.installation_id AND m.generation=f.generation AND m.id=f.mission_id WHERE j.id='shadow-job'`).first())
    .toEqual({ job_id: "shadow-job", follow_up_id: "shadow-fup", state: "scheduled", mission_state: "draft" });
  await expect(run("UPDATE assistant_jobs SET state='delivered' WHERE id='shadow-job'")).rejects.toThrow();
  await expect(run("UPDATE assistant_fup_occurrences SET state='sent' WHERE id='shadow-occurrence'")).rejects.toThrow();
});

it("rejects cross-generation occurrence references and invalid timing fields", async () => {
  await followUp("isolated");
  await expect(run(`INSERT INTO assistant_fup_occurrences(installation_id,generation,id,follow_up_id,follow_up_version,due_at)
    VALUES('work-test','other-generation','cross-generation','isolated',1,100)`)).rejects.toThrow();
  await expect(run("UPDATE assistant_follow_ups SET recurrence_limit=0 WHERE id='isolated'")).rejects.toThrow();
  await expect(run("UPDATE assistant_follow_ups SET window_end=50 WHERE id='isolated'")).rejects.toThrow();
});

it("queries a bounded overdue batch through its due index", async () => {
  await run(`INSERT INTO assistant_jobs(installation_id,generation,id,kind,dedupe_key,next_attempt_at)
    VALUES('due-test','g1','due','review','due',10),('due-test','g1','future','review','future',200)`);
  const sql = "SELECT id FROM assistant_jobs WHERE installation_id='due-test' AND generation='g1' AND state='pending' AND next_attempt_at<=100 ORDER BY next_attempt_at,id LIMIT 1";
  expect((await env.DB.prepare(sql).all()).results).toEqual([{ id: "due" }]);
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  expect(plan.results.some((row) => String(row.detail).includes("assistant_jobs_due"))).toBe(true);
});
