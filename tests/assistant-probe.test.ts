import { expect, it, vi } from 'vitest';
import probe from '../assistant/cognee/probe';
const token = 'a'.repeat(64);
function fixture() {
  const stopProbe = vi.fn(async () => ({ stopped: true }));
  const get = vi.fn(() => ({ stopProbe }));
  const env = { DB: {}, COGNEE: { get, idFromName: () => 'fixed' }, PROBE_MODE: 'build_check', PROBE_TOKEN: token,
    INSTALLATION_ID: 'build-check-20261025', OPERATIONAL_GENERATION: 'build-g2' };
  return { env, get, stopProbe };
}
it('requires an isolated namespace and secret before any container access', async () => {
  const { env, get } = fixture();
  for (const authorization of ['', 'Bearer wrong', 'Bearer ' + token + 'x']) {
    expect((await probe.fetch(new Request('https://probe/seed', { method: 'POST', headers: { Authorization: authorization } }), env as never)).status).toBe(403);
  }
  expect((await probe.fetch(new Request('https://probe/seed'), { ...env, OPERATIONAL_GENERATION: 'real' } as never)).status).toBe(503);
  expect(get).not.toHaveBeenCalled();
});
it('rejects arbitrary methods, routes and parameters without touching the container', async () => {
  const { env, get } = fixture();
  for (const [method, path] of [['GET', '/seed'], ['POST', '/shell'], ['POST', '/search?query=private']]) {
    expect((await probe.fetch(new Request('https://probe' + path, { method, headers: { Authorization: 'Bearer ' + token } }), env as never)).status).toBe(403);
  }
  expect(get).not.toHaveBeenCalled();
});
it('authenticated stop exposes only its fixed result and has no message capability', async () => {
  const { env, stopProbe } = fixture();
  const response = await probe.fetch(new Request('https://probe/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }), env as never);
  expect(await response.json()).toEqual({ stopped: true }); expect(stopProbe).toHaveBeenCalledTimes(1);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
