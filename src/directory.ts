import type { Env } from './env';
import { AppError, assertActive, assertFence, boundedInt, currentFence, decodeCursor, encodeCursor, escapeLike, type Fence } from './core';
import { chatView, getChat, type ChatRow, type ChatView } from './store';
export interface DirectoryItem {
    externalId: string;
    kind: 'individual' | 'group';
    name: string;
}
export async function upsertDirectoryPage(env: Env, fence: Fence, page: {
    items: DirectoryItem[];
    cursor?: string;
    complete: boolean;
}): Promise<{
    items: ChatView[];
    nextCursor?: string;
    complete: boolean;
}> {
    assertFence(env, fence);
    if (page.items.length > 100 || (page.cursor?.length ?? 0) > 1024)
        throw new AppError('directory_page_too_large');
    const now = Date.now();
    const statements = [];
    for (const item of page.items) {
        if (!item.externalId || item.externalId.length > 256 || !['group', 'individual'].includes(item.kind) || typeof item.name !== 'string' || item.name.length > 256)
            throw new AppError('invalid_directory_item');
        statements.push(env.DB.prepare('INSERT INTO chats(id,epoch,generation,external_id,kind,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(epoch,generation,external_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at WHERE chats.kind=excluded.kind').bind(crypto.randomUUID(), fence.epoch, fence.generation, item.externalId, item.kind, item.name, now, now));
    }
    statements.push(env.DB.prepare('INSERT INTO directory_syncs(id,epoch,generation,cursor,complete,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at').bind(`${fence.epoch}:${fence.generation}`, fence.epoch, fence.generation, page.cursor ?? null, page.complete ? 1 : 0, now));
    await env.DB.batch(statements);
    assertFence(env, fence);
    const items: ChatView[] = [];
    for (const item of page.items) {
        const r = await env.DB.prepare('SELECT * FROM chats WHERE external_id=? AND epoch=? AND generation=?').bind(item.externalId, fence.epoch, fence.generation).first<ChatRow>();
        if (r)
            items.push(chatView(r));
    }
    return { items, nextCursor: page.complete ? undefined : page.cursor, complete: page.complete };
}
export async function setCapture(env: Env, chatId: string, enabled: boolean, fence: Fence): Promise<void> { assertActive(env); assertFence(env, fence); await getChat(env, chatId, fence); await env.DB.prepare('UPDATE chats SET capture_discontinuous=CASE WHEN capture_enabled=1 AND ?=0 THEN 1 ELSE capture_discontinuous END,capture_enabled=?,capture_since=CASE WHEN capture_since IS NULL AND ?=1 THEN ? ELSE capture_since END,updated_at=? WHERE id=? AND epoch=? AND generation=?').bind(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, Date.now(), Date.now(), chatId, fence.epoch, fence.generation).run(); }
export async function listChats(env: Env, input: {
    term?: string;
    kind?: 'individual' | 'group';
    limit?: number;
    cursor?: string;
} = {}): Promise<{
    items: ChatView[];
    nextCursor?: string;
}> {
    const fence = currentFence(env);
    assertFence(env, fence);
    const limit = boundedInt(input.limit, 50, 100);
    if ((input.term?.length ?? 0) > 256)
        throw new AppError('invalid_term');
    const scope = JSON.stringify([fence, input.term ?? '', input.kind ?? '']);
    let last = '';
    if (input.cursor) {
        const c = decodeCursor<{
            scope: string;
            id: string;
        }>(input.cursor);
        if (c.scope !== scope || typeof c.id !== 'string')
            throw new AppError('invalid_cursor');
        last = c.id;
    }
    const rows = await env.DB.prepare("SELECT * FROM chats WHERE epoch=? AND generation=? AND id>? AND name LIKE ? ESCAPE '\\' AND (? IS NULL OR kind=?) ORDER BY id LIMIT ?").bind(fence.epoch, fence.generation, last, `%${escapeLike(input.term ?? '')}%`, input.kind ?? null, input.kind ?? null, limit + 1).all<ChatRow>();
    const items = rows.results.slice(0, limit).map(chatView);
    return { items, nextCursor: rows.results.length > limit ? encodeCursor({ scope, id: items.at(-1)!.id }) : undefined };
}
