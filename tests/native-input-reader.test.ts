import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { CaptureReader } from "../src/assistant-source-reader";
import { readNativeCaptureInput } from "../src/native-input-reader";
import { bridgeHash } from "../assistant/ingress";
import { readConversationActivity } from "../src/conversation-activity";

const secret = "native-input-synthetic-reader-secret-only";
const settings = (): Env => ({ ...env, OWNER_SUB: "synthetic-owner", INSTALLATION_EPOCH: "native-e",
  CONNECTION_GENERATION: "native-g", MAINTENANCE: "false", RUNTIME_CONFIG: "static", DEVELOPMENT: "true",
  ASSISTANT_READER_SECRET: secret });
const query = (sourceKind = "message", sourceId = "original") => ({ secret, sourceEpoch: "native-e",
  sourceGeneration: "native-g", chatId: "chat", sourceKind, sourceId });
const reader = (configuration = settings()) => new CaptureReader(createExecutionContext(), configuration);
const run = (sql: string) => env.DB.prepare(sql).run();
async function message(id: string, fromMe = false, text: string | null = "Exact body\n  preserved.") {
  await env.DB.prepare(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,author_id,from_me,kind,text,timestamp,received_at)
    VALUES(?,'chat','native-e','native-g',?,'peer',?,'text',?,10,20)`)
    .bind(id, `provider-${id}-must-not-leave`, fromMe ? 1 : 0, text).run();
}
beforeEach(async () => {
  await env.DB.exec(`DELETE FROM connection_state; DELETE FROM media_jobs; DELETE FROM media_derivatives;
    DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM approved_sends;
    DELETE FROM actions; DELETE FROM participants; DELETE FROM chats; DELETE FROM owner_message_originals;
    DELETE FROM assistant_capture_changes;`);
  await run(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
    VALUES('chat','native-e','native-g','synthetic-lid@lid','individual','Display name is not identity',1,10,10)`);
  await run(`INSERT INTO participants(id,epoch,generation,external_id,name)
    VALUES('peer','native-e','native-g','synthetic-peer@lid','Same display name')`);
  await env.DB.exec("DELETE FROM assistant_capture_changes; UPDATE sqlite_sequence SET seq=9 WHERE name='assistant_capture_changes';");
  await message("original");
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Native input has no external requests"); });
});
afterEach(() => vi.restoreAllMocks());

