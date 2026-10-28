import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "./env";
import { assertActive, currentFence, safeEqual } from "./core";
import { resolveRuntimeEnv } from "./connection";
import {readRecipientEnvelope} from './assistant-recipient-reader';
import {readCaptureConversationSearch} from './assistant-search-reader';

const MAX_BYTES = 32768;
const id = z.string().min(1).max(256);
export type CaptureInstallationAffinity = { observation: "capture_installation_affinity"; state: "available"; fence: { epoch: string; generation: string } }
  | { observation: "capture_installation_affinity"; state: "blocked"; reason: "reader_unavailable" | "reader_changed" };
const inputSchema = z.object({ secret: z.string().max(256), sourceEpoch: id, sourceGeneration: id,
  chatId: id, sourceId: id, sourceKind: z.enum(["message", "media", "derivative", "conversation"]),
}).strict().refine((input) => input.sourceKind !== "conversation" || input.sourceId === input.chatId);
type SourceKind = z.infer<typeof inputSchema>["sourceKind"];
export interface CaptureSnapshot {
  observation: "capture_snapshot";
  state: "available" | "withdrawn" | "blocked";
  reason?: string;
  sourceEpoch?: string; sourceGeneration?: string; sourceKind?: SourceKind; sourceId?: string; chatId?: string;
  sourceVersion?: number | null; watermark?: number | null;
  conversationKind?: "private" | "group";
  access?: { captureEnabled: boolean; captureSince: number | null; discontinuous: boolean };
  content?: Record<string, unknown>;
}
interface SnapshotRow {
  source_id: string | null; source_version: number | null; source_state: string | null;
  conversation_kind: string; conversation_name: string;
  capture_enabled: number; capture_since: number | null; capture_discontinuous: number; watermark: number;
  message_id: string | null; message_version: number; message_kind: string;
  message_deleted: number | null; privacy_locked: number; unavailable_reason: string | null;
  author_id: string | null; author_name: string | null; from_me: number; timestamp: number; received_at: number;
  media_id: string | null; media_version: number; media_message_version: number; media_kind: string;
  media_state: string; media_deleted: number | null; media_hash: string | null; media_size: number | null;
  media_mime: string | null; has_object: number; derivative_media_version: number; derivative_kind: string;
  text: string | null; text_bytes: number | null;
}
const messageScope = "m.chat_id=c.id AND m.epoch=c.epoch AND m.generation=c.generation";
const mediaScope = "a.chat_id=c.id AND a.epoch=c.epoch AND a.generation=c.generation";
const joins: Record<SourceKind, string> = {
  conversation: "LEFT JOIN capture_settings cs ON cs.chat_id=c.id",
  message: `LEFT JOIN messages m ON m.id=? AND ${messageScope}
    LEFT JOIN media a ON a.message_id=m.id AND a.message_version=m.version AND ${mediaScope}`,
  media: `LEFT JOIN media a ON a.id=? AND ${mediaScope}
    LEFT JOIN messages m ON m.id=a.message_id AND ${messageScope}`,
  derivative: `LEFT JOIN media_derivatives d ON d.id=? AND d.epoch=c.epoch AND d.generation=c.generation
    AND EXISTS(SELECT 1 FROM media dm WHERE dm.id=d.media_id AND dm.chat_id=c.id AND dm.epoch=c.epoch AND dm.generation=c.generation)
    LEFT JOIN media a ON a.id=d.media_id AND ${mediaScope}
    LEFT JOIN messages m ON m.id=a.message_id AND ${messageScope}`,
};
const messageActive = "m.id IS NOT NULL AND m.deleted_at IS NULL AND m.privacy_locked=0 AND m.unavailable_reason IS NULL";
const mediaActive = `${messageActive} AND a.id IS NOT NULL AND a.deleted_at IS NULL AND a.state='ready'
  AND a.message_version=m.version AND a.kind=m.kind`;
