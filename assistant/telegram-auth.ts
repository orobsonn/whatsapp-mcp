import { z } from "zod";
import { bridgeHash } from "./ingress";
import { CommandLedger } from "./command-ledger";
import type { OwnerAffinity } from "./mcp";

const id = z.string().min(1).max(256), revision = z.number().int().min(0).max(2147483645);
export const telegramLinkCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("telegram_link.begin"), operationId: id, expectedRevision: revision }).strict(),
  z.object({ kind: z.literal("telegram_link.confirm"), operationId: id, pairingId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("telegram_link.revoke"), operationId: id, expectedRevision: revision }).strict(),
  z.object({ kind: z.literal("telegram_link.status") }).strict(),
]);
export type TelegramLinkCommand = z.input<typeof telegramLinkCommandSchema>;
export type TelegramLinkFence = OwnerAffinity & { botInstance: string; linkRevision: number; userId: string; chatId: string };
/** Include this predicate in the SAME statement admitting #48's command/effect.
 * Reading an inbox item or checking the fence in a prior query is insufficient. */
export function telegramLinkGuard(fence: TelegramLinkFence) {
  return { sql: `EXISTS(SELECT 1 FROM assistant_telegram_links WHERE installation_id=? AND generation=? AND bot_instance=?
    AND source_epoch=? AND source_generation=? AND revision=? AND state='active' AND user_id=? AND chat_id=?)`,
    values: [fence.installationId, fence.generation, fence.botInstance, fence.sourceEpoch, fence.sourceGeneration,
      fence.linkRevision, fence.userId, fence.chatId] };
}
type Pairing = { id: string; source_epoch: string; source_generation: string; expected_revision: number; expires_at: number;
  state: string; a_hash: string; b_hash: string | null; user_id: string | null; chat_id: string | null };
type Receipt = { kind: string; revision: number; state: string; pairingId?: string; expiresAt?: number };
const ns = "installation_id=? AND generation=? AND bot_instance=?";
const origin = "source_epoch=? AND source_generation=?";
const safe = z.number().int().nonnegative().safe();
const messageSchema = z.object({ update_id: safe, message: z.object({ message_id: safe.min(1), date: safe,
  from: z.object({ id: safe.min(1), is_bot: z.literal(false) }).passthrough(),
  chat: z.object({ id: safe.min(1), type: z.literal("private") }).passthrough(),
  text: z.string(), message_thread_id: safe.min(1).optional(),
}).passthrough() }).passthrough();
const quotedMessageSchema=z.object({message_id:safe.min(1),chat:z.object({id:safe.min(1),type:z.literal('private')}).passthrough(),message_thread_id:safe.min(1).optional()}).passthrough();
/** The provider body is data, never an OwnerCommand. Copy it before any await. */
function snapshot(input: unknown) {
  let raw: unknown;
  try { const json = JSON.stringify(input); if (new TextEncoder().encode(json).length > 65536) throw 0; raw = JSON.parse(json); }
  catch { throw new Error("telegram_input"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("telegram_input");
  const update = raw as Record<string, unknown>;
  if (!safe.safeParse(update.update_id).success) throw new Error("telegram_input");
  if (!update.message || Object.keys(update).some(key => key !== "update_id" && key !== "message")) return null;
  if (typeof update.message !== "object" || Array.isArray(update.message)) throw new Error("telegram_input");
  const msg = update.message as Record<string, unknown>;
  if (["sender_chat", "via_bot", "forward_origin", "forward_from", "forward_from_chat", "business_connection_id"].some(key => key in msg)) return null;
  if (msg.chat && (msg.chat as { type: unknown }).type !== "private" || msg.from && (msg.from as { is_bot: unknown }).is_bot !== false) return null;
  if (msg.text === undefined) return null;
  const parsed = messageSchema.safeParse(raw); if (!parsed.success) throw new Error("telegram_input");
  if (new TextEncoder().encode(parsed.data.message.text).length > 16384) throw new Error("telegram_input");
  // Stable ordering lets a legitimate transport retry reorder JSON properties.
  let nodes = 0;
  const canonical = (value: unknown, depth = 0): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error("telegram_input");
    return Array.isArray(value) ? value.map(child => canonical(child, depth + 1)) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child, depth + 1)])) : value;
  };
  return { value: parsed.data, raw: canonical(raw) };
}
/** Correlation adapters compare the exact provider update to its already
 * authenticated inbox receipt. This hash does not itself authenticate anyone. */
export async function telegramUpdateHash(input:unknown):Promise<string|null>{const copy=snapshot(input);return copy?bridgeHash(copy.raw):null;}
/** Host-only capability. Instantiated by the authenticated named MCP binding or
 * secret-verified webhook; never attached to the model's tools/runtime context. */
