import { z } from "zod";
import type { Env } from "./env";
import { assertActive, currentFence, safeEqual } from "./core";
import { resolveRuntimeEnv } from "./connection";
import { readCaptureSnapshot, type CaptureSnapshot } from "./assistant-source-reader";

const id = z.string().min(1).max(256);
const querySchema = z.object({
  secret: z.string().max(256), sourceEpoch: id, sourceGeneration: id,
  sourceKind: z.enum(["message", "derivative", "media"]), sourceId: id, chatId: id,
}).strict();
export type NativeCaptureInputQuery = z.infer<typeof querySchema>;
type Identity = Omit<NativeCaptureInputQuery, "secret">;
export type NativeCaptureInput = ({ observation: "native_capture_input" } & Identity & {
  state: "available"; conversationKind: "private" | "group"; captureState: "enabled";
  originalMessageId: string; originalSequence: number; fromMe: boolean;
  authorId: string | null; authorLabel: string | null;
  text: string | null; textState: "ready" | "pending" | "unavailable";
  sourceVersion: number | null; watermark: number;
  /** Unmodified Source proof; Own hashes [sourceVersion, access, content]. */
  snapshot: CaptureSnapshot;
}) | ({ observation: "native_capture_input"; state: "blocked" | "withdrawn"; reason: string } & Partial<Identity>);

/** Private named capability only. The trigger is the original message's Source
 * upsert, including when a transcription becomes ready much later. The current
 * conversation watermark is evidence freshness, never that trigger sequence. */
export async function readNativeCaptureInput(raw: Env, input: unknown): Promise<NativeCaptureInput> {
  // Authenticate before parsing any body/ref fields or opening the database.
  const supplied = input !== null && typeof input === "object" ? (input as { secret?: unknown }).secret : undefined;
  const secret = raw.ASSISTANT_READER_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || typeof supplied !== "string" || supplied.length > 256
      || !await safeEqual(secret, supplied)) throw new Error("reader_denied");
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new Error("reader_invalid_input");
  const query = parsed.data;
  const identity: Identity = { sourceEpoch: query.sourceEpoch, sourceGeneration: query.sourceGeneration,
    sourceKind: query.sourceKind, sourceId: query.sourceId, chatId: query.chatId };
  const unavailable = (reason: string, state: "blocked" | "withdrawn" = "blocked"): NativeCaptureInput =>
    ({ observation: "native_capture_input", ...identity, state, reason });
  const env = await resolveRuntimeEnv(raw);
  try { assertActive(env); } catch { return unavailable("reader_unavailable"); }
  const fence = currentFence(env);
  if (query.sourceEpoch !== fence.epoch || query.sourceGeneration !== fence.generation) throw new Error("reader_denied");
  const snapshot = await readCaptureSnapshot(raw, query);
  if (snapshot.state !== "available") return unavailable(snapshot.reason ?? "source_unavailable", snapshot.state);
  const content = snapshot.content;
  if (!content || typeof content.messageId !== "string" || typeof content.fromMe !== "boolean"
      || !snapshot.access?.captureEnabled || !snapshot.conversationKind
      || !Number.isSafeInteger(snapshot.watermark) || snapshot.watermark! < 0) return unavailable("snapshot_incomplete");
  let originalSequence: number | null;
  try {
    originalSequence = await env.DB.prepare(`SELECT MIN(c.sequence) original_sequence
      FROM assistant_capture_changes c JOIN messages m
        ON m.id=c.source_id AND m.chat_id=c.chat_id AND m.epoch=c.epoch AND m.generation=c.generation
      WHERE c.epoch=? AND c.generation=? AND c.chat_id=? AND c.source_id=?
        AND c.source_kind='message' AND c.operation='upsert'`)
      .bind(fence.epoch, fence.generation, query.chatId, content.messageId).first<number>("original_sequence");
  } catch { return unavailable("source_unavailable"); }
  if (!Number.isSafeInteger(originalSequence) || originalSequence! < 1) return unavailable("original_sequence_unknown");
  // A lookup and snapshot span awaits. Re-read every content/version/access pin,
  // including authors and direction whose updates need not advance a watermark.
  const after = await readCaptureSnapshot(raw, query);
  if (after.state !== "available") return unavailable(after.reason ?? "source_unavailable", after.state);
  if (JSON.stringify(snapshot) !== JSON.stringify(after)) return unavailable("source_changed");
  const current = await resolveRuntimeEnv(raw);
  if (raw.ASSISTANT_READER_SECRET !== secret || !await safeEqual(secret, query.secret)) throw new Error("reader_denied");
  try { assertActive(current); } catch { return unavailable("reader_unavailable"); }
  const finalFence = currentFence(current);
  if (finalFence.epoch !== fence.epoch || finalFence.generation !== fence.generation) return unavailable("reader_changed");
  const text = typeof content.text === "string" ? content.text : null;
  const result: NativeCaptureInput = { observation: "native_capture_input", ...identity, state: "available",
    conversationKind: snapshot.conversationKind, captureState: "enabled", originalMessageId: content.messageId,
    originalSequence: originalSequence!, fromMe: content.fromMe,
    authorId: typeof content.authorId === "string" ? content.authorId : null,
    authorLabel: typeof content.authorName === "string" ? content.authorName : null,
    text, textState: text !== null ? "ready" : query.sourceKind === "media" || content.kind === "audio" || content.kind === "pdf" ? "pending" : "unavailable",
    sourceVersion: snapshot.sourceVersion ?? null, watermark: snapshot.watermark!, snapshot };
  // Each Source snapshot retains its existing 32 KiB contract. Allow envelope
  // overhead and the repeated text without narrowing the accepted Source body.
  return new TextEncoder().encode(JSON.stringify(result)).length <= 131072 ? result : unavailable("native_input_too_large");
}
