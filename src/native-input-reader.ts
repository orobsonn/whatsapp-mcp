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
export type NativeCaptureAuthorship = { kind: "external" }
  | { kind: "assistant_action"; action: { id: string; status: string } }
  | { kind: "own_device_unattributed" };
export type NativeCaptureInput = ({ observation: "native_capture_input" } & Identity & {
  state: "available"; conversationKind: "private" | "group"; captureState: "enabled";
  originalMessageId: string; originalSequence: number; fromMe: boolean;
  /** Device direction alone is never evidence of a human author or approval. */
  authorship: NativeCaptureAuthorship;
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
  const observeAuthorship = async (): Promise<NativeCaptureAuthorship | null> => {
    if (!content.fromMe) return { kind: "external" };
    // Provider identifiers stay inside this join. Scope and uniqueness are
    // required; equal text, author labels and timestamps prove no correlation.
    const row = await env.DB.prepare(`SELECT m.from_me,COUNT(a.id) match_count,
      CASE WHEN COUNT(a.id)=1 AND length(MIN(a.id)) BETWEEN 1 AND 256 THEN MIN(a.id) END action_id,
      CASE WHEN COUNT(a.id)=1 AND length(MIN(a.status)) BETWEEN 1 AND 64 THEN MIN(a.status) END action_status
      FROM messages m LEFT JOIN actions a ON a.epoch=m.epoch AND a.generation=m.generation AND a.chat_id=m.chat_id
        AND m.external_id<>'' AND (a.provider_message_id=m.external_id OR a.provider_zaap_id=m.external_id)
      WHERE m.id=? AND m.chat_id=? AND m.epoch=? AND m.generation=? GROUP BY m.id,m.from_me`)
      .bind(content.messageId, query.chatId, fence.epoch, fence.generation)
      .first<{ from_me: number; match_count: number; action_id: string | null; action_status: string | null }>();
    if (!row || row.from_me !== 1) return null;
    if (row.match_count === 1 && id.safeParse(row.action_id).success
        && z.string().min(1).max(64).safeParse(row.action_status).success)
      return { kind: "assistant_action", action: { id: row.action_id!, status: row.action_status! } };
    return { kind: "own_device_unattributed" };
  };
  let authorship: NativeCaptureAuthorship | null;
  try { authorship = await observeAuthorship(); } catch { return unavailable("source_unavailable"); }
  if (!authorship) return unavailable("source_changed");
  // A lookup and snapshot span awaits. Re-read every content/version/access pin,
  // including authors and direction whose updates need not advance a watermark.
  const after = await readCaptureSnapshot(raw, query);
  if (after.state !== "available") return unavailable(after.reason ?? "source_unavailable", after.state);
  if (JSON.stringify(snapshot) !== JSON.stringify(after)) return unavailable("source_changed");
  // Actions settle asynchronously after provider acceptance. Recheck exact
  // attribution/status across the proof; a late or ambiguous receipt is never
  // promoted into human authorship. Unknown device input stays unattributed.
  let finalAuthorship: NativeCaptureAuthorship | null;
  try { finalAuthorship = await observeAuthorship(); } catch { return unavailable("source_unavailable"); }
  if (JSON.stringify(authorship) !== JSON.stringify(finalAuthorship)) return unavailable("source_changed");
  const current = await resolveRuntimeEnv(raw);
  if (raw.ASSISTANT_READER_SECRET !== secret || !await safeEqual(secret, query.secret)) throw new Error("reader_denied");
  try { assertActive(current); } catch { return unavailable("reader_unavailable"); }
  const finalFence = currentFence(current);
  if (finalFence.epoch !== fence.epoch || finalFence.generation !== fence.generation) return unavailable("reader_changed");
  const text = typeof content.text === "string" ? content.text : null;
  const result: NativeCaptureInput = { observation: "native_capture_input", ...identity, state: "available",
    conversationKind: snapshot.conversationKind, captureState: "enabled", originalMessageId: content.messageId,
    originalSequence: originalSequence!, fromMe: content.fromMe, authorship,
    authorId: typeof content.authorId === "string" ? content.authorId : null,
    authorLabel: typeof content.authorName === "string" ? content.authorName : null,
    text, textState: text !== null ? "ready" : query.sourceKind === "media" || content.kind === "audio" || content.kind === "pdf" ? "pending" : "unavailable",
    sourceVersion: snapshot.sourceVersion ?? null, watermark: snapshot.watermark!, snapshot };
  // Each Source snapshot retains its existing 32 KiB contract. Allow envelope
  // overhead and the repeated text without narrowing the accepted Source body.
  return new TextEncoder().encode(JSON.stringify(result)).length <= 131072 ? result : unavailable("native_input_too_large");
}
