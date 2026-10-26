import { expect, it, vi } from 'vitest';
import probe from '../assistant/cognee/probe';
const token = 'a'.repeat(64);
function fixture() {
  const stopProbe = vi.fn(async () => ({ stopped: true }));
  const get = vi.fn(() => ({ stopProbe }));
  const env = { DB: {}, COGNEE: { get, idFromName: () => 'fixed' }, PROBE_MODE: 'build_check', PROBE_TOKEN: token,
    INSTALLATION_ID: 'build-check-20261025', OPERATIONAL_GENERATION: 'build-g3' };
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
it.each(['/checkpoint', '/restore', '/checkpoint/status'])('requires the same secret for the fixed %s lifecycle route', async path => {
  const { env, get } = fixture();
  expect((await probe.fetch(new Request('https://probe' + path, { method: 'POST' }), env as never)).status).toBe(403);
  expect(get).not.toHaveBeenCalled();
});
it('calls only the fixed checkpoint capability and returns no handle or credentials', async () => {
  const { env } = fixture(), checkpoint = vi.fn(async () => ({ state: 'checkpoint_confirmed', id: 'a'.repeat(64), indexRevision: 'b'.repeat(64) }));
  env.COGNEE.get = vi.fn(() => ({ checkpoint })) as never;
  const response = await probe.fetch(new Request('https://probe/checkpoint', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }), env as never);
  expect(await response.json()).toMatchObject({ state: 'checkpoint_confirmed' }); expect(checkpoint).toHaveBeenCalledTimes(1);
});
it.each(['/rebuild/begin', '/rebuild/step/0', '/rebuild/step/1', '/rebuild/step/2', '/rebuild/recover', '/rebuild/status'])('authenticates the fixed %s reconstruction route', async path => {
  const { env, get } = fixture(); expect((await probe.fetch(new Request('https://probe' + path, { method: 'POST' }), env as never)).status).toBe(403); expect(get).not.toHaveBeenCalled();
});
it('rebuild routes accept no caller source, epoch, model or cursor override', async () => {
  const { env, get } = fixture(), beginRebuildProbe = vi.fn(async () => ({ state: 'pending' })), stepRebuildProbe = vi.fn(async () => ({ state: 'ready' }));
  env.COGNEE.get = vi.fn(() => ({ beginRebuildProbe, stepRebuildProbe })) as never;
  const request = (path: string) => new Request('https://probe' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ source: 'private', epoch: 'stale', model: 'paid', cursor: 128 }) });
  expect((await probe.fetch(request('/rebuild/begin'), env as never)).status).toBe(200); expect(beginRebuildProbe).toHaveBeenCalledWith();
  expect((await probe.fetch(request('/rebuild/step/1'), env as never)).status).toBe(200); expect(stepRebuildProbe).toHaveBeenCalledWith(1);
  vi.mocked(env.COGNEE.get).mockClear(); expect((await probe.fetch(request('/rebuild/step/3'), env as never)).status).toBe(403);
  expect((await probe.fetch(request('/rebuild/begin?epoch=stale'), env as never)).status).toBe(403); expect(env.COGNEE.get).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
});