it("keeps original Source sequence 10 after incoming 11, with exact body and actual author evidence", async () => {
  await message("newer");
  const result = await reader().readNativeInput(query());
  expect(result).toMatchObject({ observation: "native_capture_input", state: "available", conversationKind: "private",
    sourceKind: "message", originalMessageId: "original", originalSequence: 10, watermark: 11,
    captureState: "enabled", text: "Exact body\n  preserved.", textState: "ready", fromMe: false,
    authorId: "peer", authorLabel: "Same display name", sourceVersion: 1 });
  expect(await reader().readNativeInput(query("message", "newer"))).toMatchObject({ originalSequence: 11 });
  expect(await readConversationActivity(settings(), { secret, sourceEpoch: "native-e", sourceGeneration: "native-g", chatId: "chat" }))
    .toMatchObject({ latestIncomingOriginalSequence: 11 });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("exposes an unmodified snapshot for the existing OriginGuard hash", async () => {
  const result = await reader().readNativeInput(query());
  if (result.state !== "available") throw new Error("fixture blocked");
  const snapshot = await reader().readSnapshot(query());
  expect(result.snapshot).toEqual(snapshot);
  expect(await bridgeHash([result.snapshot.sourceVersion ?? null, result.snapshot.access, result.snapshot.content]))
    .toBe(await bridgeHash([snapshot.sourceVersion ?? null, snapshot.access, snapshot.content]));
  expect(JSON.stringify(result)).not.toMatch(/provider-original|synthetic-lid@lid|synthetic-peer@lid|native-input-synthetic-reader-secret/);
});

it("returns owner manual sends with their original sequence after edits", async () => {
  await message("owner", true, "Owner reply");
  await run("UPDATE messages SET text='Owner edited',version=2 WHERE id='owner'");
  expect(await reader().readNativeInput(query("message", "owner"))).toMatchObject({ state: "available", fromMe: true,
    originalSequence: 11, text: "Owner edited", sourceVersion: 2, watermark: 12 });
  expect(await readConversationActivity(settings(), { secret, sourceEpoch: "native-e", sourceGeneration: "native-g", chatId: "chat" }))
    .toMatchObject({ lastOwnerOriginalSequence: 11 });
});

async function media(kind = "audio") {
  await env.DB.prepare("UPDATE messages SET kind=?,text=NULL WHERE id='original'").bind(kind).run();
  await env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,mime,size,sha256,object_key,state,source_url,created_at)
    VALUES('asset','chat','original','native-e','native-g',?,'application/octet-stream',100,?,'private/object','ready','https://provider.example/?token=secret',30)`)
    .bind(kind, "b".repeat(64)).run();
  await run(`INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at)
    VALUES('derivative','asset',1,'native-e','native-g','transcript','Exact derived text','ready',40)`);
}
it.each(["audio", "pdf"])("maps %s media and delayed derivatives to original message 10", async kind => {
  await message("newer");
  await media(kind);
  expect(await reader().readNativeInput(query())).toMatchObject({ state: "available", text: null, textState: "pending", originalSequence: 10 });
  expect(await reader().readNativeInput(query("media", "asset"))).toMatchObject({ state: "available", originalMessageId: "original",
    originalSequence: 10, text: null, textState: "pending" });
  const derivative = await reader().readNativeInput(query("derivative", "derivative"));
  expect(derivative).toMatchObject({ state: "available", originalMessageId: "original", originalSequence: 10,
    text: "Exact derived text", textState: "ready", sourceVersion: null, authorId: "peer" });
  expect(JSON.stringify(derivative)).not.toMatch(/provider.example|private\/object|token=secret/);
});

it("preserves unknown group/private author identity instead of deriving it from labels or chat IDs", async () => {
  await run("UPDATE messages SET author_id=NULL WHERE id='original'");
  expect(await reader().readNativeInput(query())).toMatchObject({ authorId: null, authorLabel: null, conversationKind: "private" });
  await run("UPDATE chats SET kind='group' WHERE id='chat'");
  expect(await reader().readNativeInput(query())).toMatchObject({ authorId: null, authorLabel: null, conversationKind: "group" });
});

it.each([
  ["UPDATE chats SET capture_enabled=0 WHERE id='chat'", "capture_disabled", "withdrawn"],
  ["UPDATE messages SET privacy_locked=1 WHERE id='original'", "privacy_protected", "withdrawn"],
  ["UPDATE messages SET deleted_at=99 WHERE id='original'", "source_withdrawn", "withdrawn"],
  ["UPDATE messages SET unavailable_reason='unsupported' WHERE id='original'", "message_unavailable", "blocked"],
])("denies current Source withdrawal/access state: %s", async (sql, reason, state) => {
  await run(sql);
  const result = await reader().readNativeInput(query());
  expect(result).toMatchObject({ state, reason });
  expect(result).not.toHaveProperty("text");
  expect(result).not.toHaveProperty("snapshot");
});

it("reports missing source, missing original sequence and unavailable text explicitly", async () => {
  expect(await reader().readNativeInput(query("message", "missing"))).toMatchObject({ state: "withdrawn", reason: "source_missing" });
  await run("UPDATE messages SET text=NULL WHERE id='original'");
  expect(await reader().readNativeInput(query())).toMatchObject({ state: "available", text: null, textState: "unavailable" });
  await run("DELETE FROM assistant_capture_changes WHERE source_id='original'");
  expect(await reader().readNativeInput(query())).toMatchObject({ state: "blocked", reason: "original_sequence_unknown" });
});

it("authenticates before parsing other fields or accessing D1", async () => {
  const prepare = vi.fn(() => { throw new Error("D1 must not be accessed"); });
  const configuration = { ...settings(), DB: { prepare } as unknown as D1Database };
  const input = { secret: "wrong", get sourceId(): string { throw new Error("Body must not be parsed"); } };
  await expect(readNativeCaptureInput(configuration, input)).rejects.toThrow("reader_denied");
  await expect(readNativeCaptureInput(configuration, { ...query(), sourceEpoch: "old" })).rejects.toThrow("reader_denied");
  expect(prepare).not.toHaveBeenCalled();
});

it("accepts only bounded, scoped message/media/derivative refs and honors maintenance", async () => {
  for (const overrides of [{ sourceKind: "conversation" }, { sourceId: "x".repeat(257) }, { sql: "SELECT *" }, { url: "https://provider.example" }])
    await expect(reader().readNativeInput({ ...query(), ...overrides })).rejects.toThrow("reader_invalid_input");
  await expect(reader().readNativeInput({ ...query(), sourceGeneration: "old" })).rejects.toThrow("reader_denied");
  expect(await reader({ ...settings(), MAINTENANCE: "true" }).readNativeInput(query())).toMatchObject({ state: "blocked", reason: "reader_unavailable" });
});

it("preserves valid Source text despite repetition in its proof, retaining the original Source snapshot limit", async () => {
  await env.DB.prepare("UPDATE messages SET text=? WHERE id='original'").bind("x".repeat(20000)).run();
  expect(await reader().readSnapshot(query())).toMatchObject({ state: "available" });
  const result = await reader().readNativeInput(query());
  expect(result).toMatchObject({ state: "available", text: "x".repeat(20000) });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeGreaterThan(32768);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(131072);
  await env.DB.prepare("UPDATE messages SET text=? WHERE id='original'").bind("x".repeat(40000)).run();
  expect(await reader().readNativeInput(query())).toMatchObject({ state: "blocked", reason: "snapshot_too_large" });
});

it.each(["text='changed'", "from_me=1", "author_id=NULL", "timestamp=42"])("denies changed snapshot pins during original-sequence lookup: %s", async update => {
  const db = env.DB;
  const proxy = new Proxy(db, { get(target, property) {
    if (property !== "prepare") return Reflect.get(target, property, target);
    return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("SELECT MIN(c.sequence) original_sequence")) return statement;
      return { bind: (...values: unknown[]) => ({ first: async (column: string) => {
        const sequence = await statement.bind(...values).first(column);
        await run(`UPDATE messages SET ${update} WHERE id='original'`);
        return sequence;
      } }) };
    };
  } });
  expect(await readNativeCaptureInput({ ...settings(), DB: proxy }, query())).toMatchObject({ state: "blocked", reason: "source_changed" });
});

it("rechecks live configuration and shared-key revocation after the snapshot proof", async () => {
  for (const change of ["CONNECTION_GENERATION", "MAINTENANCE", "ASSISTANT_READER_SECRET"] as const) {
    const configuration = settings();
    const db = env.DB;
    const proxy = new Proxy(db, { get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property, target);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SELECT MIN(c.sequence) original_sequence")) return statement;
        return { bind: (...values: unknown[]) => ({ first: async (column: string) => {
          const sequence = await statement.bind(...values).first(column);
          configuration[change] = change === "MAINTENANCE" ? "true" : "changed";
          return sequence;
        } }) };
      };
    } });
    configuration.DB = proxy;
    if (change === "MAINTENANCE") expect(await readNativeCaptureInput(configuration, query())).toMatchObject({ state: "blocked" });
    else await expect(readNativeCaptureInput(configuration, query())).rejects.toThrow("reader_denied");
  }
});
