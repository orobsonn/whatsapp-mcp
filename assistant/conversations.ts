import {sqlAnd} from './sql-conjunction';
import type { AccessGuard, TrustedActor } from "./access";
import { activeOrigin, originScopeSql, scopeKeys, type OriginScope } from "./origin-guard";
export type ConversationFence = { installationId: string; generation: string; chatId: string; sourceEpoch: string | null; sourceGeneration: string | null;
  revision: number; policyRevision: number; mode: string; applied: number; received: number; coverageFrom: number };
type Frame = { installation_id: string; generation: string; source_epoch: string; source_generation: string; chat_id: string;
  revision: number; paused: number; evaluated_sequence: number; applied_sequence: number; policy_revision: number; mode: string;
  coverage_from: number; current_policy_revision: number; current_mode: string; access_state: string; received: number; gaps: number };
const frameSql = `SELECT c.*,o.access_state,COALESCE(p.revision,0) AS current_policy_revision,
 CASE WHEN p.kind IS NOT NULL AND p.kind<>o.kind THEN 'ignore' ELSE COALESCE(p.effective_mode,CASE WHEN o.kind='private' THEN 'attend' ELSE 'ignore' END) END AS current_mode,
 COALESCE((SELECT MAX(i.sequence) FROM assistant_capture_inbox i WHERE i.installation_id=c.installation_id AND i.generation=c.generation
  AND i.source_epoch=c.source_epoch AND i.source_generation=c.source_generation AND i.chat_id=c.chat_id),0) AS received,
 (SELECT COUNT(*) FROM assistant_conversation_replay r WHERE r.installation_id=c.installation_id AND r.generation=c.generation
  AND r.source_epoch=c.source_epoch AND r.source_generation=c.source_generation AND r.chat_id=c.chat_id AND r.state='gap') AS gaps
 FROM assistant_conversations c JOIN assistant_origin_conversations o ON o.installation_id=c.installation_id AND o.generation=c.generation
 AND o.source_epoch=c.source_epoch AND o.source_generation=c.source_generation AND o.chat_id=c.chat_id
 LEFT JOIN assistant_conversation_modes p ON p.installation_id=c.installation_id AND p.generation=c.generation AND p.conversation_id=c.chat_id`;
const ready = (row: Frame) => !row.paused && row.current_mode !== "ignore" && row.access_state === "available"
  && row.policy_revision === row.current_policy_revision && row.mode === row.current_mode && row.applied_sequence === row.received && row.gaps === 0;
const fence = (row: Frame): ConversationFence => ({ installationId: row.installation_id, generation: row.generation, chatId: row.chat_id,
  sourceEpoch: row.source_epoch, sourceGeneration: row.source_generation, revision: row.revision, policyRevision: row.current_policy_revision,
  mode: row.current_mode, applied: row.applied_sequence, received: row.received, coverageFrom: row.coverage_from });
