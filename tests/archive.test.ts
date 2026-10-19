import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertDirectoryPage, listChats, setCapture } from '../src/directory';
import { ingestEvent, ingestStatus, queryMessages, normalizeZapiEvent } from '../src/capture';
import type { Env } from '../src/env';
const e: Env = { ...env, OWNER_SUB: 'synthetic-owner', INSTALLATION_EPOCH: 'e1', CONNECTION_GENERATION: 'g1', MAINTENANCE: 'false' };
const fence = { epoch: 'e1', generation: 'g1' };
async function chat(externalId: string, name = 'Homônimo') {
    const page = await upsertDirectoryPage(e, fence, { items: [{ externalId, kind: 'group', name }], complete: true });
    return page.items[0]!;
}
async function event(chatExternalId: string, externalId = 'same', extra = {}) {
    return ingestEvent(e, fence, { chatExternalId, externalId, authorExternalId: 'participant-lid', authorName: 'Pessoa Sintética', fromMe: false, kind: 'text', text: 'combinado', timestamp: 100, ...extra });
}
beforeEach(async () => {
    await env.DB.exec('DELETE FROM media_jobs; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM participants; DELETE FROM directory_syncs; DELETE FROM chats');
});
describe('arquivo D1 com isolamento e fences', () => {
    it('preserva homônimos, participantes e namespace por conversa, com replay concorrente', async () => {
        const a = await chat('group-a');
        const b = await chat('group-b');
        await setCapture(e, a.id, true, fence);
        await setCapture(e, b.id, true, fence);
        await Promise.all([event('group-a'), event('group-a'), event('group-b')]);
        const qa = await queryMessages(e, { chatId: a.id });
        const qb = await queryMessages(e, { chatId: b.id });
        expect(qa.items).toHaveLength(1);
        expect(qb.items).toHaveLength(1);
        expect(qa.items[0]!.id).not.toBe(qb.items[0]!.id);
        expect(qa.items[0]!.authorId).toBe(qb.items[0]!.authorId);
        expect(qa.items[0]!.authorName).toBe('Pessoa Sintética');
        expect((await listChats(e, { term: 'Homônimo' })).items).toHaveLength(2);
    });
    it('não captura sem liberação e recusa trabalho de geração/epoch antigo', async () => {
        const a = await chat('group-a');
        expect((await event('group-a')).captured).toBe(false);
        await setCapture(e, a.id, true, fence);
        await expect(ingestEvent(e, { ...fence, epoch: 'old' }, { chatExternalId: 'group-a', externalId: 'x', kind: 'text', text: 'a', timestamp: 1, fromMe: false })).rejects.toMatchObject({ code: 'stale_fence' });
        expect((await queryMessages(e, { chatId: a.id })).items).toHaveLength(0);
    });
    it('concilia status anterior ao corpo e não regride read', async () => {
        const a = await chat('group-a');
        await setCapture(e, a.id, true, fence);
        await ingestStatus(e, fence, { chatExternalId: 'group-a', externalId: 'same', status: 'read' });
        await event('group-a');
        await ingestStatus(e, fence, { chatExternalId: 'group-a', externalId: 'same', status: 'sent' });
        expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe('read');
    });
    it('status sem conversa anterior ao corpo concilia só com candidato único', async () => {
        const a = await chat('group-a');
        await setCapture(e, a.id, true, fence);
        await ingestStatus(e, fence, { externalId: 'same', status: 'read' });
        await event('group-a');
        expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe('read');
    });
    it('normaliza wire sem confundir autor próprio com destinatário e bloqueia mídia temporária', () => {
        const n = normalizeZapiEvent({ phone: 'group-a', messageId: 'x', isGroup: true, fromMe: true, connectedPhone: 'owner-address', participantLid: 'peer-lid', momment: 100, image: { imageUrl: 'https://media.example/img', viewOnce: true } });
        expect(n.authorExternalId).toBe('owner-address');
        expect(n.viewOnce).toBe(true);
    });
    it('status sem conversa permanece pendente se o ID aparece em dois chats', async () => {
        const a = await chat('group-a');
        const b = await chat('group-b');
        await setCapture(e, a.id, true, fence);
        await setCapture(e, b.id, true, fence);
        await event('group-a');
        await event('group-b');
        expect((await ingestStatus(e, fence, { externalId: 'same', status: 'delivered' })).pending).toBe(true);
        expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe('received');
    });
    it('edição ordenada e tombstone nunca ressuscitam em replay', async () => {
        const a = await chat('group-a');
        await setCapture(e, a.id, true, fence);
        await event('group-a');
        await event('group-a', 'same', { revision: 2, text: 'novo' });
        await event('group-a', 'same', { revision: 1, text: 'velho' });
        expect((await queryMessages(e, { chatId: a.id })).items[0]!.text).toBe('novo');
        await event('group-a', 'same', { deleted: true, revision: 3 });
        await event('group-a', 'same', { revision: 4, text: 'ressuscitar' });
        expect((await queryMessages(e, { chatId: a.id })).items[0]).toMatchObject({ text: null, deleted: true });
    });
    it('persiste mídia e job antes de retornar; temporária só registra indisponível', async () => {
        const a = await chat('group-a');
        await setCapture(e, a.id, true, fence);
        await event('group-a', 'img', { kind: 'image', text: undefined, media: { url: 'https://media.example/file', mime: 'image/jpeg', filename: 'foto.jpg' } });
        expect((await env.DB.prepare('SELECT * FROM media_jobs').all()).results).toHaveLength(1);
        await event('group-a', 'once', { kind: 'image', viewOnce: true, media: { url: 'https://media.example/private' } });
        const items = (await queryMessages(e, { chatId: a.id })).items;
        expect(items.find(x => x.kind === 'unavailable')).toBeDefined();
        expect(JSON.stringify(items)).not.toContain('https://');
        expect((await env.DB.prepare('SELECT * FROM media_jobs').all()).results).toHaveLength(1);
    });
    it('paginação do diretório preserva ausentes; filtro literal e cursor não cruzam conversa', async () => {
        const a = await chat('group-a');
        await chat('group-b');
        await upsertDirectoryPage(e, fence, { items: [{ externalId: 'group-c', kind: 'group', name: 'C' }], complete: false, cursor: 'page2' });
        expect((await listChats(e, {})).items).toHaveLength(3);
        await setCapture(e, a.id, true, fence);
        await event('group-a', '1', { timestamp: 1, text: '100% sim' });
        await event('group-a', '2', { timestamp: 2, text: 'outro' });
        expect((await queryMessages(e, { chatId: a.id, term: '%' })).items).toHaveLength(1);
        const first = await queryMessages(e, { chatId: a.id, limit: 1 });
        expect(first.nextCursor).toBeTruthy();
        const second = await queryMessages(e, { chatId: a.id, limit: 1, cursor: first.nextCursor });
        expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
        await expect(queryMessages(e, { chatId: (await listChats(e, {})).items.find(x => x.id !== a.id)!.id, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
    });
});
