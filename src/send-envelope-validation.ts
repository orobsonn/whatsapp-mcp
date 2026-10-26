import type {Env} from "./env";
import {assertActive,currentFence,AppError,LIMITS} from "./core";
import {getChat} from "./store";
import {supportsSendMedia} from "./zapi";
import {generatedMediaVisible} from "./media";
import {sendEnvelopeSchema,type SendEnvelope} from "./send-envelope";
export interface MediaRow {
  id: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  object_key: string;
  filename: string | null;
  version: number;
  message_id:string|null;
  message_version:number|null;
}
const visibleMedia=`m.state='ready' AND m.deleted_at IS NULL AND (m.message_id IS NULL OR (x.deleted_at IS NULL AND x.version=m.message_version)) AND ${generatedMediaVisible('m')}`;
export async function resolveMedia(
  env: Env,
  envelope: SendEnvelope,
): Promise<MediaRow | null> {
  if (envelope.kind === "text") return null;
  const f = currentFence(env);
  const m = await env.DB.prepare(
    `SELECT m.* FROM media m LEFT JOIN messages x ON x.id=m.message_id WHERE m.id=? AND m.epoch=? AND m.generation=? AND ${visibleMedia}`,
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
  if (!supportsSendMedia(envelope.kind, m.mime))
    throw new AppError("unsupported_send_media", 415);
  return {id:m.id,kind:m.kind,mime:m.mime,size:m.size,sha256:m.sha256,object_key:m.object_key,filename:m.filename,version:m.version,message_id:m.message_id,message_version:m.message_version};
}

/** Read-only validation shared by manual preparation and the nominal recipient proof. */
export async function resolveSendEnvelope(env:Env,input:unknown){
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
  return {envelope,chat,media:source};
}
/** The final local snapshot also closes changes during hashing/provider awaits.
 * Values are host-selected metadata, never SQL/columns supplied by a model. */
export function sendEnvelopeGuard(selected:Awaited<ReturnType<typeof resolveSendEnvelope>>){
 const {chat,media,envelope}=selected,values:(string|number|null)[]=[chat.id,chat.epoch,chat.generation,chat.external_id,chat.kind];
 let sql=`EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=? AND external_id=? AND kind=?)`;
 if(media){sql+=` AND EXISTS(SELECT 1 FROM media m LEFT JOIN messages x ON x.id=m.message_id WHERE m.id=? AND m.epoch=? AND m.generation=? AND ${visibleMedia} AND m.version=? AND m.sha256=? AND m.kind=? AND m.mime=? AND m.size=? AND m.object_key=? AND m.filename IS ? AND m.message_id IS ? AND m.message_version IS ?)`;values.push(media.id,chat.epoch,chat.generation,media.version,media.sha256,media.kind,media.mime,media.size,media.object_key,media.filename,media.message_id,media.message_version);}
 if(envelope.replyTo){sql+=` AND EXISTS(SELECT 1 FROM messages WHERE id=? AND chat_id=? AND epoch=? AND generation=? AND deleted_at IS NULL)`;values.push(envelope.replyTo,chat.id,chat.epoch,chat.generation);}
 return {sql,values};
}
