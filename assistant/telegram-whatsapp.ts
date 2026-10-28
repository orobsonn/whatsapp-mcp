import { z } from 'zod';
import type { AssistantEnv } from './env';
import type { OwnerAffinity } from './mcp';
import { SourceAccess, type AccessGuard } from './access';
import { OriginGuard, checkOriginsWithin, sameFence, type OriginFence, type SnapshotReader } from './origin-guard';
import type { ReplyDependency } from './telegram-owner-replies';
import { jsonStatement } from './d1-statement';
import { CaptureMaterializer } from './materialize';

const boundedName = z.string().trim().min(1).max(256).nullable();
const timestamp = z.number().int().nonnegative().safe().nullable();
const selectionSchema = z.object({ query: z.string().max(2048).nullable(), conversationName: boundedName,
  authorName: boundedName, from: timestamp, to: timestamp }).strict();
export type WhatsAppSelection = z.infer<typeof selectionSchema>;
type Boundary = { check: () => Promise<void>; deadlineAt: number; signal?: AbortSignal };
export type WhatsAppObservation = { kind: 'whatsapp'; question: string; query: WhatsAppSelection;
  messages: { sourceId: string; sourceKind: OriginFence['sourceKind']; contentKind: string; text: string; authorId: string | null; authorLabel: string | null; fromMe: boolean | null; occurredAt: number; conversationId: string }[];
  coverage: { complete: false; method: 'lexical_recent'; from: number | null; to: number | null; limit: 3; gaps: string[] } };
export type WhatsAppRead = { state: 'available'; observation: WhatsAppObservation; dependencies: ReplyDependency[]; guard: AccessGuard }
  | { state: 'clarify' | 'unavailable'; text: string };
type DiscoveryReader = SnapshotReader & { searchConversations?: (input: unknown) => Promise<unknown> };
const discoverySchema = z.object({ observation: z.literal('capture_conversation_search'), requestId: z.string().min(1).max(256),
  sourceEpoch: z.string().min(1).max(256), sourceGeneration: z.string().min(1).max(256), state: z.literal('available'),
  refs: z.array(z.object({ chatId: z.string().min(1).max(256), kind: z.enum(['private', 'group']) }).strict()).max(20),
  complete: z.boolean(), nextCursor: z.string().min(1).max(256).nullable() }).strict();
