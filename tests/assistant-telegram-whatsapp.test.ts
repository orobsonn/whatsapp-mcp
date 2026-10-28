import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { readTelegramWhatsApp } from '../assistant/telegram-whatsapp';
import { readCaptureConversationSearch } from '../src/assistant-search-reader';
import { receiveCapture } from '../assistant/ingress';
import { CaptureMaterializer } from '../assistant/materialize';
import type { AssistantEnv } from '../assistant/env';
import { OriginGuard } from '../assistant/origin-guard';

const secret = 'synthetic-whatsapp-reader-secret-exclusive';
const selection = { query: null, conversationName: 'Ana', authorName: null, from: null, to: null };
async function fixture(text = 'Não confirmei terça. Ficou quinta às 14h, se o contrato chegar.', fromMe: boolean | null = false, conversationKind: 'private' | 'group' = 'private', messageCount = 1) {
  const scope = { installationId: crypto.randomUUID(), generation: 'telegram-wa', sourceEpoch: 'wa-e', sourceGeneration: 'wa-g' };
  let active = true;
  const reader = {
    async searchConversations(q: { requestId: string }): Promise<{ observation: string; state: string; requestId: string; sourceEpoch: string; sourceGeneration: string; refs: { chatId: string; kind: string }[]; complete: boolean; nextCursor: string | null }> { return { observation: 'capture_conversation_search', state: 'available', requestId: q.requestId, sourceEpoch: 'wa-e', sourceGeneration: 'wa-g', refs: [{ chatId: 'chat', kind: 'private' }], complete: true, nextCursor: null }; },
    async readSnapshot(input?: { sourceId: string }) { const sourceId=input?.sourceId??'message'; return { observation: 'capture_snapshot', state: active ? 'available' : 'withdrawn', sourceEpoch: 'wa-e', sourceGeneration: 'wa-g', sourceKind: 'message', sourceId, chatId: 'chat', sourceVersion: 1, watermark: messageCount, conversationKind, access: { captureEnabled: active, captureSince: 0, discontinuous: false }, ...(active ? { content: { kind: 'text', text, authorId: 'ana', authorName: 'Ana', ...(fromMe === null ? {} : { fromMe }), occurredAt: 100, messageId: sourceId, messageVersion: 1 } } : {}) }; },
  };
  const settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: 'wa-e', BRIDGE_SOURCE_GENERATION: 'wa-g', BRIDGE_SECRET: secret, CAPTURE_READER: reader } as AssistantEnv;
  for(let sequence=1;sequence<=messageCount;sequence++){
  const response = await receiveCapture(new Request('https://synthetic.invalid/bridge', { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ protocol: 1, ...scope, sequence, previousSequence: sequence-1, chatId: 'chat', sourceId: sequence===1?'message':'message-'+sequence, sourceKind: 'message', operation: 'upsert', recordedAt: 100 }) }), settings);
  expect(response.status).toBe(200);
  }
  await new CaptureMaterializer(env.DB, () => scope, reader, secret, () => 100).drain();
  return { scope, settings, reader, text, withdraw: () => { active = false; }, boundary: { deadlineAt: Date.now() + 60000, check: async () => {} } };
}

