import { z } from "zod";
import { SourceAccess, type SourceFence, type AccessGuard } from "./access";
import { checkOriginsWithin, type OriginFence, type OriginGuard } from "./origin-guard";
import type { TelegramApi } from "./telegram";
import type { OwnerAffinity } from "./mcp";
import { sourceFence, originFence } from "./agent/contracts";
import { TelegramOwnerInbox, type TelegramOwnerTurn, type TelegramOwnerReplyFence } from "./telegram-owner-inbox";
import { telegramLinkGuard } from "./telegram-auth";
import { retentionExecutionGuard } from "./retention-execution";
import { jsonStatement } from "./d1-statement";
import { bridgeHash } from "./ingress";
import { DialogueState, dialogueWitnesses, type DialogueWitness } from "./telegram-dialogue-state";
export type ReplyDependency = { source: SourceFence; origin?: OriginFence };
export type OwnerReplySender = (check: () => Promise<void>) => Pick<TelegramApi, "send">;
const label = z.string().min(1).max(256), integer = z.number().int().nonnegative().safe();
const frameSchema = z.object({ installationId: label, generation: label, sourceEpoch: label, sourceGeneration: label,
  botInstance: label, linkRevision: integer.min(1), userId: label, chatId: label, updateId: integer, messageId: integer.min(1), threadId: integer.min(1).nullable(), deadlineAt: integer }).strict();
const dependencies = z.array(z.object({ source: sourceFence, origin: originFence.optional() }).strict()).max(10);
const ns = "installation_id=? AND generation=? AND bot_instance=?";
const liveMillis = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const owner = { kind: "owner" } as const, bytes = (s: string) => new TextEncoder().encode(s).length;
const merge = (...guards: AccessGuard[]): AccessGuard => ({ sql: guards.map(g => `(${g.sql})`).join(" AND "), values: guards.flatMap(g => g.values) });
type ReplyRow = { update_id: number; request_hash: string; body_hash: string; fence_json: string; text: string | null; deps_json: string;
  expires_at: number; state: string; attempts: number; attempt_token: string | null; message_id: number | null; purged: number; witnesses_json: string };
type Metadata = { updateId: number; state: string; attempts: number; messageId: number | null; purged: boolean };
export type OwnerReplyContent = { text: string; dependencies: ReplyDependency[]; witnesses?: DialogueWitness[] };

/** Host-only outbox. The executor must supply ALL read dependencies; model
 * citations alone are insufficient. No query/control, model or generic sender. */