function snapshotSql(kind: SourceKind): string {
  const text = kind === "message" ? "m.text" : kind === "derivative" ? "d.text" : "NULL";
  const visible = `c.capture_enabled=1 AND ${kind === "derivative"
    ? `${mediaActive} AND d.state='ready' AND d.media_version=a.version` : kind === "message" ? messageActive : "1=1"}`;
  const source = { conversation: "c.id AS source_id,COALESCE(cs.revision,0) AS source_version,NULL AS source_state",
    message: "m.id AS source_id,m.version AS source_version,NULL AS source_state",
    media: "a.id AS source_id,a.version AS source_version,a.state AS source_state",
    derivative: "d.id AS source_id,NULL AS source_version,d.state AS source_state" }[kind];
  return `SELECT ${source},c.kind AS conversation_kind,c.name AS conversation_name,
    c.capture_enabled,c.capture_since,c.capture_discontinuous,
    COALESCE((SELECT MAX(sequence) FROM assistant_capture_changes cc
      WHERE cc.epoch=c.epoch AND cc.generation=c.generation AND cc.chat_id=c.id),0) AS watermark,
    CASE WHEN ${visible} AND length(CAST(${text} AS BLOB))<=${MAX_BYTES} THEN ${text} ELSE NULL END AS text,
    length(CAST(${text} AS BLOB)) AS text_bytes
    ${kind === "conversation" ? "" : `,m.id AS message_id,m.version AS message_version,m.kind AS message_kind,
      m.deleted_at AS message_deleted,m.privacy_locked,m.unavailable_reason,m.author_id,p.name AS author_name,
      m.from_me,m.timestamp,m.received_at,a.id AS media_id,a.version AS media_version,a.message_version AS media_message_version,
      a.kind AS media_kind,a.state AS media_state,a.deleted_at AS media_deleted,a.sha256 AS media_hash,a.size AS media_size,
      a.mime AS media_mime,a.object_key IS NOT NULL AS has_object`}
    ${kind === "derivative" ? ",d.media_version AS derivative_media_version,d.kind AS derivative_kind" : ""}
    FROM chats c ${joins[kind]} ${kind === "conversation" ? "" : "LEFT JOIN participants p ON p.id=m.author_id AND p.epoch=c.epoch AND p.generation=c.generation"}
    WHERE c.id=? AND c.epoch=? AND c.generation=?`;
}

/** Shared read-only proof; binary transport uses the same authorization twice. */
export async function readCaptureSnapshot(rawEnv: Env, input: unknown): Promise<CaptureSnapshot> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("reader_invalid_input");
  const query = parsed.data;
  const secret = rawEnv.ASSISTANT_READER_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || !(await safeEqual(secret, query.secret)))
    throw new Error("reader_denied");
  const env = await resolveRuntimeEnv(rawEnv);
  try { assertActive(env); } catch { return { observation: "capture_snapshot", state: "blocked", reason: "reader_unavailable" }; }
  const fence = currentFence(env);
  if (query.sourceEpoch !== fence.epoch || query.sourceGeneration !== fence.generation) throw new Error("reader_denied");
  const base: CaptureSnapshot = { observation: "capture_snapshot", state: "blocked", sourceEpoch: fence.epoch,
    sourceGeneration: fence.generation, sourceKind: query.sourceKind, sourceId: query.sourceId, chatId: query.chatId, watermark: null };
  let row: SnapshotRow | null;
  try {
    row = await env.DB.prepare(snapshotSql(query.sourceKind)).bind(
      ...(query.sourceKind === "conversation" ? [] : [query.sourceId]), query.chatId, fence.epoch, fence.generation,
    ).first<SnapshotRow>();
  } catch { return { ...base, reason: "source_unavailable" }; }
  if (!row) return { ...base, state: "withdrawn", reason: "conversation_missing" };
  base.watermark = row.watermark; base.sourceVersion = row.source_version;
  base.conversationKind = row.conversation_kind === "individual" ? "private" : "group";
  base.access = { captureEnabled: row.capture_enabled === 1, captureSince: row.capture_since, discontinuous: row.capture_discontinuous === 1 };
  const blocked = (reason: string): CaptureSnapshot => ({ ...base, state: "blocked", reason });
  const withdrawn = (reason: string): CaptureSnapshot => ({ ...base, state: "withdrawn", reason });
  if (!row.capture_enabled) return withdrawn("capture_disabled");
  if (!row.source_id) return withdrawn("source_missing");
  if (query.sourceKind !== "conversation") {
    if (row.message_deleted !== null || row.source_state === "deleted") return withdrawn("source_withdrawn");
    if (row.privacy_locked) return withdrawn("privacy_protected");
    if (!row.message_id || row.unavailable_reason !== null) return blocked("message_unavailable");
  }
  if (query.sourceKind === "media" || query.sourceKind === "derivative") {
    if (!row.media_id) return blocked("media_unavailable");
    if (row.media_message_version !== row.message_version || row.media_kind !== row.message_kind ||
        (query.sourceKind === "derivative" && row.derivative_media_version !== row.media_version)) return blocked("version_mismatch");
    if (row.media_deleted !== null || row.media_state === "deleted") return withdrawn("source_withdrawn");
    if (row.media_state !== "ready" || !row.has_object || !row.media_hash || !/^[a-f0-9]{64}$/.test(row.media_hash)) return blocked("media_unavailable");
    if (query.sourceKind === "derivative" && row.source_state !== "ready") return blocked("derivative_unavailable");
  }
  if ((row.text_bytes ?? 0) > MAX_BYTES) return blocked("snapshot_too_large");
  if (query.sourceKind === "derivative" && row.text === null) return blocked("derivative_without_text");
  const media = row.media_id && row.media_state === "ready" && row.media_deleted === null && row.has_object &&
    row.media_kind === row.message_kind && row.media_message_version === row.message_version && row.media_hash && /^[a-f0-9]{64}$/.test(row.media_hash) ? {
      id: row.media_id, version: row.media_version, hash: row.media_hash, size: row.media_size, mime: row.media_mime,
    } : undefined;
  const content = query.sourceKind === "conversation" ? { kind: row.conversation_kind, name: row.conversation_name }
    : { kind: query.sourceKind === "derivative" ? row.derivative_kind : row.message_kind,
      ...(query.sourceKind === "media" ? {} : { text: row.text }), authorId: row.author_id, authorName: row.author_name,
      fromMe: row.from_me === 1, occurredAt: row.timestamp, receivedAt: row.received_at,
      messageId: row.message_id, messageVersion: row.message_version,
      ...(media ? { media } : {}), ...(query.sourceKind === "derivative" ? { mediaVersion: row.media_version } : {}) };
  const result: CaptureSnapshot = { ...base, state: "available", content };
  return new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES ? blocked("snapshot_too_large") : result;
}