it('returns exact authored messages, negations and conditions with both proofs and a transactional guard', async () => {
  const f = await fixture(), result = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que ficou combinado com Ana?', f.boundary);
  expect(result.state).toBe('available'); if (result.state !== 'available') return;
  expect(result.observation.messages).toMatchObject([{ text: f.text, authorLabel: 'Ana', authorId: 'ana', occurredAt: 100, fromMe: false }]);
  expect(result.dependencies).toMatchObject([{ source: { actor: 'owner', source: { origin: 'whatsapp' } }, origin: { sourceId: 'message', chatId: 'chat' } }]);
  expect(result.observation.coverage.complete).toBe(false);
  expect(await env.DB.prepare('SELECT 1 WHERE ' + result.guard.sql).bind(...result.guard.values).first()).not.toBeNull();
  await env.DB.prepare("UPDATE assistant_origin_conversations SET access_state='withdrawn' WHERE installation_id=?").bind(f.scope.installationId).run();
  expect(await env.DB.prepare('SELECT 1 WHERE ' + result.guard.sql).bind(...result.guard.values).first()).toBeNull();
});
it('keeps a named filter and requests clarification for ambiguous or ungrounded names', async () => {
  const f = await fixture();
  expect((await readTelegramWhatsApp(f.settings, f.scope, { ...selection, conversationName: 'Inventada' }, 'O que Ana disse?', f.boundary)).state).toBe('clarify');
  expect((await readTelegramWhatsApp(f.settings, f.scope, selection, 'Como ficou a semana passada no WhatsApp?', f.boundary)).state).toBe('clarify');
  f.reader.searchConversations = async q => ({ observation: 'capture_conversation_search', state: 'available', requestId: q.requestId, sourceEpoch: 'wa-e', sourceGeneration: 'wa-g', refs: [{ chatId: 'chat', kind: 'private' }, { chatId: 'other', kind: 'private' }], complete: true, nextCursor: null });
  expect((await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary)).state).toBe('clarify');
});
it.each([true, null])('preserves owner direction %s from the current proof without guessing from author labels', async fromMe => {
  const f = await fixture('Texto literal de autoria testada.', fromMe), result = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary);
  expect(result.state).toBe('available'); if (result.state !== 'available') return;
  expect(result.observation.messages[0].fromMe).toBe(fromMe);
});
it('never returns a body after remote withdrawal and does not silently search another chat', async () => {
  const f = await fixture(); f.withdraw();
  const result = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary);
  expect(JSON.stringify(result)).not.toContain(f.text);
  if (result.state === 'available') expect(result.observation.coverage.gaps).toContain('origin_stale');
});
it('requires a complete correlated name result before treating a conversation as unique', async () => {
  const f = await fixture(); let calls = 0;
  f.reader.searchConversations = async q => { calls++; return { observation: 'capture_conversation_search', state: 'available', requestId: q.requestId, sourceEpoch: 'wa-e', sourceGeneration: 'wa-g', refs: [{ chatId: calls === 1 ? 'chat' : 'other', kind: 'private' }], complete: calls > 1, nextCursor: calls === 1 ? 'chat' : null }; };
  expect((await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary)).state).toBe('clarify');
  expect(calls).toBe(2);
  f.reader.searchConversations = async () => ({ observation: 'capture_conversation_search', state: 'available', requestId: 'different-request', sourceEpoch: 'wa-e', sourceGeneration: 'wa-g', refs: [{ chatId: 'chat', kind: 'private' }], complete: true, nextCursor: null });
  expect((await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary)).state).toBe('unavailable');
});
it('never substitutes global evidence when a named conversation has no active match', async () => {
  const f = await fixture();
  f.reader.searchConversations = async q => ({ observation: 'capture_conversation_search', state: 'available', requestId: q.requestId, sourceEpoch: 'wa-e', sourceGeneration: 'wa-g', refs: [], complete: true, nextCursor: null });
  const result = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary);
  expect(result.state).toBe('clarify'); expect(JSON.stringify(result)).not.toContain(f.text);
});
it('allows an explicit owner read of ignored group evidence while automation remains denied', async () => {
  const f = await fixture('Texto do grupo, somente se o contrato chegar.', false, 'group');
  await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,'chat','group',0,'ignore',1)").bind(f.scope.installationId,f.scope.generation).run();
  const read = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse no grupo?', f.boundary);
  expect(read.state).toBe('available'); if (read.state !== 'available') return;
  expect(read.observation.messages).toHaveLength(1);
  const proof = read.dependencies[0].origin!;
  expect(proof.policyMode).toBe('ignore');
  const automation = new OriginGuard(env.DB, () => f.scope, f.reader, secret);
  const ownerRead = new OriginGuard(env.DB, () => f.scope, f.reader, secret, 2000, 'owner_read');
  expect(await ownerRead.check(proof)).toBe(true);
  expect(await automation.fence(proof.canonicalId)).toBeNull();
  expect(await automation.check(proof)).toBe(false);
  const denied = automation.localGuard(proof);
  expect(await env.DB.prepare('SELECT 1 WHERE '+denied.sql).bind(...denied.values).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 WHERE '+read.guard.sql).bind(...read.guard.values).first()).not.toBeNull();
  await env.DB.prepare("UPDATE assistant_conversation_policies SET excluded=1,revision=2 WHERE installation_id=? AND generation=? AND conversation_id='chat'").bind(f.scope.installationId,f.scope.generation).run();
  expect(await ownerRead.fence(proof.canonicalId)).toBeNull();
  expect(await ownerRead.check(proof)).toBe(false);
  expect(await env.DB.prepare('SELECT 1 WHERE '+read.guard.sql).bind(...read.guard.values).first()).toBeNull();
});
it('keeps current policy quarantine and capture withdrawal effective for explicit owner group reads', async () => {
  const f = await fixture('Mensagem capturada do grupo.', false, 'group');
  await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,'chat','group',0,'observe',1)").bind(f.scope.installationId,f.scope.generation).run();
  const read = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse no grupo?', f.boundary);
  expect(read.state).toBe('available'); if (read.state !== 'available') return;
  const proof = read.dependencies[0].origin!;
  const ownerRead = new OriginGuard(env.DB, () => f.scope, f.reader, secret, 2000, 'owner_read');
  await env.DB.prepare("INSERT INTO assistant_retention_quarantines(installation_id,generation,kind,record_key,conversation_id,version,active,reason,snapshot_seal) VALUES(?,?,'policy','chat','chat',1,1,'synthetic','synthetic')").bind(f.scope.installationId,f.scope.generation).run();
  expect(await ownerRead.fence(proof.canonicalId)).toBeNull();
  expect(await env.DB.prepare('SELECT 1 WHERE '+read.guard.sql).bind(...read.guard.values).first()).toBeNull();
  await env.DB.prepare("UPDATE assistant_retention_quarantines SET active=0 WHERE installation_id=? AND generation=? AND kind='policy'").bind(f.scope.installationId,f.scope.generation).run();
  const current = await ownerRead.fence(proof.canonicalId); expect(current).not.toBeNull(); f.withdraw();
  expect(await ownerRead.check(current!)).toBe(false);
});
it('bounds UTF-8 evidence and skips a whole oversized message without deleting its conditions', async () => {
  const f = await fixture('😀'.repeat(3000) + ' somente se aprovado'), result = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse?', f.boundary);
  expect(result.state).toBe('available'); if (result.state !== 'available') return;
  expect(result.observation.messages).toEqual([]); expect(result.observation.coverage.gaps).toContain('message_bytes_limit');
  expect(new TextEncoder().encode(JSON.stringify(result.observation)).length).toBeLessThanOrEqual(16384);
});
it('bounds owner Q&A to three fully fenced messages and exposes omitted evidence', async () => {
  const f = await fixture('Assunto do projeto, somente se houver confirmação.', false, 'group', 5);
  const result = await readTelegramWhatsApp(f.settings, f.scope, selection, 'O que Ana disse sobre projeto no grupo?', f.boundary);
  expect(result.state).toBe('available'); if(result.state!=='available')return;
  expect(result.observation.messages).toHaveLength(3);
  expect(result.dependencies).toHaveLength(3);
  expect(result.observation.coverage).toMatchObject({complete:false,method:'lexical_recent',limit:3});
  expect(result.observation.coverage.gaps).toContain('message_limit');
});
it('paginates name discovery and preserves correlation, exclusions and literal LIKE input', async () => {
  const key = crypto.randomUUID(), source = { ...env, OWNER_SUB: 'synthetic-owner', INSTALLATION_EPOCH: key, CONNECTION_GENERATION: key, MAINTENANCE: 'false', RUNTIME_CONFIG: 'static' as const, DEVELOPMENT: 'true', ASSISTANT_READER_SECRET: secret };
  for (let n = 0; n < 22; n++) await env.DB.prepare("INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at) VALUES(?,?,?,?,'individual','Ana % literal',?,1,1)").bind(key + n.toString().padStart(3, '0'), key, key, 'synthetic-' + n, n === 21 ? 0 : 1).run();
  // The capture-default trigger deliberately initializes newly discovered chats.
  await env.DB.prepare('UPDATE chats SET capture_enabled=0 WHERE id=?').bind(key + '021').run();
  const q = { secret, sourceEpoch: key, sourceGeneration: key, name: 'Ana %', requestId: 'request' };
  const first = await readCaptureConversationSearch(source, q);
  expect(first.state).toBe('available'); if (first.state !== 'available') return;
  expect(first.refs).toHaveLength(20); expect(first.complete).toBe(false);
  const last = await readCaptureConversationSearch(source, { ...q, cursor: first.nextCursor });
  expect(last.state).toBe('available'); if (last.state !== 'available') return;
  expect(last.refs).toHaveLength(1); expect(last.complete).toBe(true);
  expect(JSON.stringify(first)).not.toContain('Ana % literal');
  await expect(readCaptureConversationSearch(source, { ...q, secret: 'wrong' })).rejects.toThrow('reader_denied');
  await expect(readCaptureConversationSearch(source, { ...q, sourceGeneration: 'other' })).rejects.toThrow('reader_denied');
});
