import { bridgeHash } from "./ingress";
import { sourceTextHash } from "./sources";
import { activeOrigin, OriginGuard, originScopeSql, scopeKeys, type Observation, type OriginRef, type OriginScope, type SnapshotReader } from "./origin-guard";
type Inbox = { sequence: number; chat_id: string; source_id: string; source_kind: OriginRef["sourceKind"]; operation: string; application_state: string };
type Existing = { canonical_id: string; revision: number; current_version: number | null; status: string; watermark: number; observation_hash: string | null; tombstoned: number; chat_id: string };
type Chat = { watermark: number; kind: "private" | "group" | null; access_state: string };
const validateLimit = (value: number, max: number) => { if (!Number.isInteger(value) || value < 1 || value > max) throw new Error("materialization_limit"); };
export class CaptureMaterializer {
  private readonly guard: OriginGuard;
  constructor(private readonly db: D1Database, private readonly getScope: () => OriginScope, reader: SnapshotReader, secret: string, private readonly clock = Date.now, readerTimeoutMs = 2000) {
    this.guard = new OriginGuard(db, getScope, reader, secret, readerTimeoutMs);
  }
  private sql(sql: string, ...values: (string | number | null)[]) { return this.db.prepare(sql).bind(...values); }
  async drain(limit = 10) {
    validateLimit(limit, 50);
    const scope = activeOrigin(this.getScope);
    const rows = await this.sql(`SELECT sequence FROM assistant_capture_inbox WHERE ${originScopeSql} AND application_state='pending' ORDER BY sequence LIMIT ?`, ...scopeKeys(scope), limit).all<{ sequence: number }>();
    const results = [];
    for (const row of rows.results) results.push(await this.process(row.sequence));
    return results;
  }
  async retry(limit = 2) {
    validateLimit(limit, 5);
    const scope = activeOrigin(this.getScope);
    const rows = await this.sql(`SELECT sequence FROM assistant_materialization_results WHERE ${originScopeSql}
      AND state='blocked' AND attempts<3 AND next_retry_at<=? ORDER BY next_retry_at,sequence LIMIT ?`, ...scopeKeys(scope), this.clock(), limit).all<{ sequence: number }>();
    const results = [];
    for (const row of rows.results) results.push(await this.process(row.sequence, true));
    return results;
  }
  async process(sequence: number, retry = false): Promise<{ sequence: number; state: string; canonicalId?: string }> {
    const scope = activeOrigin(this.getScope), keys = scopeKeys(scope);
    const event = await this.sql(`SELECT sequence,chat_id,source_id,source_kind,operation,application_state FROM assistant_capture_inbox
      WHERE ${originScopeSql} AND sequence=?`, ...keys, sequence).first<Inbox>();
    if (!event) return { sequence, state: "missing" };
    if (JSON.stringify(scopeKeys(activeOrigin(this.getScope))) !== JSON.stringify(keys)) return { sequence, state: "stale" };
    if (event.application_state === "applied" || (event.application_state === "blocked" && !retry)) return { sequence, state: event.application_state };
    const ref: OriginRef = { sourceKind: event.source_kind, sourceId: event.source_id, chatId: event.chat_id };
    const [existing, chat] = await Promise.all([
      this.sql(`SELECT o.canonical_id,o.watermark,o.observation_hash,o.tombstoned,o.chat_id,s.revision,s.current_version,s.status
        FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
        WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.source_kind=? AND o.source_id=?`, ...keys, ref.sourceKind, ref.sourceId).first<Existing>(),
      this.sql(`SELECT watermark,kind,access_state FROM assistant_origin_conversations WHERE ${originScopeSql} AND chat_id=?`, ...keys, ref.chatId).first<Chat>(),
    ]);
    const tombstone = !!existing && (existing.tombstoned === 1 || existing.status === "withdrawn");
    let observed: Observation = event.operation === "withdraw" || tombstone
      ? { state: "withdrawn", reason: null, watermark: Math.max(sequence, existing?.watermark ?? 0, chat?.watermark ?? 0), kind: chat?.kind ?? null, hash: null, sourceVersion: null, content: null }
      : await this.guard.observe(scope, ref);
    // Operational generation is supplied outside the restorable database.
    if (JSON.stringify(scopeKeys(activeOrigin(this.getScope))) !== JSON.stringify(keys)) return { sequence, state: "stale" };
    if (observed.watermark !== null && (observed.watermark < sequence || observed.watermark < (chat?.watermark ?? 0))) observed = { ...observed, state: "blocked", reason: "stale_reader_snapshot" };
    if (existing && existing.chat_id !== ref.chatId) observed = { ...observed, state: "blocked", reason: "origin_chat_conflict" };
    if (existing && observed.state === "available" && observed.watermark === existing.watermark && observed.hash !== existing.observation_hash) {
      observed = { ...observed, state: "blocked", reason: "inconsistent_snapshot" };
    }
    const state = observed.state === "blocked" ? "blocked" : "applied";
    const canonicalId = existing?.canonical_id ?? `wa_${await bridgeHash([...keys, ref.sourceKind, ref.sourceId])}`;
    const originKey = JSON.stringify([scope.sourceEpoch, scope.sourceGeneration, ref.sourceKind, ref.sourceId]);
    const withdrawn = observed.state === "withdrawn";
    const newer = !existing || (observed.watermark ?? 0) >= existing.watermark;
    const bodyChanged = observed.state === "available" && ref.sourceKind !== "conversation" && newer && !tombstone && observed.hash !== existing?.observation_hash;
    const content = observed.content;
    const text = typeof content?.text === "string" ? content.text : JSON.stringify(content ?? {});
    const bodyHash = bodyChanged ? await sourceTextHash(text) : null;
    const version = withdrawn ? null : bodyChanged ? (existing?.current_version ?? 0) + 1 : existing?.current_version ?? null;
    const revision = (existing?.revision ?? 0) + (bodyChanged || (withdrawn && existing?.status !== "withdrawn") ? 1 : 0);
    const now = this.clock(), token = crypto.randomUUID();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("materialization_clock");
    const gate = "EXISTS(SELECT 1 FROM assistant_materialization_results WHERE token=? AND state='admitted')";
    const gated = (sql: string, ...values: (string | number | null)[]) => this.sql(sql.replaceAll("$gate", gate), ...values, token);
    const batch: D1PreparedStatement[] = [];
    // Admit once. Later statements depend on this token, which remains true
    // after our own source revision/watermark changes.
    const sourceFence = existing ? `EXISTS(SELECT 1 FROM assistant_source_origins o JOIN assistant_sources s
      ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
      WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.source_kind=? AND o.source_id=?
      AND o.watermark=? AND o.observation_hash IS ? AND o.tombstoned=? AND s.revision=? AND s.status=?)`
      : `NOT EXISTS(SELECT 1 FROM assistant_source_origins WHERE ${originScopeSql} AND source_kind=? AND source_id=?)
        AND NOT EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?)`;
    const sourceValues = existing ? [...keys, ref.sourceKind, ref.sourceId, existing.watermark, existing.observation_hash, existing.tombstoned, existing.revision, existing.status]
      : [...keys, ref.sourceKind, ref.sourceId, scope.installationId, scope.generation, canonicalId];
    const chatFence = chat ? `EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE ${originScopeSql} AND chat_id=? AND watermark=? AND kind IS ? AND access_state=?)`
      : `NOT EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE ${originScopeSql} AND chat_id=?)`;
    const chatValues = chat ? [...keys, ref.chatId, chat.watermark, chat.kind, chat.access_state] : [...keys, ref.chatId];
    batch.push(this.sql(`INSERT INTO assistant_materialization_results(installation_id,generation,source_epoch,source_generation,sequence,token,state,attempts,observed_at,watermark,observation_hash)
      SELECT installation_id,generation,source_epoch,source_generation,sequence,?,'admitted',1,?,?,? FROM assistant_capture_inbox
      WHERE ${originScopeSql} AND sequence=? AND application_state=? AND ${sourceFence} AND ${chatFence}
      ON CONFLICT(installation_id,generation,source_epoch,source_generation,sequence) DO UPDATE SET token=excluded.token,state='admitted',
        attempts=assistant_materialization_results.attempts+1,observed_at=excluded.observed_at,watermark=excluded.watermark,observation_hash=excluded.observation_hash
      WHERE assistant_materialization_results.state='blocked' AND assistant_materialization_results.attempts<3 AND assistant_materialization_results.next_retry_at<=?`,
    token, now, observed.watermark, observed.hash, ...keys, sequence, retry ? "blocked" : "pending", ...sourceValues, ...chatValues, now));
    const watermark = Math.max(sequence, observed.watermark ?? 0, chat?.watermark ?? 0);
    const conversationWithdrawn = withdrawn && (ref.sourceKind === "conversation" || observed.conversationWithdrawn);
    const accessState = conversationWithdrawn ? "withdrawn"
      : observed.state === "available" ? "available" : chat?.access_state ?? "unknown";
    batch.push(gated(`INSERT INTO assistant_origin_conversations(installation_id,generation,source_epoch,source_generation,chat_id,watermark,kind,access_state)
      SELECT ?,?,?,?,?,?,?,? WHERE $gate ON CONFLICT(installation_id,generation,source_epoch,source_generation,chat_id)
      DO UPDATE SET watermark=excluded.watermark,kind=COALESCE(excluded.kind,assistant_origin_conversations.kind),access_state=excluded.access_state`,
    ...keys, ref.chatId, watermark, observed.kind, accessState));
    if (conversationWithdrawn) {
      // Revoke every canonical projection in this conversation atomically.
      // Original version bodies remain retained; this is not physical deletion.
      batch.push(gated(`UPDATE assistant_sources SET status='withdrawn',current_version=NULL,revision=revision+1
        WHERE installation_id=? AND generation=? AND status='active' AND id IN (
          SELECT canonical_id FROM assistant_source_origins WHERE ${originScopeSql} AND chat_id=?) AND $gate`,
      scope.installationId, scope.generation, ...keys, ref.chatId));
      batch.push(gated(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
        SELECT s.installation_id,s.generation,s.id,s.revision,0,'withdrawn',? FROM assistant_sources s
        JOIN assistant_source_origins o ON o.installation_id=s.installation_id AND o.generation=s.generation AND o.canonical_id=s.id
        WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=?
        AND s.status='withdrawn' AND NOT EXISTS(SELECT 1 FROM assistant_source_changes c WHERE c.installation_id=s.installation_id
          AND c.generation=s.generation AND c.source_id=s.id AND c.revision=s.revision) AND $gate`, now, ...keys, ref.chatId));
      batch.push(gated(`UPDATE assistant_source_origins SET tombstoned=1 WHERE ${originScopeSql} AND chat_id=? AND $gate`, ...keys, ref.chatId));
    }
    if (ref.sourceKind !== "conversation" && state === "applied" && newer && !(conversationWithdrawn && existing)) {
      if (!existing) batch.push(gated(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,conversation_id,audience,status,revision,current_version)
        SELECT ?,?,?,'whatsapp',?,?,'restricted',?,?,? WHERE $gate`, scope.installationId, scope.generation, canonicalId, originKey, ref.chatId, withdrawn ? "withdrawn" : "active", revision, version));
      if (bodyChanged) {
        batch.push(gated(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,author_id,author_label,original_text,content_hash,occurred_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE $gate`, scope.installationId, scope.generation, canonicalId, version,
        content?.authorId ?? null, content?.authorName ?? null, text, bodyHash, content?.occurredAt ?? 0));
        const { text: _body, ...dependencies } = content!;
        batch.push(gated(`INSERT INTO assistant_origin_versions(installation_id,generation,canonical_id,version,source_version,watermark,observation_hash,dependencies_json)
          SELECT ?,?,?,?,?,?,?,? WHERE $gate`, scope.installationId, scope.generation, canonicalId, version, observed.sourceVersion, observed.watermark, observed.hash, JSON.stringify(dependencies)));
      }
      if (existing && (bodyChanged || withdrawn)) batch.push(gated(`UPDATE assistant_sources SET revision=?,current_version=?,status=?
        WHERE installation_id=? AND generation=? AND id=? AND $gate`, revision, version, withdrawn ? "withdrawn" : "active", scope.installationId, scope.generation, canonicalId));
      if (!existing || bodyChanged || (withdrawn && existing.status !== "withdrawn")) batch.push(gated(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
        SELECT ?,?,?,?,?,?,? WHERE $gate`, scope.installationId, scope.generation, canonicalId, revision, version ?? 0, withdrawn ? "withdrawn" : existing ? "corrected" : "created", now));
      batch.push(gated(`INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE $gate ON CONFLICT(installation_id,generation,source_epoch,source_generation,source_kind,source_id)
        DO UPDATE SET watermark=excluded.watermark,observation_hash=excluded.observation_hash,tombstoned=MAX(assistant_source_origins.tombstoned,excluded.tombstoned)`,
      ...keys, ref.sourceKind, ref.sourceId, ref.chatId, canonicalId, observed.watermark, observed.hash, withdrawn ? 1 : 0));
    }
    // Persist the outcome and gap before finishing the inbox. A blocked item is
    // evaluated but remains outside the strict applied prefix.
    batch.push(gated(`UPDATE assistant_capture_inbox SET application_state=? WHERE ${originScopeSql} AND sequence=? AND $gate`, state, ...keys, sequence));
    const prefix = (unresolved: string) => `COALESCE((SELECT MAX(i.sequence) FROM assistant_capture_inbox i
      WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=? AND i.sequence<COALESCE(
        (SELECT MIN(u.sequence) FROM assistant_capture_inbox u WHERE u.installation_id=? AND u.generation=?
          AND u.source_epoch=? AND u.source_generation=? AND ${unresolved}),9223372036854775807)),0)`;
    batch.push(gated(`INSERT INTO assistant_materialization_progress(installation_id,generation,source_epoch,source_generation,evaluated_sequence)
      SELECT ?,?,?,?,${prefix("u.application_state='pending'")} WHERE $gate
      ON CONFLICT(installation_id,generation,source_epoch,source_generation) DO UPDATE SET evaluated_sequence=excluded.evaluated_sequence`, ...keys, ...keys, ...keys));
    batch.push(gated(`UPDATE assistant_capture_streams SET applied_sequence=${prefix("u.application_state<>'applied'")}
      WHERE ${originScopeSql} AND $gate`, ...keys, ...keys, ...keys));
    batch.push(this.sql(`UPDATE assistant_materialization_results SET state=?,last_gap_reason=COALESCE(?,last_gap_reason),next_retry_at=? WHERE token=? AND state='admitted'`,
      state, observed.reason, state === "blocked" ? now + 1000 : null, token));
    if (JSON.stringify(scopeKeys(activeOrigin(this.getScope))) !== JSON.stringify(keys)) return { sequence, state: "stale" };
    try { await this.db.batch(batch); } catch { throw new Error("materialization_commit_uncertain"); }
    const outcome = await this.sql(`SELECT state FROM assistant_materialization_results WHERE token=?`, token).first<{ state: string }>();
    return { sequence, state: outcome?.state ?? "stale", ...(ref.sourceKind === "conversation" ? {} : { canonicalId }) };
  }
  async progress() {
    const keys = scopeKeys(activeOrigin(this.getScope));
    const row = await this.sql(`SELECT s.read_sequence AS received,s.applied_sequence AS applied,COALESCE(p.evaluated_sequence,0) AS evaluated,
      (SELECT COUNT(*) FROM assistant_capture_inbox i WHERE i.installation_id=s.installation_id AND i.generation=s.generation
        AND i.source_epoch=s.source_epoch AND i.source_generation=s.source_generation AND i.application_state='blocked') AS gaps
      FROM assistant_capture_streams s LEFT JOIN assistant_materialization_progress p ON p.installation_id=s.installation_id AND p.generation=s.generation
      AND p.source_epoch=s.source_epoch AND p.source_generation=s.source_generation
      WHERE s.installation_id=? AND s.generation=? AND s.source_epoch=? AND s.source_generation=?`, ...keys).first();
    return row ?? { received: 0, applied: 0, evaluated: 0, gaps: 0 };
  }
}
