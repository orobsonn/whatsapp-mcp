import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as archive from "../src/index";
import type { Env } from "../src/env";
import { sha256 } from "../src/core";
import { readMedia } from "../src/media";

const secret = "synthetic-media-reader-secret-no-provider";
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6xkAAAAASUVORK5CYII="), c => c.charCodeAt(0));
const objectKey = "private-reader/object-not-in-response";
const cap = 2097152;
const settings = (): Env => ({ ...env, OWNER_SUB: "synthetic-owner", INSTALLATION_EPOCH: "media-reader-e",
  CONNECTION_GENERATION: "media-reader-g", MAINTENANCE: "false", RUNTIME_CONFIG: "static", DEVELOPMENT: "true",
  ASSISTANT_READER_SECRET: secret });
type Result = { observation: string; state: string; reason?: string; bytes?: Uint8Array; [key: string]: unknown };
function reader(configuration = settings()) {
  const Constructor = (archive as unknown as { CaptureMediaReader: new (...args: any[]) => { readBoundedMedia(input: unknown): Promise<Result> } }).CaptureMediaReader;
  expect(Constructor, "archive must expose its nominal binary reader").toBeTypeOf("function");
  return new Constructor(createExecutionContext(), configuration);
}
const request = async () => ({ secret, sourceEpoch: "media-reader-e", sourceGeneration: "media-reader-g", chatId: "binary-chat",
  mediaId: "binary-media", expectedMessageVersion: 1, expectedMediaVersion: 1, expectedBlobHash: await sha256(png) });
