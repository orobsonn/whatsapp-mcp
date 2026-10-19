import type { Env } from './env';
import { AppError, assertFence, currentFence, type Fence } from './core';
export interface ChatRow {
    id: string;
    epoch: string;
    generation: string;
    external_id: string;
    kind: 'individual' | 'group';
    name: string;
    capture_enabled: number;
    capture_since: number | null;
    created_at: number;
    updated_at: number;
}
export interface ChatView {
    id: string;
    kind: 'individual' | 'group';
    name: string;
    captureEnabled: boolean;
}
export const chatView = (r: ChatRow): ChatView => ({ id: r.id, kind: r.kind, name: r.name, captureEnabled: !!r.capture_enabled });
export async function getChat(env: Env, id: string, fence: Fence = currentFence(env)): Promise<ChatRow> { assertFence(env, fence); const row = await env.DB.prepare('SELECT * FROM chats WHERE id=? AND epoch=? AND generation=?').bind(id, fence.epoch, fence.generation).first<ChatRow>(); if (!row)
    throw new AppError('chat_not_found', 404); return row; }
export async function getChatExternal(env: Env, externalId: string, fence: Fence): Promise<ChatRow | null> { assertFence(env, fence); return env.DB.prepare('SELECT * FROM chats WHERE external_id=? AND epoch=? AND generation=?').bind(externalId, fence.epoch, fence.generation).first<ChatRow>(); }
