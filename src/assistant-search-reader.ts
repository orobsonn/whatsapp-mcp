import { z } from 'zod';
import type { Env } from './env';
import { assertActive, currentFence, safeEqual } from './core';
import { resolveRuntimeEnv } from './connection';

const id = z.string().min(1).max(256);
const input = z.object({ secret: z.string().max(256), sourceEpoch: id, sourceGeneration: id,
  name: z.string().trim().min(1).max(256), requestId: id, cursor: id.nullable().optional() }).strict();
export type CaptureConversationSearch = { observation: 'capture_conversation_search'; requestId: string; sourceEpoch: string; sourceGeneration: string } & (
  { state: 'available'; refs: { chatId: string; kind: 'private' | 'group' }[]; complete: boolean; nextCursor: string | null }
  | { state: 'blocked'; reason: 'reader_unavailable' | 'reader_changed' });

/** Private discovery only: no directory sync, provider access, bodies or names
 * leave this capability. References confer no permission to read a message. */
export async function readCaptureConversationSearch(raw: Env, value: unknown): Promise<CaptureConversationSearch> {
  const parsed = input.safeParse(value); if (!parsed.success) throw Error('reader_invalid_input');
  const q = parsed.data, secret = raw.ASSISTANT_READER_SECRET;
  if (!secret || secret.length < 32 || !await safeEqual(secret, q.secret)) throw Error('reader_denied');
  const env = await resolveRuntimeEnv(raw), fence = currentFence(env);
  if (fence.epoch !== q.sourceEpoch || fence.generation !== q.sourceGeneration) throw Error('reader_denied');
  const base = { observation: 'capture_conversation_search' as const, requestId: q.requestId, sourceEpoch: fence.epoch, sourceGeneration: fence.generation };
  try { assertActive(env); } catch { return { ...base, state: 'blocked', reason: 'reader_unavailable' }; }
  const rows = await env.DB.prepare(`SELECT id,kind FROM chats WHERE epoch=? AND generation=? AND capture_enabled=1
    AND id>? AND instr(lower(name),lower(?))>0 ORDER BY id LIMIT 21`)
    .bind(fence.epoch, fence.generation, q.cursor ?? '', q.name).all<{ id: string; kind: string }>();
  const current = await resolveRuntimeEnv(raw);
  try { assertActive(current); } catch { return { ...base, state: 'blocked', reason: 'reader_changed' }; }
  const after = currentFence(current);
  if (raw.ASSISTANT_READER_SECRET !== secret || after.epoch !== fence.epoch || after.generation !== fence.generation)
    return { ...base, state: 'blocked', reason: 'reader_changed' };
  const refs = rows.results.slice(0, 20).map(row => ({ chatId: row.id, kind: row.kind === 'individual' ? 'private' as const : 'group' as const }));
  return { ...base, state: 'available', refs, complete: rows.results.length <= 20,
    nextCursor: rows.results.length > 20 ? refs.at(-1)!.chatId : null };
}