const run = (sql: string) => env.DB.prepare(sql).run();
const boundedRead = readMedia as (e: Env, id: string, maxBytes?: number) => ReturnType<typeof readMedia>;
beforeEach(async () => {
  await env.DB.exec("DELETE FROM connection_state; DELETE FROM media_jobs; DELETE FROM media_derivatives; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM actions; DELETE FROM participants; DELETE FROM chats;");
  for (const object of (await env.MEDIA.list()).objects) await env.MEDIA.delete(object.key);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
      VALUES('binary-chat','media-reader-e','media-reader-g','synthetic-binary-chat','individual','Synthetic',1,10,10)`),
    env.DB.prepare(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at)
      VALUES('binary-message','binary-chat','media-reader-e','media-reader-g','synthetic-binary-message',0,'image',NULL,10,10)`),
    env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,mime,size,sha256,object_key,state,source_url,filename,created_at)
      VALUES('binary-media','binary-chat','binary-message','media-reader-e','media-reader-g','image','image/png',?,?,?,'ready','https://provider.invalid/private?token=do-not-return','private-name.png',10)`)
      .bind(png.length, await sha256(png), objectKey),
  ]);
  await env.MEDIA.put(objectKey, png);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("No network in binary reader"); });
});
afterEach(() => vi.restoreAllMocks());

it("bounds readMedia metadata before R2 while retaining its default", async () => {
  expect((await boundedRead(settings(), "binary-media")).bytes).toEqual(png);
  expect((await boundedRead(settings(), "binary-media", png.length)).bytes).toEqual(png);
  const get = vi.spyOn(env.MEDIA, "get");
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(boundedRead(settings(), "binary-media", invalid)).rejects.toHaveProperty("code", "invalid_media_limit");
  }
  await expect(boundedRead(settings(), "binary-media", png.length - 1)).rejects.toHaveProperty("code", "media_not_ready");
  expect(get).not.toHaveBeenCalled();
});

it("cancels an oversized stream at the host cap instead of consuming the audio limit", async () => {
  await run("UPDATE media SET kind='audio',mime='audio/wav' WHERE id='binary-media'");
  await run("UPDATE messages SET kind='audio' WHERE id='binary-message'");
  const original = env.MEDIA.get.bind(env.MEDIA); let produced = 0, cancelled = false;
  vi.spyOn(env.MEDIA, "get").mockImplementation(async (...args) => {
    const object = await original(...args); if (!object || !("body" in object)) return object;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      produced += 64; controller.enqueue(new Uint8Array(64)); if (produced === 1024) controller.close();
    }, cancel() { cancelled = true; } });
    return new Proxy(object, { get(target, key) { return key === "body" ? stream : Reflect.get(target, key); } });
  });
  await expect(boundedRead(settings(), "binary-media", 128)).rejects.toHaveProperty("code", "body_too_large");
  expect(cancelled).toBe(true); expect(produced).toBeLessThanOrEqual(256);
});

it("does not let a larger host cap increase the existing image limit", async () => {
  await run("UPDATE media SET size=2097153 WHERE id='binary-media'");
  const get = vi.spyOn(env.MEDIA, "get");
  await expect(boundedRead(settings(), "binary-media", 2097154)).rejects.toHaveProperty("code", "media_not_ready");
  expect(get).not.toHaveBeenCalled();
});

it("returns a literal binary envelope without archive transport or identity data", async () => {
  const result = await reader().readBoundedMedia(await request());
  const watermark = await env.DB.prepare("SELECT MAX(sequence) value FROM assistant_capture_changes WHERE epoch='media-reader-e' AND generation='media-reader-g' AND chat_id='binary-chat'").first<{ value: number }>();
  expect(result).toEqual({ observation: "capture_media", state: "available", sourceEpoch: "media-reader-e", sourceGeneration: "media-reader-g",
    chatId: "binary-chat", mediaId: "binary-media", messageVersion: 1, mediaVersion: 1, blobHash: await sha256(png), mime: "image/png", size: png.length,
    watermark: watermark!.value, bytes: png });
  expect(JSON.stringify(result)).not.toMatch(/provider\.invalid|private-reader|private-name|synthetic-media-reader-secret|object_key|source_url|author/);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("denies invalid authentication and strict input before touching R2", async () => {
  const input = await request(), get = vi.spyOn(env.MEDIA, "get");
  for (const invalid of [{ ...input, secret: "wrong" }, { ...input, sourceEpoch: "old" }, { ...input, sourceGeneration: "old" }]) {
    await expect(reader().readBoundedMedia(invalid)).rejects.toThrow("reader_denied");
  }
  for (const invalid of [{ ...input, url: "https://provider.invalid" }, { ...input, objectKey }, { ...input, sql: "SELECT *" },
    { ...input, mediaId: "x".repeat(257) }, { ...input, expectedMessageVersion: 0 }, { ...input, expectedMediaVersion: 2147483648 },
    { ...input, expectedBlobHash: "invalid" }]) await expect(reader().readBoundedMedia(invalid)).rejects.toThrow("reader_invalid_input");
  for (const configured of [{ ...settings(), ASSISTANT_READER_SECRET: undefined }, { ...settings(), ASSISTANT_READER_SECRET: "short" }]) {
    await expect(reader(configured).readBoundedMedia(input)).rejects.toThrow("reader_denied");
  }
  expect(get).not.toHaveBeenCalled();
});

it("rejects wrong references, versions and type before touching R2", async () => {
  const input = await request(), get = vi.spyOn(env.MEDIA, "get");
  for (const changed of [{ chatId: "other-chat" }, { mediaId: "missing" }, { expectedMessageVersion: 2 }, { expectedMediaVersion: 2 }, { expectedBlobHash: "b".repeat(64) }]) {
    const result = await reader().readBoundedMedia({ ...input, ...changed });
    expect(result.state).not.toBe("available"); expect(result.bytes).toBeUndefined();
  }
  for (const sql of ["UPDATE media SET size=2097153", "UPDATE media SET size=0", "UPDATE media SET size=NULL",
    "UPDATE media SET size=1.5", "UPDATE media SET mime='audio/wav'", "UPDATE media SET kind='audio'"]) {
    await env.DB.prepare("UPDATE media SET kind='image',mime='image/png',size=?").bind(png.length).run();
    await run(sql); const result = await reader().readBoundedMedia(input);
    expect(result.state).toBe("blocked"); expect(result.bytes).toBeUndefined();
  }
  expect(get).not.toHaveBeenCalled();
});

it("does not read otherwise available audio or release a same-size corrupted object", async () => {
  const input = await request(), get = vi.spyOn(env.MEDIA, "get");
  await run("UPDATE media SET kind='audio',mime='audio/wav' WHERE id='binary-media'");
  await run("UPDATE messages SET kind='audio' WHERE id='binary-message'");
  expect(await reader().readBoundedMedia(input)).toMatchObject({ state: "blocked" });
  expect(get).not.toHaveBeenCalled();
  await run("UPDATE media SET kind='image',mime='image/png' WHERE id='binary-media'");
  await run("UPDATE messages SET kind='image' WHERE id='binary-message'");
  const corrupt = png.slice(); corrupt[0] = 0;
  await env.MEDIA.put(objectKey, corrupt);
  const result = await reader().readBoundedMedia(input);
  expect(result.state).toBe("blocked"); expect(result.bytes).toBeUndefined();
});

it.each([
  ["image/jpeg", "image"], ["image/webp", "image"], ["application/pdf", "pdf"],
])("transports stored %s bytes without claiming decoding or OCR", async (mime, kind) => {
  const bytes = new TextEncoder().encode("synthetic transport fixture, not a decoded image or PDF");
  await env.MEDIA.put(objectKey, bytes);
  await env.DB.prepare("UPDATE media SET mime=?,kind=?,size=?,sha256=? WHERE id='binary-media'").bind(mime, kind, bytes.length, await sha256(bytes)).run();
  await env.DB.prepare("UPDATE messages SET kind=? WHERE id='binary-message'").bind(kind).run();
  expect(await reader().readBoundedMedia({ ...await request(), expectedBlobHash: await sha256(bytes) }))
    .toMatchObject({ state: "available", mime, bytes });
});

it("accepts exactly 2MiB and refuses an object growing beyond declared metadata", async () => {
  const bytes = new Uint8Array(cap); bytes[0] = 137;
  await env.MEDIA.put(objectKey, bytes);
  await env.DB.prepare("UPDATE media SET size=?,sha256=? WHERE id='binary-media'").bind(cap, await sha256(bytes)).run();
  expect((await reader().readBoundedMedia({ ...await request(), expectedBlobHash: await sha256(bytes) })).bytes?.length).toBe(cap);
  await env.MEDIA.put(objectKey, new Uint8Array(cap + 1));
  const result = await reader().readBoundedMedia({ ...await request(), expectedBlobHash: await sha256(bytes) });
  expect(result.state).toBe("blocked"); expect(result.bytes).toBeUndefined();
});

it.each([
  ["privacy", "UPDATE messages SET privacy_locked=1 WHERE id='binary-message'"],
  ["capture", "UPDATE chats SET capture_enabled=0 WHERE id='binary-chat'"],
  ["message version", "UPDATE messages SET version=2 WHERE id='binary-message'"],
  ["media version", "UPDATE media SET version=2 WHERE id='binary-media'"],
  ["withdraw", "UPDATE messages SET deleted_at=20 WHERE id='binary-message'"],
  ["watermark", `INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at)
    VALUES('new-during-read','binary-chat','media-reader-e','media-reader-g','new-during-read',0,'text','New event',11,11)`],
])("suppresses bytes when %s changes during R2 read", async (_name, sql) => {
  const original = env.MEDIA.get.bind(env.MEDIA);
  vi.spyOn(env.MEDIA, "get").mockImplementation(async (...args) => { const object = await original(...args); await run(sql); return object; });
  const result = await reader().readBoundedMedia(await request());
  expect(result.state).not.toBe("available"); expect(result.bytes).toBeUndefined();
});

it("owns its input before authentication and R2 awaits", async () => {
  const input = await request(); const pending = reader().readBoundedMedia(input);
  input.chatId = "attacker-chat"; input.mediaId = "attacker-media"; input.expectedBlobHash = "f".repeat(64);
  expect(await pending).toMatchObject({ state: "available", chatId: "binary-chat", mediaId: "binary-media", bytes: png });
});

it("fails closed for unavailable runtime and storage without returning exception content", async () => {
  const input = await request(), get = vi.spyOn(env.MEDIA, "get");
  expect(await reader({ ...settings(), MAINTENANCE: "true" }).readBoundedMedia(input)).toMatchObject({ state: "blocked" });
  expect(await reader({ ...settings(), OWNER_SUB: "" }).readBoundedMedia(input)).toMatchObject({ state: "blocked" });
  expect(get).not.toHaveBeenCalled();
  await env.MEDIA.delete(objectKey);
  expect(await reader().readBoundedMedia(input)).toMatchObject({ state: "blocked" });
  get.mockRejectedValue(new Error("provider-token-secret-never-return"));
  const result = await reader().readBoundedMedia(input);
  expect(result).toEqual({ observation: "capture_media", state: "blocked", reason: "media_unavailable" });
  expect(JSON.stringify(result)).not.toMatch(/provider-token/);
});

it("fails closed without reading R2 when the shared snapshot query fails", async () => {
  const input = await request(), get = vi.spyOn(env.MEDIA, "get");
  vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("private-database-error-not-in-response"); });
  expect(await reader().readBoundedMedia(input)).toEqual({ observation: "capture_media", state: "blocked", reason: "source_unavailable" });
  expect(get).not.toHaveBeenCalled();
});

it("uses the live database generation and suppresses bytes when connection disappears mid-read", async () => {
  const configured = { ...settings(), RUNTIME_CONFIG: "database" as const, DEVELOPMENT: "false", CONNECTION_GENERATION: "pending",
    PUBLIC_ORIGIN: "https://binary-reader.invalid", ENCRYPTION_KEY: btoa("k".repeat(32)) };
  const generation = "c".repeat(32), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("k".repeat(32)), "AES-GCM", false, ["encrypt"]);
  const payload = JSON.stringify({ instanceId: "synthetic-instance", instanceToken: "synthetic-token", clientToken: "synthetic-client", phone: "5511000000000", generation, webhookSecret: "d".repeat(64) });
  const aad = new TextEncoder().encode(JSON.stringify(["whatsapp-mcp/connection/v1", configured.PUBLIC_ORIGIN, configured.INSTALLATION_EPOCH]));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(payload));
  const cipher = `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
  await env.DB.prepare("INSERT INTO connection_state(id,epoch,cipher,state,attempt_id,step,created_at,updated_at) VALUES(1,'media-reader-e',?,'active','synthetic','done',10,10)").bind(cipher).run();
  for (const table of ["chats", "messages", "media"]) await env.DB.prepare(`UPDATE ${table} SET generation=?`).bind(generation).run();
  const input = { ...await request(), sourceGeneration: generation };
  expect(await reader(configured).readBoundedMedia(input)).toMatchObject({ state: "available", sourceGeneration: generation, bytes: png });
  const original = env.MEDIA.get.bind(env.MEDIA);
  vi.spyOn(env.MEDIA, "get").mockImplementation(async (...args) => { const object = await original(...args); await run("DELETE FROM connection_state"); return object; });
  const result = await reader(configured).readBoundedMedia(input);
  expect(result.state).toBe("blocked"); expect(result.bytes).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/synthetic-token|synthetic-client|5511000000000/);
});
