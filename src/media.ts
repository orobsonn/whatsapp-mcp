import type { Env } from "./env";
import {
  AppError,
  assertActive,
  assertFence,
  currentFence,
  LIMITS,
  readBounded,
  sha256,
  type Fence,
} from "./core";
import { getChat } from "./store";

export interface UploadMediaInput {
  bytes: Uint8Array;
  mime: string;
  filename?: string;
  durationSeconds?: number;
}
export interface MediaView {
  id: string;
  chatId: string;
  kind: string;
  mime: string | null;
  size: number | null;
  sha256: string | null;
  filename: string | null;
  state: string;
  version: number;
  durationSeconds: number | null;
}
export type MediaFetcher = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
interface MediaRow {
  id: string;
  chat_id: string;
  message_id: string | null;
  message_version: number;
  version: number;
  epoch: string;
  generation: string;
  kind: string;
  mime: string | null;
  size: number | null;
  sha256: string | null;
  object_key: string | null;
  state: string;
  source_url: string | null;
  filename: string | null;
  duration_seconds: number | null;
}
interface Job {
  id: string;
  media_id: string;
  message_version: number;
  epoch: string;
  generation: string;
  kind: string;
  attempts: number;
  lease_until: number;
}
export interface TranscriptView {
  id: string;
  mediaId: string;
  text: string;
  untrusted: true;
}
const DOWNLOAD_MS = 15000;
const TRANSCRIBE_MS = 45000;
// All aliases here are internal constants, never input. D1, not an R2 key, grants visibility.
function visible(alias = "media"): string {
  return `${alias}.deleted_at IS NULL AND EXISTS(SELECT 1 FROM chats c WHERE c.id=${alias}.chat_id AND c.epoch=${alias}.epoch AND c.generation=${alias}.generation) AND (${alias}.message_id IS NULL OR EXISTS(SELECT 1 FROM messages msg WHERE msg.id=${alias}.message_id AND msg.chat_id=${alias}.chat_id AND msg.epoch=${alias}.epoch AND msg.generation=${alias}.generation AND msg.version=${alias}.message_version AND msg.deleted_at IS NULL AND msg.unavailable_reason IS NULL AND msg.kind=${alias}.kind))`;
}
function view(m: MediaRow): MediaView {
  return {
    id: m.id,
    chatId: m.chat_id,
    kind: m.kind,
    mime: m.mime,
    size: m.size,
    sha256: m.sha256,
    filename: m.filename,
    state: m.state,
    version: m.version,
    durationSeconds: m.duration_seconds,
  };
}
async function row(
  env: Env,
  id: string,
  fence: Fence = currentFence(env),
): Promise<MediaRow> {
  assertActive(env);
  assertFence(env, fence);
  const m = await env.DB.prepare(
    `SELECT * FROM media WHERE id=? AND epoch=? AND generation=? AND ${visible()}`,
  )
    .bind(id, fence.epoch, fence.generation)
    .first<MediaRow>();
  if (!m) throw new AppError("media_not_found", 404);
  assertActive(env);
  assertFence(env, fence);
  return m;
}
function filename(name?: string | null, mime?: string): string | null {
  if (name == null) return null;
  if (
    !name ||
    name.length > 160 ||
    name.trim() !== name ||
    /[\x00-\x1f\x7f/\\:]/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new AppError("invalid_media_filename");
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : null;
  const extensions: Record<string, string[]> = {
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/webp": ["webp"],
    "application/pdf": ["pdf"],
    "audio/ogg": ["ogg", "opus"],
    "audio/wav": ["wav"],
    "audio/mpeg": ["mp3"],
    "audio/mp4": ["m4a", "m4b"],
  };
  if (mime && ext && !extensions[mime]?.includes(ext))
    throw new AppError("media_filename_mismatch");
  return name;
}
function duration(seconds?: number | null): void {
  if (
    seconds != null &&
    (!Number.isFinite(seconds) || seconds < 0 || seconds > 120)
  )
    throw new AppError("invalid_audio_duration");
}
function canonicalMime(mime: string): string {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  return (
    (
      {
        "audio/x-wav": "audio/wav",
        "audio/mp3": "audio/mpeg",
        "audio/x-m4a": "audio/mp4",
        "audio/m4a": "audio/mp4",
      } as Record<string, string>
    )[m] ?? m
  );
}
function ascii(bytes: Uint8Array, offset: number, n: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + n));
}
function detect(bytes: Uint8Array): {
  kind: "image" | "pdf" | "audio";
  mime: string;
} {
  const n = bytes.length;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    n >= 45 &&
    bytes[0] === 137 &&
    ascii(bytes, 1, 7) === "PNG\r\n\x1a\n" &&
    d.getUint32(8) === 13 &&
    ascii(bytes, 12, 4) === "IHDR" &&
    d.getUint32(16) > 0 &&
    d.getUint32(20) > 0 &&
    ascii(bytes, n - 8, 4) === "IEND"
  )
    return { kind: "image", mime: "image/png" };
  if (
    n >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[n - 2] === 255 &&
    bytes[n - 1] === 217
  )
    return { kind: "image", mime: "image/jpeg" };
  if (
    n >= 20 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    d.getUint32(4, true) + 8 === n &&
    ascii(bytes, 8, 4) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4))
  )
    return { kind: "image", mime: "image/webp" };
  if (
    n >= 14 &&
    /^%PDF-[12]\.[0-9]/.test(ascii(bytes, 0, 8)) &&
    new TextDecoder()
      .decode(bytes.subarray(Math.max(0, n - 1024)))
      .includes("%%EOF")
  )
    return { kind: "pdf", mime: "application/pdf" };
  if (
    n >= 44 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    d.getUint32(4, true) + 8 === n &&
    ascii(bytes, 8, 4) === "WAVE" &&
    ascii(bytes, 12, 4) === "fmt " &&
    d.getUint32(16, true) >= 16
  )
    return { kind: "audio", mime: "audio/wav" };
  if (
    n >= 36 &&
    ascii(bytes, 0, 4) === "OggS" &&
    bytes[4] === 0 &&
    bytes[26]! > 0
  ) {
    const body = 27 + bytes[26]!;
    if (
      ascii(bytes, body, 8) === "OpusHead" ||
      ascii(bytes, body + 1, 6) === "vorbis"
    )
      return { kind: "audio", mime: "audio/ogg" };
  }
  let offset = 0;
  if (
    n >= 10 &&
    ascii(bytes, 0, 3) === "ID3" &&
    bytes.subarray(6, 10).every((x) => x < 128)
  )
    offset =
      10 +
      ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  if (
    n > offset + 4 &&
    bytes[offset] === 255 &&
    (bytes[offset + 1]! & 224) === 224 &&
    (bytes[offset + 1]! & 24) !== 8 &&
    (bytes[offset + 1]! & 6) !== 0 &&
    bytes[offset + 2]! >> 4 > 0 &&
    bytes[offset + 2]! >> 4 < 15 &&
    (bytes[offset + 2]! & 12) !== 12
  )
    return { kind: "audio", mime: "audio/mpeg" };
  if (
    n >= 24 &&
    d.getUint32(0) >= 20 &&
    d.getUint32(0) <= n &&
    ascii(bytes, 4, 4) === "ftyp" &&
    ["M4A ", "M4B "].includes(ascii(bytes, 8, 4))
  )
    return { kind: "audio", mime: "audio/mp4" };
  throw new AppError("unsupported_media", 415);
}
function validate(
  bytes: Uint8Array,
  mime?: string | null,
  kind?: string,
): { kind: "image" | "pdf" | "audio"; mime: string } {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0)
    throw new AppError("invalid_media");
  if (bytes.length > LIMITS.mediaBytes)
    throw new AppError("body_too_large", 413);
  const detected = detect(bytes);
  if (mime && canonicalMime(mime) !== detected.mime)
    throw new AppError("media_mime_mismatch", 415);
  if (kind && kind !== detected.kind)
    throw new AppError("media_kind_mismatch", 415);
  return detected;
}
export async function getMedia(env: Env, id: string): Promise<MediaView> {
  return view(await row(env, id));
}
export async function readMedia(
  env: Env,
  id: string,
): Promise<{ metadata: MediaView; bytes: Uint8Array }> {
  const fence = currentFence(env);
  const m = await row(env, id, fence);
  if (
    m.state !== "ready" ||
    !m.object_key ||
    !m.sha256 ||
    m.size == null ||
    m.size > LIMITS.mediaBytes
  )
    throw new AppError("media_not_ready", 409);
  const object = await env.MEDIA.get(m.object_key);
  if (!object) throw new AppError("media_missing", 404);
  const bytes = await readBounded(object.body, LIMITS.mediaBytes);
  if (bytes.length !== m.size || (await sha256(bytes)) !== m.sha256)
    throw new AppError("media_integrity_failed", 409);
  const latest = await row(env, id, fence);
  if (
    latest.state !== "ready" ||
    latest.version !== m.version ||
    latest.object_key !== m.object_key ||
    latest.sha256 !== m.sha256
  )
    throw new AppError("stale_media", 409);
  return { metadata: view(latest), bytes };
}
export async function uploadMedia(
  env: Env,
  chatId: string,
  input: UploadMediaInput,
): Promise<MediaView> {
  assertActive(env);
  const fence = currentFence(env);
  await getChat(env, chatId, fence);
  // Own the bytes across awaits; callers cannot mutate an already hashed upload.
  if (
    !input ||
    !(input.bytes instanceof Uint8Array) ||
    typeof input.mime !== "string"
  )
    throw new AppError("invalid_media");
  if (input.bytes.length > LIMITS.mediaBytes)
    throw new AppError("body_too_large", 413);
  const bytes = input.bytes.slice();
  const type = validate(bytes, input.mime);
  const name = filename(input.filename, type.mime);
  if (type.kind === "audio") duration(input.durationSeconds);
  const hash = await sha256(bytes);
  assertFence(env, fence);
  const id = crypto.randomUUID();
  const key = `original/${id}/${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO media(id,chat_id,epoch,generation,kind,mime,size,sha256,state,filename,duration_seconds,created_at) SELECT ?,?,?,?,?,?,?,?,'pending',?,?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=?)`,
  )
    .bind(
      id,
      chatId,
      fence.epoch,
      fence.generation,
      type.kind,
      type.mime,
      bytes.length,
      hash,
      name,
      type.kind === "audio" ? (input.durationSeconds ?? null) : null,
      Date.now(),
      chatId,
      fence.epoch,
      fence.generation,
    )
    .run();
  let published = false;
  try {
    await env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: type.mime },
    });
    assertActive(env);
    assertFence(env, fence);
    const result = await env.DB.prepare(
      `UPDATE media SET state='ready',object_key=? WHERE id=? AND epoch=? AND generation=? AND version=1 AND state='pending' AND ${visible()}`,
    )
      .bind(key, id, fence.epoch, fence.generation)
      .run();
    if (result.meta.changes !== 1) throw new AppError("stale_media", 409);
    published = true;
    return await getMedia(env, id);
  } catch (error) {
    if (!published) await env.MEDIA.delete(key);
    await env.DB.prepare(
      "UPDATE media SET state='failed' WHERE id=? AND state='pending'",
    )
      .bind(id)
      .run();
    throw error;
  }
}
// No caller supplies a URL to a tool. Only durable backend source_url reaches this validator.
function source(env: Env, value: string | null): string {
  if (!value || value.length > 4096 || /[\s\\]/.test(value))
    throw new AppError("media_source_forbidden");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("media_source_forbidden");
  }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  const host = url.hostname;
  const validHost = (h: string) =>
    h.length <= 253 &&
    h.includes(".") &&
    h
      .split(".")
      .every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) &&
    !/^[0-9.]+$/.test(h) &&
    !/(?:^|\.)(?:localhost|local|internal|home|invalid|test)$/.test(h);
  const allowed = env.MEDIA_HOSTS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(validHost);
  if (
    url.protocol !== "https:" ||
    !authority ||
    /[@:]/.test(authority) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !validHost(host) ||
    !allowed.includes(host)
  )
    throw new AppError("media_source_forbidden");
  return url.href;
}
function lease(job: Job): (string | number)[] {
  return [job.id, job.epoch, job.generation, job.attempts, job.lease_until];
}
const ownsLease =
  "id=? AND epoch=? AND generation=? AND attempts=? AND lease_until=? AND status='processing'";
