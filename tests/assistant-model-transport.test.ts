import { expect, it, vi } from 'vitest';
import { createOpenAIAdapter, DEFAULT_BROKER_CONFIG } from '../assistant/model-transport';
const call = { path: '/v1/chat/completions' as const, body: JSON.stringify({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Synthetic' }], max_completion_tokens: 6000 }), signal: new AbortController().signal };
const reply = { choices: [{ message: { role: 'assistant', content: 'Synthetic answer' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
it('uses only the fixed provider with host credentials, no redirects/retries, and accounts conservatively', async () => {
  const network = vi.fn<typeof fetch>(async () => Response.json(reply));
  const output = await createOpenAIAdapter('synthetic-test-key', network)(call);
  expect(output).toMatchObject({ status: 200, actualUnits: 35 });
  const [url, options] = network.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/chat/completions');
  expect(options).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Authorization: 'Bearer synthetic-test-key' }, signal: call.signal });
  expect(options?.body).toBe(call.body); expect(network).toHaveBeenCalledTimes(1);
  expect(DEFAULT_BROKER_CONFIG.chatCeiling).toBeGreaterThan(65536 * 0.25 + 6000 * 0.5);
});
it('counts embedding tokens and rejects another model or path before network', async () => {
  const network = vi.fn<typeof fetch>(async () => Response.json({ data: [], usage: { prompt_tokens: 101, total_tokens: 101 } }));
  const adapter = createOpenAIAdapter('synthetic-test-key', network);
  expect((await adapter({ ...call, path: '/v1/embeddings', body: '{"model":"text-embedding-3-small","input":"Synthetic"}' })).actualUnits).toBe(3);
  await expect(adapter({ ...call, body: '{"model":"different"}' })).rejects.toThrow('model_transport_request');
  await expect(adapter({ ...call, path: 'https://attacker.invalid' as never })).rejects.toThrow('model_transport_request');
  expect(network).toHaveBeenCalledTimes(1);
});
it('never exposes rejected provider bodies and leaves unknown usage reserved', async () => {
  const network = vi.fn<typeof fetch>(async () => new Response('DO_NOT_ECHO_PROVIDER_SECRET', { status: 401 }));
  const output = await createOpenAIAdapter('synthetic-test-key', network)(call);
  expect(output.status).toBe(401); expect(output.body).toBe(''); expect(Number.isNaN(output.actualUnits)).toBe(true);
  expect(network).toHaveBeenCalledTimes(1);
});
it('does not invent usage when JSON is valid but tokens are absent, negative or inconsistent', async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 }, { prompt_tokens: 10, completion_tokens: 1, total_tokens: 9 }]) {
    const network = vi.fn<typeof fetch>(async () => Response.json({ ...reply, usage }));
    await expect(createOpenAIAdapter('synthetic-test-key', network)(call)).rejects.toThrow('model_transport_usage');
    expect(network).toHaveBeenCalledTimes(1);
  }
});
it('bounds streamed responses even without Content-Length and cancels excess bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel() { cancelled = true; } });
  const network = vi.fn<typeof fetch>(async () => new Response(stream));
  await expect(createOpenAIAdapter('synthetic-test-key', network)(call)).rejects.toThrow('model_transport_size');
  expect(cancelled).toBe(true);
});
it('rejects missing keys and invalid bodies without touching the network', async () => {
  const network = vi.fn<typeof fetch>();
  expect(() => createOpenAIAdapter('', network)).toThrow('model_transport_configuration');
  await expect(createOpenAIAdapter('synthetic-test-key', network)({ ...call, body: 'x'.repeat(65537) })).rejects.toThrow('model_transport_request');
  expect(network).not.toHaveBeenCalled();
});
it('diagnoses successful transport with fixed fields and no request or provider content', async () => {
  const diagnostics: unknown[] = [];
  await createOpenAIAdapter('synthetic-test-key', async () => Response.json(reply), event => { diagnostics.push(event); })(call);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ stage: 'done', outcome: 'success', status: 200, aborted: false });
  expect(Object.keys(diagnostics[0] as object).sort()).toEqual(['aborted', 'elapsedMs', 'outcome', 'stage', 'status']);
  expect((diagnostics[0] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(diagnostics)).not.toMatch(/Synthetic|synthetic-test-key|choices|Authorization/);
});
it('diagnoses HTTP rejection using status alone without reading the rejected provider body', async () => {
  const diagnostics: unknown[] = [];
  const output = await createOpenAIAdapter('synthetic-test-key', async () => new Response('SECRET_PROVIDER_BODY', { status: 429 }), event => { diagnostics.push(event); })(call);
  expect(output.body).toBe(''); expect(diagnostics).toEqual([expect.objectContaining({ stage: 'fetch', outcome: 'http_rejected', status: 429, aborted: false })]);
  expect(JSON.stringify(diagnostics)).not.toContain('SECRET_PROVIDER_BODY');
});
it('distinguishes aborted fetch from network failure without copying exception messages', async () => {
  for (const aborted of [false, true]) {
    const controller = new AbortController(); if (aborted) controller.abort(); const diagnostics: unknown[] = [];
    const adapter = createOpenAIAdapter('synthetic-test-key', async () => { throw new Error('SECRET_NETWORK_DETAILS'); }, event => { diagnostics.push(event); });
    await expect(adapter({ ...call, signal: controller.signal })).rejects.toThrow();
    expect(diagnostics).toEqual([expect.objectContaining({ stage: 'fetch', outcome: aborted ? 'aborted' : 'network_failed', aborted })]);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_NETWORK_DETAILS');
  }
});
it('distinguishes response parse failure from invalid usage without echoing provider values', async () => {
  for (const [body, outcome] of [['SECRET_BAD_JSON', 'response_invalid'], [JSON.stringify({ ...reply, usage: { prompt_tokens: 'SECRET_USAGE' } }), 'usage_invalid']]) {
    const diagnostics: unknown[] = [];
    await expect(createOpenAIAdapter('synthetic-test-key', async () => new Response(body), event => { diagnostics.push(event); })(call)).rejects.toThrow();
    expect(diagnostics).toEqual([expect.objectContaining({ stage: outcome === 'usage_invalid' ? 'usage' : 'body', outcome, status: 200 })]);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET');
  }
});
it('diagnoses an oversized response and cancellation during body reading', async () => {
  for (const aborted of [false, true]) {
    const controller = new AbortController(); const diagnostics: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({ start(target) {
      if (aborted) { controller.abort(); target.error(new Error('SECRET_STREAM_FAILURE')); }
      else target.enqueue(new Uint8Array(262145));
    } });
    await expect(createOpenAIAdapter('synthetic-test-key', async () => new Response(stream), event => { diagnostics.push(event); })({ ...call, signal: controller.signal })).rejects.toThrow();
    expect(diagnostics).toEqual([expect.objectContaining({ stage: 'body', outcome: aborted ? 'aborted' : 'response_too_large', aborted, status: 200 })]);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET');
  }
});
it('isolates a failing diagnostic callback and emits one event for rejected requests without network', async () => {
  const network = vi.fn<typeof fetch>(async () => Response.json(reply));
  expect((await createOpenAIAdapter('synthetic-test-key', network, () => { throw new Error('SECRET_CALLBACK'); })(call)).status).toBe(200);
  const diagnostics: unknown[] = [];
  await expect(createOpenAIAdapter('synthetic-test-key', network, event => { diagnostics.push(event); })({ ...call, body: '{' })).rejects.toThrow('model_transport_request');
  expect(diagnostics).toEqual([expect.objectContaining({ stage: 'request', outcome: 'request_invalid', aborted: false })]); expect(network).toHaveBeenCalledTimes(1);
});
it('constructs a real workerd Request before the simulated provider response', async () => {
  const network = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    expect(request.redirect).toBe('manual');
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    return Response.json(reply);
  });
  expect((await createOpenAIAdapter('synthetic-test-key', network)(call)).status).toBe(200);
});
it('rejects a 302 redirect without following its external Location or exposing its body', async () => {
  const diagnostics: unknown[] = [];
  const network = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    expect(request.redirect).toBe('manual');
    return new Response('SECRET_REDIRECT_BODY', { status: 302, headers: { Location: 'https://evil.example/collect' } });
  });
  const result = await createOpenAIAdapter('synthetic-test-key', network, event => { diagnostics.push(event); })(call);
  expect(result.status).toBe(302); expect(result.body).toBe(''); expect(Number.isNaN(result.actualUnits)).toBe(true);
  expect(network).toHaveBeenCalledTimes(1); expect(diagnostics).toEqual([expect.objectContaining({ stage: 'fetch', outcome: 'http_rejected', status: 302 })]);
  expect(JSON.stringify(diagnostics)).not.toMatch(/evil|SECRET_REDIRECT_BODY/);
});
