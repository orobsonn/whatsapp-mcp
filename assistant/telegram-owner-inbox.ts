import type { OwnerAffinity } from "./mcp";
import type { AccessGuard } from "./access";
import { telegramLinkGuard } from "./telegram-auth";
import { retentionExecutionGuard } from "./retention-execution";

// SQL time, not a captured JavaScript timestamp: a guard must expire even when
// its caller holds it across an await and no cleanup worker has run.
const liveMillis = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const ns = "installation_id=? AND generation=? AND bot_instance=?";
type Activation = Readonly<{ linkRevision: number; cutoffAt: number; cutoffSecond: number }>;
export type TelegramOwnerTurn = Readonly<{ updateId: number; messageId: number; threadId: number | null; text: string; deadlineAt: number }>;
type TurnRow = {
  update_id: number; payload_hash: string; token: string; update_token: string;
  source_epoch: string; source_generation: string; link_revision: number; user_id: string; chat_id: string;
  message_id: number; message_date: number; thread_id: number | null; received_at: number; deadline_at: number;
};

/** Internal host authority. No HTTP/MCP/JSON constructor or model-visible
 * bearer grant. This class does not execute commands or call a provider. */
export class TelegramOwnerInbox {
  private readonly scope: Readonly<OwnerAffinity>;
  private readonly turns = new WeakMap<TelegramOwnerTurn, TurnRow>();
  constructor(private readonly db: D1Database, scope: OwnerAffinity, private readonly bot: string) {
    if (![scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration, bot].every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value))) throw Error("telegram_owner_scope");
    this.scope = Object.freeze({ ...scope });
  }
  private keys() { return [this.scope.installationId, this.scope.generation, this.bot]; }
  async activate(): Promise<Activation> {
    const retention = retentionExecutionGuard(this.scope);
    await this.db.prepare(`INSERT INTO assistant_telegram_owner_activations
      SELECT installation_id,generation,bot_instance,revision,source_epoch,source_generation,user_id,chat_id,${liveMillis},CAST(${liveMillis}/1000 AS INTEGER)
      FROM assistant_telegram_links WHERE ${ns} AND source_epoch=? AND source_generation=? AND state='active' AND (${retention.sql}) ON CONFLICT DO NOTHING`)
      .bind(...this.keys(), this.scope.sourceEpoch, this.scope.sourceGeneration, ...retention.values).run();
    const activation = await this.db.prepare(`SELECT a.link_revision AS linkRevision,a.cutoff_at AS cutoffAt,a.cutoff_second AS cutoffSecond
      FROM assistant_telegram_owner_activations a JOIN assistant_telegram_links l USING(installation_id,generation,bot_instance)
      WHERE a.installation_id=? AND a.generation=? AND a.bot_instance=? AND a.source_epoch=? AND a.source_generation=?
      AND l.state='active' AND l.revision=a.link_revision AND l.source_epoch=a.source_epoch AND l.source_generation=a.source_generation
      AND l.user_id=a.user_id AND l.chat_id=a.chat_id AND (${retention.sql})`)
      .bind(...this.keys(), this.scope.sourceEpoch, this.scope.sourceGeneration, ...retention.values).first<Activation>();
    if (!activation) throw Error("telegram_owner_unavailable");
    return Object.freeze(activation);
  }
  async claim(updateId: number, deadlineAt?: number): Promise<TelegramOwnerTurn | null> {
    if (!Number.isSafeInteger(updateId) || updateId < 0 || deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) throw Error("telegram_owner_input");
    const retention = retentionExecutionGuard(this.scope), token = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO assistant_telegram_owner_turns
      SELECT u.installation_id,u.generation,u.bot_instance,u.update_id,u.payload_hash,?,u.token,u.source_epoch,u.source_generation,u.link_revision,
      u.user_id,u.chat_id,u.message_id,u.message_date,u.thread_id,u.received_at,${liveMillis},MIN(u.received_at+120000,${liveMillis}+120000,COALESCE(?,${liveMillis}+120000)),
      'claimed',NULL,NULL FROM assistant_telegram_updates u
      JOIN assistant_telegram_owner_activations a ON a.installation_id=u.installation_id AND a.generation=u.generation AND a.bot_instance=u.bot_instance AND a.link_revision=u.link_revision
      JOIN assistant_telegram_links l ON l.installation_id=u.installation_id AND l.generation=u.generation AND l.bot_instance=u.bot_instance
      WHERE u.installation_id=? AND u.generation=? AND u.bot_instance=? AND u.update_id=? AND u.source_epoch=? AND u.source_generation=?
      AND u.state='pending' AND u.outcome='pending' AND u.text IS NOT NULL AND u.pairing_id IS NULL
      AND a.source_epoch=u.source_epoch AND a.source_generation=u.source_generation AND a.user_id=u.user_id AND a.chat_id=u.chat_id
      AND l.source_epoch=u.source_epoch AND l.source_generation=u.source_generation AND l.revision=u.link_revision AND l.state='active' AND l.user_id=u.user_id AND l.chat_id=u.chat_id
      AND u.message_date>a.cutoff_second AND u.received_at>=a.cutoff_at AND u.received_at<=${liveMillis}+1000
      AND u.message_date>l.activation_cut AND u.message_date<=CAST(${liveMillis}/1000 AS INTEGER)
      AND MIN(u.received_at+120000,COALESCE(?,${liveMillis}+120000))>${liveMillis}
      AND (${retention.sql}) ON CONFLICT DO NOTHING RETURNING *,
      (SELECT original.text FROM assistant_telegram_updates original
        WHERE original.installation_id=assistant_telegram_owner_turns.installation_id AND original.generation=assistant_telegram_owner_turns.generation
        AND original.bot_instance=assistant_telegram_owner_turns.bot_instance AND original.update_id=assistant_telegram_owner_turns.update_id
        AND original.token=assistant_telegram_owner_turns.update_token AND original.payload_hash=assistant_telegram_owner_turns.payload_hash) AS input_text`)
      .bind(token, deadlineAt ?? null, ...this.keys(), updateId, this.scope.sourceEpoch, this.scope.sourceGeneration, deadlineAt ?? null, ...retention.values).first<TurnRow & { input_text: string }>();
    if (!row) return null;
    // RETURNING observes the input in the SAME admission statement. A later
    // edit must invalidate the guard rather than become newly trusted input.
    if (typeof row.input_text !== "string") throw Error("telegram_owner_input_unavailable");
    const turn = Object.freeze({ updateId, messageId: row.message_id, threadId: row.thread_id, text: row.input_text, deadlineAt: row.deadline_at });
    this.turns.set(turn, Object.freeze(row));
    return turn;
  }
  /** Include in the SAME admission statement as model reservation or mutation.
   * Checking it once before calling a controller is not sufficient. */
  guard(turn: TelegramOwnerTurn): AccessGuard {
    const row = this.turns.get(turn);
    if (!row) throw Error("telegram_owner_turn_invalid");
    const link = telegramLinkGuard({ ...this.scope, botInstance: this.bot, linkRevision: row.link_revision, userId: row.user_id, chatId: row.chat_id });
    const retention = retentionExecutionGuard(this.scope);
    return { sql: `EXISTS(SELECT 1 FROM assistant_telegram_owner_turns t
      JOIN assistant_telegram_updates u ON u.installation_id=t.installation_id AND u.generation=t.generation AND u.bot_instance=t.bot_instance AND u.update_id=t.update_id
      JOIN assistant_telegram_owner_activations a ON a.installation_id=t.installation_id AND a.generation=t.generation AND a.bot_instance=t.bot_instance AND a.link_revision=t.link_revision
      WHERE t.installation_id=? AND t.generation=? AND t.bot_instance=? AND t.update_id=? AND t.token=? AND t.state='claimed' AND t.deadline_at>${liveMillis}
      AND t.payload_hash=? AND t.source_epoch=? AND t.source_generation=? AND t.link_revision=? AND t.user_id=? AND t.chat_id=?
      AND t.message_id=? AND t.message_date=? AND t.thread_id IS ? AND t.received_at=? AND t.deadline_at=?
      AND u.token=t.update_token AND u.payload_hash=t.payload_hash AND u.source_epoch=t.source_epoch AND u.source_generation=t.source_generation
      AND u.link_revision=t.link_revision AND u.user_id=t.user_id AND u.chat_id=t.chat_id AND u.message_id=t.message_id
      AND u.message_date=t.message_date AND u.thread_id IS t.thread_id AND u.received_at=t.received_at AND u.text=? AND u.state='pending' AND u.outcome='pending' AND u.pairing_id IS NULL
      AND a.source_epoch=t.source_epoch AND a.source_generation=t.source_generation AND a.user_id=t.user_id AND a.chat_id=t.chat_id
      AND t.message_date>a.cutoff_second AND t.received_at>=a.cutoff_at)
      AND (${link.sql}) AND (${retention.sql})`,
      values: [...this.keys(), row.update_id, row.token, row.payload_hash, row.source_epoch, row.source_generation, row.link_revision, row.user_id, row.chat_id,
        row.message_id, row.message_date, row.thread_id, row.received_at, row.deadline_at, turn.text, ...link.values, ...retention.values] };
  }
  async complete(turn: TelegramOwnerTurn): Promise<boolean> {
    const guard = this.guard(turn), finish = crypto.randomUUID();
    const result = await this.db.batch([
      this.db.prepare(`UPDATE assistant_telegram_owner_turns SET state='complete',finish_token=?,completed_at=${liveMillis}
        WHERE ${ns} AND update_id=? AND (${guard.sql}) RETURNING update_id`)
        .bind(finish, ...this.keys(), turn.updateId, ...guard.values),
      // The first UPDATE changes the live guard. Only THIS batch's winning
      // nonce admits the second mutation; an old completion cannot satisfy it.
      this.db.prepare(`UPDATE assistant_telegram_updates SET state='completed' WHERE ${ns} AND update_id=?
        AND EXISTS(SELECT 1 FROM assistant_telegram_owner_turns t WHERE t.installation_id=assistant_telegram_updates.installation_id
          AND t.generation=assistant_telegram_updates.generation AND t.bot_instance=assistant_telegram_updates.bot_instance
          AND t.update_id=assistant_telegram_updates.update_id AND t.finish_token=? AND t.state='complete')`)
        .bind(...this.keys(), turn.updateId, finish),
    ]);
    return result[0].results.length === 1 && result[1].meta.changes === 1;
  }
  async expire(updateId: number): Promise<boolean> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw Error("telegram_owner_input");
    return !!await this.db.prepare(`UPDATE assistant_telegram_owner_turns SET state='uncertain' WHERE ${ns} AND update_id=? AND state='claimed' AND deadline_at<=${liveMillis} RETURNING update_id`)
      .bind(...this.keys(), updateId).first();
  }
  async inspect(updateId: number): Promise<{ updateId: number; state: string; deadlineAt: number; completedAt: number | null } | null> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw Error("telegram_owner_input");
    return this.db.prepare(`SELECT update_id AS updateId,state,deadline_at AS deadlineAt,completed_at AS completedAt FROM assistant_telegram_owner_turns WHERE ${ns} AND update_id=?`)
      .bind(...this.keys(), updateId).first();
  }
}