const owner = { kind: 'owner' } as const;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const normalized = (value: string) => value.normalize('NFC').toLocaleLowerCase('pt-BR');
const literalName = (text: string, name: string) => new RegExp('(?:^|[^\\p{L}\\p{N}_])' + normalized(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\p{L}\\p{N}_])', 'u').test(normalized(text));
const stop = new Set('a o as os de da do das dos e que qual quais quem como quando para por em no na nos nas com um uma se eu me meu minha foi ficou disse falou sobre whatsapp conversa mensagens combinado'.split(' '));
const terms = (text: string) => [...new Set(normalized(text).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(term => term.length > 1 && !stop.has(term)).slice(0, 12);
const unavailable = (): WhatsAppRead => ({ state: 'unavailable', text: 'Não consegui consultar esse recorte do WhatsApp agora. A leitura está incompleta.' });
const merge = (guards: AccessGuard[]): AccessGuard => ({ sql: guards.length ? guards.map(g => '(' + g.sql + ')').join(' AND ') : '1', values: guards.flatMap(g => g.values) });

/** Host-only retrieval. The caller freezes this exact observation + every
 * dependency before the paid answer phase, then rechecks them before delivery.
 * Discovery references and model filters never become read authorization. */
export async function readTelegramWhatsApp(env: AssistantEnv, scope: OwnerAffinity, rawSelection: WhatsAppSelection,
  ownerText: string, boundary: Boundary): Promise<WhatsAppRead> {
  const selected = selectionSchema.safeParse(rawSelection);
  if (!selected.success || typeof ownerText !== 'string' || !ownerText.trim() || bytes(ownerText) > 8192) return unavailable();
  const query = selected.data;
  if (query.from !== null && query.to !== null && query.from > query.to) return { state: 'clarify', text: 'Qual período você quer consultar no WhatsApp?' };
  if ([query.conversationName, query.authorName].some(name => name !== null && !literalName(ownerText, name)))
    return { state: 'clarify', text: 'Diga o nome da pessoa ou do grupo que você quer consultar.' };
  if (!env.DB || !env.CAPTURE_READER || !env.BRIDGE_SECRET || env.BRIDGE_SECRET.length < 32) return unavailable();
  const reader = env.CAPTURE_READER as DiscoveryReader, db = env.DB, access = new SourceAccess(db, scope), origin = new OriginGuard(db, () => scope, reader, env.BRIDGE_SECRET, 2000, 'owner_read');
  const check = async () => { if (boundary.signal?.aborted || Date.now() >= boundary.deadlineAt) throw Error('whatsapp_read_expired'); await boundary.check(); if (boundary.signal?.aborted || Date.now() >= boundary.deadlineAt) throw Error('whatsapp_read_expired'); };
  try {
    await check(); let conversation: string | null = null;
    if (query.conversationName) {
      if (!reader.searchConversations) return unavailable();
      const requestId = crypto.randomUUID(), found = new Set<string>(); let cursor: string | null = null, complete = false;
      for (let page = 0; page < 5 && !complete; page++) {
        await check();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let raw: unknown;
        try { raw = await Promise.race([
          reader.searchConversations({ secret: env.BRIDGE_SECRET, sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration, name: query.conversationName, requestId, cursor }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('whatsapp_discovery_timeout')), Math.max(1, Math.min(2000, boundary.deadlineAt - Date.now()))); }),
        ]); } finally { clearTimeout(timer); }
        await check(); if (bytes(raw) > 12288) return unavailable();
        const result = discoverySchema.safeParse(raw); if (!result.success) return unavailable();
        const r = result.data;
        if (r.requestId !== requestId || r.sourceEpoch !== scope.sourceEpoch || r.sourceGeneration !== scope.sourceGeneration ||
          (r.complete ? r.nextCursor !== null : !r.nextCursor || r.nextCursor === cursor)) return unavailable();
        for (const ref of r.refs) found.add(ref.chatId);
        complete = r.complete; cursor = r.nextCursor;
      }
      if (!complete) return { state: 'clarify', text: 'Há muitas conversas para esse nome. Informe um nome mais específico.' };
      if (found.size !== 1) return { state: 'clarify', text: found.size ? 'Há mais de uma conversa com esse nome. Diga um detalhe que diferencie a pessoa ou o grupo.' : 'Não localizei essa conversa no recorte com captura ativa. Confirme o nome da pessoa ou do grupo.' };
      conversation = [...found][0];
    }
    // Advance only the bounded, authenticated inbox already received by this
    // installation. This controller performs no model or automation work.
    await check(); let captureGap: string | undefined;
    try {
      const refreshed = await new CaptureMaterializer(db, () => scope, reader, env.BRIDGE_SECRET).drain(10);
      if (refreshed.some(item => item.state !== 'applied')) captureGap = 'capture_refresh_incomplete';
    } catch { captureGap = 'capture_refresh_unavailable'; }
    await check();
    const searchTerms = terms(query.query ?? ownerText).filter(term => !terms(query.conversationName ?? '').includes(term) && !terms(query.authorName ?? '').includes(term));
    const visible = access.ownerRows(Date.now());
    if (query.authorName) {
      const identities = await db.prepare(`WITH visible AS (${visible.sql}) SELECT DISTINCT COALESCE(v.author_id,'conversation:'||v.conversation_id) AS identity
        FROM visible v JOIN assistant_source_origins o ON o.installation_id=? AND o.generation=? AND o.canonical_id=v.id
        WHERE o.source_epoch=? AND o.source_generation=? AND o.tombstoned=0 AND v.origin='whatsapp'
        AND (? IS NULL OR v.conversation_id=?) AND instr(lower(v.author_label),lower(?))>0
        AND (? IS NULL OR v.occurred_at>=?) AND (? IS NULL OR v.occurred_at<=?) LIMIT 2`)
        .bind(...visible.values, scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration,
          conversation, conversation, query.authorName, query.from, query.from, query.to, query.to).all<{ identity: string | null }>();
      if (identities.results.length > 1) return { state: 'clarify', text: 'Esse nome aparece em mais de um autor. Informe também a conversa ou um detalhe da pessoa.' };
    }
    const score = searchTerms.length ? searchTerms.map(() => 'CASE WHEN instr(lower(v.original_text),lower(?))>0 THEN 1 ELSE 0 END').join('+') : '0';
    const rows = await db.prepare(`WITH visible AS (${visible.sql}) SELECT v.id,v.revision,(${score}) AS score
      FROM visible v JOIN assistant_source_origins o ON o.installation_id=? AND o.generation=? AND o.canonical_id=v.id
      WHERE o.source_epoch=? AND o.source_generation=? AND o.tombstoned=0 AND o.source_kind IN ('message','derivative') AND v.origin='whatsapp'
      AND (? IS NULL OR v.conversation_id=?) AND (? IS NULL OR instr(lower(v.author_label),lower(?))>0)
      AND (? IS NULL OR v.occurred_at>=?) AND (? IS NULL OR v.occurred_at<=?)
      ORDER BY score DESC,v.occurred_at DESC,v.id LIMIT 13`)
      .bind(...visible.values, ...searchTerms, scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration,
        conversation, conversation, query.authorName, query.authorName, query.from, query.from, query.to, query.to).all<{ id: string; revision: number; score: number }>();
    await check();
    const gaps = new Set(['captured_local_versions_only', 'semantic_search_not_used', 'bounded_recent_context']);
    if (captureGap) gaps.add(captureGap);
    if (rows.results.length > 3) gaps.add('message_limit');
    if (searchTerms.length && !rows.results.some(row => row.score > 0)) gaps.add('lexical_no_hit');
    const observation: WhatsAppObservation = { kind: 'whatsapp', question: ownerText, query,
      messages: [], coverage: { complete: false, method: 'lexical_recent', from: query.from, to: query.to, limit: 3, gaps: [] } };
    const dependencies: ReplyDependency[] = [];
    for (const row of rows.results.slice(0, 12)) {
      // Keep the combined admission predicate below D1's expression-depth
      // limit; every included message still carries its full source+origin.
      if (dependencies.length === 3) break;
      await check(); const source = await access.read(owner, row.id, row.revision);
      if (!source || source.text === null || source.fence.source.origin !== 'whatsapp' || !source.fence.source.conversationId) { gaps.add('source_unavailable'); continue; }
      if (conversation !== null && source.fence.source.conversationId !== conversation) { gaps.add('source_changed'); continue; }
      if (bytes(source.text) > 8192) { gaps.add('message_bytes_limit'); continue; }
      const proof = await origin.fence(source.id);
      if (!proof || proof.chatId !== source.fence.source.conversationId || proof.revision !== source.fence.source.revision || proof.version !== source.fence.source.version) { gaps.add('origin_stale'); continue; }
      const observed = await origin.observe(scope, proof);
      if (observed.state !== 'available' || observed.hash !== proof.hash || observed.watermark !== proof.watermark || observed.kind !== proof.conversationKind || !sameFence(await origin.fence(source.id), proof)) { gaps.add('origin_stale'); continue; }
      if (typeof observed.content?.text !== 'string' || observed.content.text !== source.text) { gaps.add('message_text_unavailable'); continue; }
      const message = { sourceId: source.id, sourceKind: proof.sourceKind, contentKind: observed.content.kind, text: source.text, authorId: source.authorId, authorLabel: source.authorLabel,
        fromMe: typeof observed.content.fromMe === 'boolean' ? observed.content.fromMe : null, occurredAt: source.occurredAt, conversationId: source.fence.source.conversationId };
      if (bytes({ ...observation, messages: [...observation.messages, message] }) > 15360) { gaps.add('context_bytes_limit'); continue; }
      observation.messages.push(message); dependencies.push({ source: source.fence, origin: proof });
    }
    await check();
    if (!await checkOriginsWithin(dependencies.map(dep => dep.origin!), proof => origin.check(proof))) return unavailable();
    const guard = merge(dependencies.flatMap(dep => [access.guard(owner, dep.source, Date.now()), origin.localGuard(dep.origin!)]));
    if (!await jsonStatement(db, 'SELECT 1 WHERE ' + guard.sql, guard.values).first()) return unavailable();
    if (!observation.messages.length) gaps.add('no_current_evidence_in_selected_slice');
    observation.coverage.gaps = [...gaps];
    if (bytes(observation) > 16384 || bytes(dependencies) > 32768) return unavailable();
    return { state: 'available', observation, dependencies, guard };
  } catch { return unavailable(); }
}
