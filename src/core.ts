import type { Env } from './env';
export const LIMITS = { eventBytes: 262144, mediaBytes: 2097152, textChars: 8000, page: 50, pageChars: 32000, directoryPage: 100, jobs: 5, leaseMs: 120000, attempts: 3 } as const;
export class AppError extends Error {
    constructor(public code: string, public status = 400) { super(code); this.name = 'AppError'; }
}
export interface Fence {
    epoch: string;
    generation: string;
}
export const currentFence = (env: Env): Fence => ({ epoch: env.INSTALLATION_EPOCH, generation: env.CONNECTION_GENERATION });
export function assertFence(env: Env, fence: Fence): void {
    if (!fence.epoch || !fence.generation || fence.epoch === 'unconfigured' || fence.generation === 'unconfigured' || fence.epoch !== env.INSTALLATION_EPOCH || fence.generation !== env.CONNECTION_GENERATION)
        throw new AppError('stale_fence', 409);
}
export function assertActive(env: Env): void { if (env.MAINTENANCE !== 'false' || !env.OWNER_SUB)
    throw new AppError('not_active', 503); assertFence(env, currentFence(env)); }
export function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { 'cache-control': 'no-store' } }); }
export function errorResponse(error: unknown): Response { return json({ error: error instanceof AppError ? error.code : 'internal_error' }, error instanceof AppError ? error.status : 500); }
export async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> { const b = typeof data === 'string' ? new TextEncoder().encode(data) : data; return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function constantTimeEqual(a: string, b: string): Promise<boolean> { const [x, y] = await Promise.all([sha256(a), sha256(b)]); let diff = 0; for (let i = 0; i < x.length; i++)
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i); return diff === 0; }
export const safeEqual = constantTimeEqual;
export async function readBounded(body: ReadableStream<Uint8Array> | Request | Response | null, max = LIMITS.eventBytes): Promise<Uint8Array> {
    const stream = body instanceof Request || body instanceof Response ? body.body : body;
    if (!stream)
        return new Uint8Array();
    const reader = stream.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > max) {
                await reader.cancel();
                throw new AppError('body_too_large', 413);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}
export function boundedInt(value: number | undefined, fallback: number, max: number): number { if (value === undefined)
    return fallback; if (!Number.isInteger(value) || value < 1 || value > max)
    throw new AppError('invalid_limit'); return value; }
export function escapeLike(s: string): string { return s.replace(/[\\%_]/g, '\\$&'); }
export function encodeCursor(data: unknown): string { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))); }
export function decodeCursor<T>(cursor: string): T { try {
    if (cursor.length > 2048)
        throw 0;
    return JSON.parse(decodeURIComponent(escape(atob(cursor)))) as T;
}
catch {
    throw new AppError('invalid_cursor');
} }
