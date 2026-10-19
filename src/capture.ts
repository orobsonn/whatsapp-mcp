import type { Env } from './env';
import { AppError, assertActive, assertFence, boundedInt, currentFence, decodeCursor, encodeCursor, escapeLike, LIMITS, sha256, type Fence } from './core';
import { getChat, getChatExternal } from './store';
export type MessageKind = 'text' | 'image' | 'pdf' | 'audio' | 'unavailable';
export interface NormalizedEvent {
    chatExternalId: string;
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
    status: 'accepted' | 'sent' | 'delivered' | 'read';
    failure?: string;
}
const statusNames = ['received', 'accepted', 'sent', 'delivered', 'read'] as const;
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
}
export interface MessageView {
    id: string;
    chatId: string;
    authorId: string | null;
    authorName: string | null;
    fromMe: boolean;
    kind: MessageKind;
    text: string | null;
    timestamp: number;
    receivedAt: number;
    version: number;
    status: string;
    failure: string | null;
    deleted: boolean;
    unavailableReason: string | null;
    mediaId: string | null;
}
export async function ingestEvent(env: Env, fence: Fence, event: NormalizedEvent): Promise<{
    captured: boolean;
    messageId?: string;
}> {
    assertActive(env);
    assertFence(env, fence);
    if (!event.externalId || event.externalId.length > 256 || !event.chatExternalId || event.chatExternalId.length > 256 || !Number.isFinite(event.timestamp) || event.timestamp < 0 || typeof event.fromMe !== 'boolean' || !['text', 'image', 'pdf', 'audio', 'unavailable'].includes(event.kind) || (event.text?.length ?? 0) > LIMITS.textChars || (event.authorExternalId?.length ?? 0) > 256)
        throw new AppError('invalid_event');
    const version = event.revision ?? 1;
    if (!Number.isSafeInteger(version) || version < 1)
        throw new AppError('invalid_revision');
    const chat = await getChatExternal(env, event.chatExternalId, fence);
    if (!chat?.capture_enabled)
        return { captured: false };
    const id = await sha256(JSON.stringify([fence.epoch, fence.generation, event.chatExternalId, event.externalId]));
    const author = event.authorExternalId ? await sha256(JSON.stringify([fence.epoch, fence.generation, 'author', event.authorExternalId])) : null;
    const unavailable = event.viewOnce ? 'view_once' : event.temporary ? 'temporary' : event.unavailableReason ?? (event.kind !== 'text' && !event.media ? 'missing_media' : null);
    const kind = unavailable ? 'unavailable' : event.kind;
    const text = event.deleted || unavailable ? null : event.text ?? null;
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    if (author)
        statements.push(env.DB.prepare('INSERT INTO participants(id,epoch,generation,external_id,name) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(author, fence.epoch, fence.generation, event.authorExternalId!, event.authorName?.slice(0, 256) ?? null));
    statements.push(env.DB.prepare(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,author_id,from_me,kind,text,timestamp,received_at,version,deleted_at,unavailable_reason)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND capture_enabled=1 AND epoch=? AND generation=?)
 ON CONFLICT(epoch,generation,chat_id,external_id) DO UPDATE SET kind=excluded.kind,text=excluded.text,version=MAX(messages.version,excluded.version),deleted_at=COALESCE(messages.deleted_at,excluded.deleted_at),unavailable_reason=excluded.unavailable_reason
 WHERE messages.deleted_at IS NULL AND (excluded.deleted_at IS NOT NULL OR excluded.version>messages.version OR (messages.text IS NULL AND excluded.text IS NOT NULL AND excluded.version=messages.version))`).bind(id, chat.id, fence.epoch, fence.generation, event.externalId, author, event.fromMe ? 1 : 0, kind, text, event.timestamp, now, version, event.deleted ? now : null, unavailable, chat.id, fence.epoch, fence.generation));
    statements.push(env.DB.prepare('INSERT INTO message_versions(message_id,version,text,kind,created_at) SELECT id,version,text,kind,? FROM messages WHERE id=? AND deleted_at IS NULL ON CONFLICT DO NOTHING').bind(now, id));
    // Invalidate old derivatives and jobs atomically with the visible message version.
    statements.push(env.DB.prepare("UPDATE media SET deleted_at=?,state='deleted',source_url=NULL WHERE message_id=? AND (message_version<>(SELECT version FROM messages WHERE id=?) OR EXISTS(SELECT 1 FROM messages WHERE id=? AND deleted_at IS NOT NULL))").bind(now, id, id, id));
    statements.push(env.DB.prepare("UPDATE media_jobs SET status='cancelled',lease_until=NULL WHERE media_id IN(SELECT id FROM media WHERE message_id=? AND deleted_at IS NOT NULL)").bind(id));
    statements.push(env.DB.prepare("UPDATE media_derivatives SET text=NULL,state='deleted' WHERE media_id IN(SELECT id FROM media WHERE message_id=? AND deleted_at IS NOT NULL)").bind(id));
    statements.push(env.DB.prepare('DELETE FROM message_versions WHERE message_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND deleted_at IS NOT NULL)').bind(id, id));
    if (event.media && !unavailable && !event.deleted) {
        if (event.media.url.length > 4096)
            throw new AppError('invalid_media');
        const mediaId = await sha256(JSON.stringify([id, version, 'media']));
        statements.push(env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,version,message_version,epoch,generation,kind,mime,state,source_url,filename,duration_seconds,created_at)
 SELECT ?,?,?,1,?,?,?,?,?,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND version=? AND deleted_at IS NULL) ON CONFLICT(message_id,message_version) DO NOTHING`).bind(mediaId, chat.id, id, version, fence.epoch, fence.generation, kind, event.media.mime ?? null, event.media.url, event.media.filename?.slice(0, 256) ?? null, event.media.durationSeconds ?? null, now, id, version));
        statements.push(env.DB.prepare("INSERT INTO media_jobs(id,media_id,message_version,epoch,generation,kind,status) SELECT ?,id,message_version,epoch,generation,'download','pending' FROM media WHERE id=? AND deleted_at IS NULL ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), mediaId));
    }
    statements.push(env.DB.prepare(`UPDATE messages SET status_rank=MAX(status_rank,COALESCE((SELECT status_rank FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=?),0)),failure=COALESCE((SELECT failure FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=?),failure) WHERE id=?`).bind(fence.epoch, fence.generation, event.chatExternalId, event.externalId, fence.epoch, fence.generation, event.chatExternalId, event.externalId, id));
    statements.push(env.DB.prepare('DELETE FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id=? AND external_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=?)').bind(fence.epoch, fence.generation, event.chatExternalId, event.externalId, id));
    // A status without chat can be reconciled only while exactly one captured candidate exists.
    statements.push(env.DB.prepare(`UPDATE messages SET status_rank=MAX(status_rank,COALESCE((SELECT status_rank FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id='' AND external_id=?),0)),failure=COALESCE((SELECT failure FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id='' AND external_id=?),failure) WHERE id=? AND (SELECT COUNT(*) FROM messages WHERE epoch=? AND generation=? AND external_id=?)=1`).bind(fence.epoch, fence.generation, event.externalId, fence.epoch, fence.generation, event.externalId, id, fence.epoch, fence.generation, event.externalId));
    statements.push(env.DB.prepare("DELETE FROM pending_statuses WHERE epoch=? AND generation=? AND chat_external_id='' AND external_id=? AND (SELECT COUNT(*) FROM messages WHERE epoch=? AND generation=? AND external_id=?)=1").bind(fence.epoch, fence.generation, event.externalId, fence.epoch, fence.generation, event.externalId));
    await env.DB.batch(statements);
    assertFence(env, fence);
    return { captured: true, messageId: id };
}
export async function ingestStatus(env: Env, fence: Fence, event: StatusEvent): Promise<{
    pending: boolean;
}> {
    assertActive(env);
    assertFence(env, fence);
    const rank = statusNames.indexOf(event.status);
    if (rank < 1 || !event.externalId || event.externalId.length > 256)
        throw new AppError('invalid_status');
    const rows = await env.DB.prepare('SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.epoch=? AND m.generation=? AND m.external_id=? AND (? IS NULL OR c.external_id=?) LIMIT 2').bind(fence.epoch, fence.generation, event.externalId, event.chatExternalId ?? null, event.chatExternalId ?? null).all<{
        id: string;
    }>();
    if (rows.results.length === 1) {
        await env.DB.prepare('UPDATE messages SET status_rank=MAX(status_rank,?),failure=COALESCE(?,failure) WHERE id=? AND epoch=? AND generation=?').bind(rank, event.failure ? 'provider_failure' : null, rows.results[0]!.id, fence.epoch, fence.generation).run();
        return { pending: false };
    }
    await env.DB.prepare('INSERT INTO pending_statuses(id,epoch,generation,external_id,chat_external_id,status_rank,failure,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(epoch,generation,chat_external_id,external_id) DO UPDATE SET status_rank=MAX(pending_statuses.status_rank,excluded.status_rank),failure=COALESCE(excluded.failure,pending_statuses.failure)').bind(crypto.randomUUID(), fence.epoch, fence.generation, event.externalId, event.chatExternalId ?? '', rank, event.failure ? 'provider_failure' : null, Date.now()).run();
    return { pending: true };
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
export async function queryMessages(env: Env, input: MessageQuery): Promise<{
    items: MessageView[];
    nextCursor?: string;
    coverage: {
        captureEnabled: boolean;
        captureSince: number | null;
        historicalImport: false;
        unavailable: number;
        pendingMedia: number;
    };
}> {
    const fence = currentFence(env);
    const chat = await getChat(env, input.chatId, fence);
    const limit = boundedInt(input.limit, 50, 50);
    if ((input.term?.length ?? 0) > 256)
        throw new AppError('invalid_term');
    for (const n of [input.from, input.to])
        if (n !== undefined && (!Number.isFinite(n) || n < 0))
            throw new AppError('invalid_period');
    const scope = JSON.stringify([fence, input.chatId, input.from ?? null, input.to ?? null, input.authorId ?? null, input.kind ?? null, input.term ?? '']);
    let last: {
        timestamp: number;
        id: string;
    } = { timestamp: -1, id: '' };
    if (input.cursor) {
        const c = decodeCursor<{
            scope: string;
            timestamp: number;
            id: string;
        }>(input.cursor);
        if (c.scope !== scope || !Number.isFinite(c.timestamp) || typeof c.id !== 'string')
            throw new AppError('invalid_cursor');
        last = c;
    }
    const rows = await env.DB.prepare(`SELECT m.*, (SELECT name FROM participants WHERE id=m.author_id) author_name, (SELECT id FROM media WHERE message_id=m.id AND message_version=m.version AND deleted_at IS NULL LIMIT 1) media_id FROM messages m WHERE chat_id=? AND epoch=? AND generation=? AND (timestamp>? OR (timestamp=? AND id>?)) AND (? IS NULL OR timestamp>=?) AND (? IS NULL OR timestamp<=?) AND (? IS NULL OR author_id=?) AND (? IS NULL OR kind=?) AND (? IS NULL OR text LIKE ? ESCAPE '\\') ORDER BY timestamp,id LIMIT ?`).bind(chat.id, fence.epoch, fence.generation, last.timestamp, last.timestamp, last.id, input.from ?? null, input.from ?? null, input.to ?? null, input.to ?? null, input.authorId ?? null, input.authorId ?? null, input.kind ?? null, input.kind ?? null, input.term ?? null, `%${escapeLike(input.term ?? '')}%`, limit + 1).all<MessageRow>();
    const items: MessageView[] = [];
    let chars = 0;
    for (const r of rows.results.slice(0, limit)) {
        const view: MessageView = { id: r.id, chatId: r.chat_id, authorId: r.author_id, authorName: r.from_me ? 'Você' : r.author_name, fromMe: !!r.from_me, kind: r.kind, text: r.deleted_at ? null : r.text, timestamp: r.timestamp, receivedAt: r.received_at, version: r.version, status: statusNames[r.status_rank] ?? 'received', failure: r.failure, deleted: !!r.deleted_at, unavailableReason: r.unavailable_reason, mediaId: r.media_id };
        const len = JSON.stringify(view).length;
        if (chars + len > LIMITS.pageChars)
            break;
        items.push(view);
        chars += len;
    }
    const missing = await env.DB.prepare("SELECT COUNT(*) count FROM messages WHERE chat_id=? AND unavailable_reason IS NOT NULL").bind(chat.id).first<{
        count: number;
    }>();
    const pending = await env.DB.prepare("SELECT COUNT(*) count FROM media WHERE chat_id=? AND deleted_at IS NULL AND state<>'ready'").bind(chat.id).first<{
        count: number;
    }>();
    const tail = items.at(-1);
    return { items, nextCursor: tail && rows.results.length > items.length ? encodeCursor({ scope, timestamp: tail.timestamp, id: tail.id }) : undefined, coverage: { captureEnabled: !!chat.capture_enabled, captureSince: chat.capture_since, historicalImport: false, unavailable: missing?.count ?? 0, pendingMedia: pending?.count ?? 0 } };
}
// Z-API wire fields remain backend-only; normalization never treats sender text as commands.
export function normalizeZapiEvent(payload: unknown): NormalizedEvent {
    const p = record(payload);
    const chatExternalId = str(p.phone);
    const externalId = str(p.messageId);
    if (!chatExternalId || !externalId || typeof p.fromMe !== 'boolean')
        throw new AppError('invalid_event');
    const timestamp = typeof p.momment === 'number' ? p.momment : typeof p.moment === 'number' ? p.moment : NaN;
    const text = record(p.text), image = record(p.image), audio = record(p.audio), document = record(p.document);
    let kind: MessageKind = 'unavailable';
    let media: NormalizedEvent['media'];
    let content = str(text.message) || undefined;
    if (content !== undefined)
        kind = 'text';
    else if (str(image.imageUrl)) {
        kind = 'image';
        media = { url: str(image.imageUrl), mime: str(image.mimeType) || 'image/jpeg', filename: str(image.fileName) || undefined };
        content = str(image.caption) || undefined;
    }
    else if (str(audio.audioUrl)) {
        kind = 'audio';
        media = { url: str(audio.audioUrl), mime: str(audio.mimeType) || undefined, durationSeconds: typeof audio.seconds === 'number' ? audio.seconds : undefined };
    }
    else if (str(document.documentUrl)) {
        kind = 'pdf';
        media = { url: str(document.documentUrl), mime: str(document.mimeType) || undefined, filename: str(document.fileName) || undefined };
    }
    const deleted = p.isDeleted === true || p.type === 'DeletedCallback';
    return { chatExternalId, externalId, authorExternalId: p.fromMe === true ? (str(p.connectedPhone) || undefined) : p.isGroup === true ? (str(p.participantLid) || str(p.participantPhone) || undefined) : (str(p.senderLid) || chatExternalId), authorName: str(p.senderName) || undefined, fromMe: p.fromMe, kind, text: content, timestamp, revision: p.isEdit === true ? Math.max(2, timestamp) : 1, deleted, viewOnce: p.viewOnce === true || image.viewOnce === true || audio.viewOnce === true || document.viewOnce === true, temporary: typeof p.messageExpirationSeconds === 'number' && p.messageExpirationSeconds > 0, unavailableReason: kind === 'unavailable' ? 'unsupported_or_missing_content' : undefined, media };
}
function record(x: unknown): Record<string, unknown> { return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}; }
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