export class TelegramLink {
  private readonly scope: Readonly<OwnerAffinity>;
  constructor(private readonly db: D1Database, scope: OwnerAffinity, private readonly bot: string,
    private readonly secret: string, private readonly clock = Date.now) {
    if (![scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration, bot].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
      || !/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(bot) || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("telegram_unconfigured");
    this.scope = Object.freeze({ ...scope });
  }
  private keys() { return [this.scope.installationId, this.scope.generation, this.bot]; }
  private affinity() { return [this.scope.sourceEpoch, this.scope.sourceGeneration]; }
  private now() { const n = this.clock(); if (!Number.isSafeInteger(n) || n < 0) throw new Error("telegram_clock"); return n; }
  private pair(id: string) { return this.db.prepare(`SELECT * FROM assistant_telegram_pairings WHERE ${ns} AND id=?`).bind(...this.keys(), id).first<Pairing>(); }
  private async capability(pair: Pairing, phase: "p" | "c") {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const data = ["telegram-link-v1", phase, this.scope.installationId, this.scope.generation, this.bot,
      pair.source_epoch, pair.source_generation, pair.id, pair.expected_revision, pair.expires_at,
      ...(phase === "c" ? [pair.user_id, pair.chat_id] : [])];
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(data))));
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  private async enrich(result: Receipt) {
    if (!result.pairingId || result.kind === "telegram_link.revoke") return result;
    const pair = await this.pair(result.pairingId); if (!pair) throw new Error("telegram_receipt_unavailable");
    const phase = result.kind === "telegram_link.begin" ? "p" : "c", nonce = await this.capability(pair, phase);
    if (await bridgeHash(nonce) !== (phase === "p" ? pair.a_hash : pair.b_hash)) throw new Error("telegram_capability_rotated");
    // bot instance is a public username configured by the host, never a token.
    return { ...result, link: `https://t.me/${this.bot}?start=${phase}_${nonce}` };
  }
  async execute(input: unknown): Promise<unknown> {
    let item: z.output<typeof telegramLinkCommandSchema>;
    try { item = telegramLinkCommandSchema.parse(input); } catch { throw new Error("telegram_input"); }
    if (item.kind === "telegram_link.status") {
      const link = await this.db.prepare(`SELECT revision,state,user_id,chat_id,source_epoch,source_generation FROM assistant_telegram_links WHERE ${ns}`).bind(...this.keys()).first<{ revision: number; state: string; user_id: string | null; chat_id: string | null; source_epoch: string; source_generation: string }>();
      const pair = await this.db.prepare(`SELECT id,state,expires_at,user_id,chat_id FROM assistant_telegram_pairings WHERE ${ns} AND ${origin} AND state IN ('issued','claimed','confirmable') ORDER BY expires_at DESC LIMIT 1`).bind(...this.keys(), ...this.affinity()).first<{ id: string; state: string; expires_at: number; user_id: string | null; chat_id: string | null }>();
      return { state: link?.state ?? "unlinked", revision: link?.revision ?? 0,
        affinityCurrent: !link || link.source_epoch === this.scope.sourceEpoch && link.source_generation === this.scope.sourceGeneration,
        ...(pair ? { pairing: { pairingId: pair.id, state: pair.expires_at <= this.now() ? "expired" : pair.state, expiresAt: pair.expires_at,
          ...(pair.user_id ? { fingerprint: (await bridgeHash([pair.user_id, pair.chat_id])).slice(0, 16) } : {}) } } : {}) };
    }
    const ledger = new CommandLedger(this.db, this.scope, item.operationId, await bridgeHash(["telegram-link-v1", this.bot, this.scope, item]));
    const previous = await ledger.recover<Receipt>(); if (previous) return this.enrich(previous);
    const now = this.now(), pair = item.kind === "telegram_link.confirm" ? await this.pair(item.pairingId) : null;
    if (item.kind === "telegram_link.confirm" && !pair) throw new Error("telegram_precondition");
    const expected = item.kind === "telegram_link.confirm" ? pair!.expected_revision : item.expectedRevision;
    const next = item.kind === "telegram_link.revoke" ? expected + 1 : expected;
    const result: Receipt = { kind: item.kind, revision: next, state: item.kind === "telegram_link.begin" ? "issued" : item.kind === "telegram_link.confirm" ? "confirmable" : "revoked" };
    const stateCondition = `((NOT EXISTS(SELECT 1 FROM assistant_telegram_links WHERE ${ns}) AND ?=0)
      OR EXISTS(SELECT 1 FROM assistant_telegram_links WHERE ${ns} AND revision=?${item.kind === "telegram_link.revoke" ? "" : " AND state<>'active'"}))`;
    let condition = stateCondition, values: (string | number | null)[] = [...this.keys(), expected, ...this.keys(), expected];
    let newPair: Pairing | null = null, bHash: string | null = null;
    if (item.kind === "telegram_link.begin") {
      newPair = { id: crypto.randomUUID(), source_epoch: this.scope.sourceEpoch, source_generation: this.scope.sourceGeneration,
        expected_revision: expected, expires_at: now + 300000, state: "issued", a_hash: "", b_hash: null, user_id: null, chat_id: null };
      newPair.a_hash = await bridgeHash(await this.capability(newPair, "p"));
      result.pairingId = newPair.id; result.expiresAt = newPair.expires_at;
    } else if (item.kind === "telegram_link.confirm") {
      condition += ` AND EXISTS(SELECT 1 FROM assistant_telegram_pairings WHERE ${ns} AND id=? AND ${origin}
        AND state='claimed' AND expected_revision=? AND expires_at>?)`;
      values.push(...this.keys(), pair!.id, ...this.affinity(), expected, now);
      bHash = await bridgeHash(await this.capability(pair!, "c")); result.pairingId = pair!.id; result.expiresAt = pair!.expires_at;
    }
    const statements = [ledger.admit(result, now, condition, values)];
    if (item.kind === "telegram_link.confirm") {
      statements.push(ledger.statement(`UPDATE assistant_telegram_pairings SET state='confirmable',b_hash=? WHERE ${ns} AND id=? AND $gate`, bHash, ...this.keys(), pair!.id));
    } else {
      statements.push(ledger.statement(`INSERT INTO assistant_telegram_links SELECT ?,?,?,?,?,?,'${item.kind === "telegram_link.revoke" ? "revoked" : "unlinked"}',NULL,NULL,NULL WHERE $gate
        ON CONFLICT(installation_id,generation,bot_instance) DO UPDATE SET source_epoch=excluded.source_epoch,source_generation=excluded.source_generation,revision=excluded.revision,state=excluded.state,user_id=NULL,chat_id=NULL,activation_cut=NULL`, ...this.keys(), ...this.affinity(), next));
      statements.push(ledger.statement(`UPDATE assistant_telegram_pairings SET state='revoked' WHERE ${ns} AND state IN ('issued','claimed','confirmable') AND $gate`, ...this.keys()));
      if (newPair) statements.push(ledger.statement(`INSERT INTO assistant_telegram_pairings SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE $gate`, ...this.keys(), newPair.id, ...this.affinity(), expected, newPair.expires_at, "issued", newPair.a_hash, null, null, null));
      else statements.push(ledger.statement(`UPDATE assistant_telegram_updates SET state='cancelled' WHERE ${ns} AND state='pending' AND $gate`, ...this.keys()));
    }
    await this.db.batch(statements);
    const saved = await ledger.recover<Receipt>(); if (!saved) throw new Error("telegram_precondition");
    return this.enrich(saved);
  }
  async receive(input: unknown): Promise<string> {
    const copy = snapshot(input); if (!copy) return "unsupported";
    const { update_id: updateId, message: msg } = copy.value, user = String(msg.from.id), chat = String(msg.chat.id);
    const hash = await bridgeHash(copy.raw), now = this.now(), second = Math.floor(now / 1000);
    const recover = async () => this.db.prepare(`SELECT payload_hash,outcome FROM assistant_telegram_updates WHERE ${ns} AND update_id=?`).bind(...this.keys(), updateId).first<{ payload_hash: string; outcome: string }>();
    const previous = await recover(); if (previous) return previous.payload_hash === hash ? previous.outcome : "conflict";
    const challenge = /^\/start ([pc])_([A-Za-z0-9_-]{43})$/.exec(msg.text);
    const token = crypto.randomUUID(), gate = `EXISTS(SELECT 1 FROM assistant_telegram_updates WHERE ${ns} AND update_id=? AND token=?)`;
    const gateValues = [...this.keys(), updateId, token];
    const columns = "installation_id,generation,bot_instance,update_id,payload_hash,token,source_epoch,source_generation,link_revision,pairing_id,user_id,chat_id,message_id,message_date,thread_id,text,outcome,state,received_at,reply_to_message_id,reply_to_chat_id,reply_to_thread_id";
    const base = [...this.keys(), updateId, hash, token, ...this.affinity()];
    if (challenge) {
      const phase = challenge[1] === "p" ? "p" : "c", nonceHash = await bridgeHash(challenge[2]);
      const pair = await this.db.prepare(`SELECT * FROM assistant_telegram_pairings WHERE ${ns} AND ${origin} AND ${phase === "p" ? "a_hash" : "b_hash"}=?`).bind(...this.keys(), ...this.affinity(), nonceHash).first<Pairing>();
      if (!pair) return "denied";
      const currentHash = await bridgeHash(await this.capability(pair, phase));
      if (currentHash !== nonceHash || currentHash !== (phase === "p" ? pair.a_hash : pair.b_hash)) return "denied";
      const valid = `EXISTS(SELECT 1 FROM assistant_telegram_pairings p JOIN assistant_telegram_links l USING(installation_id,generation,bot_instance)
        WHERE p.installation_id=? AND p.generation=? AND p.bot_instance=? AND p.id=? AND p.source_epoch=? AND p.source_generation=?
        AND l.source_epoch=p.source_epoch AND l.source_generation=p.source_generation AND l.revision=p.expected_revision AND l.state<>'active'
        AND p.state=? AND p.expires_at>? AND ?<=?${phase === "c" ? " AND p.user_id=? AND p.chat_id=?" : ""})`;
      const validValues = [...this.keys(), pair.id, ...this.affinity(), phase === "p" ? "issued" : "confirmable", now, msg.date, second,
        ...(phase === "c" ? [user, chat] : [])];
      const outcome = phase === "p" ? "pairing_claimed" : "linked", revision = pair.expected_revision + (phase === "c" ? 1 : 0);
      const statements = [this.db.prepare(`INSERT INTO assistant_telegram_updates(${columns}) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'completed',?,NULL,NULL,NULL WHERE ${valid} ON CONFLICT DO NOTHING`)
        .bind(...base, revision, pair.id, user, chat, msg.message_id, msg.date, msg.message_thread_id ?? null, outcome, now, ...validValues)];
      statements.push(this.db.prepare(`UPDATE assistant_telegram_pairings SET state=?,user_id=?,chat_id=? WHERE ${ns} AND id=? AND ${gate}`)
        .bind(phase === "p" ? "claimed" : "consumed", user, chat, ...this.keys(), pair.id, ...gateValues));
      if (phase === "c") statements.push(this.db.prepare(`UPDATE assistant_telegram_links SET state='active',revision=?,user_id=?,chat_id=?,activation_cut=? WHERE ${ns} AND ${gate}`)
        .bind(revision, user, chat, Math.max(msg.date, second), ...this.keys(), ...gateValues));
      await this.db.batch(statements);
    } else {
      // This INSERT is the authorization check, including temporal ambiguity.
      // No raw command, source write or model execution happens in #47.
      const outcome = `CASE WHEN ?<activation_cut THEN 'denied_before_activation' WHEN ?=activation_cut THEN 'denied_ambiguous_activation' WHEN ?>? THEN 'denied_future' ELSE 'pending' END`;
      const timeValues = [msg.date, msg.date, msg.date, second];
      const quoted=quotedMessageSchema.safeParse(msg.reply_to_message);
      const quoteValues=quoted.success?[quoted.data.message_id,String(quoted.data.chat.id),quoted.data.message_thread_id??null]:[null,null,null];
      await this.db.batch([this.db.prepare(`INSERT INTO assistant_telegram_updates(${columns}) SELECT ?,?,?,?,?,?,?,?,revision,NULL,?,?,?,?,?,
        CASE WHEN ?>activation_cut AND ?<=? THEN ? ELSE NULL END,${outcome},CASE WHEN ?>activation_cut AND ?<=? THEN 'pending' ELSE 'completed' END,?,
        CASE WHEN ?>activation_cut AND ?<=? THEN ? ELSE NULL END,
        CASE WHEN ?>activation_cut AND ?<=? THEN ? ELSE NULL END,
        CASE WHEN ?>activation_cut AND ?<=? THEN ? ELSE NULL END
        FROM assistant_telegram_links WHERE ${ns} AND ${origin} AND state='active' AND user_id=? AND chat_id=? ON CONFLICT DO NOTHING`)
        .bind(...base, user, chat, msg.message_id, msg.date, msg.message_thread_id ?? null,
          msg.date, msg.date, second, msg.text, ...timeValues, msg.date, msg.date, second, now,
          ...quoteValues.flatMap(value=>[msg.date,msg.date,second,value]),
          ...this.keys(), ...this.affinity(), user, chat)]);
    }
    const saved = await recover(); return saved ? saved.payload_hash === hash ? saved.outcome : "conflict" : "denied";
  }
}
