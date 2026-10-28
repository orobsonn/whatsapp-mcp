import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { CaptureReader } from "../src/assistant-source-reader";

const secret = "synthetic-reader-secret-exclusive-tests";
const settings = () => ({ ...env, OWNER_SUB: "synthetic-owner", INSTALLATION_EPOCH: "reader-e",
  CONNECTION_GENERATION: "reader-g", MAINTENANCE: "false", RUNTIME_CONFIG: "static" as const,
  DEVELOPMENT: "true", ASSISTANT_READER_SECRET: secret });
const request = (sourceKind = "message", sourceId = "reader-message") => ({
  secret, sourceEpoch: "reader-e", sourceGeneration: "reader-g", chatId: "reader-chat", sourceKind, sourceId,
});
const reader = (configuration: Env = settings()) => new CaptureReader(createExecutionContext(), configuration);
const run = (sql: string) => env.DB.prepare(sql).run();
beforeEach(async () => {
  await env.DB.exec("DELETE FROM connection_state; DELETE FROM media_jobs; DELETE FROM media_derivatives; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM actions; DELETE FROM participants; DELETE FROM chats;");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
      VALUES('reader-chat','reader-e','reader-g','synthetic-address','individual','Synthetic conversation',1,10,10)`),
    env.DB.prepare(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at)
      VALUES('reader-message','reader-chat','reader-e','reader-g','synthetic-message',0,'audio','Synthetic captured content',10,10)`),
    env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,mime,size,sha256,object_key,state,source_url,created_at)
      VALUES('reader-media','reader-chat','reader-message','reader-e','reader-g','audio','audio/ogg',100,?,'private/do-not-return','ready','https://provider.example/private?token=synthetic',10)`)
      .bind("a".repeat(64)),
    env.DB.prepare(`INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at)
      VALUES('reader-derivative','reader-media',1,'reader-e','reader-g','transcript','Synthetic captured transcript','ready',10)`),
  ]);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Reader must not use network"); });
});
afterEach(() => vi.restoreAllMocks());
it('returns only the authenticated current Source stream head for a prospective pilot cutoff', async () => {
  const input = { secret, sourceEpoch: 'reader-e', sourceGeneration: 'reader-g' };
  const expected = await env.DB.prepare("SELECT COALESCE(MAX(sequence),0) n FROM assistant_capture_changes WHERE epoch='reader-e' AND generation='reader-g'").first<number>('n');
  expect(await reader().streamHead(input)).toEqual({observation:'capture_stream_head',state:'available',sourceEpoch:'reader-e',sourceGeneration:'reader-g',sequence:expected});
  await expect(reader().streamHead({...input,secret:'invalid'})).rejects.toThrow('reader_denied');
  await expect(reader().streamHead({...input,sourceGeneration:'old'})).rejects.toThrow('reader_denied');
  await expect(reader().streamHead({...input,sql:'SELECT *'})).rejects.toThrow('reader_invalid_input');
  expect(await reader({...settings(),MAINTENANCE:'true'}).streamHead(input)).toMatchObject({state:'blocked'});
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("authenticates a nominal read-only entrypoint and refuses arbitrary input", async () => {
  await expect(reader().readSnapshot({ ...request(), secret: "invalid" })).rejects.toThrow("reader_denied");
  await expect(reader().readSnapshot({ ...request(), sourceGeneration: "old-generation" })).rejects.toThrow("reader_denied");
  await expect(reader().readSnapshot({ ...request(), sql: "SELECT *", url: "https://provider.example" })).rejects.toThrow("reader_invalid_input");
  await expect(reader().readSnapshot({ ...request(), sourceId: "x".repeat(257) })).rejects.toThrow("reader_invalid_input");
  await expect(reader().readSnapshot({ ...request(), sourceKind: "arbitrary" })).rejects.toThrow("reader_invalid_input");
});
it("bootstraps only current installation affinity through the named reader capability", async () => {
  expect(await reader().installationAffinity({ secret })).toEqual({ observation: "capture_installation_affinity", state: "available", fence: { epoch: "reader-e", generation: "reader-g" } });
  await expect(reader().installationAffinity({ secret: "invalid" })).rejects.toThrow("reader_denied");
  await expect(reader().installationAffinity({ secret, sourceEpoch: "invented" })).rejects.toThrow("reader_invalid_input");
  await expect(reader().installationAffinity({ secret, sql: "SELECT *" })).rejects.toThrow("reader_invalid_input");
  expect(await reader({ ...settings(), MAINTENANCE: "true" }).installationAffinity({ secret })).toEqual({ observation: "capture_installation_affinity", state: "blocked", reason: "reader_unavailable" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("reads current content and conversation watermark without requiring a known author", async () => {
  const snapshot = await reader().readSnapshot(request());
  const latest = await env.DB.prepare("SELECT MAX(sequence) AS watermark FROM assistant_capture_changes WHERE epoch='reader-e' AND generation='reader-g' AND chat_id='reader-chat'").first();
  expect(snapshot).toMatchObject({ observation: "capture_snapshot", state: "available", sourceVersion: 1,
    watermark: latest!.watermark, content: { text: "Synthetic captured content", authorId: null, fromMe: false } });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("identifies private and group conversations in the same source snapshot", async () => {
  expect(await reader().readSnapshot(request())).toMatchObject({conversationKind:"private"});
  await run("UPDATE chats SET kind='group' WHERE id='reader-chat'");
  expect(await reader().readSnapshot(request("derivative","reader-derivative"))).toMatchObject({conversationKind:"group"});
});

it("returns media and derivative dependencies without provider URLs, keys or secrets", async () => {
  const media = await reader().readSnapshot(request("media", "reader-media"));
  expect(media).toMatchObject({ state: "available", content: { media: { id: "reader-media", version: 1, hash: "a".repeat(64) } } });
  const derivative = await reader().readSnapshot(request("derivative", "reader-derivative"));
  expect(derivative).toMatchObject({ state: "available", content: { text: "Synthetic captured transcript", messageVersion: 1, mediaVersion: 1 } });
  expect(JSON.stringify([media, derivative])).not.toMatch(/provider\.example|private\/do-not-return|source_url|object_key|synthetic-reader-secret/);
  await run("UPDATE media SET kind='pdf' WHERE id='reader-media'");
  expect((await reader().readSnapshot(request())).content?.media).toBeUndefined();
});

it("removes content after capture is disabled, privacy protection or withdrawal", async () => {
  await run("UPDATE chats SET capture_enabled=0 WHERE id='reader-chat'");
  for (const [kind, id] of [["message", "reader-message"], ["media", "reader-media"], ["derivative", "reader-derivative"], ["conversation", "reader-chat"]]) {
    const snapshot = await reader().readSnapshot(request(kind, id));
    expect(snapshot).toMatchObject({ state: "withdrawn", reason: "capture_disabled" });
    expect(snapshot.content).toBeUndefined();
  }
  await run("UPDATE chats SET capture_enabled=1 WHERE id='reader-chat'");
  await run("UPDATE messages SET privacy_locked=1 WHERE id='reader-message'");
  expect(await reader().readSnapshot(request())).toMatchObject({ state: "withdrawn", reason: "privacy_protected" });
  await run("UPDATE messages SET privacy_locked=0,deleted_at=20 WHERE id='reader-message'");
  expect(await reader().readSnapshot(request())).toMatchObject({ state: "withdrawn", reason: "source_withdrawn" });
});

it("distinguishes absence and incompatible media/derivative versions", async () => {
  expect(await reader().readSnapshot(request("message", "absent"))).toMatchObject({ state: "withdrawn", reason: "source_missing" });
  await run(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
    VALUES('other-reader-chat','reader-e','reader-g','synthetic-other','individual','Other conversation',1,10,10)`);
  expect(await reader().readSnapshot({ ...request("derivative", "reader-derivative"), chatId: "other-reader-chat" }))
    .toMatchObject({ state: "withdrawn", reason: "source_missing" });
  await run("UPDATE messages SET version=2 WHERE id='reader-message'");
  for (const [kind, id] of [["media", "reader-media"], ["derivative", "reader-derivative"]]) {
    const snapshot = await reader().readSnapshot(request(kind, id));
    expect(snapshot).toMatchObject({ state: "blocked", reason: "version_mismatch" });
    expect(snapshot.content).toBeUndefined();
  }
});

