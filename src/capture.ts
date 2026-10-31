import type { Env } from "./env";
import {
  AppError,
  assertActive,
  assertFence,
  boundedInt,
  currentFence,
  decodeCursor,
  encodeCursor,
  escapeLike,
  LIMITS,
  sha256,
  type Fence,
} from "./core";
import { captureSetting, captureGaps, metricStatement } from "./capture-policy";
import { getChat, getChatExternal } from "./store";
export type MessageKind = "text" | "image" | "pdf" | "audio" | "unavailable";
export interface NormalizedEvent {
  chatExternalId: string;
  chatKind?: "individual" | "group";
  chatName?: string;
  externalId: string;
  authorExternalId?: string;
  authorName?: string;
  fromMe: boolean;
  kind: MessageKind;
  text?: string;
  timestamp: number;
  revision?: number;
  deleted?: boolean;
  viewOnce?: boolean;
  temporary?: boolean;
  unavailableReason?: string;
  media?: {
    url: string;
    mime?: string;
    filename?: string;
    durationSeconds?: number;
  };
}
export interface StatusEvent {
  externalId: string;
  chatExternalId?: string;
  status: "accepted" | "sent" | "delivered" | "read";
  failure?: string;
}
const statusNames = [
  "received",
  "accepted",
  "sent",
  "delivered",
  "read",
] as const;
interface MessageRow {
  id: string;
  chat_id: string;
  author_id: string | null;
  from_me: number;
  kind: MessageKind;
  text: string | null;
  timestamp: number;
  received_at: number;
  version: number;
  status_rank: number;
  failure: string | null;
  deleted_at: number | null;
  unavailable_reason: string | null;
  media_id: string | null;
  author_name: string | null;
  transcription_json: string | null;
}
export interface MessageView {
  id: string;
  chatId: string;
  authorId: string | null;
  authorName: string | null;
  fromMe: boolean;
  kind: MessageKind;
  text: string | null;
  textTruncated: boolean;
  transcription: {
    status: string;
    text: string | null;
    error: string | null;
    untrusted: true;
    truncated: boolean;
  } | null;
  timestamp: number;
  receivedAt: number;
  version: number;
  status: string;
  failure: string | null;
  deleted: boolean;
  unavailableReason: string | null;
  mediaId: string | null;
}
export async function ingestEvent(
  env: Env,
  fence: Fence,
  event: NormalizedEvent,
  observe = false,
): Promise<{
  captured: boolean;
  messageId?: string;
}> {
  assertActive(env);
  assertFence(env, fence);
  if (
    !event.externalId ||
    event.externalId.length > 256 ||
    !event.chatExternalId ||
    event.chatExternalId.length > 256 ||
    !Number.isFinite(event.timestamp) ||
    event.timestamp < 0 ||
    typeof event.fromMe !== "boolean" ||
    !["text", "image", "pdf", "audio", "unavailable"].includes(event.kind) ||
    (event.text?.length ?? 0) > LIMITS.textChars ||
    (event.authorExternalId?.length ?? 0) > 256
  )
    throw new AppError("invalid_event");
  const version = event.revision ?? 1;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AppError("invalid_revision");
  let chat = await getChatExternal(env, event.chatExternalId, fence);
  if (!chat && event.chatKind) {
    if (!["individual", "group"].includes(event.chatKind))
      throw new AppError("invalid_chat_kind");
    const id = await sha256(
      JSON.stringify([
        fence.epoch,
        fence.generation,
        "chat",
        event.chatExternalId,
      ]),
    );
    const time = Date.now();
    await env.DB.prepare(
      "INSERT INTO chats(id,epoch,generation,external_id,kind,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(epoch,generation,external_id) DO NOTHING",
    )
      .bind(
        id,
        fence.epoch,
        fence.generation,
        event.chatExternalId,
        event.chatKind,
        event.chatName?.slice(0, 256) || "Sem nome",
        time,
        time,
      )
      .run();
    chat = await getChatExternal(env, event.chatExternalId, fence);
  }
  if (chat && event.chatKind && chat.kind !== event.chatKind)
    throw new AppError("chat_kind_mismatch", 409);
  if (!chat?.capture_enabled) {
    if (observe)
      await env.DB.batch([
        metricStatement(env, "received"),
        metricStatement(env, "skipped"),
      ]);
    return { captured: false };
  }
  const id = await sha256(
    JSON.stringify([
      fence.epoch,
      fence.generation,
      event.chatExternalId,
      event.externalId,
    ]),
  );
  const author = event.authorExternalId
    ? await sha256(
        JSON.stringify([
          fence.epoch,
          fence.generation,
          "author",
          event.authorExternalId,
        ]),
      )
    : null;
  const unavailable = event.viewOnce
    ? "view_once"
    : (event.unavailableReason ??
      (event.kind !== "text" && !event.media ? "missing_media" : null));
  const privacyLocked = event.viewOnce ? 1 : 0;
  const kind = unavailable ? "unavailable" : event.kind;
  const text = event.deleted || privacyLocked ? null : (event.text ?? null);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (observe) {
    statements.push(metricStatement(env, "received"));
    statements.push(
      env.DB.prepare(
        "INSERT INTO capture_metrics(epoch,generation,day,stored,duplicates,skipped) SELECT ?,?,?,CASE WHEN c.capture_enabled=1 AND NOT EXISTS(SELECT 1 FROM messages WHERE id=?) THEN 1 ELSE 0 END,CASE WHEN c.capture_enabled=1 AND EXISTS(SELECT 1 FROM messages WHERE id=?) THEN 1 ELSE 0 END,CASE c.capture_enabled WHEN 0 THEN 1 ELSE 0 END FROM chats c WHERE c.id=? ON CONFLICT(epoch,generation,day) DO UPDATE SET stored=stored+excluded.stored,duplicates=duplicates+excluded.duplicates,skipped=skipped+excluded.skipped",
      ).bind(
        fence.epoch,
        fence.generation,
        new Date(now).toISOString().slice(0, 10),
        id,
        id,
        chat.id,
      ),
    );
  }
  if (author)
    statements.push(
      env.DB.prepare(
        "INSERT INTO participants(id,epoch,generation,external_id,name) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND capture_enabled=1 AND epoch=? AND generation=?) ON CONFLICT(id) DO UPDATE SET name=COALESCE(participants.name,excluded.name)",
      ).bind(
        author,
        fence.epoch,
        fence.generation,
        event.authorExternalId!,
        event.authorName?.slice(0, 256) ?? null,
        chat.id,
        fence.epoch,
        fence.generation,
      ),
    );
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages(id,chat_id,epoch,generation,external_id,author_id,from_me,kind,text,timestamp,received_at,version,deleted_at,unavailable_reason,privacy_locked)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND capture_enabled=1 AND epoch=? AND generation=?)
 ON CONFLICT(epoch,generation,chat_id,external_id) DO UPDATE SET
 privacy_locked=MAX(messages.privacy_locked,excluded.privacy_locked),
 kind=CASE WHEN messages.privacy_locked=1 OR excluded.privacy_locked=1 THEN 'unavailable' WHEN excluded.version>messages.version OR (messages.kind='unavailable' AND excluded.kind<>'unavailable') THEN excluded.kind ELSE messages.kind END,
 text=CASE WHEN messages.privacy_locked=1 OR excluded.privacy_locked=1 OR excluded.deleted_at IS NOT NULL THEN NULL WHEN excluded.version>messages.version THEN excluded.text ELSE COALESCE(messages.text,excluded.text) END,
 author_id=COALESCE(messages.author_id,excluded.author_id),
 version=MAX(messages.version,excluded.version),deleted_at=COALESCE(messages.deleted_at,excluded.deleted_at),
 unavailable_reason=CASE WHEN messages.privacy_locked=1 THEN messages.unavailable_reason WHEN excluded.privacy_locked=1 OR excluded.version>messages.version THEN excluded.unavailable_reason WHEN messages.kind='unavailable' AND excluded.kind<>'unavailable' THEN NULL ELSE messages.unavailable_reason END
 WHERE messages.deleted_at IS NULL AND (excluded.deleted_at IS NOT NULL OR excluded.privacy_locked=1 OR (messages.privacy_locked=0 AND excluded.version>=messages.version))`,
    ).bind(
      id,
      chat.id,
      fence.epoch,
      fence.generation,
      event.externalId,
      author,
      event.fromMe ? 1 : 0,
      kind,
      text,
      event.timestamp,
      now,
      version,
      event.deleted ? now : null,
      unavailable,
      privacyLocked,
      chat.id,
      fence.epoch,
      fence.generation,
    ),
  );
  statements.push(
    env.DB.prepare(
      "INSERT INTO message_versions(message_id,version,text,kind,created_at) SELECT id,version,text,kind,? FROM messages WHERE id=? AND deleted_at IS NULL AND privacy_locked=0 AND EXISTS(SELECT 1 FROM chats c WHERE c.id=messages.chat_id AND c.capture_enabled=1) ON CONFLICT DO NOTHING",
    ).bind(now, id),
  );
  // Invalidate old derivatives and jobs atomically with the visible message version.
  statements.push(
    env.DB.prepare(
      "UPDATE media SET deleted_at=?,state='deleted',source_url=NULL WHERE message_id=? AND (message_version<>(SELECT version FROM messages WHERE id=?) OR EXISTS(SELECT 1 FROM messages WHERE id=? AND (deleted_at IS NOT NULL OR privacy_locked=1)))",
    ).bind(now, id, id, id),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE media_jobs SET status='cancelled',lease_until=NULL WHERE media_id IN(SELECT id FROM media WHERE message_id=? AND deleted_at IS NOT NULL)",
    ).bind(id),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE media_derivatives SET text=NULL,state='deleted' WHERE media_id IN(SELECT id FROM media WHERE message_id=? AND deleted_at IS NOT NULL)",
    ).bind(id),
  );
  statements.push(
    env.DB.prepare(
      "DELETE FROM message_versions WHERE message_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND (deleted_at IS NOT NULL OR privacy_locked=1))",
    ).bind(id, id),
  );
  if (event.media && !unavailable && !event.deleted) {
    if (event.media.url.length > 4096) throw new AppError("invalid_media");
    const mediaId = await sha256(JSON.stringify([id, version, "media"]));
    statements.push(
      env.DB.prepare(
        `INSERT INTO media(id,chat_id,message_id,version,message_version,epoch,generation,kind,mime,state,source_url,filename,duration_seconds,created_at)
 SELECT ?,?,?,1,?,?,?,?,?,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND version=? AND deleted_at IS NULL AND privacy_locked=0 AND unavailable_reason IS NULL AND EXISTS(SELECT 1 FROM chats c WHERE c.id=messages.chat_id AND c.capture_enabled=1)) ON CONFLICT(message_id,message_version) DO NOTHING`,
      ).bind(
        mediaId,
        chat.id,
        id,
        version,
        fence.epoch,
        fence.generation,
        kind,
        event.media.mime ?? null,
        event.media.url,
        event.media.filename?.slice(0, 256) ?? null,
        event.media.durationSeconds ?? null,
        now,
        id,
        version,
      ),
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO media_jobs(id,media_id,message_version,epoch,generation,kind,status) SELECT ?,id,message_version,epoch,generation,'download','pending' FROM media WHERE id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM chats c WHERE c.id=media.chat_id AND c.capture_enabled=1) ON CONFLICT DO NOTHING",
      ).bind(crypto.randomUUID(), mediaId),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE messages SET status_rank=MAX(status_rank,COALESCE((SELECT status_rank FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=?),0)),failure=COALESCE((SELECT failure FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=?),failure) WHERE id=?`,
    ).bind(
      fence.epoch,
      fence.generation,
      event.chatExternalId,
      event.externalId,
      fence.epoch,
      fence.generation,
      event.chatExternalId,
      event.externalId,
      id,
    ),
  );
  statements.push(
    env.DB.prepare(
      "DELETE FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=?)",
    ).bind(
      fence.epoch,
      fence.generation,
      event.chatExternalId,
      event.externalId,
      id,
    ),
  );
  // A status without chat can be reconciled only while exactly one captured candidate exists.
  statements.push(
    env.DB.prepare(
      `UPDATE messages SET status_rank=MAX(status_rank,COALESCE((SELECT status_rank FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id='' AND external_id=?),0)),failure=COALESCE((SELECT failure FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id='' AND external_id=?),failure) WHERE id=? AND (SELECT COUNT(*) FROM messages WHERE epoch=? AND generation=? AND external_id=?)=1`,
    ).bind(
      fence.epoch,
      fence.generation,
      event.externalId,
      fence.epoch,
      fence.generation,
      event.externalId,
      id,
      fence.epoch,
      fence.generation,
      event.externalId,
    ),
  );
  statements.push(
    env.DB.prepare(
      "DELETE FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id='' AND external_id=? AND (SELECT COUNT(*) FROM messages WHERE epoch=? AND generation=? AND external_id=?)=1",
    ).bind(
      fence.epoch,
      fence.generation,
      event.externalId,
      fence.epoch,
      fence.generation,
      event.externalId,
    ),
  );
  const guarded = statements;
  // Final state is read within the same transaction; an opt-out queued before it wins.
  guarded.push(
    env.DB.prepare(
      "SELECT capture_enabled FROM chats WHERE id=? AND epoch=? AND generation=?",
    ).bind(chat.id, fence.epoch, fence.generation),
  );
  const result = await env.DB.batch(guarded);
  assertFence(env, fence);
  const captured = !!(
    result.at(-1)?.results[0] as { capture_enabled?: number } | undefined
  )?.capture_enabled;
  return captured ? { captured: true, messageId: id } : { captured: false };
}
export async function ingestStatus(
  env: Env,
  fence: Fence,
  event: StatusEvent,
): Promise<{
  pending: boolean;
}> {
  assertActive(env);
  assertFence(env, fence);
  const rank = statusNames.indexOf(event.status);
  if (rank < 1 || !event.externalId || event.externalId.length > 256)
    throw new AppError("invalid_status");
  if (
    event.chatExternalId !== undefined &&
    (!event.chatExternalId || event.chatExternalId.length > 256)
  )
    throw new AppError("invalid_status");
  const key = [
    fence.epoch,
    fence.generation,
    event.chatExternalId ?? "",
    event.externalId,
  ];
  const candidates = `SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.epoch=? AND m.generation=? AND m.external_id=? AND (? IS NULL OR c.external_id=?)`;
  const candidateBindings = [
    fence.epoch,
    fence.generation,
    event.externalId,
    event.chatExternalId ?? null,
    event.chatExternalId ?? null,
  ];
  // Persist, reconcile and consume in one D1 transaction. Capture may run before or after this batch,
  // but cannot interleave between a missing-body snapshot and the durable pending record.
  const result = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pending_statuses(id,epoch,generation,chat_external_id,external_id,status_rank,failure,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(epoch,generation,chat_external_id,external_id) DO UPDATE SET status_rank=MAX(pending_statuses.status_rank,excluded.status_rank),failure=COALESCE(excluded.failure,pending_statuses.failure)",
    ).bind(
      crypto.randomUUID(),
      ...key,
      rank,
      event.failure ? "provider_failure" : null,
      Date.now(),
    ),
    env.DB.prepare(
      `UPDATE messages SET status_rank=MAX(status_rank,(SELECT status_rank FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=?)),failure=COALESCE((SELECT failure FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=?),failure) WHERE id IN (${candidates}) AND (SELECT COUNT(*) FROM (${candidates}))=1`,
    ).bind(...key, ...key, ...candidateBindings, ...candidateBindings),
    env.DB.prepare(
      `DELETE FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=? AND (SELECT COUNT(*) FROM (${candidates}))=1`,
    ).bind(...key, ...candidateBindings),
  ]);
  assertFence(env, fence);
  return { pending: result[2]!.meta.changes === 0 };
}
export interface MessageQuery {
  chatId: string;
  from?: number;
  to?: number;
  authorId?: string;
  kind?: MessageKind;
  term?: string;
  cursor?: string;
  limit?: number;
}
export async function queryMessages(
  env: Env,
  input: MessageQuery,
): Promise<{
  items: MessageView[];
  nextCursor?: string;
  coverage: {
    captureEnabled: boolean;
    captureMode: string;
    gaps: Awaited<ReturnType<typeof captureGaps>>;
    captureSince: number | null;
    discontinuous: boolean;
    historicalImport: false;
    unavailable: number;
    pendingMedia: number;
  };
}> {
  const fence = currentFence(env);
  const chat = await getChat(env, input.chatId, fence);
  const limit = boundedInt(input.limit, 50, 50);
  if ((input.term?.length ?? 0) > 256) throw new AppError("invalid_term");
  for (const n of [input.from, input.to])
    if (n !== undefined && (!Number.isFinite(n) || n < 0))
      throw new AppError("invalid_period");
  const scope = JSON.stringify([
    fence,
    input.chatId,
    input.from ?? null,
    input.to ?? null,
    input.authorId ?? null,
    input.kind ?? null,
    input.term ?? "",
  ]);
  let last: {
    timestamp: number;
    id: string;
  } = { timestamp: -1, id: "" };
  if (input.cursor) {
    const c = decodeCursor<{
      scope: string;
      timestamp: number;
      id: string;
    }>(input.cursor);
    if (
      c.scope !== scope ||
      !Number.isFinite(c.timestamp) ||
      typeof c.id !== "string"
    )
      throw new AppError("invalid_cursor");
    last = c;
  }
  const rows = await env.DB.prepare(
    `SELECT m.*, (SELECT name FROM participants WHERE id=m.author_id) author_name, (SELECT id FROM media WHERE message_id=m.id AND message_version=m.version AND epoch=m.epoch AND generation=m.generation AND deleted_at IS NULL LIMIT 1) media_id,
    (SELECT json_object('status',CASE WHEN d.id IS NOT NULL THEN 'ready' WHEN a.state='failed' THEN 'download_failed' WHEN a.state<>'ready' THEN 'downloading' WHEN ${env.TRANSCRIPTION_ENABLED !== "true" || !env.AI || env.AUTO_TRANSCRIPTION_ENABLED !== "true" || !chat.capture_enabled ? 1 : 0}=1 THEN 'paused' WHEN j.error='transcription_quota' AND j.next_attempt_at>${Date.now()} THEN 'waiting_quota' WHEN j.status='failed' THEN 'failed' WHEN j.status='processing' THEN 'processing' WHEN j.status IN ('pending','retry') THEN 'pending' WHEN m.from_me=0 AND m.received_at>=(SELECT enabled_since FROM transcription_state WHERE id=1) THEN 'pending' ELSE 'not_requested' END,'text',d.text,'error',CASE WHEN a.state='failed' THEN (SELECT error FROM media_jobs WHERE media_id=a.id AND kind='download' AND epoch=a.epoch AND generation=a.generation LIMIT 1) ELSE j.error END,'untrusted',json('true'),'truncated',json('false'))
    FROM media a LEFT JOIN media_derivatives d ON d.media_id=a.id AND d.media_version=a.version AND d.epoch=a.epoch AND d.generation=a.generation AND d.kind='transcript' AND d.state='ready'
    LEFT JOIN media_jobs j ON j.media_id=a.id AND j.message_version=a.message_version AND j.epoch=a.epoch AND j.generation=a.generation AND j.kind='transcribe'
    WHERE a.message_id=m.id AND a.message_version=m.version AND a.chat_id=m.chat_id AND a.epoch=m.epoch AND a.generation=m.generation AND a.kind='audio' AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.privacy_locked=0 AND m.unavailable_reason IS NULL AND m.kind='audio' LIMIT 1) transcription_json
    FROM messages m WHERE chat_id=? AND epoch=? AND generation=? AND (timestamp>? OR (timestamp=? AND id>?)) AND (? IS NULL OR timestamp>=?) AND (? IS NULL OR timestamp<=?) AND (? IS NULL OR author_id=?) AND (? IS NULL OR kind=?) AND (? IS NULL OR (m.deleted_at IS NULL AND m.privacy_locked=0 AND m.unavailable_reason IS NULL AND (text LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM media a JOIN media_derivatives d ON d.media_id=a.id AND d.media_version=a.version AND d.epoch=a.epoch AND d.generation=a.generation AND d.kind='transcript' AND d.state='ready' WHERE a.message_id=m.id AND a.message_version=m.version AND a.chat_id=m.chat_id AND a.epoch=m.epoch AND a.generation=m.generation AND a.deleted_at IS NULL AND a.state='ready' AND a.kind='audio' AND m.kind='audio' AND d.text LIKE ? ESCAPE '\\')))) ORDER BY timestamp,id LIMIT ?`,
  )
    .bind(
      chat.id,
      fence.epoch,
      fence.generation,
      last.timestamp,
      last.timestamp,
      last.id,
      input.from ?? null,
      input.from ?? null,
      input.to ?? null,
      input.to ?? null,
      input.authorId ?? null,
      input.authorId ?? null,
      input.kind ?? null,
      input.kind ?? null,
      input.term ?? null,
      `%${escapeLike(input.term ?? "")}%`,
      `%${escapeLike(input.term ?? "")}%`,
      limit + 1,
    )
    .all<MessageRow>();
  const missing = await env.DB.prepare(
    "SELECT COUNT(*) count FROM messages WHERE chat_id=? AND unavailable_reason IS NOT NULL",
  )
    .bind(chat.id)
    .first<{
      count: number;
    }>();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) count FROM media WHERE chat_id=? AND deleted_at IS NULL AND state<>'ready'",
  )
    .bind(chat.id)
    .first<{
      count: number;
    }>();
  const gap = await env.DB.prepare(
    "SELECT capture_discontinuous FROM chats WHERE id=?",
  )
    .bind(chat.id)
    .first<{
      capture_discontinuous: number;
    }>();
  const coverage = {
    captureEnabled: !!chat.capture_enabled,
    captureMode: (await captureSetting(env, chat.id)).mode,
    gaps: await captureGaps(env, chat.id),
    captureSince: chat.capture_since,
    discontinuous: !!gap?.capture_discontinuous,
    historicalImport: false as const,
    unavailable: missing?.count ?? 0,
    pendingMedia: pending?.count ?? 0,
  };
  const items: MessageView[] = [];
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let nextCursor: string | undefined;
  for (const r of rows.results.slice(0, limit)) {
    const view: MessageView = {
      id: r.id,
      chatId: r.chat_id,
      authorId: r.author_id,
      authorName: r.from_me ? "Você" : r.author_name,
      fromMe: !!r.from_me,
      kind: r.kind,
      text: r.deleted_at ? null : r.text,
      textTruncated: false,
      transcription: r.transcription_json
        ? JSON.parse(r.transcription_json)
        : null,
      timestamp: r.timestamp,
      receivedAt: r.received_at,
      version: r.version,
      status: statusNames[r.status_rank] ?? "received",
      failure: r.failure,
      deleted: !!r.deleted_at,
      unavailableReason: r.unavailable_reason,
      mediaId: r.media_id,
    };
    const cursor =
      rows.results.length > items.length + 1
        ? encodeCursor({ scope, timestamp: r.timestamp, id: r.id })
        : undefined;
    const fits = () =>
      bytes({ items: [...items, view], nextCursor: cursor, coverage }) <=
      LIMITS.pageChars;
    if (!fits()) {
      if (items.length) break;
      // Ensure progress even when JSON escaping or UTF8 expansion makes the first message large.
      // Iterate code points through Array.from so a truncation never splits a surrogate pair.
      const transcript = view.transcription;
      if (transcript?.text && !fits()) {
        const points = Array.from(transcript.text);
        let low = 0,
          high = points.length;
        transcript.truncated = true;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          transcript.text = points.slice(0, middle).join("");
          if (fits()) low = middle;
          else high = middle - 1;
        }
        transcript.text = points.slice(0, low).join("");
      }
      if (!fits()) {
        const points = Array.from(view.text ?? "");
        let low = 0,
          high = points.length;
        view.textTruncated = true;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          view.text = points.slice(0, middle).join("");
          if (fits()) low = middle;
          else high = middle - 1;
        }
        view.text = points.slice(0, low).join("");
      }
      if (!fits()) throw new AppError("projection_too_large", 413);
    }
    items.push(view);
    nextCursor = cursor;
  }
  return { items, nextCursor, coverage };
}
// Z-API wire fields remain backend-only; normalization never treats sender text as commands.
export function normalizeZapiEvent(payload: unknown): NormalizedEvent {
  const p = record(payload);
  const chatExternalId = str(p.phone);
  const externalId = str(p.messageId);
  if (!chatExternalId || !externalId || typeof p.fromMe !== "boolean")
    throw new AppError("invalid_event");
  const timestamp =
    typeof p.momment === "number"
      ? p.momment
      : typeof p.moment === "number"
        ? p.moment
        : NaN;
  const text = record(p.text),
    image = record(p.image),
    audio = record(p.audio),
    document = record(p.document);
  let kind: MessageKind = "unavailable";
  let media: NormalizedEvent["media"];
  let content = str(text.message) || undefined;
  if (content !== undefined) kind = "text";
  else if (Object.keys(image).length) {
    kind = "image";
    if (str(image.imageUrl))
      media = {
        url: str(image.imageUrl),
        mime: str(image.mimeType) || "image/jpeg",
        filename: str(image.fileName) || undefined,
      };
    content = str(image.caption) || undefined;
  } else if (str(audio.audioUrl)) {
    kind = "audio";
    media = {
      url: str(audio.audioUrl),
      mime: str(audio.mimeType) || undefined,
      durationSeconds:
        typeof audio.seconds === "number" ? audio.seconds : undefined,
    };
  } else if (str(document.documentUrl)) {
    kind = "pdf";
    media = {
      url: str(document.documentUrl),
      mime: str(document.mimeType) || undefined,
      filename: str(document.fileName) || undefined,
    };
  }
  const deleted = p.isDeleted === true || p.type === "DeletedCallback";
  return {
    chatExternalId,
    chatKind:
      typeof p.isGroup === "boolean"
        ? p.isGroup
          ? "group"
          : "individual"
        : undefined,
    chatName:
      str(p.chatName) ||
      (p.fromMe === false && p.isGroup === false ? str(p.senderName) : "") ||
      undefined,
    externalId,
    authorExternalId:
      p.fromMe === true
        ? str(p.connectedPhone) || undefined
        : p.isGroup === true
          ? str(p.participantLid) || str(p.participantPhone) || undefined
          : str(p.senderLid) || chatExternalId,
    authorName: str(p.senderName) || undefined,
    fromMe: p.fromMe,
    kind,
    text: content,
    timestamp,
    revision: p.isEdit === true ? Math.max(2, timestamp) : 1,
    deleted,
    viewOnce:
      p.viewOnce === true ||
      image.viewOnce === true ||
      audio.viewOnce === true ||
      document.viewOnce === true,
    temporary:
      typeof p.messageExpirationSeconds === "number" &&
      p.messageExpirationSeconds > 0,
    unavailableReason:
      kind === "unavailable" ? "unsupported_or_missing_content" : undefined,
    media,
  };
}
function record(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
}
function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}