export class TelegramOwnerReplies {
  private readonly scope: Readonly<OwnerAffinity>;
  private readonly access: SourceAccess;
  constructor(private readonly db: D1Database, scope: OwnerAffinity, private readonly bot: string,
    private readonly inbox: TelegramOwnerInbox, private readonly sender: OwnerReplySender, private readonly origin?: Pick<OriginGuard, "localGuard" | "check">) {
    this.scope = Object.freeze({ ...scope }); this.access = new SourceAccess(db, this.scope);
  }
  private keys() { return [this.scope.installationId, this.scope.generation, this.bot]; }
  private frame(input: unknown): TelegramOwnerReplyFence {
    const frame = frameSchema.parse(input);
    if (frame.installationId !== this.scope.installationId || frame.generation !== this.scope.generation || frame.botInstance !== this.bot
      || frame.sourceEpoch !== this.scope.sourceEpoch || frame.sourceGeneration !== this.scope.sourceGeneration) throw Error("telegram_owner_reply_input");
    return frame;
  }
  private ownDependencies(input: unknown): ReplyDependency[] {
    try {
      const deps = dependencies.parse(input); if (bytes(JSON.stringify(deps)) > 32768) throw 0;
      const selected = new Map<string, ReplyDependency>();
      for (const dep of deps) {
        const s = dep.source;
        if (s.installationId !== this.scope.installationId || s.generation !== this.scope.generation || !["owner_note", "whatsapp"].includes(s.source.origin)) throw 0;
        if (s.source.origin === "whatsapp") {
          const o = dep.origin;
          if (!this.origin || !o || o.canonicalId !== s.source.id || o.revision !== s.source.revision || o.version !== s.source.version
            || o.chatId !== s.source.conversationId || o.installationId !== this.scope.installationId || o.generation !== this.scope.generation
            || o.sourceEpoch !== this.scope.sourceEpoch || o.sourceGeneration !== this.scope.sourceGeneration) throw 0;
        } else if (dep.origin) throw 0;
        const previous = selected.get(s.source.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(dep)) throw 0;
        selected.set(s.source.id, dep);
      }
      return [...selected.values()].sort((a, b) => a.source.source.id.localeCompare(b.source.source.id));
    } catch { throw Error("telegram_owner_reply_input"); }
  }
  private ownContent(text: string, input: ReplyDependency[], witnesses: DialogueWitness[]) {
    if (typeof text !== "string" || !text.trim() || text.length > 4000 || bytes(text) > 12000) throw Error("telegram_owner_reply_input");
    return { text, deps: this.ownDependencies(input), proof: dialogueWitnesses.parse(witnesses) };
  }
  /** One canonical envelope for the Plan, publication and historical settlement. */
  requestHash(inputFrame: unknown, text: string, input: ReplyDependency[], witnesses: DialogueWitness[] = []): Promise<string> {
    const frame = this.frame(inputFrame), content = this.ownContent(text, input, witnesses);
    return bridgeHash([frame, content.text, content.deps, content.proof]);
  }
  private sourceGuard(deps: ReplyDependency[]) {
    return merge({ sql: "1", values: [] }, ...deps.flatMap(dep => [this.access.guard(owner, dep.source, Date.now()), ...(dep.origin ? [this.origin!.localGuard(dep.origin)] : [])]));
  }
  private remote(deps: ReplyDependency[]) {
    const origins = deps.flatMap(dep => dep.origin ? [dep.origin] : []);
    return checkOriginsWithin(origins, proof => this.origin!.check(proof));
  }
  private read(updateId: number) {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw Error("telegram_owner_reply_input");
    return this.db.prepare(`SELECT * FROM assistant_telegram_owner_replies WHERE ${ns} AND update_id=?`).bind(...this.keys(), updateId).first<ReplyRow>();
  }
  private metadata(row: ReplyRow, state = row.state): Metadata {
    return { updateId: row.update_id, state, attempts: row.attempts, messageId: row.message_id, purged: row.purged === 1 };
  }
  async inspect(updateId: number): Promise<Metadata | null>;
  async inspect(updateId: number, expected: OwnerReplyContent): Promise<(Metadata & { requestHash: string }) | null>;
  async inspect(updateId: number, expected?: OwnerReplyContent): Promise<(Metadata & { requestHash?: string }) | null> {
    // Capture the expected private envelope before the first await. This path
    // proves historical equality only; it never admits another send or model.
    const content = expected ? this.ownContent(expected.text, expected.dependencies, expected.witnesses ?? []) : null;
    const row = await this.read(updateId); if (!row) return null;
    if (!content) return this.metadata(row);
    if (row.state !== "sent" || row.purged || row.text === null || !Number.isSafeInteger(row.message_id) || row.message_id! < 1) return null;
    const frame = this.frame(JSON.parse(row.fence_json));
    if (frame.updateId !== updateId || row.expires_at !== frame.deadlineAt || await bridgeHash(row.text) !== row.body_hash
      || await this.requestHash(frame, row.text, JSON.parse(row.deps_json), JSON.parse(row.witnesses_json)) !== row.request_hash) throw Error("telegram_owner_reply_corrupt");
    const expectedHash = await this.requestHash(frame, content.text, content.deps, content.proof);
    if (expectedHash !== row.request_hash) throw Error("telegram_owner_reply_conflict");
    const completed = this.completed(frame);
    if (!await jsonStatement(this.db, `SELECT 1 WHERE ${completed.sql}`, completed.values).first()) throw Error("telegram_owner_reply_corrupt");
    return { ...this.metadata(row), requestHash: expectedHash };
  }
  async prepare(turn: TelegramOwnerTurn, text: string, input: ReplyDependency[], witnesses: DialogueWitness[] = []): Promise<Metadata> {
    // Own every model-derived scalar/proof synchronously, before hashing/RPC.
    const { deps, proof } = this.ownContent(text, input, witnesses), frame = this.frame(this.inbox.replyFence(turn));
    const proofJSON = JSON.stringify(proof), proofGuard = new DialogueState(this.db, this.scope).guard(proof);
    const frameJSON = JSON.stringify(frame), depsJSON = JSON.stringify(deps), requestHash = await this.requestHash(frame, text, deps, proof), bodyHash = await bridgeHash(text);
    const previous = await this.read(frame.updateId);
    if (previous) { if (previous.request_hash !== requestHash) throw Error("telegram_owner_reply_conflict"); return this.metadata(previous); }
    if (!await this.remote(deps)) return { updateId: frame.updateId, state: "blocked", attempts: 0, messageId: null, purged: false };
    const guard = merge(this.sourceGuard(deps), proofGuard, { sql: `NOT EXISTS(SELECT 1 FROM assistant_telegram_owner_replies WHERE ${ns} AND update_id=?)`, values: [...this.keys(), frame.updateId] });
    await this.inbox.complete(turn, { guard, build: witness => [jsonStatement(this.db, `INSERT INTO assistant_telegram_owner_replies
      (installation_id,generation,bot_instance,update_id,request_hash,body_hash,fence_json,text,deps_json,expires_at,published_at,state,attempts,attempt_token,message_id,purged,witnesses_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,${liveMillis},'prepared',0,NULL,NULL,0,? WHERE (${witness.sql})`,
      [...this.keys(), frame.updateId, requestHash, bodyHash, frameJSON, text, depsJSON, frame.deadlineAt, proofJSON, ...witness.values])] });
    const saved = await this.read(frame.updateId);
    if (saved) { if (saved.request_hash !== requestHash) throw Error("telegram_owner_reply_conflict"); return this.metadata(saved); }
    return { updateId: frame.updateId, state: "blocked", attempts: 0, messageId: null, purged: false };
  }
  private completed(frame: TelegramOwnerReplyFence): AccessGuard {
    return { sql: `EXISTS(SELECT 1 FROM assistant_telegram_owner_turns t JOIN assistant_telegram_updates u
      ON u.installation_id=t.installation_id AND u.generation=t.generation AND u.bot_instance=t.bot_instance AND u.update_id=t.update_id
      WHERE t.installation_id=? AND t.generation=? AND t.bot_instance=? AND t.update_id=? AND t.state='complete'
      AND t.source_epoch=? AND t.source_generation=? AND t.link_revision=? AND t.user_id=? AND t.chat_id=? AND t.message_id=? AND t.thread_id IS ? AND t.deadline_at=?
      AND u.state='completed' AND u.payload_hash=t.payload_hash AND u.token=t.update_token AND u.user_id=t.user_id AND u.chat_id=t.chat_id AND u.message_id=t.message_id AND u.thread_id IS t.thread_id)`,
      values: [...this.keys(), frame.updateId, frame.sourceEpoch, frame.sourceGeneration, frame.linkRevision, frame.userId, frame.chatId, frame.messageId, frame.threadId, frame.deadlineAt] };
  }
  private current(row: ReplyRow, deps: ReplyDependency[], state: "prepared" | "attempting", nonce?: string): AccessGuard {
    const frame = this.frame(JSON.parse(row.fence_json)), completed = this.completed(frame);
    const reply = { sql: `EXISTS(SELECT 1 FROM assistant_telegram_owner_replies WHERE ${ns} AND update_id=? AND request_hash=? AND body_hash=? AND fence_json=?
      AND text IS ? AND deps_json=? AND witnesses_json=? AND expires_at=? AND expires_at>${liveMillis} AND purged=0 AND state=? AND attempts=? ${nonce ? "AND attempt_token=?" : "AND attempt_token IS NULL"})`,
      values: [...this.keys(), row.update_id, row.request_hash, row.body_hash, row.fence_json, row.text, row.deps_json, row.witnesses_json, row.expires_at, state, state === "prepared" ? 0 : 1, ...(nonce ? [nonce] : [])] };
    return merge(completed, reply, telegramLinkGuard(frame), retentionExecutionGuard(this.scope), this.sourceGuard(deps), new DialogueState(this.db, this.scope).guard(JSON.parse(row.witnesses_json)));
  }
  async dispatch(updateId: number): Promise<Metadata | null> {
    const row = await this.read(updateId); if (!row) return null;
    if (row.state !== "prepared" || row.purged || row.text === null) return this.metadata(row);
    const deps = this.ownDependencies(JSON.parse(row.deps_json)), frame = this.frame(JSON.parse(row.fence_json));
    if (row.expires_at !== frame.deadlineAt || await bridgeHash(row.text) !== row.body_hash || await this.requestHash(frame, row.text, deps, JSON.parse(row.witnesses_json)) !== row.request_hash) throw Error("telegram_owner_reply_corrupt");
    if (!await this.remote(deps)) return this.metadata(row, "blocked");
    const nonce = crypto.randomUUID(), guard = this.current(row, deps, "prepared");
    try {
      const admitted = await jsonStatement(this.db, `UPDATE assistant_telegram_owner_replies SET state='attempting',attempts=1,attempt_token=?
        WHERE ${ns} AND update_id=? AND (${guard.sql}) RETURNING update_id`, [nonce, ...this.keys(), updateId, ...guard.values]).first();
      if (!admitted) {
        const current = (await this.read(updateId))!;
        return this.metadata(current, current.state === "prepared" ? "blocked" : current.state);
      }
      const check = async () => {
        if (!await this.remote(deps)) throw Error("telegram_owner_reply_stale");
        const current = this.current(row, deps, "attempting", nonce);
        if (!await jsonStatement(this.db, `SELECT 1 WHERE ${current.sql}`, current.values).first()) throw Error("telegram_owner_reply_stale");
      };
      const messageId = await this.sender(check).send(frame.chatId, frame.threadId, row.text, []);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw Error("telegram_owner_reply_ack");
      // Settle the exact admitted attempt even after revoke/expiry/purge. Never
      // re-authorize another send or restore any cleared body/dependency.
      await this.db.prepare(`UPDATE assistant_telegram_owner_replies SET state='sent',message_id=? WHERE ${ns} AND update_id=? AND request_hash=? AND attempt_token=? AND attempts=1 AND state IN ('attempting','uncertain')`)
        .bind(messageId, ...this.keys(), updateId, row.request_hash, nonce).run();
    } catch {
      await this.db.prepare(`UPDATE assistant_telegram_owner_replies SET state='uncertain' WHERE ${ns} AND update_id=? AND request_hash=? AND attempt_token=? AND attempts=1 AND state='attempting'`)
        .bind(...this.keys(), updateId, row.request_hash, nonce).run();
    }
    return this.inspect(updateId);
  }
  async cleanup(): Promise<number> {
    const rows = (await this.db.prepare(`SELECT update_id FROM assistant_telegram_owner_replies WHERE ${ns} AND purged=0 AND expires_at<=${liveMillis} ORDER BY expires_at,update_id LIMIT 8`).bind(...this.keys()).all<{ update_id: number }>()).results;
    if (!rows.length) return 0;
    const result = await this.db.batch(rows.flatMap(row => [
      this.db.prepare(`UPDATE assistant_telegram_updates SET text=NULL WHERE ${ns} AND update_id=? AND state='completed'
        AND EXISTS(SELECT 1 FROM assistant_telegram_owner_replies r WHERE r.installation_id=assistant_telegram_updates.installation_id AND r.generation=assistant_telegram_updates.generation AND r.bot_instance=assistant_telegram_updates.bot_instance AND r.update_id=assistant_telegram_updates.update_id AND r.purged=0 AND r.expires_at<=${liveMillis})`).bind(...this.keys(), row.update_id),
      this.db.prepare(`UPDATE assistant_telegram_owner_replies SET text=NULL,deps_json='[]',witnesses_json='[]',purged=1,state=CASE WHEN state='prepared' THEN 'cancelled' WHEN state='attempting' THEN 'uncertain' ELSE state END
        WHERE ${ns} AND update_id=? AND purged=0 AND expires_at<=${liveMillis}`).bind(...this.keys(), row.update_id),
    ]));
    return result.reduce((count, record, index) => count + (index % 2 ? record.meta.changes : 0), 0);
  }
}