async function claim(env: Env, id: string, fence: Fence): Promise<Job | null> {
  assertActive(env);
  assertFence(env, fence);
  const now = Date.now();
  return env.DB.prepare(
    `UPDATE media_jobs SET status='processing',attempts=attempts+1,lease_until=? WHERE id=? AND epoch=? AND generation=? AND attempts<? AND next_attempt_at<=? AND (status IN ('pending','retry') OR (status='processing' AND lease_until<=?)) AND EXISTS(SELECT 1 FROM media m WHERE m.id=media_jobs.media_id AND m.message_version=media_jobs.message_version AND m.epoch=media_jobs.epoch AND m.generation=media_jobs.generation AND m.state=CASE WHEN media_jobs.kind='download' THEN 'pending' ELSE 'ready' END AND ${visible("m")}) RETURNING *`,
  )
    .bind(
      now + LIMITS.leaseMs,
      id,
      fence.epoch,
      fence.generation,
      LIMITS.attempts,
      now,
      now,
    )
    .first<Job>();
}
function liveJob(job: Job): (string | number)[] {
  return lease(job);
}
async function failJob(env: Env, job: Job, error: unknown): Promise<void> {
  const permanent =
    error instanceof AppError &&
    !["media_download_failed", "media_deadline"].includes(error.code);
  const terminal = permanent || job.attempts >= LIMITS.attempts;
  const code =
    error instanceof AppError
      ? error.code
      : job.kind === "download"
        ? "media_download_failed"
        : "transcription_failed";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE media SET state='failed' WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM media_jobs WHERE ${ownsLease}) AND ?=1`,
    ).bind(job.media_id, ...liveJob(job), terminal ? 1 : 0),
    env.DB.prepare(
      `UPDATE media_jobs SET status=?,error=?,next_attempt_at=?,lease_until=NULL WHERE ${ownsLease}`,
    ).bind(
      terminal ? "failed" : "retry",
      code,
      Date.now() + Math.min(300000, 1000 * 2 ** job.attempts),
      ...liveJob(job),
    ),
  ]);
}
async function readDownload(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new AppError("media_deadline", 504);
      const part = await reader.read();
      if (signal.aborted) throw new AppError("media_deadline", 504);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > LIMITS.mediaBytes) {
        await reader.cancel();
        throw new AppError("body_too_large", 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
async function download(
  env: Env,
  job: Job,
  fetcher: MediaFetcher,
): Promise<void> {
  const fence = { epoch: job.epoch, generation: job.generation };
  const m = await row(env, job.media_id, fence);
  const url = source(env, m.source_url);
  filename(m.filename);
  if (m.kind === "audio") duration(m.duration_seconds);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppError("media_deadline", 504));
    }, DOWNLOAD_MS);
  });
  let key: string | undefined;
  try {
    const bytes = await Promise.race([
      (async () => {
        const response = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept:
              "image/png,image/jpeg,image/webp,application/pdf,audio/ogg,audio/wav,audio/mpeg,audio/mp4",
          },
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new AppError("media_redirect_forbidden");
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new AppError("media_download_failed", 502);
        }
        const length = response.headers.get("content-length");
        if (
          length &&
          (!/^\d+$/.test(length) || Number(length) > LIMITS.mediaBytes)
        ) {
          await response.body?.cancel();
          throw new AppError("body_too_large", 413);
        }
        const result = await readDownload(response, controller.signal);
        validate(result, response.headers.get("content-type"), m.kind);
        return result;
      })(),
      deadline,
    ]);
    const type = validate(bytes, m.mime, m.kind);
    filename(m.filename, type.mime);
    const hash = await sha256(bytes);
    assertActive(env);
    assertFence(env, fence);
    key = `original/${m.id}/${crypto.randomUUID()}`;
    await env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: type.mime },
    });
    assertActive(env);
    assertFence(env, fence);
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE media SET mime=?,size=?,sha256=?,object_key=?,state='ready',source_url=NULL WHERE id=? AND version=? AND message_version=? AND epoch=? AND generation=? AND state='pending' AND ${visible()} AND EXISTS(SELECT 1 FROM media_jobs WHERE ${ownsLease} AND lease_until>?)`,
      ).bind(
        type.mime,
        bytes.length,
        hash,
        key,
        m.id,
        m.version,
        job.message_version,
        fence.epoch,
        fence.generation,
        ...liveJob(job),
        Date.now(),
      ),
      env.DB.prepare(
        `UPDATE media_jobs SET status='ready',lease_until=NULL,error=NULL WHERE ${ownsLease} AND EXISTS(SELECT 1 FROM media WHERE id=? AND object_key=? AND state='ready' AND ${visible()})`,
      ).bind(...liveJob(job), m.id, key),
    ]);
    if (results[0]!.meta.changes !== 1 || results[1]!.meta.changes !== 1)
      throw new AppError("stale_media", 409);
  } catch (error) {
    if (key) await env.MEDIA.delete(key);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
export async function processMediaJobs(
  env: Env,
  fetcher: MediaFetcher = fetch,
): Promise<{ processed: number; ready: number; failed: number }> {
  assertActive(env);
  const fence = currentFence(env);
  const now = Date.now();
  // An expired final lease is terminal, including process death after the last attempt.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE media SET state='failed' WHERE state='pending' AND epoch=? AND generation=? AND id IN(SELECT media_id FROM media_jobs WHERE kind='download' AND status='processing' AND attempts>=? AND lease_until<=?)",
    ).bind(fence.epoch, fence.generation, LIMITS.attempts, now),
    env.DB.prepare(
      "UPDATE media_jobs SET status='failed',error='media_attempts_exhausted',lease_until=NULL WHERE epoch=? AND generation=? AND kind='download' AND status='processing' AND attempts>=? AND lease_until<=?",
    ).bind(fence.epoch, fence.generation, LIMITS.attempts, now),
  ]);
  await env.DB.prepare(
    `UPDATE media_jobs SET status='cancelled',lease_until=NULL WHERE epoch=? AND generation=? AND status NOT IN ('ready','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM media m WHERE m.id=media_jobs.media_id AND m.message_version=media_jobs.message_version AND m.epoch=media_jobs.epoch AND m.generation=media_jobs.generation AND ${visible("m")})`,
  )
    .bind(fence.epoch, fence.generation)
    .run();
  const jobs = await env.DB.prepare(
    "SELECT id FROM media_jobs WHERE epoch=? AND generation=? AND kind='download' AND attempts<? AND next_attempt_at<=? AND (status IN ('pending','retry') OR (status='processing' AND lease_until<=?)) ORDER BY next_attempt_at,id LIMIT ?",
  )
    .bind(fence.epoch, fence.generation, LIMITS.attempts, now, now, LIMITS.jobs)
    .all<{ id: string }>();
  const out = { processed: 0, ready: 0, failed: 0 };
  for (const candidate of jobs.results) {
    const job = await claim(env, candidate.id, fence);
    if (!job) continue;
    out.processed++;
    try {
      await download(env, job, fetcher);
      out.ready++;
    } catch (error) {
      await failJob(env, job, error);
      out.failed++;
    }
  }
  return out;
}
export async function transcribeMedia(
  env: Env,
  id: string,
): Promise<TranscriptView> {
  assertActive(env);
  if (env.TRANSCRIPTION_ENABLED !== "true" || !env.AI)
    throw new AppError("transcription_disabled", 503);
  const fence = currentFence(env);
  const m = await row(env, id, fence);
  if (m.kind !== "audio") throw new AppError("not_audio");
  duration(m.duration_seconds);
  if (m.state !== "ready") throw new AppError("media_not_ready", 409);
  const derivativeId = await sha256(
    JSON.stringify([id, m.version, fence, "transcript"]),
  );
  const existing = await env.DB.prepare(
    "SELECT text FROM media_derivatives WHERE id=? AND media_version=? AND epoch=? AND generation=? AND state='ready'",
  )
    .bind(derivativeId, m.version, fence.epoch, fence.generation)
    .first<{ text: string }>();
  if (existing) {
    const latest = await row(env, id, fence);
    if (
      latest.version !== m.version ||
      latest.state !== "ready" ||
      latest.sha256 !== m.sha256
    )
      throw new AppError("stale_media", 409);
    return {
      id: derivativeId,
      mediaId: id,
      text: existing.text,
      untrusted: true,
    };
  }
  await env.DB.prepare(
    `INSERT INTO media_jobs(id,media_id,message_version,epoch,generation,kind,status) SELECT ?,id,message_version,epoch,generation,'transcribe','pending' FROM media WHERE id=? AND version=? AND state='ready' AND epoch=? AND generation=? AND ${visible()} ON CONFLICT DO NOTHING`,
  )
    .bind(derivativeId, id, m.version, fence.epoch, fence.generation)
    .run();
  const job = await claim(env, derivativeId, fence);
  if (!job) throw new AppError("media_job_busy", 409);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const original = await readMedia(env, id);
    if (
      original.metadata.version !== m.version ||
      original.metadata.sha256 !== m.sha256
    )
      throw new AppError("stale_media", 409);
    validate(original.bytes, m.mime, "audio");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AppError("media_deadline", 504));
      }, TRANSCRIBE_MS);
    });
    const result = await Promise.race([
      env.AI.run(
        "@cf/openai/whisper",
        { audio: Array.from(original.bytes) },
        { signal: controller.signal },
      ),
      deadline,
    ]);
    if (
      !result ||
      typeof result.text !== "string" ||
      result.text.length > LIMITS.pageChars
    )
      throw new AppError("invalid_transcription", 502);
    assertActive(env);
    assertFence(env, fence);
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at) SELECT ?,id,version,epoch,generation,'transcript',?,'ready',? FROM media WHERE id=? AND version=? AND message_version=? AND epoch=? AND generation=? AND state='ready' AND ${visible()} AND EXISTS(SELECT 1 FROM media_jobs WHERE ${ownsLease} AND lease_until>?) ON CONFLICT DO NOTHING`,
      ).bind(
        derivativeId,
        result.text,
        Date.now(),
        id,
        m.version,
        job.message_version,
        fence.epoch,
        fence.generation,
        ...liveJob(job),
        Date.now(),
      ),
      env.DB.prepare(
        `UPDATE media_jobs SET status='ready',lease_until=NULL,error=NULL WHERE ${ownsLease} AND EXISTS(SELECT 1 FROM media_derivatives WHERE id=? AND state='ready')`,
      ).bind(...liveJob(job), derivativeId),
    ]);
    if (results[0]!.meta.changes !== 1 || results[1]!.meta.changes !== 1)
      throw new AppError("stale_media", 409);
    await row(env, id, fence);
    return {
      id: derivativeId,
      mediaId: id,
      text: result.text,
      untrusted: true,
    };
  } catch (error) {
    await failJob(env, job, error);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** Only browser uploads from the current chat/install, never captured message attachments. */
export async function listUploadedMedia(env: Env, chatId: string) {
  assertActive(env);
  const fence = currentFence(env);
  await getChat(env, chatId, fence);
  const rows = await env.DB.prepare(
    `SELECT * FROM media WHERE chat_id=? AND epoch=? AND generation=? AND message_id IS NULL AND state='ready' AND ${visible()} ORDER BY created_at DESC,id DESC LIMIT 10`,
  )
    .bind(chatId, fence.epoch, fence.generation)
    .all<MediaRow & { created_at: number }>();
  assertFence(env, fence);
  assertActive(env);
  return rows.results.map((r) => ({ ...view(r), createdAt: r.created_at }));
}
