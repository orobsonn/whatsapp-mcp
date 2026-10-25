import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { SourceController, sourceTextHash, type SourceInput } from "../assistant/sources";
import { SourceAccess, type TrustedActor } from "../assistant/access";
// @ts-expect-error Vite raw SQL import.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL import.
import policy from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite raw SQL import.
import admissions from "../assistant/migrations/0007_source_controls.sql?raw";
let scope: { installationId: string; generation: string };
let owner: SourceController;
let access: SourceAccess;
const ownerActor: TrustedActor = { kind: "owner" };
const guest: TrustedActor = { kind: "interlocutor", provider: "whatsapp", address: "address", conversationId: "conversation", conversationKind: "private", action: "reply_text", mandateId: "mandate" };
const input = (originKey = "note", audience: "owner" | "restricted" | "public" = "owner"): SourceInput => ({
  originKey, text: "Original synthetic statement", authorId: "author", authorLabel: "Synthetic author", occurredAt: 100, audience,
});
const sql = (query: string, ...values: (string | number | null)[]) => env.DB.prepare(query).bind(scope.installationId, scope.generation, ...values);
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1" };
  for (const schema of [sources, policy, admissions]) {
    const statements = schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim());
    if (statements.length) await env.DB.batch(statements.map((part: string) => env.DB.prepare(part)));
  }
  owner = new SourceController(env.DB, scope, ownerActor, () => 150);
  access = new SourceAccess(env.DB, scope, () => 150);
});
async function sharedFixture(sourceId: string, projectId: string | null = null) {
  const proof = await owner.create(input("proof"));
  await env.DB.batch([
    sql("INSERT INTO assistant_people VALUES(?,?,'person','Synthetic person')"),
    sql("INSERT INTO assistant_provider_identities VALUES(?,?,'whatsapp','address','person',?,1,'owner_confirmed',100)", proof.id),
    sql("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'conversation','private')"),
    sql(`INSERT INTO assistant_mandates(installation_id,generation,id,version,conversation_id,project_id,purpose,status,issued_at,expires_at)
      VALUES(?,?,'mandate',1,'conversation',?,'Synthetic assistance','active',100,200)`, projectId),
    sql("INSERT INTO assistant_mandate_actions VALUES(?,?,'mandate',1,'reply_text')"),
    sql("INSERT INTO assistant_mandate_sources VALUES(?,?,'mandate',1,?)", sourceId),
  ]);
  return proof;
}
it("keeps default owner notes private even with identity, mandate and matching project membership", async () => {
  await sql("INSERT INTO assistant_projects VALUES(?,?,'project','Synthetic project')").run();
  const source = await owner.create({ ...input(), projectId: "project" });
  await sharedFixture(source.id, "project");
  await sql("INSERT INTO assistant_project_memberships VALUES(?,?,'membership','project','person','member',100,NULL)").run();
  expect(await access.read(guest, source.id)).toBeNull();
  expect((await access.read(ownerActor, source.id))?.text).toBe("Original synthetic statement");
});
it("allows public context for an unknown person under private attendance defaults", async () => {
  const source = await owner.create(input("note", "public"));
  expect((await access.read(guest, source.id))?.text).toBe("Original synthetic statement");
  await sql("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded) VALUES(?,?,'conversation','private',1)").run();
  expect(await access.read(guest, source.id)).toBeNull();
  expect(await access.read({ ...guest, conversationId: "group", conversationKind: "group" }, source.id)).toBeNull();
});
it("denies project membership alone and requires the explicit current mandate source and action", async () => {
  const source = await owner.create(input("note", "restricted"));
  expect(await access.read(guest, source.id)).toBeNull();
  await sharedFixture(source.id);
  expect((await access.read(guest, source.id))?.text).toBe("Original synthetic statement");
  await sql("DELETE FROM assistant_mandate_actions WHERE installation_id=? AND generation=?").run();
  expect(await access.read(guest, source.id)).toBeNull();
});
it("preserves the old version and attribution while correcting with a CAS revision", async () => {
  const source = await owner.create(input());
  const corrected = await owner.correct(source.id, 1, { text: "Corrected synthetic statement", occurredAt: 150 });
  expect(corrected).toMatchObject({ revision: 2, version: 2 });
  expect(await access.read(ownerActor, source.id, 1)).toBeNull();
  expect((await access.read(ownerActor, source.id, 2))?.text).toBe("Corrected synthetic statement");
  expect((await sql("SELECT version,author_id,author_label,original_text FROM assistant_source_versions WHERE installation_id=? AND generation=? AND source_id=? ORDER BY version", source.id).all()).results)
    .toEqual([
      { version: 1, author_id: "author", author_label: "Synthetic author", original_text: "Original synthetic statement" },
      { version: 2, author_id: "author", author_label: "Synthetic author", original_text: "Corrected synthetic statement" },
    ]);
});
it("admits exactly one concurrent correction against the same revision", async () => {
  const source = await owner.create(input());
  const results = await Promise.allSettled([
    owner.correct(source.id, 1, { text: "Correction A", occurredAt: 150 }),
    owner.correct(source.id, 1, { text: "Correction B", occurredAt: 150 }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await access.read(ownerActor, source.id))?.fence.source.revision).toBe(2);
  expect((await sql("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=? AND source_id=?", source.id).all()).results).toHaveLength(2);
});
it("keeps create retries idempotent after correction and rejects conflicting content or metadata", async () => {
  const source = await owner.create(input());
  await owner.correct(source.id, 1, { text: "Corrected", occurredAt: 150 });
  expect((await owner.create(input())).id).toBe(source.id);
  await expect(owner.create({ ...input(), authorId: "different-author" })).rejects.toThrow("source_origin_conflict");
  await expect(owner.create({ ...input(), text: "Different" })).rejects.toThrow("source_origin_conflict");
});
it("blocks withdrawn sources and invalidates access fences after an audience change", async () => {
  const source = await owner.create(input("note", "public"));
  const read = (await access.read(guest, source.id))!;
  expect(await access.revalidate(guest, read.fence)).toBe(true);
  await owner.changeAudience(source.id, 1, "owner");
  expect(await access.revalidate(guest, read.fence)).toBe(false);
  await owner.withdraw(source.id, 2);
  expect(await access.read(ownerActor, source.id)).toBeNull();
});
it.each(["revoked", "expired"])("ignores an older active mandate when its latest version is %s", async (state) => {
  const source = await owner.create(input("note", "restricted"));
  await sharedFixture(source.id);
  expect(await access.read(guest, source.id)).not.toBeNull();
  await sql(`INSERT INTO assistant_mandates(installation_id,generation,id,version,conversation_id,purpose,status,issued_at,expires_at)
    VALUES(?,?,'mandate',2,'conversation','New mandate',?,100,?)`, state === "revoked" ? "revoked" : "active", state === "expired" ? 140 : 200).run();
  expect(await access.read(guest, source.id)).toBeNull();
});
it("invalidates restricted context when its identity proof is withdrawn", async () => {
  const source = await owner.create(input("note", "restricted"));
  const proof = await sharedFixture(source.id);
  const read = (await access.read(guest, source.id))!;
  await owner.withdraw(proof.id, 1);
  expect(await access.revalidate(guest, read.fence)).toBe(false);
});
it("rejects all extractor mutations and ignores an owner role embedded in the payload", async () => {
  const source = await owner.create(input());
  const extractor = new SourceController(env.DB, scope, { kind: "extractor" }, () => 150);
  await expect(extractor.create({ ...input("injection"), role: "owner" } as SourceInput)).rejects.toThrow("owner_required");
  await expect(extractor.correct(source.id, 1, { text: "Injected", occurredAt: 150 })).rejects.toThrow("owner_required");
  await expect(extractor.changeAudience(source.id, 1, "public")).rejects.toThrow("owner_required");
  await expect(extractor.withdraw(source.id, 1)).rejects.toThrow("owner_required");
  expect(await access.read({ kind: "extractor" }, source.id)).toBeNull();
});
it("invalidates the serialized fence on a relevant policy revision", async () => {
  const source = await owner.create(input("note", "public"));
  const first = (await access.read(guest, source.id))!;
  await sql("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'conversation','private')").run();
  expect(await access.revalidate(guest, JSON.parse(JSON.stringify(first.fence)))).toBe(false);
  const second = (await access.read(guest, source.id))!;
  await sql("UPDATE assistant_conversation_policies SET revision=2,excluded=1 WHERE installation_id=? AND generation=?").run();
  expect(await access.revalidate(guest, second.fence)).toBe(false);
});
it("allows restricted WhatsApp conversation context but never relabels owner notes as WhatsApp", async () => {
  const source = await owner.create({ ...input("note", "restricted"), conversationId: "conversation", origin: "whatsapp" } as SourceInput);
  expect(await access.read(guest, source.id)).toBeNull();
  // Simulates the separate trusted materializer, not input interpretation.
  await sql("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?", source.id).run();
  expect(await access.read(guest, source.id)).not.toBeNull();
  expect(await access.read({ ...guest, conversationId: "another" }, source.id)).toBeNull();
});
it("applies a UTF-8 byte cap before persisting source text", async () => {
  await expect(owner.create({ ...input(), text: "😀".repeat(9000) })).rejects.toThrow("source_text_too_large");
  expect((await sql("SELECT id FROM assistant_sources WHERE installation_id=? AND generation=?").all()).results).toEqual([]);
});
it("rejects restricted sharing with a mismatched mandate project, source or action", async () => {
  await env.DB.batch([
    sql("INSERT INTO assistant_projects VALUES(?,?,'project-a','A')"),
    sql("INSERT INTO assistant_projects VALUES(?,?,'project-b','B')"),
  ]);
  const source = await owner.create({ ...input("note", "restricted"), projectId: "project-a" });
  await sharedFixture(source.id, "project-b");
  await sql("INSERT INTO assistant_project_memberships VALUES(?,?,'membership','project-a','person','member',100,NULL)").run();
  expect(await access.read(guest, source.id)).toBeNull();
  await sql("UPDATE assistant_mandates SET project_id='project-a' WHERE installation_id=? AND generation=?").run();
  expect(await access.read(guest, source.id)).not.toBeNull();
  expect(await access.read({ ...guest, action: "reply_audio" }, source.id)).toBeNull();
  await sql("DELETE FROM assistant_mandate_sources WHERE installation_id=? AND generation=?").run();
  expect(await access.read(guest, source.id)).toBeNull();
});
it("preserves one canonical source under concurrent idempotent creates", async () => {
  const created = await Promise.all([owner.create(input()), owner.create(input())]);
  expect(created[0].id).toBe(created[1].id);
  expect((await sql("SELECT source_id FROM assistant_source_changes WHERE installation_id=? AND generation=?").all()).results).toHaveLength(1);
});
it("returns the service-computed body hash and rejects a fence in another namespace", async () => {
  const source = await owner.create({ ...input(), text: "abc" });
  const read = (await access.read(ownerActor, source.id))!;
  expect(read.fence.source.hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const other = new SourceAccess(env.DB, { ...scope, generation: "g2" }, () => 150);
  expect(await other.read(ownerActor, source.id)).toBeNull();
  expect(await other.revalidate(ownerActor, read.fence)).toBe(false);
});
it("owns creation text and metadata while its body hash is awaiting", async () => {
  const draft = input("creation-before-await");
  const pending = owner.create(draft);
  draft.text = "Changed by caller while hashing";
  draft.authorLabel = "Changed attribution";
  draft.audience = "public";
  const created = await pending;
  const read = (await access.read(ownerActor, created.id))!;
  expect(read.text).toBe("Original synthetic statement");
  expect(read.authorLabel).toBe("Synthetic author");
  expect(read.fence.source.hash).toBe(await sourceTextHash(read.text!));
  expect(await access.read(guest, created.id)).toBeNull();
});
it("owns correction text and occurrence time while its body hash is awaiting", async () => {
  const source = await owner.create(input());
  const draft = { text: "Correction before await", occurredAt: 150 };
  const pending = owner.correct(source.id, 1, draft);
  draft.text = "Changed by caller while hashing";
  draft.occurredAt = 999;
  await pending;
  const read = (await access.read(ownerActor, source.id))!;
  expect(read.text).toBe("Correction before await");
  expect(read.occurredAt).toBe(150);
  expect(read.fence.source.hash).toBe(await sourceTextHash(read.text!));
});
it("rejects a previously authorized fence after its mandate expires", async () => {
  const source = await owner.create(input("note", "restricted"));
  await sharedFixture(source.id);
  const read = (await access.read(guest, source.id))!;
  const later = new SourceAccess(env.DB, scope, () => 200);
  expect(await later.revalidate(guest, read.fence)).toBe(false);
});
