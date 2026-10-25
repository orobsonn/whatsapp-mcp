import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
// @ts-expect-error Vite raw SQL import, without changing the app's TypeScript config.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL import, without changing the app's TypeScript config.
import policies from "../assistant/migrations/0002_identity_policy.sql?raw";

async function migrate(sql: string) {
  const parts = sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part) => part.trim());
  if (parts.length) await env.DB.batch(parts.map((part) => env.DB.prepare(part)));
}
beforeEach(async () => {
  await migrate(sources); await migrate(policies);
  // The test database persists between cases; remove only these fixtures.
  const tables = ["mandate_actions", "mandate_sources", "mandates", "project_memberships",
    "provider_identities", "conversation_policies", "projects", "people"];
  await env.DB.batch([
    ...tables.map((table) => env.DB.prepare(`DELETE FROM assistant_${table} WHERE installation_id IN ('policy-test','other-test')`)),
    env.DB.prepare("UPDATE assistant_sources SET status='withdrawn',current_version=NULL WHERE installation_id='policy-test'"),
    env.DB.prepare("DELETE FROM assistant_source_versions WHERE installation_id='policy-test'"),
    env.DB.prepare("DELETE FROM assistant_source_changes WHERE installation_id='policy-test'"),
    env.DB.prepare("DELETE FROM assistant_sources WHERE installation_id='policy-test'"),
  ]);
});
const run = (sql: string) => env.DB.prepare(sql).run();
async function fixture() {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key)
      VALUES('policy-test','g1','proof','owner_note','proof')`),
    env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
      VALUES('policy-test','g1','proof',1,'Synthetic identity evidence',?,100)`).bind("a".repeat(64)),
    env.DB.prepare(`INSERT INTO assistant_people VALUES('policy-test','g1','p1','Same name'),('policy-test','g1','p2','Same name')`),
    env.DB.prepare(`INSERT INTO assistant_projects VALUES('policy-test','g1','project','Synthetic project')`),
    env.DB.prepare(`INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind)
      VALUES('policy-test','g1','private','private'),('policy-test','g1','group','group')`),
  ]);
}

it("creates the identity policy schema", async () => {
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='assistant_people'").first())
    .toEqual({ name: "assistant_people" });
});

it("separates names and rejects conflicting provider identities within a generation", async () => {
  await fixture();
  expect((await env.DB.prepare("SELECT id FROM assistant_people WHERE display_name='Same name'").all()).results).toHaveLength(2);
  await run(`INSERT INTO assistant_provider_identities VALUES('policy-test','g1','whatsapp','synthetic-address','p1','proof',1,'owner_confirmed',100)`);
  await expect(run(`INSERT INTO assistant_provider_identities VALUES('policy-test','g1','whatsapp','synthetic-address','p2','proof',1,'owner_confirmed',100)`)).rejects.toThrow();
  await run(`INSERT INTO assistant_people VALUES('policy-test','g2','p1','Same name')`);
  await expect(run(`INSERT INTO assistant_provider_identities VALUES('policy-test','g2','whatsapp','synthetic-address','p1','proof',1,'owner_confirmed',100)`)).rejects.toThrow();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key) VALUES('policy-test','g2','proof','owner_note','proof')"),
    env.DB.prepare("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES('policy-test','g2','proof',1,'Synthetic proof',?,100)").bind("b".repeat(64)),
    env.DB.prepare(`INSERT INTO assistant_provider_identities VALUES('policy-test','g2','whatsapp','synthetic-address','p1','proof',1,'provider_verified',100)`),
  ]);
});

it("keeps membership dates sane and rejects cross-namespace relationships", async () => {
  await fixture();
  await run(`INSERT INTO assistant_project_memberships VALUES('policy-test','g1','member','project','p1','collaborator',100,200)`);
  await expect(run(`INSERT INTO assistant_project_memberships VALUES('policy-test','g1','bad-time','project','p2','collaborator',200,100)`)).rejects.toThrow();
  await run(`INSERT INTO assistant_projects VALUES('other-test','g1','outside','Synthetic project')`);
  await expect(run(`INSERT INTO assistant_project_memberships VALUES('policy-test','g1','bad-project','outside','p1','collaborator',100,NULL)`)).rejects.toThrow();
});

it("records private attendance by default while explicit exclusion overrides it", async () => {
  await fixture();
  expect(await env.DB.prepare("SELECT effective_mode FROM assistant_conversation_modes WHERE conversation_id='private'").first())
    .toEqual({ effective_mode: "attend" });
  await run("UPDATE assistant_conversation_policies SET excluded=1,revision=revision+1 WHERE conversation_id='private'");
  expect(await env.DB.prepare("SELECT effective_mode FROM assistant_conversation_modes WHERE conversation_id='private'").first())
    .toEqual({ effective_mode: "ignore" });
});

it("requires explicit group participation and keeps exclusion restrictive", async () => {
  await fixture();
  expect(await env.DB.prepare("SELECT effective_mode FROM assistant_conversation_modes WHERE conversation_id='group'").first())
    .toEqual({ effective_mode: "ignore" });
  await run("UPDATE assistant_conversation_policies SET group_mode='respond' WHERE conversation_id='group'");
  expect(await env.DB.prepare("SELECT effective_mode FROM assistant_conversation_modes WHERE conversation_id='group'").first())
    .toEqual({ effective_mode: "respond" });
  await run("UPDATE assistant_conversation_policies SET excluded=1 WHERE conversation_id='group'");
  expect(await env.DB.prepare("SELECT effective_mode FROM assistant_conversation_modes WHERE conversation_id='group'").first())
    .toEqual({ effective_mode: "ignore" });
});

it("persists mandate version and expiry without implicitly granting actions", async () => {
  await fixture();
  await run(`INSERT INTO assistant_mandates(installation_id,generation,id,version,conversation_id,purpose,issued_at,expires_at)
    VALUES('policy-test','g1','mandate',1,'private','Synthetic assistance',100,200)`);
  expect(await env.DB.prepare("SELECT version,status,expires_at FROM assistant_mandates WHERE id='mandate'").first())
    .toEqual({ version: 1, status: "draft", expires_at: 200 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS actions FROM assistant_mandate_actions").first()).toEqual({ actions: 0 });
  await expect(run("INSERT INTO assistant_mandates SELECT * FROM assistant_mandates")).rejects.toThrow();
  await expect(run("UPDATE assistant_mandates SET expires_at=issued_at WHERE id='mandate'")).rejects.toThrow();
  await expect(run(`INSERT INTO assistant_mandate_actions VALUES('policy-test','g1','mandate',1,'execute_sql')`)).rejects.toThrow();
  await run(`INSERT INTO assistant_mandate_actions VALUES('policy-test','g1','mandate',1,'reply_text')`);
  await run(`INSERT INTO assistant_mandate_sources VALUES('policy-test','g1','mandate',1,'proof')`);
  await expect(run(`INSERT INTO assistant_mandate_sources VALUES('policy-test','g1','mandate',2,'proof')`)).rejects.toThrow();
  await expect(run(`INSERT INTO assistant_mandate_sources VALUES('policy-test','g1','mandate',1,'unknown-source')`)).rejects.toThrow();
});