// A missing target can be used by pre-capture adapters, but any later observed
// conversation invalidates that absence fence. WhatsApp origins require observation.
export async function jobConversationFence(db: D1Database, scope: { installationId: string; generation: string; sourceEpoch?: string; sourceGeneration?: string }, chatId: string, observed: boolean, canonicalId?: string) {
  const nominal = !!scope.sourceEpoch && !!scope.sourceGeneration;
  const keys: (string | number | null)[] = [scope.installationId, scope.generation, chatId];
  if (nominal) keys.push(scope.sourceEpoch!, scope.sourceGeneration!);
  const row = nominal ? await db.prepare(`${frameSql} WHERE c.installation_id=? AND c.generation=? AND c.chat_id=? AND c.source_epoch=? AND c.source_generation=?`).bind(...keys).first<Frame>() : null;
  if (!row) {
    const origin = await db.prepare(`SELECT 1 FROM assistant_origin_conversations WHERE installation_id=? AND generation=? AND chat_id=?${nominal ? " AND source_epoch=? AND source_generation=?" : ""}`).bind(...keys).first();
    if (observed || origin) return null;
    return { installationId: scope.installationId, generation: scope.generation, chatId, sourceEpoch: scope.sourceEpoch ?? null, sourceGeneration: scope.sourceGeneration ?? null,
      revision: 0, policyRevision: 0, mode: "unobserved", applied: 0, received: 0, coverageFrom: 0 };
  }
  if (observed && (!canonicalId || !await db.prepare(`SELECT 1 FROM assistant_source_origins WHERE installation_id=? AND generation=? AND canonical_id=? AND source_epoch=? AND source_generation=?`)
    .bind(scope.installationId, scope.generation, canonicalId, scope.sourceEpoch!, scope.sourceGeneration!).first())) return null;
  return row && ready(row) ? fence(row) : null;
}
type ConversationField=keyof ConversationFence;
function absentConversation(ref:(field:ConversationField)=>string,nominal:boolean){const where=()=>`installation_id=${ref('installationId')} AND generation=${ref('generation')} AND chat_id=${ref('chatId')}${nominal?` AND source_epoch=${ref('sourceEpoch')} AND source_generation=${ref('sourceGeneration')}`:''}`;return `NOT EXISTS(SELECT 1 FROM assistant_conversations WHERE ${where()}) AND NOT EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE ${where()})`;}
function presentConversation(ref:(field:ConversationField)=>string,frames?:'owner_context_frames'){const keys=sqlAnd([`c.installation_id=${ref('installationId')}`,`c.generation=${ref('generation')}`,`c.chat_id=${ref('chatId')}`]);const where=sqlAnd([`source_epoch=${ref('sourceEpoch')}`,`source_generation=${ref('sourceGeneration')}`,`revision=${ref('revision')}`,'paused=0',`current_policy_revision=${ref('policyRevision')}`,'policy_revision=current_policy_revision',`current_mode=${ref('mode')}`,'mode=current_mode',"current_mode<>'ignore'","access_state='available'",`applied_sequence=${ref('applied')}`,`received=${ref('received')}`,`coverage_from=${ref('coverageFrom')}`,'applied_sequence=received','gaps=0']);return `EXISTS(SELECT 1 FROM ${frames?`${frames} c`:`(${frameSql}) c`} WHERE ${keys} AND ${where.replaceAll('current.','c.')})`;}

export function conversationGuard(value:ConversationFence):AccessGuard{const values:(string|number|null)[]=[],ref=(field:ConversationField)=>{values.push(value[field]);return '?';};return {sql:value.revision===0?absentConversation(ref,value.sourceEpoch!==null&&value.sourceGeneration!==null):presentConversation(ref),values};}
/** Same readiness as jobConversationFence(observed=false), for host catalog rows. */
export function conversationEligibleSQL(installation:string,generation:string,chat:string,epoch:string,sourceGeneration:string,frames?:'owner_context_frames'){const ready=sqlAnd([`eligible.installation_id=${installation}`,`eligible.generation=${generation}`,`eligible.chat_id=${chat}`,`eligible.source_epoch=${epoch}`,`eligible.source_generation=${sourceGeneration}`,'paused=0',"current_mode<>'ignore'","access_state='available'",'policy_revision=current_policy_revision','mode=current_mode','applied_sequence=received','gaps=0']);return `(${chat} IS NULL OR (EXISTS(SELECT 1 FROM ${frames??`(${frameSql})`} eligible WHERE ${ready}) OR (NOT EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE installation_id=${installation} AND generation=${generation} AND chat_id=${chat} AND source_epoch=${epoch} AND source_generation=${sourceGeneration}) AND NOT EXISTS(SELECT 1 FROM assistant_conversations WHERE installation_id=${installation} AND generation=${generation} AND chat_id=${chat} AND source_epoch=${epoch} AND source_generation=${sourceGeneration}))))`;}

/** Shared metadata row projection; callers still bind scope and apply readiness. */
export function conversationFrameRowsSQL(){return frameSql;}

