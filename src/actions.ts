import { z } from "zod";
import type { Env } from "./env";
import { AppError, assertActive, currentFence, sha256, LIMITS } from "./core";
import { getChat } from "./store";
import type { ZapiSendEnvelope, ZapiSendIds } from "./zapi";
import { ingestEvent, ingestStatus } from "./capture";

const ref = z.string().min(1).max(200);
const options = { chatId: ref, replyTo: ref.optional() };
const file = {
  ...options,
  mediaId: ref,
  mediaHash: z.string().regex(/^[a-f0-9]{64}$/),
  caption: z.string().max(8000).optional(),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\x00-\x1f]+$/)
    .optional(),
};
export const sendEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...options,
      kind: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(8000)
        .refine((s) => s.trim().length > 0),
    })
    .strict(),
  z.object({ ...file, kind: z.literal("image") }).strict(),
  z.object({ ...file, kind: z.literal("pdf") }).strict(),
  z.object({ ...file, kind: z.literal("audio") }).strict(),
]);
export type SendEnvelope = z.infer<typeof sendEnvelopeSchema>;

/** Parse to a fixed key order before hashing; unknown transport options are forbidden. */
export function canonicalEnvelope(input: unknown): string {
  return JSON.stringify(sendEnvelopeSchema.parse(input));
}
export async function actionDigest(input: unknown): Promise<string> {
  const parsed = JSON.parse(canonicalEnvelope(input));
  return sha256(JSON.stringify(parsed, Object.keys(parsed).sort()));
}
interface ActionRow {
  id: string;
  epoch: string;
  generation: string;
  chat_id: string;
  envelope_json: string;
  hash: string;
  status: string;
  expires_at: number;
  approved_at: number | null;
  attempted_at: number | null;
  provider_message_id: string | null;
  provider_zaap_id: string | null;
  last_error: string | null;
  created_at: number;
}
interface MediaRow {
  id: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  object_key: string;
  filename: string | null;
  version: number;
}
export interface SendProvider {
  status(): Promise<{ connected: boolean; phone?: string }>;
  send(envelope: ZapiSendEnvelope): Promise<ZapiSendIds>;
}
export interface ApprovalProof {
  sub: string;
  epoch: string;
  purpose: string;
  resourceId: string;
  envelopeHash: string;
}
async function row(env: Env, id: string): Promise<ActionRow> {
  assertActive(env);
  const f = currentFence(env);
  const a = await env.DB.prepare(
    "SELECT * FROM actions WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(id, f.epoch, f.generation)
    .first<ActionRow>();
  if (!a) throw new AppError("action_not_found", 404);
  if (a.envelope_json === "{}") {
    if (["proposed", "approved"].includes(a.status))
      throw new AppError("action_expired", 409);
  } else if ((await actionDigest(JSON.parse(a.envelope_json))) !== a.hash)
    throw new AppError("action_changed", 409);
  return a;
}
async function resolveMedia(
  env: Env,
  envelope: SendEnvelope,
): Promise<MediaRow | null> {
  if (envelope.kind === "text") return null;
  const f = currentFence(env);
  const m = await env.DB.prepare(
    "SELECT m.* FROM media m LEFT JOIN messages x ON x.id=m.message_id WHERE m.id=? AND m.epoch=? AND m.generation=? AND m.state='ready' AND m.deleted_at IS NULL AND (m.message_id IS NULL OR (x.deleted_at IS NULL AND x.version=m.message_version))",
  )
    .bind(envelope.mediaId, f.epoch, f.generation)
    .first<MediaRow>();
  if (
    !m ||
    m.sha256 !== envelope.mediaHash ||
    m.kind !== envelope.kind ||
    !m.object_key ||
    m.size > LIMITS.mediaBytes
  )
    throw new AppError("media_unavailable", 409);
  return m;
}
export async function prepareAction(env: Env, input: unknown) {
  assertActive(env);
  const envelope = sendEnvelopeSchema.parse(input);
  const chat = await getChat(env, envelope.chatId);
  const source = await resolveMedia(env, envelope);
  if (
    envelope.kind === "audio" &&
    (envelope.caption !== undefined || envelope.replyTo !== undefined)
  )
    throw new AppError("unsupported_audio_options");
  if (envelope.kind === "pdf") {
    envelope.fileName = envelope.fileName ?? source?.filename ?? "arquivo.pdf";
    if (!/^[^/\\\x00-\x1f\x7f]{1,124}\.pdf$/i.test(envelope.fileName))
      throw new AppError("invalid_pdf_filename");
  }
  if (envelope.replyTo) {
    const reply = await env.DB.prepare(
      "SELECT id FROM messages WHERE id=? AND chat_id=? AND epoch=? AND generation=? AND deleted_at IS NULL",
    )
      .bind(envelope.replyTo, chat.id, chat.epoch, chat.generation)
      .first();
    if (!reply) throw new AppError("reply_not_found", 404);
  }
  const id = crypto.randomUUID(),
    now = Date.now(),
    hash = await actionDigest(envelope);
  await env.DB.prepare(
    "INSERT INTO actions(id,epoch,generation,chat_id,envelope_json,hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,'proposed',?,?)",
  )
    .bind(
      id,
      chat.epoch,
      chat.generation,
      chat.id,
      canonicalEnvelope(envelope),
      hash,
      now + 600000,
      now,
    )
    .run();
  return getAction(env, id);
}
export async function getAction(env: Env, id: string) {
  const a = await row(env, id),
    chat = await getChat(env, a.chat_id);
  const status = a.status === "attempting" ? "uncertain" : a.status;
  return {
    id: a.id,
    status,
    chat: { id: chat.id, name: chat.name, kind: chat.kind },
    envelope:
      a.envelope_json === "{}"
        ? null
        : (JSON.parse(a.envelope_json) as SendEnvelope),
    redacted: a.envelope_json === "{}",
    hash: a.hash,
    expiresAt: a.expires_at,
    error: a.last_error,
    confirmationUrl: `${env.PUBLIC_ORIGIN}/confirm/send/${encodeURIComponent(a.id)}`,
    groupDelivery: chat.kind === "group" ? "aggregate_only" : undefined,
  };
}
/** Only the browser confirmation handler calls this; it is deliberately absent from MCP. */
export async function approveAction(
  env: Env,
  id: string,
  proof: ApprovalProof,
): Promise<void> {
  const a = await row(env, id);
  if (
    proof.sub !== env.OWNER_SUB ||
    proof.epoch !== a.epoch ||
    proof.purpose !== "send" ||
    proof.resourceId !== id ||
    proof.envelopeHash !== a.hash
  )
    throw new AppError("approval_mismatch", 403);
  if (a.expires_at <= Date.now()) throw new AppError("action_expired", 409);
  const result = await env.DB.prepare(
    "UPDATE actions SET status='approved',approved_at=? WHERE id=? AND epoch=? AND generation=? AND status='proposed' AND hash=? AND expires_at>?",
  )
    .bind(Date.now(), id, a.epoch, a.generation, a.hash, Date.now())
    .run();
  if (result.meta.changes !== 1) throw new AppError("action_not_proposed", 409);
}
export async function cancelAction(env: Env, id: string): Promise<void> {
  const a = await row(env, id);
  await env.DB.prepare(
    "UPDATE actions SET status='cancelled' WHERE id=? AND epoch=? AND generation=? AND status IN ('proposed','approved')",
  )
    .bind(id, a.epoch, a.generation)
    .run();
}
export async function executeAction(
  env: Env,
  id: string,
  provider: SendProvider,
) {
  const a = await row(env, id);
  if (!["proposed", "approved"].includes(a.status)) return getAction(env, id);
  if (a.expires_at <= Date.now()) throw new AppError("action_expired", 409);
  if (a.status !== "approved") throw new AppError("action_not_approved", 403);
  const envelope = sendEnvelopeSchema.parse(JSON.parse(a.envelope_json));
  const chat = await getChat(env, a.chat_id),
    media = await resolveMedia(env, envelope);
  let bytes: Uint8Array | undefined;
  if (media) {
    const object = await env.MEDIA.get(media.object_key);
    if (!object || object.size > LIMITS.mediaBytes)
      throw new AppError("media_unavailable", 409);
    bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256(bytes)) !== media.sha256)
      throw new AppError("media_changed", 409);
  }
  let replyTo: string | undefined;
  if (envelope.replyTo) {
    const reply = await env.DB.prepare(
      "SELECT external_id FROM messages WHERE id=? AND chat_id=? AND deleted_at IS NULL",
    )
      .bind(envelope.replyTo, chat.id)
      .first<{ external_id: string }>();
    if (!reply) throw new AppError("reply_not_found", 404);
    replyTo = reply.external_id;
  }
  const status = await provider.status();
  if (
    !status.connected ||
    !env.CONNECTED_PHONE ||
    status.phone !== env.CONNECTED_PHONE
  )
    throw new AppError("device_changed", 409);
  assertActive(env);
  // A single conditional write owns the sole external attempt. A crash after it is uncertain.
  const claimed = await env.DB.prepare(
    "UPDATE actions SET status='attempting',attempted_at=? WHERE id=? AND epoch=? AND generation=? AND status='approved' AND expires_at>? AND hash=? AND (? IS NULL OR EXISTS (SELECT 1 FROM media WHERE id=? AND deleted_at IS NULL AND state='ready' AND sha256=?))",
  )
    .bind(
      Date.now(),
      id,
      a.epoch,
      a.generation,
      Date.now(),
      a.hash,
      media?.id ?? null,
      media?.id ?? null,
      media?.sha256 ?? null,
    )
    .run();
  if (claimed.meta.changes !== 1) return getAction(env, id);
  let ids: ZapiSendIds;
  try {
    ids = await provider.send({
      destination: chat.external_id,
      kind: envelope.kind,
      text: envelope.kind === "text" ? envelope.text : undefined,
      bytes,
      mime: media?.mime,
      caption: envelope.kind === "text" ? undefined : envelope.caption,
      fileName:
        envelope.kind === "text"
          ? undefined
          : (envelope.fileName ?? media?.filename ?? undefined),
      replyTo,
    });
  } catch {
    await env.DB.prepare(
      "UPDATE actions SET status='uncertain',last_error='provider_result_unknown' WHERE id=? AND status='attempting'",
    )
      .bind(id)
      .run();
    return getAction(env, id);
  }
  await env.DB.prepare(
    "UPDATE actions SET status=CASE WHEN status='attempting' THEN 'accepted' ELSE status END,provider_message_id=?,provider_zaap_id=? WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(ids.messageId ?? null, ids.zaapId ?? null, id, a.epoch, a.generation)
    .run();
  if (ids.messageId) {
    if (envelope.kind === "text")
      await ingestEvent(env, currentFence(env), {
        chatExternalId: chat.external_id,
        externalId: ids.messageId,
        fromMe: true,
        kind: "text",
        text: envelope.text,
        timestamp: Date.now(),
      });
    else if (media && chat.capture_enabled)
      await archiveSentMedia(
        env,
        a,
        chat.external_id,
        ids.messageId,
        envelope,
        media,
      );
    await ingestStatus(env, currentFence(env), {
      chatExternalId: chat.external_id,
      externalId: ids.messageId,
      status: "accepted",
    });
    // Re-read pending status through the same namespace when the callback preceded API response.
    const m = await env.DB.prepare(
      "SELECT status_rank FROM messages WHERE chat_id=? AND external_id=? AND epoch=? AND generation=?",
    )
      .bind(chat.id, ids.messageId, a.epoch, a.generation)
      .first<{ status_rank: number }>();
    if (m && m.status_rank > 0)
      await reconcileActions(env, {
        externalId: ids.messageId,
        chatExternalId: chat.external_id,
        status:
          (["accepted", "sent", "delivered", "read"] as const)[
            m.status_rank - 1
          ] ?? "accepted",
      });
  }
  return getAction(env, id);
}
async function archiveSentMedia(
  env: Env,
  a: ActionRow,
  chatExternalId: string,
  externalId: string,
  envelope: Exclude<SendEnvelope, { kind: "text" }>,
  source: MediaRow,
): Promise<void> {
  const messageId = await sha256(
    JSON.stringify([a.epoch, a.generation, chatExternalId, externalId]),
  );
  const mediaId = await sha256(JSON.stringify([messageId, 1, "media"])),
    now = Date.now();
  // Archive the exact immutable object we sent. An early provider echo remains one message.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at,status_rank) SELECT ?,?,?,?,?,1,?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=? AND capture_enabled=1) ON CONFLICT(epoch,generation,chat_id,external_id) DO UPDATE SET status_rank=MAX(messages.status_rank,1) WHERE messages.deleted_at IS NULL",
    ).bind(
      messageId,
      a.chat_id,
      a.epoch,
      a.generation,
      externalId,
      envelope.kind,
      envelope.caption ?? null,
      now,
      now,
      a.chat_id,
      a.epoch,
      a.generation,
    ),
    env.DB.prepare(
      "INSERT INTO media(id,chat_id,message_id,version,message_version,epoch,generation,kind,mime,size,sha256,object_key,state,filename,created_at) SELECT ?,?,?,1,1,?,?,?,?,?,?,?,'ready',?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND version=1 AND deleted_at IS NULL AND privacy_locked=0 AND unavailable_reason IS NULL) AND EXISTS(SELECT 1 FROM media WHERE id=? AND state='ready' AND deleted_at IS NULL AND sha256=?) ON CONFLICT(message_id,message_version) DO UPDATE SET mime=excluded.mime,size=excluded.size,sha256=excluded.sha256,object_key=excluded.object_key,state='ready',source_url=NULL WHERE media.deleted_at IS NULL",
    ).bind(
      mediaId,
      a.chat_id,
      messageId,
      a.epoch,
      a.generation,
      envelope.kind,
      source.mime,
      source.size,
      source.sha256,
      source.object_key,
      envelope.fileName ?? source.filename,
      now,
      messageId,
      source.id,
      source.sha256,
    ),
    env.DB.prepare(
      "UPDATE media_jobs SET status='done',lease_until=NULL WHERE media_id=? AND kind='download' AND EXISTS(SELECT 1 FROM media WHERE id=? AND state='ready' AND deleted_at IS NULL)",
    ).bind(mediaId, mediaId),
  ]);
}
export async function reconcileActions(
  env: Env,
  input: {
    externalId: string;
    chatExternalId?: string;
    status: "accepted" | "sent" | "delivered" | "read";
  },
) {
  const f = currentFence(env);
  const rows = await env.DB.prepare(
    "SELECT a.id,a.status FROM actions a JOIN chats c ON c.id=a.chat_id WHERE a.epoch=? AND a.generation=? AND a.provider_message_id=? AND (? IS NULL OR c.external_id=?)",
  )
    .bind(
      f.epoch,
      f.generation,
      input.externalId,
      input.chatExternalId ?? null,
      input.chatExternalId ?? null,
    )
    .all<{ id: string; status: string }>();
  if (rows.results.length !== 1) return;
  const a = rows.results[0]!,
    rank = ["accepted", "sent", "delivered", "read"];
  if (
    rank.indexOf(input.status) > rank.indexOf(a.status) &&
    !["cancelled", "proposed", "approved"].includes(a.status)
  )
    await env.DB.prepare(
      "UPDATE actions SET status=?,last_error=NULL WHERE id=? AND status=?",
    )
      .bind(input.status, a.id, a.status)
      .run();
}
