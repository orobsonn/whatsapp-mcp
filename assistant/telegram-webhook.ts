import type { AssistantEnv } from "./env";
import { bridgeHash } from "./ingress";
import { TelegramLink } from "./telegram-auth";
import { createTelegramReview } from "./telegram";
class InputError extends Error { constructor(readonly status: number) { super("telegram_input"); } }
async function read(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw new InputError(400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new InputError(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw new InputError(400); }
}
export async function receiveTelegram(request: Request, env: AssistantEnv): Promise<Response> {
  const reply = (code: string, status = 200) => Response.json({ code }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if (!env.TELEGRAM_WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) return reply("telegram_unconfigured", 503);
  // Hash both inputs to fixed size before comparison. Never inspect body or DB
  // until the dedicated provider header has been authenticated.
  const hashes = await Promise.all([bridgeHash(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? ""), bridgeHash(env.TELEGRAM_WEBHOOK_SECRET)]);
  let difference = 0; for (let i = 0; i < 64; i++) difference |= hashes[0].charCodeAt(i) ^ hashes[1].charCodeAt(i);
  if (difference) return reply("telegram_denied", 403);
  if (!env.DB) return reply("telegram_unconfigured", 503);
  try {
    const link = new TelegramLink(env.DB, { installationId: env.INSTALLATION_ID!, generation: env.OPERATIONAL_GENERATION!,
      sourceEpoch: env.BRIDGE_SOURCE_EPOCH!, sourceGeneration: env.BRIDGE_SOURCE_GENERATION! }, env.TELEGRAM_BOT_INSTANCE!, env.TELEGRAM_WEBHOOK_SECRET);
    const input = await read(request);
    if (input && typeof input === "object" && "callback_query" in input) {
      const review = await createTelegramReview(env, { installationId: env.INSTALLATION_ID!, generation: env.OPERATIONAL_GENERATION!, sourceEpoch: env.BRIDGE_SOURCE_EPOCH!, sourceGeneration: env.BRIDGE_SOURCE_GENERATION! });
      return reply(await review.receiveCallback(input));
    }
    return reply(await link.receive(input));
  } catch (error) {
    if (error instanceof InputError) return reply("telegram_input", error.status);
    if (error instanceof Error && error.message === "telegram_input") return reply("telegram_input", 400);
    return reply("telegram_unavailable", 503);
  }
}
