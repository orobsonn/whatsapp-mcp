import { createExecutionContext, env } from "cloudflare:test";
import { CaptureReader } from "../src/assistant-source-reader";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceAccess } from "../assistant/access";
import { JobQueue } from "../assistant/queue";
import { Conversations } from "../assistant/conversations";
import { receiveCapture } from "../assistant/ingress";
import { CaptureMaterializer } from "../assistant/materialize";
import { OriginGuard, type OriginScope, type ReaderQuery, type SnapshotReader } from "../assistant/origin-guard";
// @ts-expect-error Vite raw SQL import.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL import.
import policy from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite raw SQL import.
import inbox from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Vite raw SQL import.
import origins from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Vite raw SQL import.
import work from "../assistant/migrations/0003_work.sql?raw";
// @ts-expect-error Vite raw SQL import.
import jobs from "../assistant/migrations/0005_job_ledger.sql?raw";
// @ts-expect-error Vite raw SQL import.
import conversations from "../assistant/migrations/0011_conversations.sql?raw";
let scope: OriginScope;
let now: number;
const secret = "synthetic-exclusive-reader-bridge-secret";
afterEach(() => vi.restoreAllMocks());
let snapshots: Map<string, Record<string, any>>;
let reader: SnapshotReader;
let materializer: CaptureMaterializer;
let guard: OriginGuard;
const config = () => ({ ...scope });
const keys = () => [scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration];
const query = (sql: string, ...values: (string | number | null)[]) => env.DB.prepare(sql).bind(...values);
function snapshot(kind = "message", id = "message", watermark = 10, text = "Synthetic original") {
  return { observation: "capture_snapshot", state: "available", sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration,
    sourceKind: kind, sourceId: id, chatId: "chat", sourceVersion: kind === "derivative" ? null : 1, watermark,
    conversationKind: "private", access: { captureEnabled: true, captureSince: 0, discontinuous: false },
    content: kind === "conversation" ? { kind: "individual", name: "Synthetic conversation" } : {
      kind: kind === "derivative" ? "transcript" : "text", text, authorId: "author", authorName: "Synthetic author", fromMe: false,
      occurredAt: 10, receivedAt: 11, messageId: "message", messageVersion: 1,
    } };
}
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "capture-e", sourceGeneration: "capture-g" };
  now = 100;
  for (const schema of [sources, policy, work, inbox, jobs, origins, conversations]) {
    const statements = schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim());
    if (statements.length) await env.DB.batch(statements.map((part: string) => env.DB.prepare(part)));
  }
  snapshots = new Map([["message:message", snapshot()], ["conversation:chat", snapshot("conversation", "chat")]]);
  reader = { async readSnapshot(input) {
    expect(input.secret).toBe(secret);
    const value = snapshots.get(`${input.sourceKind}:${input.sourceId}`);
    if (!value) throw new Error("synthetic reader offline");
    return value;
  } };
  guard = new OriginGuard(env.DB, config, reader, secret);
  materializer = new CaptureMaterializer(env.DB, config, reader, secret, () => now);
});
async function event(sequence = 10, previousSequence = 0, sourceKind = "message", sourceId = "message", operation = "upsert") {
  const result = await receiveCapture(new Request("https://assistant.test/bridge", { method: "POST", headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ protocol: 1, ...scope, sequence, previousSequence, chatId: "chat", sourceKind, sourceId, operation, recordedAt: sequence }) }),
  { DB: env.DB, BRIDGE_SECRET: secret, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration,
    INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation });
  expect(result.status).toBe(200);
}
async function canonical() {
  return query("SELECT id,revision,current_version,state.original_text FROM assistant_sources s LEFT JOIN assistant_source_versions state ON state.installation_id=s.installation_id AND state.generation=s.generation AND state.source_id=s.id AND state.version=s.current_version WHERE s.installation_id=? AND s.generation=?", scope.installationId, scope.generation).first<{ id: string; revision: number; current_version: number; original_text: string }>();
}
function intercepted(callback: (batch: D1PreparedStatement[]) => Promise<void>, after = false): D1Database {
  return { prepare: env.DB.prepare.bind(env.DB), async batch(statements: D1PreparedStatement[]) {
    if (!after) await callback(statements);
    const result = await env.DB.batch(statements);
    if (after) await callback(statements);
    return result;
  } } as D1Database;
}
it("materializes a restricted WhatsApp source and its provenance atomically with the inbox", async () => {
  await event();
  expect(await materializer.drain()).toMatchObject([{ state: "applied" }]);
  expect(await canonical()).toMatchObject({ revision: 1, current_version: 1, original_text: "Synthetic original" });
  const source = await query("SELECT origin,audience FROM assistant_sources WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).first();
  expect(source).toEqual({ origin: "whatsapp", audience: "restricted" });
  expect(await materializer.progress()).toEqual({ received: 10, evaluated: 10, applied: 10, gaps: 0 });
  expect(await guard.check((await guard.fence((await canonical())!.id))!)).toBe(true);
});
it("preserves original and corrected versions while an old event observes current state", async () => {
  await event(); await materializer.drain();
  snapshots.set("message:message", { ...snapshot("message", "message", 30, "Corrected synthetic"), sourceVersion: 2 });
  snapshots.set("conversation:chat", snapshot("conversation", "chat", 30));
  await event(20, 10); await event(30, 20);
  await materializer.drain();
  expect(await canonical()).toMatchObject({ revision: 2, current_version: 2, original_text: "Corrected synthetic" });
  expect((await query("SELECT original_text,author_id FROM assistant_source_versions WHERE installation_id=? AND generation=? ORDER BY version", scope.installationId, scope.generation).all()).results)
    .toEqual([{ original_text: "Synthetic original", author_id: "author" }, { original_text: "Corrected synthetic", author_id: "author" }]);
});
it("stores media and derivative dependencies without downloading a file", async () => {
  const media = snapshot("media", "media");
  const mediaMetadata = { id: "media", version: 1, hash: "a".repeat(64), size: 100, mime: "audio/ogg" };
  media.content = { ...media.content, media: mediaMetadata } as any;
  snapshots.set("media:media", media);
  snapshots.set("derivative:derivative", { ...snapshot("derivative", "derivative", 20, "Synthetic transcript"), content: { ...snapshot().content, kind: "transcript", text: "Synthetic transcript", mediaVersion: 1, media: mediaMetadata } });
  await event(10, 0, "media", "media"); await materializer.drain();
  snapshots.set("conversation:chat", snapshot("conversation", "chat", 20));
  await event(20, 10, "derivative", "derivative"); await materializer.drain();
  const rows = await query("SELECT dependencies_json FROM assistant_origin_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all<{ dependencies_json: string }>();
  expect(rows.results).toHaveLength(2);
  expect(rows.results.some((row) => JSON.parse(row.dependencies_json).mediaVersion === 1)).toBe(true);
});
it("keeps a gap visible while a later authenticated withdrawal bypasses a failed reader", async () => {
  snapshots.clear();
  await event(); expect(await materializer.drain()).toMatchObject([{ state: "blocked" }]);
  await event(20, 10, "message", "message", "withdraw");
  expect(await materializer.drain()).toMatchObject([{ state: "applied" }]);
  expect(await materializer.progress()).toEqual({ received: 20, evaluated: 20, applied: 0, gaps: 1 });
  expect(await query("SELECT status,current_version FROM assistant_sources WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).first())
    .toEqual({ status: "withdrawn", current_version: null });
  now = 1200;
  expect(await materializer.retry(1)).toMatchObject([{ state: "applied" }]);
  expect(await materializer.progress()).toEqual({ received: 20, evaluated: 20, applied: 20, gaps: 0 });
});
it("does not resurrect a tombstone even if replay later returns available content", async () => {
  await event(10, 0, "message", "message", "withdraw"); await materializer.drain();
  snapshots.set("message:message", snapshot("message", "message", 20));
  snapshots.set("conversation:chat", snapshot("conversation", "chat", 20));
  await event(20, 10); await materializer.drain();
  expect(await canonical()).toMatchObject({ current_version: null });
  expect((await query("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toEqual([]);
});
it("reconciles an application commit with a lost acknowledgement without duplicating its version", async () => {
  await event();
  let lose = true;
  const db = intercepted(async () => { if (lose) { lose = false; throw new Error("lost commit ack"); } }, true);
  await expect(new CaptureMaterializer(db, config, reader, secret, () => now).process(10)).rejects.toThrow("materialization_commit_uncertain");
  expect(await materializer.process(10)).toMatchObject({ state: "applied" });
  expect((await query("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toHaveLength(1);
  expect(await materializer.progress()).toEqual({ received: 10, evaluated: 10, applied: 10, gaps: 0 });
});
it("rolls back every publication when the local source fence fails at admission", async () => {
  await event(); await materializer.drain();
  const source = (await canonical())!;
  snapshots.set("message:message", snapshot("message", "message", 20, "Uncommitted correction"));
  snapshots.set("conversation:chat", snapshot("conversation", "chat", 20));
  await event(20, 10);
  let injected = false;
  const db = intercepted(async () => {
    if (!injected) { injected = true; await query("UPDATE assistant_sources SET status='withdrawn',revision=2 WHERE installation_id=? AND generation=? AND id=?", scope.installationId, scope.generation, source.id).run(); }
  });
  expect(await new CaptureMaterializer(db, config, reader, secret, () => now).process(20)).toMatchObject({ state: "stale" });
  expect((await query("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toHaveLength(1);
  expect(await query("SELECT application_state FROM assistant_capture_inbox WHERE installation_id=? AND generation=? AND sequence=20", scope.installationId, scope.generation).first())
    .toEqual({ application_state: "pending" });
});
it("blocks consumption after withdrawal between the snapshot and its canonical commit", async () => {
  await event();
  const db = intercepted(async () => { snapshots.set("message:message", { ...snapshot(), state: "withdrawn", reason: "source_withdrawn", content: undefined }); });
  await new CaptureMaterializer(db, config, reader, secret, () => now).drain();
  const source = (await canonical())!;
  const fence = (await guard.fence(source.id))!;
  expect(await guard.check(fence)).toBe(false);
});
it("invalidates old draft fences when the conversation watermark or policy changes", async () => {
  await event(); await materializer.drain();
  const fence = (await guard.fence((await canonical())!.id))!;
  snapshots.set("message:message", snapshot("message", "message", 20));
  snapshots.set("conversation:chat", snapshot("conversation", "chat", 20));
  expect(await guard.check(fence)).toBe(false);
  snapshots.set("message:message", snapshot()); snapshots.set("conversation:chat", snapshot("conversation", "chat"));
  await query("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded) VALUES(?,?,'chat','private',1)", scope.installationId, scope.generation).run();
  expect(await guard.check(fence)).toBe(false);
});
it("closes the conversation gate after access withdrawal even after an earlier gap", async () => {
  await event(); await materializer.drain();
  const fence = (await guard.fence((await canonical())!.id))!;
  snapshots.delete("message:message"); await event(20, 10); await materializer.drain();
  snapshots.set("conversation:chat", { ...snapshot("conversation", "chat", 30), state: "withdrawn", reason: "capture_disabled", access: { captureEnabled: false, captureSince: 0, discontinuous: true }, content: undefined });
  await event(30, 20, "conversation", "chat", "access"); await materializer.drain();
  expect(await guard.check(fence)).toBe(false);
  expect(await materializer.progress()).toEqual({ received: 30, evaluated: 30, applied: 10, gaps: 1 });
});
it("rejects old operational or origin generations before applying a snapshot", async () => {
  await event();
  const old = { ...scope };
  reader.readSnapshot = async () => { scope = { ...scope, sourceGeneration: "new-origin" }; return snapshot(); };
  expect(await materializer.process(10)).toMatchObject({ state: "stale" });
  expect((await query("SELECT id FROM assistant_sources WHERE installation_id=? AND generation=?", old.installationId, old.generation).all()).results).toEqual([]);
  scope = { ...old, generation: "new-generation" };
  expect(await materializer.process(10)).toMatchObject({ state: "missing" });
});
it("persists oversize gaps without truncation and never publishes reader supplied ACL fields", async () => {
  const large = snapshot(); large.content!.text = "x".repeat(40000);
  snapshots.set("message:message", large); await event();
  expect(await materializer.drain()).toMatchObject([{ state: "blocked" }]);
  expect(await canonical()).toBeNull();
  const current = snapshot(); current.content = { ...current.content, role: "owner", audience: "public" } as any;
  snapshots.set("message:message", current); now = 1200; await materializer.retry(1);
  expect(await query("SELECT audience FROM assistant_sources WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).first())
    .toEqual({ audience: "restricted" });
});
it("copies a reader observation before asynchronous hashing yields", async () => {
  await event();
  const original = snapshot();
  reader.readSnapshot = async () => original;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    original.content!.text = "Mutated untrusted observation";
    return digest(algorithm, data);
  });
  await materializer.drain();
  expect(await canonical()).toMatchObject({ original_text: "Synthetic original" });
});
it("integrates the real strict CaptureReader, bridge, canonical store and current-origin guard", async () => {
  const chatId = `${scope.installationId}-chat`, messageId = `${scope.installationId}-message`;
  await env.DB.batch([
    query(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
      VALUES(?,?,?,?,'individual','Synthetic integrated chat',1,10,10)`, chatId, scope.sourceEpoch, scope.sourceGeneration, chatId),
    query(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at)
      VALUES(?,?,?,?,?,0,'text','Synthetic integrated text',10,10)`, messageId, chatId, scope.sourceEpoch, scope.sourceGeneration, messageId),
  ]);
  const watermark = (await query("SELECT MAX(sequence) AS value FROM assistant_capture_changes WHERE epoch=? AND generation=? AND chat_id=?", scope.sourceEpoch, scope.sourceGeneration, chatId).first<{ value: number }>())!.value;
  const result = await receiveCapture(new Request("https://assistant.test/bridge", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({
    protocol: 1, ...scope, sequence: watermark, previousSequence: 0, chatId, sourceId: messageId, sourceKind: "message", operation: "upsert", recordedAt: 10,
  }) }), { DB: env.DB, BRIDGE_SECRET: secret, BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration,
    INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation });
  expect(result.status).toBe(200);
  const real = new CaptureReader(createExecutionContext(), { ...env, OWNER_SUB: "synthetic-owner", INSTALLATION_EPOCH: scope.sourceEpoch,
    CONNECTION_GENERATION: scope.sourceGeneration, RUNTIME_CONFIG: "static", DEVELOPMENT: "true", MAINTENANCE: "false", ASSISTANT_READER_SECRET: secret });
  const materialize = new CaptureMaterializer(env.DB, config, real, secret, () => now);
  expect(await materialize.drain()).toMatchObject([{ state: "applied" }]);
  const verifier = new OriginGuard(env.DB, config, real, secret);
  const fence = (await verifier.fence((await canonical())!.id))!;
  expect(await verifier.check(fence)).toBe(true);
  await query("UPDATE messages SET deleted_at=20 WHERE id=?", messageId).run();
  expect(await verifier.check(fence)).toBe(false);
});
it("does not overwrite a newer conversation access observation with an older snapshot", async () => {
  snapshots.set("conversation:chat", { ...snapshot("conversation", "chat", 90), state: "withdrawn", access: { captureEnabled: false, captureSince: 0, discontinuous: true }, content: undefined });
  await event(30, 0, "conversation", "chat", "access"); await materializer.drain();
  snapshots.set("conversation:chat", snapshot("conversation", "chat", 50));
  await event(40, 30, "conversation", "chat", "access");
  // Reader watermark may lead received events; an older later read cannot reopen access.
  expect(await materializer.drain()).toMatchObject([{ state: "blocked" }]);
  expect(await query(`SELECT watermark,access_state FROM assistant_origin_conversations WHERE installation_id=? AND generation=?`, scope.installationId, scope.generation).first())
    .toEqual({ watermark: 90, access_state: "withdrawn" });
});
it("admits only one concurrent application and does not append a second canonical version", async () => {
  await event();
  await Promise.all([materializer.process(10), new CaptureMaterializer(env.DB, config, reader, secret, () => now).process(10)]);
  expect((await query("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toHaveLength(1);
  expect((await query("SELECT sequence FROM assistant_materialization_results WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toHaveLength(1);
  expect(await materializer.progress()).toEqual({ received: 10, evaluated: 10, applied: 10, gaps: 0 });
});
it("rolls back canonical data, admission, inbox and cursors on a D1 transaction failure", async () => {
  await event();
  const db = intercepted(async (statements) => {
    statements.push(query("INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at) VALUES(?,?,'missing',1,1,'created',100)", scope.installationId, scope.generation));
  });
  await expect(new CaptureMaterializer(db, config, reader, secret, () => now).process(10)).rejects.toThrow("materialization_commit_uncertain");
  expect(await canonical()).toBeNull();
  expect((await query("SELECT sequence FROM assistant_materialization_results WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toEqual([]);
  expect(await materializer.progress()).toEqual({ received: 10, evaluated: 0, applied: 0, gaps: 0 });
});
it("keeps historical context usable with a fresh fence after a newer message invalidates its draft", async () => {
  await event(); await materializer.drain();
  const first = (await canonical())!.id;
  const oldFence = (await guard.fence(first))!;
  snapshots.set("message:message", snapshot("message", "message", 20));
  snapshots.set("message:second", snapshot("message", "second", 20, "A newer message"));
  await event(20, 10, "message", "second"); await materializer.drain();
  expect(await guard.check(oldFence)).toBe(false);
  const freshFence = await guard.fence(first);
  expect(freshFence).not.toBeNull();
  expect(await guard.check(freshFence!)).toBe(true);
});
it("fails closed for changed capture boundaries or dependencies despite unchanged text", async () => {
  await event(); await materializer.drain();
  const fence = (await guard.fence((await canonical())!.id))!;
  const changed = snapshot(); changed.access.captureSince = 5;
  snapshots.set("message:message", changed);
  expect(await guard.check(fence)).toBe(false);
  const dependency = snapshot(); dependency.content!.messageVersion = 2;
  snapshots.set("message:message", dependency);
  expect(await guard.check(fence)).toBe(false);
  snapshots.clear();
  expect(await guard.check(fence)).toBe(false);
});
it("uses explicit group policy and refuses a mismatched private policy", async () => {
  snapshots.set("message:message", { ...snapshot(), conversationKind: "group" });
  await event(); await materializer.drain();
  const source = (await canonical())!.id;
  expect(await guard.fence(source)).toBeNull();
  await query("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'chat','private')", scope.installationId, scope.generation).run();
  expect(await guard.fence(source)).toBeNull();
  await query("UPDATE assistant_conversation_policies SET kind='group',group_mode='observe',revision=2 WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).run();
  expect(await guard.check((await guard.fence(source))!)).toBe(true);
});
it("applies an authenticated withdrawal whose event predates a newer observed conversation watermark", async () => {
  await event(); await materializer.drain();
  snapshots.set("message:second", snapshot("message", "second", 90, "Newer context"));
  await event(20, 10, "message", "second"); await materializer.drain();
  snapshots.clear();
  await event(50, 20, "message", "message", "withdraw");
  expect(await materializer.drain()).toMatchObject([{ state: "applied" }]);
  expect(await query("SELECT s.status FROM assistant_sources s JOIN assistant_source_origins o ON o.installation_id=s.installation_id AND o.generation=s.generation AND o.canonical_id=s.id WHERE o.installation_id=? AND o.generation=? AND o.source_id='message'", scope.installationId, scope.generation).first())
    .toEqual({ status: "withdrawn" });
});
it("withdraws every canonical source on capture-off before ACL reads or queue admission", async () => {
  await event(); await materializer.drain();
  const first = (await canonical())!.id;
  snapshots.set("message:second", snapshot("message", "second", 20, "Second source"));
  await event(20, 10, "message", "second"); await materializer.drain();
  const queue = new JobQueue(env.DB, scope);
  await new Conversations(env.DB, config).replay("chat");
  await queue.enqueue({ kind: "reasoning", dedupeKey: "before-capture-off", sourceId: first, sourceRevision: 1, request: "Synthetic reasoning" }, now);
  const lease = (await queue.claim(now, 100))!;
  snapshots.set("conversation:chat", { ...snapshot("conversation", "chat", 30), state: "withdrawn", access: { captureEnabled: false, captureSince: 0, discontinuous: true }, content: undefined });
  await event(30, 20, "conversation", "chat", "access"); await materializer.drain();
  const rows = await query("SELECT id,status,current_version,revision FROM assistant_sources WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all();
  expect(rows.results).toHaveLength(2);
  expect(rows.results.every((row) => row.status === "withdrawn" && row.current_version === null && row.revision === 2)).toBe(true);
  expect(await new SourceAccess(env.DB, scope).read({ kind: "owner" }, first)).toBeNull();
  expect(await queue.admit(lease, now)).toBeNull();
  expect((await query("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toHaveLength(2);
  expect((await query("SELECT kind FROM assistant_source_changes WHERE installation_id=? AND generation=? AND kind='withdrawn'", scope.installationId, scope.generation).all()).results).toHaveLength(2);
});
it("bounds an unresponsive reader, persists the gap and still applies later withdrawal", async () => {
  let resolveReader!: (value: unknown) => void;
  reader.readSnapshot = () => new Promise((resolve) => { resolveReader = resolve; });
  await event(); await event(20, 10, "message", "message", "withdraw");
  const bounded = new CaptureMaterializer(env.DB, config, reader, secret, () => now, 10);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([bounded.drain(), new Promise<string>((resolve) => { timer = setTimeout(() => resolve("reader_hung"), 100); })]);
  clearTimeout(timer);
  expect(result).toMatchObject([{ state: "blocked" }, { state: "applied" }]);
  expect(await materializer.progress()).toEqual({ received: 20, evaluated: 20, applied: 0, gaps: 1 });
  resolveReader(snapshot());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await canonical()).toMatchObject({ current_version: null });
  expect((await query("SELECT version FROM assistant_source_versions WHERE installation_id=? AND generation=?", scope.installationId, scope.generation).all()).results).toEqual([]);
});
