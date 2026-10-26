// Isolated synthetic homologation only; never imported by the product entrypoint.
import type { AssistantEnv } from '../env';
import { CogneeContainer, engineName } from '../container';
import { SourceController } from '../sources';
import { SourceAccess } from '../access';
import { InferenceBudget } from '../budget';
import { bridgeHash } from '../ingress';
import { CogneeModelBroker } from '../model-broker';
import { createOpenAIAdapter, DEFAULT_BROKER_CONFIG, type ModelDiagnostic } from '../model-transport';
export { CogneeBroker } from '../container';
export class ProbeContainer extends CogneeContainer {
  async stopProbe() { await this.ctx.container?.destroy(); return { stopped: true }; }
  async beginRebuildProbe() {
    const prior = await this.ctx.storage.get<{ phase: string; reason?: string }>('rebuild');
    if (prior && (prior.phase !== 'blocked' || prior.reason !== 'rebuild_recovered')) return this.rebuildStatus();
    const index = await this.ctx.storage.get<{ epoch?: string }>('index'); if (!index?.epoch || !this.env.DB) return { state: 'blocked', reason: 'probe_index_missing' };
    const scope = { installationId: 'build-check-20261025', generation: 'build-g3' }, access = new SourceAccess(this.env.DB, scope), refs = [];
    for (let i = 0; i < originals.length; i++) {
      const row = await this.env.DB.prepare('SELECT id FROM assistant_sources WHERE installation_id=? AND generation=? AND origin_key=?')
        .bind(scope.installationId, scope.generation, 'build-check-' + i).first<{ id: string }>();
      const source = row && await access.read(owner, row.id);
      if (!source || source.text !== originals[i]) return { state: 'blocked', reason: 'probe_source_changed' };
      refs.push({ id: source.id, revision: source.fence.source.revision, version: source.fence.source.version, hash: source.fence.source.hash });
    }
    return this.rebuildBegin(index.epoch, refs);
  }
  async stepRebuildProbe(cursor: 0 | 1 | 2) {
    const run = await this.ctx.storage.get<{ indexEpoch: string; sources: unknown[] }>('rebuild');
    return run?.sources.length === 2 ? this.rebuildStep(run.indexEpoch, cursor) : { state: 'blocked', reason: 'probe_rebuild_missing' };
  }
  async recoverRebuildProbe() {
    const run = await this.ctx.storage.get<{ indexEpoch: string }>('rebuild');
    return run ? this.rebuildRecover(run.indexEpoch) : { state: 'blocked', reason: 'probe_rebuild_missing' };
  }
}
type ProbeEnv = Omit<AssistantEnv, 'COGNEE'> & { PROBE_TOKEN?: string; PROBE_MODE?: string; COGNEE: DurableObjectNamespace<ProbeContainer> };
const originals = [
  'Isadora coordena o projeto sintético Aurora. A revisão de Caio precisa acontecer antes da demonstração. A demonstração está prevista para 30 de outubro de 2026; ainda não foi confirmada.',
  'No projeto sintético Aurora, Caio propôs revisar em 29 de outubro. Isadora decidiu que a revisão será em 28 de outubro de 2026. A proposta anterior de Caio foi substituída.',
];
const owner = { kind: 'owner' } as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export default {
  async fetch(request: Request, env: ProbeEnv) {
    if (env.PROBE_MODE !== 'build_check' || !env.PROBE_TOKEN || env.PROBE_TOKEN.length !== 64 || !env.DB || !env.COGNEE ||
      env.INSTALLATION_ID !== 'build-check-20261025' || env.OPERATIONAL_GENERATION !== 'build-g3') return json({ error: 'probe_unconfigured' }, 503);
    const authorization = request.headers.get('Authorization') ?? '';
    if (authorization.length > 128) return json({ error: 'probe_denied' }, 403);
    const [a, b] = await Promise.all([bridgeHash(authorization), bridgeHash('Bearer ' + env.PROBE_TOKEN)]);
    let difference = 0; for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    if (difference || request.method !== 'POST') return json({ error: 'probe_denied' }, 403);
    const url = new URL(request.url);
    if (url.search || !['/seed', '/status', '/ingest/0', '/ingest/1', '/search', '/stop', '/model-check', '/checkpoint', '/restore', '/checkpoint/status',
      '/rebuild/begin', '/rebuild/step/0', '/rebuild/step/1', '/rebuild/step/2', '/rebuild/recover', '/rebuild/status'].includes(url.pathname)) return json({ error: 'probe_denied' }, 403);
    const scope = { installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION };
    const budget = new InferenceBudget(env.DB, { ...scope, period: new Date().toISOString().slice(0, 10) });
    const engine = env.COGNEE.get(env.COGNEE.idFromName(engineName(scope.installationId, scope.generation)));
    try {
      if (url.pathname === '/stop') return json(await engine.stopProbe());
      if (url.pathname === '/checkpoint') return json(await engine.checkpoint());
      if (url.pathname === '/restore') return json(await engine.restoreCheckpoint());
      if (url.pathname === '/checkpoint/status') return json(await engine.checkpointStatus());
      if (url.pathname === '/rebuild/begin') return json(await engine.beginRebuildProbe());
      if (url.pathname === '/rebuild/status') return json(await engine.rebuildStatus());
      if (url.pathname === '/rebuild/recover') return json(await engine.recoverRebuildProbe());
      if (['/rebuild/step/0', '/rebuild/step/1', '/rebuild/step/2'].includes(url.pathname)) return json(await engine.stepRebuildProbe(Number(url.pathname.at(-1)) as 0 | 1 | 2));
      if (url.pathname === '/seed') {
        const period = new Date().toISOString().slice(0, 10);
        const existing = await env.DB.prepare('SELECT cap_units FROM assistant_budget_accounts WHERE installation_id=? AND generation=? AND period=?')
          .bind(scope.installationId, scope.generation, period).first();
        if (!existing) {
          // Preserve all prior generations/days, including their uncertain ceilings.
          const prior = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END),0) AS committed
            FROM assistant_budget_reservations WHERE installation_id=? AND NOT(generation=? AND period=?)`)
            .bind(scope.installationId, scope.generation, period).first<{ committed: number }>();
          const used = prior?.committed ?? 0;
          if (!Number.isSafeInteger(used) || used < 0 || used > 300000) return json({ error: 'probe_budget_exhausted' }, 409);
          await budget.configure(300000 - used);
        }
        const controller = new SourceController(env.DB, scope, owner), sources = [];
        for (let i = 0; i < originals.length; i++) sources.push(await controller.create({ originKey: 'build-check-' + i,
          text: originals[i], authorId: i ? 'isadora-synthetic' : 'robson-synthetic', occurredAt: Date.UTC(2026, 9, 25), audience: 'owner' }));
        return json({ sources, budget: await budget.status() });
      }
      if (url.pathname === '/status') {
        const calls = await env.DB.prepare('SELECT state,COUNT(*) AS count FROM assistant_model_receipts WHERE installation_id=? AND generation=? GROUP BY state').bind(scope.installationId, scope.generation).all();
        return json({ budget: await budget.status(), calls: calls.results });
      }
      const access = new SourceAccess(env.DB, scope);
      const sources = [];
      for (let i = 0; i < originals.length; i++) {
        const row = await env.DB.prepare('SELECT id FROM assistant_sources WHERE installation_id=? AND generation=? AND origin_key=?')
          .bind(scope.installationId, scope.generation, 'build-check-' + i).first<{ id: string }>();
        const source = row && await access.read(owner, row.id); if (!source) return json({ error: 'probe_not_seeded' }, 409);
        sources.push(source);
      }
      if (url.pathname === '/model-check') {
        const diagnostics: ModelDiagnostic[] = [];
        const adapter = createOpenAIAdapter(env.OPENAI_API_KEY!, fetch, event => diagnostics.push(event));
        const broker = new CogneeModelBroker(env.DB, { ...scope, period: new Date().toISOString().slice(0, 10) }, DEFAULT_BROKER_CONFIG, adapter);
        const result = await broker.invoke(await broker.issuePermit(sources[0].id, sources[0].fence.source.revision, Date.now() + 60000),
          '/v1/chat/completions', { model: DEFAULT_BROKER_CONFIG.chatModel, messages: [{ role: 'user', content: 'Responda apenas OK. Teste sintético de conectividade.' }], max_completion_tokens: 32 });
        return json({ state: result.state, operationKey: result.operationKey, diagnostics });
      }
      if (url.pathname === '/ingest/0' || url.pathname === '/ingest/1') return json(await engine.ingest({ source: sources[Number(url.pathname.at(-1))], actor: owner }));
      if (url.pathname === '/search') return json(await engine.search({ actor: owner,
        query: 'Quem coordena Aurora, quando será a revisão e qual a relação com a demonstração?', limit: 4,
        allowedSources: sources.map(s => ({ id: s.id, version: s.fence.source.version, hash: s.fence.source.hash })),
        permits: sources.map(s => ({ source: s.fence })) }));
      return json({ error: 'probe_denied' }, 403);
    } catch { return json({ error: 'probe_failed' }, 500); }
  },
};
