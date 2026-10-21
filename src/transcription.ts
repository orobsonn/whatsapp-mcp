import type { Env } from "./env";
import { assertActive, currentFence, LIMITS } from "./core";
import { transcribeMedia } from "./media";

/** Bounded background consumer. Per-media claims also protect manual/cron overlap. */
export async function processTranscriptions(env: Env) {
  const out = { processed: 0, ready: 0, failed: 0 };
  assertActive(env);
  if (
    env.AUTO_TRANSCRIPTION_ENABLED !== "true" ||
    env.TRANSCRIPTION_ENABLED !== "true" ||
    !env.AI
  )
    return out;
  const fence = currentFence(env),
    start = Date.now(),
    token = crypto.randomUUID();
  const lock = await env.DB.prepare(
    "UPDATE transcription_state SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<=? RETURNING enabled_since",
  )
    .bind(token, start + 360_000, start)
    .first<{ enabled_since: number }>();
  if (!lock) return out;
  try {
    await env.DB.prepare(
      "UPDATE media_jobs SET status='failed',error='media_attempts_exhausted',lease_until=NULL WHERE kind='transcribe' AND epoch=? AND generation=? AND status='processing' AND attempts>=? AND lease_until<=?",
    )
      .bind(fence.epoch, fence.generation, LIMITS.attempts, start)
      .run();
    const candidates = await env.DB.prepare(
      `SELECT a.id FROM media a JOIN messages m ON m.id=a.message_id AND m.version=a.message_version AND m.chat_id=a.chat_id AND m.epoch=a.epoch AND m.generation=a.generation JOIN chats c ON c.id=a.chat_id AND c.epoch=a.epoch AND c.generation=a.generation LEFT JOIN media_jobs j ON j.media_id=a.id AND j.kind='transcribe' AND j.message_version=a.message_version AND j.epoch=a.epoch AND j.generation=a.generation WHERE a.kind='audio' AND a.state='ready' AND a.deleted_at IS NULL AND a.epoch=? AND a.generation=? AND m.from_me=0 AND m.received_at>=? AND m.deleted_at IS NULL AND m.privacy_locked=0 AND m.unavailable_reason IS NULL AND m.kind='audio' AND c.capture_enabled=1 AND NOT EXISTS(SELECT 1 FROM media_derivatives d WHERE d.media_id=a.id AND d.media_version=a.version AND d.epoch=a.epoch AND d.generation=a.generation AND d.kind='transcript' AND d.state='ready') AND (j.id IS NULL OR (j.attempts<? AND j.next_attempt_at<=? AND (j.status IN ('pending','retry') OR (j.status='processing' AND j.lease_until<=?)))) ORDER BY m.received_at,a.id LIMIT 3`,
    )
      .bind(
        fence.epoch,
        fence.generation,
        lock.enabled_since,
        LIMITS.attempts,
        start,
        start,
      )
      .all<{ id: string }>();
    for (const candidate of candidates.results) {
      if (Date.now() - start >= 180_000) break;
      out.processed++;
      try {
        await transcribeMedia(env, candidate.id);
        out.ready++;
      } catch {
        out.failed++;
      } // Sanitized reason is persisted by transcribeMedia.
    }
    return out;
  } finally {
    await env.DB.prepare(
      "UPDATE transcription_state SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?",
    )
      .bind(token)
      .run();
  }
}
