// Isolated synthetic validation entrypoint. Never imported by production.
import { runContextProbe } from '../assistant/context-probe';
import { SourceAccess } from '../assistant/access';
import { bridgeHash } from '../assistant/ingress';
import { createOpenAIAdapter, type ModelDiagnostic } from '../assistant/model-transport';
import { InferenceBudget } from '../assistant/budget';
type Env = { DB: D1Database; OPENAI_API_KEY: string; PROBE_TOKEN: string; PROBE_MODE: string };
const scope = { installationId: 'build-check-20261025', generation: 'build-g2' };
export default {
  async fetch(request: Request, env: Env) {
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (env.PROBE_MODE !== 'context_check' || !env.PROBE_TOKEN || env.PROBE_TOKEN.length !== 64) return reply({ error: 'unconfigured' }, 503);
    const url = new URL(request.url), auth = request.headers.get('Authorization') ?? '';
    if (auth.length > 128 || request.method !== 'POST' || url.search || !['/run', '/status'].includes(url.pathname)) return reply({ error: 'denied' }, 403);
    const [a, b] = await Promise.all([bridgeHash(auth), bridgeHash('Bearer ' + env.PROBE_TOKEN)]);
    let difference = 0; for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    if (difference) return reply({ error: 'denied' }, 403);
    const current = { ...scope, period: new Date().toISOString().slice(0, 10) }, budget = new InferenceBudget(env.DB, current);
    try {
      if (url.pathname === '/status') return reply(await budget.status());
      const diagnostics: ModelDiagnostic[] = [], access = new SourceAccess(env.DB, scope);
      const metrics = await runContextProbe(env.DB, current, createOpenAIAdapter(env.OPENAI_API_KEY, fetch, event => diagnostics.push(event)), async sources => {
        for (const source of sources) {
          if (source.origin || source.fence.source.origin === 'whatsapp') return false;
          const guard = access.guard({ kind: 'owner' }, source.fence, Date.now());
          if (!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()) return false;
        }
        return true;
      });
      return reply({ metrics, diagnostics });
    } catch { return reply({ error: 'probe_failed' }, 500); }
  },
};
