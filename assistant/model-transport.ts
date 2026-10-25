import type { BrokerConfig, ModelAdapter } from './model-broker';

export const DEFAULT_BROKER_CONFIG: Readonly<BrokerConfig> = Object.freeze({
  extractionConfig: 'cognee-1.6.5-provenance-v1', priceVersion: '2026-10-25-upper-input-0.25-output-0.50',
  chatModel: 'gpt-6-luna', embeddingModel: 'text-embedding-3-small',
  maxOutputTokens: 6000, chatCeiling: 20000, embeddingCeiling: 1500,
});
export type ModelDiagnostic = Readonly<{
  stage: 'request' | 'fetch' | 'body' | 'usage' | 'done';
  outcome: 'success' | 'request_invalid' | 'aborted' | 'network_failed' | 'http_rejected' | 'response_invalid' | 'response_too_large' | 'usage_invalid';
  status?: number; elapsedMs: number; aborted: boolean;
}>;
class ResponseSizeError extends Error { constructor() { super('model_transport_size'); } }
const size = (value: string) => new TextEncoder().encode(value).length;
const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** A conservative token-priced charge, not an invoice: input uses the published
 * 12h cache-write upper rate even when ordinary/cached input costs less. */
function charge(path: string, usage: unknown): number {
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | null;
  if (!u || !tokenCount(u.prompt_tokens) || !tokenCount(u.total_tokens)) throw new Error('model_transport_usage');
  const output = path === '/v1/embeddings' ? 0 : u.completion_tokens;
  if (!tokenCount(output) || u.prompt_tokens + output !== u.total_tokens) throw new Error('model_transport_usage');
  const amount = Math.ceil(path === '/v1/embeddings' ? u.prompt_tokens / 50 : u.prompt_tokens / 4 + output / 2);
  if (!Number.isSafeInteger(amount)) throw new Error('model_transport_usage');
  return amount;
}
async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('model_transport_response');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); let total = 0, body = '';
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength; if (total > 262144) throw new ResponseSizeError();
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
/** Fixed diagnostics contain no request/response data or exception text.
 * The hook cannot change transport outcome and is never awaited. */
export function createOpenAIAdapter(apiKey: string, fetcher: typeof fetch = fetch,
  onDiagnostic?: (event: ModelDiagnostic) => void): ModelAdapter {
  if (!apiKey || apiKey.length > 1024 || /[\s\x00-\x1f]/.test(apiKey)) throw new Error('model_transport_configuration');
  return async request => {
    const { path, body, signal } = request, started = Date.now();
    let stage: ModelDiagnostic['stage'] = 'request';
    let outcome: ModelDiagnostic['outcome'] = 'request_invalid';
    let status: number | undefined;
    try {
      let model: unknown;
      try { if (typeof body !== 'string' || size(body) > 65536) throw 0; model = JSON.parse(body).model; }
      catch { throw new Error('model_transport_request'); }
      if (!((path === '/v1/chat/completions' && model === DEFAULT_BROKER_CONFIG.chatModel) ||
        (path === '/v1/embeddings' && model === DEFAULT_BROKER_CONFIG.embeddingModel))) throw new Error('model_transport_request');
      stage = 'fetch';
      const response = await fetcher('https://api.openai.com' + path, { method: 'POST', redirect: 'manual', signal,
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body });
      status = response.status;
      if (status !== 200) {
        outcome = 'http_rejected'; await response.body?.cancel().catch(() => {});
        return { status, body: '', actualUnits: Number.NaN };
      }
      stage = 'body';
      const text = await boundedBody(response);
      let usage: unknown; try { usage = JSON.parse(text).usage; } catch { throw new Error('model_transport_response'); }
      stage = 'usage';
      const actualUnits = charge(path, usage);
      stage = 'done'; outcome = 'success';
      return { status, body: text, actualUnits };
    } catch (error) {
      if (signal.aborted) outcome = 'aborted';
      else if (stage === 'fetch') outcome = 'network_failed';
      else if (stage === 'body') outcome = error instanceof ResponseSizeError ? 'response_too_large' : 'response_invalid';
      else if (stage === 'usage') outcome = 'usage_invalid';
      throw error;
    } finally {
      const event: ModelDiagnostic = Object.freeze({ stage, outcome, ...(status === undefined ? {} : { status }),
        elapsedMs: Math.max(0, Date.now() - started), aborted: signal.aborted });
      try { void Promise.resolve(onDiagnostic?.(event)).catch(() => {}); } catch { /* Observability never changes a paid outcome. */ }
    }
  };
}