/** Bootstrap only through the named read capability with its fresh shared key.
 * No body, provider credential, phone, URL or public HTTP endpoint is involved. */
export async function readInstallationAffinity(rawEnv: Env, input: unknown): Promise<CaptureInstallationAffinity> {
  const parsed = z.object({ secret: z.string().max(256) }).strict().safeParse(input);
  if (!parsed.success) throw new Error("reader_invalid_input");
  const secret = rawEnv.ASSISTANT_READER_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || !await safeEqual(secret, parsed.data.secret)) throw new Error("reader_denied");
  const blocked = (reason: "reader_unavailable" | "reader_changed"): CaptureInstallationAffinity => ({ observation: "capture_installation_affinity", state: "blocked", reason });
  const first = await resolveRuntimeEnv(rawEnv);
  try { assertActive(first); } catch { return blocked("reader_unavailable"); }
  const fence = currentFence(first), current = await resolveRuntimeEnv(rawEnv);
  if (rawEnv.ASSISTANT_READER_SECRET !== secret || !await safeEqual(secret, parsed.data.secret)) throw new Error("reader_denied");
  try { assertActive(current); } catch { return blocked("reader_unavailable"); }
  const after = currentFence(current);
  if (after.epoch !== fence.epoch || after.generation !== fence.generation) return blocked("reader_changed");
  return { observation: "capture_installation_affinity", state: "available", fence };
}

/** Prospective cutoff on the Source stream, including changes not yet received by Own. */
export async function readCaptureStreamHead(rawEnv: Env,input:unknown) {
  const parsed=z.object({secret:z.string().max(256),sourceEpoch:id,sourceGeneration:id}).strict().safeParse(input);
  if(!parsed.success)throw Error('reader_invalid_input');
  const secret=rawEnv.ASSISTANT_READER_SECRET;
  if(typeof secret!=='string'||secret.length<32||!await safeEqual(secret,parsed.data.secret))throw Error('reader_denied');
  const env=await resolveRuntimeEnv(rawEnv),blocked=(reason:string)=>({observation:'capture_stream_head' as const,state:'blocked' as const,reason});
  try{assertActive(env);}catch{return blocked('reader_unavailable');}
  const fence=currentFence(env);
  if(fence.epoch!==parsed.data.sourceEpoch||fence.generation!==parsed.data.sourceGeneration)throw Error('reader_denied');
  const sequence=await env.DB.prepare('SELECT COALESCE(MAX(sequence),0) n FROM assistant_capture_changes WHERE epoch=? AND generation=?').bind(fence.epoch,fence.generation).first<number>('n');
  const current=await resolveRuntimeEnv(rawEnv);try{assertActive(current);}catch{return blocked('reader_unavailable');}
  if(rawEnv.ASSISTANT_READER_SECRET!==secret||!await safeEqual(secret,parsed.data.secret))throw Error('reader_denied');
  const after=currentFence(current);
  if(after.epoch!==fence.epoch||after.generation!==fence.generation)return blocked('reader_changed');
  if(sequence===null||!Number.isSafeInteger(sequence)||sequence<0)return blocked('source_unavailable');
  return {observation:'capture_stream_head' as const,state:'available' as const,sourceEpoch:fence.epoch,sourceGeneration:fence.generation,sequence:sequence!};
}

/** Named RPC capability only. Never bind an agent to the archive's default Fetcher. */
export class CaptureReader extends WorkerEntrypoint<Env> {
  streamHead(input:unknown){return readCaptureStreamHead(this.env,input);}
  searchConversations(input: unknown) { return readCaptureConversationSearch(this.env, input); }
  readRecipientEnvelope(input:unknown){return readRecipientEnvelope(this.env,input);}
  readSnapshot(input: unknown): Promise<CaptureSnapshot> { return readCaptureSnapshot(this.env, input); }
  installationAffinity(input: unknown): Promise<CaptureInstallationAffinity> { return readInstallationAffinity(this.env, input); }
}
