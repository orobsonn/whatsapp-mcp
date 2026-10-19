import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("migração group preserva nonces consumidos, validade, índice e restrições", async () => {
  const old = env.TEST_MIGRATIONS.find((m) => m.name === "0002_auth.sql")!;
  const next = env.TEST_MIGRATIONS.find(
    (m) => m.name === "0006_group_management.sql",
  )!;
  // Exercise the actual shipped SQL in a separate namespace, leaving runtime auth intact.
  const rename = (sql: string) =>
    sql
      .replace(/\bauth_nonces_group\b/g, "migration_nonces_group")
      .replace(/\bauth_nonces\b/g, "migration_nonces")
      .replace(/\bauth_nonces_expiry\b/g, "migration_nonces_expiry");
  for (const sql of old.queries) await env.DB.prepare(rename(sql)).run();
  await env.DB.prepare(
    "INSERT INTO migration_nonces(nonce_hash,sub,epoch,purpose,resource_id,envelope_hash,payload_json,expires_at,consumed_at) VALUES('legacy','owner','epoch','send','a','hash','{}',12345,12300)",
  ).run();
  const auth = next.queries.filter((q) => /auth_nonces/.test(q));
  for (const sql of auth) await env.DB.prepare(rename(sql)).run();
  expect(
    await env.DB.prepare(
      "SELECT purpose,expires_at,consumed_at,payload_json FROM migration_nonces WHERE nonce_hash='legacy'",
    ).first(),
  ).toEqual({
    purpose: "send",
    expires_at: 12345,
    consumed_at: 12300,
    payload_json: "{}",
  });
  await env.DB.prepare(
    "INSERT INTO migration_nonces(nonce_hash,sub,epoch,purpose,resource_id,envelope_hash,expires_at) VALUES('group','owner','epoch','group','g','hash',12345)",
  ).run();
  await expect(
    env.DB.prepare(
      "INSERT INTO migration_nonces(nonce_hash,sub,epoch,purpose,resource_id,envelope_hash,expires_at) VALUES('invalid','owner','epoch','arbitrary','g','hash',12345)",
    ).run(),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='migration_nonces_expiry'",
    ).first(),
  ).toEqual({ name: "migration_nonces_expiry" });
});