function limit(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("conversation_page_limit"); }
export class Conversations {
  private readonly actor: TrustedActor;
  constructor(private readonly db: D1Database, private readonly getScope: () => OriginScope, actor: TrustedActor = { kind: "owner" }) { this.actor = Object.freeze({ ...actor }); }
  private sql(query: string, ...values: (string | number | null)[]) { return this.db.prepare(query).bind(...values); }
  async ensure(chatId: string) {
    if (!chatId || chatId.length > 256) throw new Error("conversation_id");
    const keys = scopeKeys(activeOrigin(this.getScope));
    await this.sql(`INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode)
     SELECT o.installation_id,o.generation,o.source_epoch,o.source_generation,o.chat_id,COALESCE(p.revision,0),
      CASE WHEN p.kind IS NOT NULL AND p.kind<>o.kind THEN 'ignore' ELSE COALESCE(p.effective_mode,CASE WHEN o.kind='private' THEN 'attend' ELSE 'ignore' END) END
     FROM assistant_origin_conversations o LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
     WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.chat_id=? AND o.kind IS NOT NULL ON CONFLICT DO NOTHING`, ...keys, chatId).run();
    return this.read(chatId);
  }
  private read(chatId: string) {
    return this.sql(`${frameSql} WHERE c.installation_id=? AND c.generation=? AND c.source_epoch=? AND c.source_generation=? AND c.chat_id=?`,
      ...scopeKeys(activeOrigin(this.getScope)), chatId).first<Frame>();
  }
  private view(row: Frame, stale = false) {
    return { state: stale ? "stale" : row.paused ? "paused" : row.gaps ? "pending" : row.current_mode === "ignore" ? "ignored" : ready(row) ? "ready" : "pending",
      revision: row.revision, mode: row.current_mode, evaluated: row.evaluated_sequence, applied: row.applied_sequence, received: row.received,
      gaps: row.gaps, coverage: "observed_only", coverageFrom: row.coverage_from };
  }
  async state(chatId: string) { const row = await this.read(chatId); if (!row) throw new Error("conversation_unobserved"); return this.view(row); }
  async fence(chatId: string) { const row = await this.read(chatId); return row && ready(row) ? fence(row) : null; }
  async check(value: ConversationFence) {
    const scope = activeOrigin(this.getScope);
    if (value.installationId !== scope.installationId || value.generation !== scope.generation || value.sourceEpoch !== scope.sourceEpoch || value.sourceGeneration !== scope.sourceGeneration) return false;
    const guard = conversationGuard(value); return !!await this.sql(`SELECT 1 WHERE ${guard.sql}`, ...guard.values).first();
  }
  async setPaused(chatId: string, expectedRevision: number, paused: boolean) {
    if (this.actor.kind !== "owner") throw new Error("owner_required");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof paused !== "boolean") throw new Error("conversation_revision");
    const result = await this.sql(`UPDATE assistant_conversations SET paused=?,revision=revision+1 WHERE ${originScopeSql} AND chat_id=? AND revision=? AND paused<>? RETURNING revision`,
      paused ? 1 : 0, ...scopeKeys(activeOrigin(this.getScope)), chatId, expectedRevision, paused ? 1 : 0).first();
    if (!result) { const row = await this.read(chatId); if (!row || row.revision !== expectedRevision || !!row.paused !== paused) throw new Error("conversation_conflict"); }
    return this.state(chatId);
  }
  async outcomes(chatId: string, after = 0, pageSize = 100) {
    limit(pageSize);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("conversation_cursor");
    return (await this.sql(`SELECT sequence,state,reason,canonical_id,observed_revision,observed_version,observed_watermark,coalesced,authorship,style_eligible
     FROM assistant_conversation_replay WHERE ${originScopeSql} AND chat_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
      ...scopeKeys(activeOrigin(this.getScope)), chatId, after, pageSize).all()).results;
  }
  replay(chatId: string, pageSize = 100) { return this.consume(chatId, pageSize, false); }
  retryGaps(chatId: string, pageSize = 100) { return this.consume(chatId, pageSize, true); }
  private async consume(chatId: string, pageSize: number, retry: boolean) {
    limit(pageSize); const scope = activeOrigin(this.getScope), keys = scopeKeys(scope);
    let row = await this.ensure(chatId); if (!row) throw new Error("conversation_unobserved");
    if (row.policy_revision !== row.current_policy_revision || row.mode !== row.current_mode) {
      await this.sql(`UPDATE assistant_conversations SET revision=revision+1,policy_revision=?,mode=?,coverage_from=MAX(coverage_from,?)
       WHERE ${originScopeSql} AND chat_id=? AND revision=?`, row.current_policy_revision, row.current_mode, row.received, ...keys, chatId, row.revision).run();
      row = (await this.read(chatId))!;
    }
    if (row.paused) return this.view(row);
    const rows = await this.sql(`SELECT i.sequence FROM assistant_capture_inbox i WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=?
     AND i.chat_id=? AND ${retry ? "EXISTS(SELECT 1 FROM assistant_conversation_replay r WHERE r.installation_id=i.installation_id AND r.generation=i.generation AND r.source_epoch=i.source_epoch AND r.source_generation=i.source_generation AND r.chat_id=i.chat_id AND r.sequence=i.sequence AND r.state='gap')" : "i.sequence>?"}
     ORDER BY i.sequence LIMIT ?`, ...keys, chatId, ...(retry ? [] : [row.evaluated_sequence]), pageSize).all<{ sequence: number }>();
    if (!rows.results.length) return this.view(row);
    const evaluated = retry ? row.evaluated_sequence : rows.results.at(-1)!.sequence;
    // CAS gates every projection and the cursor in the same D1 transaction.
    const gate = `EXISTS(SELECT 1 FROM (${frameSql} WHERE c.installation_id=? AND c.generation=? AND c.source_epoch=? AND c.source_generation=? AND c.chat_id=?) g
     WHERE revision=? AND paused=0 AND evaluated_sequence=? AND current_policy_revision=? AND current_mode=?)`;
    const gateValues = [...keys, chatId, row.revision, row.evaluated_sequence, row.current_policy_revision, row.current_mode];
    const ignored = `(?='ignore' OR i.sequence<=?)`;
    const gap = `(i.application_state<>'applied' OR m.state IS NULL OR m.state<>'applied' OR (i.source_kind<>'conversation' AND s.id IS NULL))`;
    const batch = rows.results.map((item) => this.sql(`INSERT INTO assistant_conversation_replay
     SELECT i.installation_id,i.generation,i.source_epoch,i.source_generation,i.chat_id,i.sequence,
      CASE WHEN ${gap} THEN 'gap' WHEN ${ignored} THEN 'ignored' WHEN i.operation='withdraw' OR s.status='withdrawn' THEN 'withdrawn' ELSE 'applied' END,
      CASE WHEN ${gap} THEN COALESCE(m.last_gap_reason,'canonical_pending') WHEN ${ignored} THEN 'outside_attendance_window' ELSE NULL END,
      s.id,s.revision,s.current_version,COALESCE(o.watermark,m.watermark),COALESCE(o.watermark,m.watermark,0)>i.sequence,'unknown',0
     FROM assistant_capture_inbox i LEFT JOIN assistant_materialization_results m ON m.installation_id=i.installation_id AND m.generation=i.generation AND m.source_epoch=i.source_epoch AND m.source_generation=i.source_generation AND m.sequence=i.sequence
     LEFT JOIN assistant_source_origins o ON o.installation_id=i.installation_id AND o.generation=i.generation AND o.source_epoch=i.source_epoch AND o.source_generation=i.source_generation AND o.source_kind=i.source_kind AND o.source_id=i.source_id AND o.chat_id=i.chat_id
     LEFT JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
     WHERE i.installation_id=? AND i.generation=? AND i.source_epoch=? AND i.source_generation=? AND i.chat_id=? AND i.sequence=? AND ${gate}
     ON CONFLICT(installation_id,generation,source_epoch,source_generation,chat_id,sequence) DO UPDATE SET state=excluded.state,reason=excluded.reason,
      canonical_id=excluded.canonical_id,observed_revision=excluded.observed_revision,observed_version=excluded.observed_version,observed_watermark=excluded.observed_watermark,coalesced=excluded.coalesced`,
      row.current_mode, row.coverage_from, row.current_mode, row.coverage_from, ...keys, chatId, item.sequence, ...gateValues));
    batch.push(this.sql(`UPDATE assistant_conversations SET evaluated_sequence=?,applied_sequence=COALESCE((SELECT MAX(r.sequence) FROM assistant_conversation_replay r
     WHERE r.installation_id=? AND r.generation=? AND r.source_epoch=? AND r.source_generation=? AND r.chat_id=? AND r.sequence<=?
     AND r.sequence<COALESCE((SELECT MIN(g.sequence) FROM assistant_conversation_replay g WHERE g.installation_id=r.installation_id AND g.generation=r.generation AND g.source_epoch=r.source_epoch AND g.source_generation=r.source_generation AND g.chat_id=r.chat_id AND g.state='gap'),9223372036854775807)),0),revision=revision+1
     WHERE ${originScopeSql} AND chat_id=? AND ${gate} RETURNING revision`, evaluated, ...keys, chatId, evaluated, ...keys, chatId, ...gateValues));
    if (JSON.stringify(keys) !== JSON.stringify(scopeKeys(activeOrigin(this.getScope)))) return this.view(row, true);
    const result = await this.db.batch(batch);
    if (JSON.stringify(keys) !== JSON.stringify(scopeKeys(activeOrigin(this.getScope)))) return this.view(row, true);
    const current = (await this.read(chatId))!;
    return this.view(current, !result.at(-1)!.results.length);
  }
}