it("reports oversized content without truncation while later withdrawal is still readable", async () => {
  await env.DB.prepare("UPDATE media_derivatives SET text=? WHERE id='reader-derivative'").bind("x".repeat(40000)).run();
  const snapshot = await reader().readSnapshot(request("derivative", "reader-derivative"));
  expect(snapshot).toMatchObject({ state: "blocked", reason: "snapshot_too_large" });
  expect(snapshot.content).toBeUndefined();
  await run("UPDATE media_derivatives SET state='deleted' WHERE id='reader-derivative'");
  expect(await reader().readSnapshot(request("derivative", "reader-derivative")))
    .toMatchObject({ state: "withdrawn", reason: "source_withdrawn" });
});

it("uses the live encrypted connection generation instead of raw pending runtime configuration", async () => {
  const configuration = { ...settings(), RUNTIME_CONFIG: "database" as const, DEVELOPMENT: "false",
    CONNECTION_GENERATION: "pending", PUBLIC_ORIGIN: "https://reader.example", ENCRYPTION_KEY: btoa("k".repeat(32)) };
  const generation = "c".repeat(32), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("k".repeat(32)), "AES-GCM", false, ["encrypt"]);
  const payload = JSON.stringify({ instanceId: "synthetic-instance", instanceToken: "synthetic-token", clientToken: "synthetic-client",
    phone: "5511000000000", generation, webhookSecret: "d".repeat(64) });
  const aad = new TextEncoder().encode(JSON.stringify(["whatsapp-mcp/connection/v1", configuration.PUBLIC_ORIGIN, configuration.INSTALLATION_EPOCH]));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(payload));
  const cipher = `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
  await env.DB.prepare("INSERT INTO connection_state(id,epoch,cipher,state,attempt_id,step,created_at,updated_at) VALUES(1,'reader-e',?,'active','synthetic','done',10,10)").bind(cipher).run();
  await env.DB.prepare("UPDATE chats SET generation=? WHERE id='reader-chat'").bind(generation).run();
  await env.DB.prepare("UPDATE messages SET generation=? WHERE id='reader-message'").bind(generation).run();
  const snapshot = await reader(configuration).readSnapshot({ ...request(), sourceGeneration: generation });
  expect(snapshot).toMatchObject({ state: "available", sourceGeneration: generation, content: { text: "Synthetic captured content" } });
  expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-token|synthetic-client|5511000000000/);
  expect(await reader(configuration).installationAffinity({ secret })).toEqual({ observation: "capture_installation_affinity", state: "available", fence: { epoch: "reader-e", generation } });
  const affinity = JSON.stringify(await reader(configuration).installationAffinity({ secret }));
  expect(affinity).not.toMatch(/synthetic-token|synthetic-client|5511000000000|instanceId|cipher|ENCRYPTION_KEY/);
});

it("refuses a connection generation or pause changed during the bootstrap recheck", async () => {
  for (const field of ["CONNECTION_GENERATION", "MAINTENANCE", "ASSISTANT_READER_SECRET"] as const) {
    const configuration = settings(); let reads = 0;
    Object.defineProperty(configuration, field, { configurable: true, enumerable: true, get: () => {
      reads++; return reads > (field === "ASSISTANT_READER_SECRET" ? 3 : 1) ? field === "MAINTENANCE" ? "true" : "changed" : field === "MAINTENANCE" ? "false" : field === "CONNECTION_GENERATION" ? "reader-g" : secret;
    } });
    if (field === "ASSISTANT_READER_SECRET") await expect(reader(configuration).installationAffinity({ secret })).rejects.toThrow("reader_denied");
    else expect(await reader(configuration).installationAffinity({ secret })).toMatchObject({ state: "blocked" });
  }
});

it("uses the per-conversation watermark index", async () => {
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT MAX(sequence) FROM assistant_capture_changes WHERE epoch='reader-e' AND generation='reader-g' AND chat_id='reader-chat'").all();
  expect(plan.results.some((row) => String(row.detail).includes("assistant_capture_changes_chat"))).toBe(true);
});
