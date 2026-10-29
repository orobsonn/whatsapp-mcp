import { z } from "zod";
import type { AssistantEnv } from "./env";

// Shared metadata protocol. It has no content, provider URLs or arbitrary tools.
const id = z.string().min(1).max(256);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const captureMetadata = z.object({
  protocol: z.literal(1), installationId: id, generation: id,
  sourceEpoch: id, sourceGeneration: id, sequence: integer.min(1), previousSequence: integer,
  chatId: id, sourceId: id, sourceKind: z.enum(["message", "derivative", "media", "conversation"]),
  operation: z.enum(["upsert", "withdraw", "access"]), recordedAt: integer,
}).strict().refine((event) => event.sequence > event.previousSequence)
  .refine((event) => (event.sourceKind === "conversation") === (event.operation === "access"));
export async function bridgeHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
class InputError extends Error { constructor(public status: number) { super("invalid_bridge_input"); } }
export async function readBridgeJson(input: Request | Response): Promise<unknown> {
  const reader = input.body?.getReader(); if (!reader) throw new InputError(400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new InputError(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(body));
}

export async function receiveCapture(request: Request, env: AssistantEnv): Promise<Response> {
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!env.DB || !env.BRIDGE_SECRET || env.BRIDGE_SECRET.length < 32 || !env.INSTALLATION_ID ||
      !env.OPERATIONAL_GENERATION || !env.BRIDGE_SOURCE_EPOCH || !env.BRIDGE_SOURCE_GENERATION)
    return reply({ error: "bridge_unconfigured" }, 503);
  const authorization = request.headers.get("Authorization") ?? "";
  const hashes = await Promise.all([bridgeHash(authorization), bridgeHash(`Bearer ${env.BRIDGE_SECRET}`)]);
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= hashes[0].charCodeAt(i) ^ hashes[1].charCodeAt(i);
  if (difference) return reply({ error: "bridge_denied" }, 403);
  try {
    const parsed = captureMetadata.safeParse(await readBridgeJson(request));
    if (!parsed.success) return reply({ error: "invalid_bridge_input" }, 400);
    const event = parsed.data;
    if (event.installationId !== env.INSTALLATION_ID || event.generation !== env.OPERATIONAL_GENERATION ||
        event.sourceEpoch !== env.BRIDGE_SOURCE_EPOCH || event.sourceGeneration !== env.BRIDGE_SOURCE_GENERATION)
      return reply({ error: "bridge_denied" }, 403);
    const keys = [event.installationId, event.generation, event.sourceEpoch, event.sourceGeneration];
    const hash = await bridgeHash(event);
    const scope = "installation_id=? AND generation=? AND source_epoch=? AND source_generation=?";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO assistant_capture_streams(installation_id,generation,source_epoch,source_generation)
        SELECT ?,?,?,? WHERE ?=0 ON CONFLICT DO NOTHING`).bind(...keys, event.previousSequence),
      env.DB.prepare(`INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,
        previous_sequence,chat_id,source_id,source_kind,operation,recorded_at,metadata_hash,received_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? FROM assistant_capture_streams WHERE ${scope} AND read_sequence=?
        ON CONFLICT DO NOTHING`).bind(...keys, event.sequence, event.previousSequence, event.chatId, event.sourceId,
          event.sourceKind, event.operation, event.recordedAt, hash, Date.now(), ...keys, event.previousSequence),
      env.DB.prepare(`UPDATE assistant_capture_streams SET read_sequence=? WHERE ${scope} AND read_sequence=?
        AND EXISTS(SELECT 1 FROM assistant_capture_inbox WHERE ${scope} AND sequence=? AND metadata_hash=?)
        RETURNING read_sequence`).bind(event.sequence, ...keys, event.previousSequence, ...keys, event.sequence, hash),
    ]);
    const stored = await env.DB.prepare(`SELECT metadata_hash FROM assistant_capture_inbox WHERE ${scope} AND sequence=?`)
      .bind(...keys, event.sequence).first<{ metadata_hash: string }>();
    if (!stored || stored.metadata_hash !== hash) return reply({ error: "bridge_conflict" }, 409);
    // This is a persistent transport receipt; no canonical source was applied.
    // Native inference runs in its own durable session. A downstream admission
    // gap cannot erase the already committed capture receipt or trigger a
    // second legacy brain; the native intake worker reconciles it later.
    if(env.NATIVE_CONVERSATIONS_MODE&&env.NATIVE_CONVERSATIONS_MODE!=='off'&&env.ROUTINES_PAUSED!=='true'){
      try{const {NativeApplicationHost}=await import('./agent-runtime/native-host');await new NativeApplicationHost(env).receiveCapture(event.sequence);}
      catch{/* Durable capture inbox remains the retry source. */}
    }
    return reply({ sequence: event.sequence, metadataHash: stored.metadata_hash, state: "received" });
  } catch (error) {
    return reply({ error: "bridge_unavailable" }, error instanceof InputError ? error.status : error instanceof SyntaxError ? 400 : 503);
  }
}
