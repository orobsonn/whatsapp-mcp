import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { Conversations } from "../assistant/conversations";
import { jobConversationFence } from "../assistant/conversations";
import { JobQueue } from "../assistant/queue";
import { JobController } from "../assistant/jobs";
import { receiveCapture } from "../assistant/ingress";
import { CaptureMaterializer } from "../assistant/materialize";
import type { OriginScope } from "../assistant/origin-guard";
// @ts-expect-error Vite raw SQL import.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL import.
import policy from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite raw SQL import.
import work from "../assistant/migrations/0003_work.sql?raw";
// @ts-expect-error Vite raw SQL import.
import inbox from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Vite raw SQL import.
import jobs from "../assistant/migrations/0005_job_ledger.sql?raw";
// @ts-expect-error Vite raw SQL import.
import origins from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Vite raw SQL import.
import conversations from "../assistant/migrations/0011_conversations.sql?raw";
let scope: OriginScope; let controller: Conversations;
const keys = () => [scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration];
const sql = (query: string, ...values: (string | number | null)[]) => env.DB.prepare(query).bind(...values);
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "archive-e", sourceGeneration: "archive-g" };
  for (const schema of [sources, policy, work, inbox, jobs, origins, conversations]) {
    const parts = schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim());
    if (parts.length) await env.DB.batch(parts.map((part: string) => env.DB.prepare(part)));
  }
  controller = new Conversations(env.DB, () => scope);
});
async function seed(count = 1, kind = "private", gap = -1) {
  await env.DB.batch([
    sql("INSERT INTO assistant_capture_streams VALUES(?,?,?,?,?,?)", ...keys(), count * 3, gap < 0 ? count * 3 : 0),
    sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,?,?,'available')", ...keys(), "chat", count * 3, kind),
    sql("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,conversation_id,audience) VALUES(?,?,'canonical','whatsapp','message','chat','restricted')", scope.installationId, scope.generation),
    sql("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,'canonical',1,'Current synthetic original',?,0)", scope.installationId, scope.generation, "a".repeat(64)),
    sql("INSERT INTO assistant_source_origins VALUES(?,?,?,?,'message','message','chat','canonical',?,?,0)", ...keys(), count * 3, "b".repeat(64)),
    sql("INSERT INTO assistant_origin_versions VALUES(?,?,'canonical',1,2,?,?,?)", scope.installationId, scope.generation, count * 3, "b".repeat(64), JSON.stringify({ fromMe: true, authorId: "owner", messageId: "message", messageVersion: 2 })),
  ]);
  for (let start = 1; start <= count; start += 50) {
    const batch: D1PreparedStatement[] = [];
    for (let index = start; index <= Math.min(count, start + 49); index++) {
      batch.push(sql(`INSERT INTO assistant_capture_inbox VALUES(?,?,?,?,?,?,'chat','message','message','upsert',?,?,0,?)`,
        ...keys(), index * 3, (index - 1) * 3, index, "c".repeat(64), index === gap ? "blocked" : "applied"));
      batch.push(sql(`INSERT INTO assistant_materialization_results VALUES(?,?,?,?,?,?,?, ?,1,?,0,?,?)`,
        ...keys(), index * 3, crypto.randomUUID(), index === gap ? "blocked" : "applied", index === gap ? "media_unavailable" : null, index === gap ? 1000 : null, count * 3, "b".repeat(64)));
    }
    await env.DB.batch(batch);
  }
  await controller.ensure("chat");
}
it.each([101, 1050])("replays %i sparse changes across bounded pages and restarts", async (count) => {
  await seed(count);
  let pages = 0; let result;
  do { result = await new Conversations(env.DB, () => scope).replay("chat", 100); pages++; } while (result.evaluated < count * 3);
  expect(pages).toBe(Math.ceil(count / 100));
  expect(result).toMatchObject({ applied: count * 3, gaps: 0, coverage: "observed_only" });
  expect((await controller.outcomes("chat", 0, 1))[0]).toMatchObject({ coalesced: 1, observed_watermark: count * 3, observed_revision: 1, style_eligible: 0 });
});
it("pauses processing while transport and materialization continue independently", async () => {
  await seed(2);
  const before = await controller.state("chat");
  await controller.setPaused("chat", before.revision, true);
  const secret = "synthetic-paused-bridge-exclusive-secret";
  const receipt = await receiveCapture(new Request("https://assistant.test/bridge", { method: "POST", headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ protocol: 1, ...scope, sequence: 9, previousSequence: 6, chatId: "chat", sourceId: "message", sourceKind: "message", operation: "upsert", recordedAt: 9 }) }),
  { DB: env.DB, BRIDGE_SECRET: secret, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation });
  expect(receipt.status).toBe(200);
  const reader = { async readSnapshot() { return { observation: "capture_snapshot", state: "available", ...scope, chatId: "chat", sourceId: "message", sourceKind: "message",
    sourceVersion: 3, watermark: 9, conversationKind: "private", access: { captureEnabled: true, captureSince: 0, discontinuous: false },
    content: { kind: "text", text: "New original while paused", messageId: "message", messageVersion: 3, fromMe: false, occurredAt: 9 } }; } };
  expect(await new CaptureMaterializer(env.DB, () => scope, reader, secret, () => 100).drain()).toMatchObject([{ state: "applied" }]);
  expect(await controller.replay("chat")).toMatchObject({ state: "paused", evaluated: 0 });
  expect(await sql("SELECT read_sequence,applied_sequence FROM assistant_capture_streams WHERE installation_id=?", scope.installationId).first()).toEqual({ read_sequence: 9, applied_sequence: 9 });
  const paused = await controller.state("chat");
  await controller.setPaused("chat", paused.revision, false);
  expect(await controller.replay("chat")).toMatchObject({ state: "ready", applied: 9 });
});
it("keeps delayed media as a gap without jumping the applied prefix", async () => {
  await seed(3, "private", 2);
  await sql("UPDATE assistant_capture_inbox SET source_kind='media',source_id='media' WHERE installation_id=? AND sequence=6", scope.installationId).run();
  expect(await controller.replay("chat")).toMatchObject({ evaluated: 9, applied: 3, gaps: 1, state: "pending" });
  expect((await controller.outcomes("chat"))[1]).toMatchObject({ state: "gap", reason: "media_unavailable" });
  const reader = { async readSnapshot() { return { observation: "capture_snapshot", state: "available", ...scope, sourceKind: "media", sourceId: "media", chatId: "chat", sourceVersion: 1,
    watermark: 9, conversationKind: "private", access: { captureEnabled: true, captureSince: 0, discontinuous: false },
    content: { kind: "audio", messageId: "message", messageVersion: 1, media: { id: "media", version: 1, hash: "d".repeat(64), size: 20, mime: "audio/ogg" } } }; } };
  expect(await new CaptureMaterializer(env.DB, () => scope, reader, "synthetic-reader-exclusive-secret", () => 5000).process(6, true)).toMatchObject({ state: "applied" });
  expect(await controller.retryGaps("chat")).toMatchObject({ evaluated: 9, applied: 9, gaps: 0 });
});
it("uses current observation explicitly and never treats fromMe as human-style proof", async () => {
  await seed(2); await controller.replay("chat");
  expect((await controller.outcomes("chat"))[0]).toMatchObject({ observed_version: 1, observed_watermark: 6, coalesced: 1, style_eligible: 0, authorship: "unknown" });
});
it("honors private exclusions and group modes while retaining control-event metadata", async () => {
  await seed(1, "group");
  expect(await controller.replay("chat")).toMatchObject({ mode: "ignore", applied: 3 });
  await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'chat','group',0,'respond',1)", scope.installationId, scope.generation).run();
  expect(await controller.replay("chat")).toMatchObject({ mode: "respond", coverageFrom: 3 });
  await sql("UPDATE assistant_conversation_policies SET group_mode='observe',revision=2 WHERE installation_id=?", scope.installationId).run();
  expect(await controller.replay("chat")).toMatchObject({ mode: "observe" });
  await sql("UPDATE assistant_conversation_policies SET excluded=1,revision=3 WHERE installation_id=?", scope.installationId).run();
  expect(await controller.replay("chat")).toMatchObject({ mode: "ignore" });
});
it("invalidates old draft fences on pause/resume and fences queue admission", async () => {
  await seed(); await controller.replay("chat");
  const queue = new JobQueue(env.DB, scope);
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "draft", sourceId: "canonical", sourceRevision: 1, request: "Synthetic reasoning" }, 100);
  const lease = (await queue.claim(100, 10))!;
  const before = await controller.fence("chat");
  await controller.setPaused("chat", before!.revision, true);
  const paused = await controller.state("chat");
  await controller.setPaused("chat", paused.revision, false);
  expect(await controller.check(before!)).toBe(false);
  let calls = 0;
  const worker = new JobController(queue, { async execute() { calls++; return "Synthetic result"; }, async lookup() { return { state: "not_found" }; } }, () => 100);
  expect(await worker.process(lease)).toBe("blocked");
  expect(calls).toBe(0);
  expect(await queue.ledger(job.id)).toMatchObject({ state: "prepared" });
});
it("retains the receipt but rejects publication after pause inside provider execution", async () => {
  await seed(); await controller.replay("chat");
  const queue = new JobQueue(env.DB, scope);
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "race", sourceId: "canonical", sourceRevision: 1, request: "Synthetic reasoning" }, 100);
  const worker = new JobController(queue, { async execute() { const state = await controller.state("chat"); await controller.setPaused("chat", state.revision, true); return "Paid truth conserved"; }, async lookup() { return { state: "not_found" }; } }, () => 100);
  expect(await worker.process((await queue.claim(100, 10))!)).toBe("blocked");
  expect(await queue.receipt(job.id)).toBe("Paid truth conserved");
});
it("allows only one concurrent replay CAS and isolates operational generations", async () => {
  await seed(2);
  const results = await Promise.all([controller.replay("chat"), controller.replay("chat")]);
  expect(results.filter((result) => result.state !== "stale")).toHaveLength(1);
  expect(await new Conversations(env.DB, () => ({ ...scope, generation: "other" })).ensure("chat")).toBeNull();
});
function beforeMutation(fragment: string, change: () => Promise<unknown>): D1Database {
  return new Proxy(env.DB, { get(db, property) {
    if (property === "prepare") return (query: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "first" && query.includes(fragment)) return async (...args: Parameters<D1PreparedStatement["first"]>) => { await change(); return target.first(...args); };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      return wrap(db.prepare(query));
    };
    const value = Reflect.get(db, property); return typeof value === "function" ? value.bind(db) : value;
  } });
}
it.each(["admission", "publication"])("checks pause inside the actual %s mutation", async (stage) => {
  await seed(); await controller.replay("chat");
  const queue = new JobQueue(env.DB, scope);
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "atomic", sourceId: "canonical", sourceRevision: 1, request: "Synthetic reasoning" }, 100);
  const lease = (await queue.claim(100, 10))!;
  if (stage === "publication") expect(await queue.admit(lease, 100)).not.toBeNull();
  const db = beforeMutation(stage === "admission" ? "SET state='attempting'" : "SET state='shadow_completed'", async () => {
    const state = await controller.state("chat"); await controller.setPaused("chat", state.revision, true);
  });
  const guarded = new JobQueue(db, scope);
  if (stage === "admission") expect(await guarded.admit(lease, 100)).toBeNull();
  else { expect(await guarded.complete(lease, "Synthetic receipt", 100)).toBe(false); expect(await guarded.receipt(job.id)).toBe("Synthetic receipt"); }
});
it("preserves private default attendance and explicit exclusion even for owner jobs", async () => {
  await seed(); expect(await controller.replay("chat")).toMatchObject({ mode: "attend" });
  const queue = new JobQueue(env.DB, scope);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "excluded", sourceId: "canonical", sourceRevision: 1, request: "Synthetic request" }, 100);
  const lease = (await queue.claim(100, 10))!;
  await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'chat','private',1,'ignore',1)", scope.installationId, scope.generation).run();
  expect(await queue.admit(lease, 100)).toBeNull();
  expect(await controller.replay("chat")).toMatchObject({ mode: "ignore" });
});
it("does not drop access or withdrawal events under ignore mode", async () => {
  await seed(2, "group");
  await env.DB.batch([
    sql("UPDATE assistant_capture_inbox SET source_kind='conversation',source_id='chat',operation='access' WHERE installation_id=? AND sequence=3", scope.installationId),
    sql("UPDATE assistant_capture_inbox SET operation='withdraw' WHERE installation_id=? AND sequence=6", scope.installationId),
  ]);
  expect(await controller.replay("chat")).toMatchObject({ applied: 6, mode: "ignore" });
  expect(await controller.outcomes("chat")).toHaveLength(2);
});
it("bounds input and refuses control from an extractor", async () => {
  await seed();
  await expect(controller.replay("chat", 101)).rejects.toThrow("conversation_page_limit");
  await expect(new Conversations(env.DB, () => scope, { kind: "extractor" }).setPaused("chat", 1, true)).rejects.toThrow("owner_required");
  expect(await controller.ensure("never-observed")).toBeNull();
});
it("keeps the same chat independent under a new origin generation", async () => {
  await seed(); await controller.replay("chat");
  const queue = new JobQueue(env.DB, scope);
  await queue.enqueue({ kind: "reasoning", dedupeKey: "old-origin", sourceId: "canonical", sourceRevision: 1, request: "Synthetic request" }, 100);
  const lease = (await queue.claim(100, 10))!;
  const next = { ...scope, sourceGeneration: "archive-g-next" };
  await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,?,?,'available')", ...[next.installationId, next.generation, next.sourceEpoch, next.sourceGeneration], "chat", 0, "private").run();
  expect(await new Conversations(env.DB, () => next).ensure("chat")).not.toBeNull();
  expect(await jobConversationFence(env.DB, next, "chat", false)).toMatchObject({ sourceGeneration: next.sourceGeneration });
  expect(await jobConversationFence(env.DB, { installationId: scope.installationId, generation: scope.generation }, "chat", false)).toBeNull();
  expect(await jobConversationFence(env.DB, next, "chat", true, "canonical")).toBeNull();
  expect(await new JobQueue(env.DB, next).admit(lease, 100)).toBeNull();
});
it("keeps a pending withdrawal as a canonical gap even under ignore", async () => {
  await seed(1, "group", 1);
  await sql("UPDATE assistant_capture_inbox SET operation='withdraw' WHERE installation_id=?", scope.installationId).run();
  expect(await controller.replay("chat")).toMatchObject({ applied: 0, gaps: 1 });
  await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'chat','group',0,'respond',1)", scope.installationId, scope.generation).run();
  expect(await controller.replay("chat")).toMatchObject({ state: "pending" });
});
it("invalidates a precapture absence fence as soon as materialization observes the chat", async () => {
  await seed();
  await sql("DELETE FROM assistant_conversations WHERE installation_id=?", scope.installationId).run();
  await sql("DELETE FROM assistant_origin_conversations WHERE installation_id=?", scope.installationId).run();
  await sql("UPDATE assistant_sources SET origin='owner_note',conversation_id=NULL,audience='public' WHERE installation_id=?", scope.installationId).run();
  const queue = new JobQueue(env.DB, { installationId: scope.installationId, generation: scope.generation },
    { kind: "interlocutor", provider: "whatsapp", address: "synthetic", conversationId: "new-chat", conversationKind: "private", action: "reply_text" });
  await queue.enqueue({ kind: "reasoning", dedupeKey: "before-observation", sourceId: "canonical", sourceRevision: 1, request: "Synthetic request" }, 100);
  const lease = (await queue.claim(100, 10))!;
  await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,?,?,'available')", ...keys(), "new-chat", 0, "private").run();
  expect(await queue.admit(lease, 100)).toBeNull();
});
