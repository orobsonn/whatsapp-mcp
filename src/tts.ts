import { z } from "zod";
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
import { publicOrigin } from "./auth";
import { resolveRuntimeEnv } from "./connection";
import { getChat } from "./store";
import {
  getMedia,
  uploadMedia,
  type MediaFetcher,
  type MediaView,
} from "./media";

const TIMEOUT_MS = 45_000;
export const audioGenerationSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    text: z
      .string()
      .min(1)
      .max(2000)
      .refine(
        (s) =>
          s.trim().length > 0 && new TextEncoder().encode(s).length <= 8000,
      ),
  })
  .strict();
interface GenerationRow {
  id: string;
  epoch: string;
  generation: string;
  chat_id: string;
  text: string | null;
  voice_name: string | null;
  model: string;
  status: "attempting" | "ready" | "failed" | "uncertain" | "unavailable";
  media_id: string | null;
  error: string | null;
  deadline_at: number;
}
export interface GeneratedAudio {
  id: string;
  status: GenerationRow["status"];
  text: string | null;
  voice: string | null;
  model: string;
  media: MediaView | null;
  previewUrl: string | null;
  error: string | null;
  mayHaveConsumedCredit: true;
  guidance: string;
}
export function ttsConfiguration(env: Env): {
  available: boolean;
  guidance: string;
} {
  const available =
    env.TTS_ENABLED === "true" &&
    Boolean(
      env.FISH_API_KEY && /^[\x21-\x7e]{1,512}$/.test(env.FISH_API_KEY),
    ) &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(env.FISH_VOICE_ID ?? "") &&
    Boolean(env.FISH_VOICE_NAME?.trim() && env.FISH_VOICE_NAME.length <= 120) &&
    ["s2.1-pro", "s2-pro", "s2.1-pro-free"].includes(env.FISH_TTS_MODEL ?? "");
  return {
    available,
    guidance: available
      ? "O texto será enviado ao Fish Audio e pode consumir saldo da API. Gerar não envia WhatsApp."
      : "Geração indisponível. O operador deve configurar o secret FISH_API_KEY, FISH_VOICE_ID da sua voz já cadastrada, FISH_VOICE_NAME, FISH_TTS_MODEL e TTS_ENABLED=true. Não informe chaves no chat.",
  };
}
async function active(env: Env, fence: Fence): Promise<void> {
  const latest = await resolveRuntimeEnv(env);
  assertActive(latest);
  assertFence(latest, fence);
}
async function generationRow(env: Env, id: string): Promise<GenerationRow> {
  assertActive(env);
  const f = currentFence(env);
  const row = await env.DB.prepare(
    "SELECT * FROM tts_generations WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(id, f.epoch, f.generation)
    .first<GenerationRow>();
  if (!row) throw new AppError("tts_not_found", 404);
  await active(env, f);
  await getChat(env, row.chat_id, f);
  return row;
}
export async function getGeneratedAudio(
  env: Env,
  id: string,
): Promise<GeneratedAudio> {
  await generationRow(env, id);
  // A dead Worker cannot safely resume its external submission. Keep the tombstone.
  await env.DB.prepare(
    "UPDATE tts_generations SET status='uncertain',error='tts_outcome_uncertain',text=NULL,voice_name=NULL WHERE id=? AND status='attempting' AND deadline_at<=?",
  )
    .bind(id, Date.now())
    .run();
  const row = await generationRow(env, id);
  let media: MediaView | null = null;
  if (row.status === "ready" && row.media_id) {
    media = await getMedia(env, row.media_id);
    if (media.state !== "ready")
      throw new AppError("tts_media_unavailable", 409);
  }
  return {
    id: row.id,
    status: row.status,
    text: row.text,
    voice: row.voice_name,
    model: row.model,
    media,
    previewUrl: media ? `${publicOrigin(env)}/audio/${row.id}` : null,
    error: row.error,
    mayHaveConsumedCredit: true,
    guidance:
      row.status === "ready"
        ? "Abra a prévia privada, ouça o MP3 e peça nova autorização do dono para este arquivo final antes de preparar_envio/executar_envio. Gerar nunca autoriza enviar, mesmo em um pedido de gerar e enviar."
        : row.status === "attempting"
          ? "Geração em andamento. Consulte este id; não inicie outra geração para contornar a espera."
          : "Não repetimos esta geração. Ela pode ter consumido saldo; confira o Fish antes de autorizar qualquer nova tentativa. Texto e voz de tentativas sem arquivo foram removidos.",
  };
}
async function invalidateUpload(env: Env, media: MediaView): Promise<void> {
  const object = await env.DB.prepare("SELECT object_key FROM media WHERE id=?")
    .bind(media.id)
    .first<{ object_key: string | null }>();
  await env.DB.prepare(
    "UPDATE media SET state='deleted',deleted_at=?,filename=NULL,sha256=NULL,size=NULL WHERE id=?",
  )
    .bind(Date.now(), media.id)
    .run();
  if (object?.object_key) await env.MEDIA.delete(object.object_key);
}
export async function generateAudio(
  env: Env,
  raw: unknown,
  fetcher: MediaFetcher = fetch,
): Promise<GeneratedAudio> {
  assertActive(env);
  const config = ttsConfiguration(env);
  if (!config.available) throw new AppError("tts_not_configured", 503);
  const input = audioGenerationSchema.parse(raw);
  const fence = currentFence(env);
  const origin = publicOrigin(env);
  await active(env, fence);
  await getChat(env, input.chatId, fence);
  // Includes all generation settings. No client-generated key or retry aliases to lose.
  const id = await sha256(
    JSON.stringify([
      "fish-tts-v1",
      origin,
      fence,
      input.chatId,
      input.text,
      env.FISH_VOICE_ID,
      env.FISH_TTS_MODEL,
      "mp3",
      128,
      "normal",
    ]),
  );
  const deadline = Date.now() + TIMEOUT_MS;
  const claim = await env.DB.prepare(
    "INSERT INTO tts_generations(id,epoch,generation,chat_id,text,voice_name,model,status,deadline_at,created_at) SELECT ?,?,?,?,?,?,?,'attempting',?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(
      id,
      fence.epoch,
      fence.generation,
      input.chatId,
      input.text,
      env.FISH_VOICE_NAME!,
      env.FISH_TTS_MODEL!,
      deadline,
      Date.now(),
      input.chatId,
      fence.epoch,
      fence.generation,
    )
    .run();
  if (claim.meta.changes !== 1) return getGeneratedAudio(env, id);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let media: MediaView | undefined;
  let submitted = false;
  try {
    await active(env, fence);
    const current = await generationRow(env, id);
    if (current.status !== "attempting" || current.text === null)
      return getGeneratedAudio(env, id);
    if (Date.now() >= deadline) throw new AppError("tts_claim_expired", 409);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          if (reader) void reader.cancel().catch(() => {});
          reject(new AppError("tts_outcome_uncertain", 504));
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    submitted = true;
    const bytes = await Promise.race([
      (async () => {
        const response = await fetcher("https://api.fish.audio/v1/tts", {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${env.FISH_API_KEY}`,
            "Content-Type": "application/json",
            model: env.FISH_TTS_MODEL!,
          },
          body: JSON.stringify({
            text: input.text,
            reference_id: env.FISH_VOICE_ID,
            format: "mp3",
            mp3_bitrate: 128,
            latency: "normal",
          }),
        });
        // A fetch ignoring abort must not release its late result into storage.
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new AppError("tts_outcome_uncertain", 504);
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new AppError(
            response.status >= 400 && response.status < 500
              ? `tts_provider_rejected_${response.status}`
              : "tts_outcome_uncertain",
            502,
          );
        }
        const mime = response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (!["audio/mpeg", "audio/mp3"].includes(mime ?? "")) {
          void response.body?.cancel().catch(() => {});
          throw new AppError("tts_invalid_mime", 415);
        }
        if (
          Number(response.headers.get("content-length")) > LIMITS.mediaBytes
        ) {
          void response.body?.cancel().catch(() => {});
          throw new AppError("body_too_large", 413);
        }
        reader = response.body?.getReader();
        if (!reader) throw new AppError("invalid_media");
        // Keep the owned reader cancellable even when a provider stalls between chunks.
        const stream = new ReadableStream<Uint8Array>({
          async pull(c) {
            const r = await reader!.read();
            if (r.done) c.close();
            else c.enqueue(r.value);
          },
          cancel: (reason) => reader!.cancel(reason),
        });
        return readBounded(stream, LIMITS.mediaBytes);
      })(),
      timeout,
    ]);
    await active(env, fence);
    const latest = await generationRow(env, id);
    if (
      latest.status !== "attempting" ||
      latest.text === null ||
      Date.now() >= deadline
    )
      throw new AppError("tts_publication_cancelled", 409);
    media = await uploadMedia(env, input.chatId, {
      bytes,
      mime: "audio/mpeg",
      filename: `voz-${id.slice(0, 12)}.mp3`,
      ttsGenerationId: id,
    });
    await active(env, fence);
    const published = await env.DB.prepare(
      "UPDATE tts_generations SET status='ready',media_id=? WHERE id=? AND epoch=? AND generation=? AND status='attempting' AND text IS NOT NULL AND deadline_at>? AND EXISTS(SELECT 1 FROM media WHERE id=? AND tts_generation_id=? AND state='ready' AND deleted_at IS NULL)",
    )
      .bind(
        media.id,
        id,
        fence.epoch,
        fence.generation,
        Date.now(),
        media.id,
        id,
      )
      .run();
    if (published.meta.changes !== 1)
      throw new AppError("tts_publication_cancelled", 409);
  } catch (error) {
    if (media) await invalidateUpload(env, media);
    const code =
      error instanceof AppError ? error.code : "tts_outcome_uncertain";
    const invalid = [
      "tts_invalid_mime",
      "body_too_large",
      "invalid_media",
      "unsupported_media",
      "media_mime_mismatch",
    ].includes(code);
    const status =
      invalid || code.startsWith("tts_provider_rejected_") || !submitted
        ? "failed"
        : "uncertain";
    await env.DB.prepare(
      "UPDATE tts_generations SET status=?,error=?,text=NULL,voice_name=NULL WHERE id=? AND status='attempting'",
    )
      .bind(
        status,
        invalid || code.startsWith("tts_provider_rejected_")
          ? code
          : "tts_outcome_uncertain",
        id,
      )
      .run();
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
  return getGeneratedAudio(env, id);
}

/** Reuses the existing cron: no provider call and no expired attempt is resumed. */
export async function cleanupAudioGenerations(env: Env): Promise<void> {
  assertActive(env);
  const fence = currentFence(env);
  await active(env, fence);
  await env.DB.prepare(
    "UPDATE tts_generations SET status=CASE WHEN epoch<>? OR generation<>? THEN 'unavailable' ELSE 'uncertain' END,error='tts_outcome_uncertain',text=NULL,voice_name=NULL WHERE id IN(SELECT id FROM tts_generations WHERE (status='attempting' AND deadline_at<=?) OR ((epoch<>? OR generation<>?) AND text IS NOT NULL) ORDER BY created_at LIMIT 10)",
  )
    .bind(
      fence.epoch,
      fence.generation,
      Date.now(),
      fence.epoch,
      fence.generation,
    )
    .run();
  await env.DB.prepare(
    "UPDATE media SET state='deleted',deleted_at=?,filename=NULL,sha256=NULL,size=NULL WHERE id IN(SELECT m.id FROM media m LEFT JOIN tts_generations t ON t.id=m.tts_generation_id WHERE m.tts_generation_id IS NOT NULL AND m.deleted_at IS NULL AND (t.id IS NULL OR t.status NOT IN ('attempting','ready')) LIMIT 10)",
  )
    .bind(Date.now())
    .run();
}
