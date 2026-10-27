import {relationAudience,ownerContextStamp} from './relation-visibility';
import type { Audience, SourceScope } from "./sources";
export type TrustedActor = Readonly<{ kind: "owner" }> | Readonly<{ kind: "extractor" }> | Readonly<{
  kind: "interlocutor"; provider: string; address: string; conversationId: string; conversationKind: "private" | "group";
  action: "reply_text" | "reply_audio" | "ask_clarification" | "future_contact" | "read_github" | "read_calendar" | "propose_calendar_change";
  mandateId?: string;
}>;
export type SourceFence = {
  installationId: string; generation: string; actor: string;
  source: { id: string; revision: number; version: number; hash: string; audience: Audience; origin: string; conversationId: string | null; projectId: string | null };
  policy: { conversationId: string; kind: string; revision: number; mode: string } | null;
  identity: { personId: string; proofId: string; proofRevision: number } | null;
  mandate: { id: string; version: number; expiresAt: number; action: string } | null;
};
export type SourceRead = { id: string; text: string | null; authorId: string | null; authorLabel: string | null; occurredAt: number; fence: SourceFence };
export type AccessRow = {
  id: string; revision: number; version: number; content_hash: string; audience: Audience; origin: string;
  conversation_id: string | null; project_id: string | null; original_text: string | null;
  author_id: string | null; author_label: string | null; occurred_at: number;
  policy_revision?: number; policy_mode?: string;
  person_id?: string; proof_source_id?: string; proof_source_revision?: number;
  mandate_version?: number; mandate_expires_at?: number;
};
export type AccessGuard = { sql: string; values: (string | number | null)[] };
const actorKey = (actor: Exclude<TrustedActor, { kind: "extractor" }>) => actor.kind === "owner" ? "owner"
  : JSON.stringify([actor.provider, actor.address, actor.conversationId, actor.conversationKind, actor.action, actor.mandateId ?? null]);
const sourceColumns = `s.id,s.revision,s.current_version AS version,s.audience,s.origin,s.conversation_id,s.project_id,
  v.content_hash,v.original_text,v.author_id,v.author_label,v.occurred_at`;
const versionJoin = `JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation
  AND v.source_id=s.id AND v.version=s.current_version`;

// All actor fields come from a trusted adapter, never a tool's text payload.
// read() selects the current body and its authorization in one SQLite snapshot.
export class SourceAccess {
  private readonly scope: SourceScope;
  constructor(private readonly db: D1Database, scope: SourceScope, private readonly clock = Date.now) {
    if (!scope.installationId || !scope.generation) throw new Error("invalid_source_scope");
    this.scope = Object.freeze({ installationId: scope.installationId, generation: scope.generation });
  }
  private current(actor: TrustedActor, id: string | null, expectedRevision: number | undefined, now: number): AccessGuard | null {
    if (actor.kind === "extractor") return null;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return null;
    const keys = [this.scope.installationId, this.scope.generation, ...(id === null ? [] : [id]), expectedRevision ?? null, expectedRevision ?? null];
    const current = `s.installation_id=? AND s.generation=?${id === null ? '' : ' AND s.id=?'} AND (? IS NULL OR s.revision=?) AND s.status='active'
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=s.installation_id AND (b.source_id=s.id OR (b.origin=s.origin AND b.origin_key=s.origin_key)))
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=s.installation_id AND q.generation=s.generation AND q.kind='origin_source' AND q.source_id=s.id AND q.active=1)
      AND NOT EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=s.installation_id AND g.state='quiescing')`;

    if (actor.kind === "owner") {
      return { sql: `SELECT ${sourceColumns} FROM assistant_sources s ${versionJoin} WHERE ${current}`, values: keys };
    } else {
      // Select the latest mandate before testing its state, dates or permissions.
      return { sql: `SELECT ${sourceColumns},COALESCE(p.revision,0) AS policy_revision,
        COALESCE(p.effective_mode,CASE WHEN ?='private' THEN 'attend' ELSE 'ignore' END) AS policy_mode,
        i.person_id,i.proof_source_id,i.proof_source_revision,m.version AS mandate_version,m.expires_at AS mandate_expires_at
        FROM assistant_sources s ${versionJoin}
        LEFT JOIN assistant_conversation_modes p ON p.installation_id=s.installation_id AND p.generation=s.generation AND p.conversation_id=?
        LEFT JOIN assistant_provider_identities i ON i.installation_id=s.installation_id AND i.generation=s.generation AND i.provider=? AND i.address=?
          AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=i.installation_id AND q.generation=i.generation AND q.kind='provider_identity' AND q.provider=i.provider AND q.address=i.address AND q.active=1)
        LEFT JOIN assistant_sources proof ON proof.installation_id=i.installation_id AND proof.generation=i.generation AND proof.id=i.proof_source_id
          AND proof.status='active' AND proof.revision=i.proof_source_revision
          AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=proof.installation_id AND (b.source_id=proof.id OR (b.origin=proof.origin AND b.origin_key=proof.origin_key)))
          AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=proof.installation_id AND q.generation=proof.generation AND q.kind='origin_source' AND q.source_id=proof.id AND q.active=1)
        LEFT JOIN assistant_mandates m ON m.installation_id=s.installation_id AND m.generation=s.generation AND m.id=?
          AND m.version=(SELECT MAX(latest.version) FROM assistant_mandates latest WHERE latest.installation_id=m.installation_id
            AND latest.generation=m.generation AND latest.id=m.id)
        WHERE ${current} AND COALESCE(p.kind,?)=?
        AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=s.installation_id AND q.generation=s.generation AND q.kind='source_authorization' AND q.source_id=s.id AND q.active=1)
        AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=p.installation_id AND q.generation=p.generation AND q.kind='policy' AND q.conversation_id=p.conversation_id AND q.version=p.revision AND q.active=1)
        AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=m.installation_id AND q.generation=m.generation AND q.kind='mandate' AND q.mandate_id=m.id AND q.version=m.version AND q.active=1)
        AND COALESCE(p.effective_mode,CASE WHEN ?='private' THEN 'attend' ELSE 'ignore' END)<>'ignore'
        AND (s.audience='public' OR (s.audience='restricted' AND (
          (s.origin='whatsapp' AND s.conversation_id=?) OR
          (proof.id IS NOT NULL AND m.conversation_id=? AND m.project_id IS s.project_id
            AND m.status='active' AND m.issued_at<=? AND m.expires_at>?
            AND EXISTS(SELECT 1 FROM assistant_mandate_actions a WHERE a.installation_id=m.installation_id AND a.generation=m.generation
              AND a.mandate_id=m.id AND a.mandate_version=m.version AND a.action=?)
            AND EXISTS(SELECT 1 FROM assistant_mandate_sources ms WHERE ms.installation_id=m.installation_id AND ms.generation=m.generation
              AND ms.mandate_id=m.id AND ms.mandate_version=m.version AND ms.source_id=s.id)))))`, values: [actor.conversationKind, actor.conversationId, actor.provider, actor.address, actor.mandateId ?? null, ...keys,
          actor.conversationKind, actor.conversationKind, actor.conversationKind, actor.conversationId, actor.conversationId,
          now, now, actor.action] };
    }
  }
  /** Host SQL snapshot used by private context proofs; no caller permission SQL. */
  ownerRows(now=this.clock()):AccessGuard{return this.current({kind:'owner'},null,undefined,now)!;}
  async read(actor: TrustedActor, id: string, expectedRevision?: number, now = this.clock()): Promise<SourceRead | null> {
    actor = Object.freeze({ ...actor });
    const query = this.current(actor, id, expectedRevision, now);
    if (!query || actor.kind === "extractor") return null;
    const row = await this.db.prepare(query.sql).bind(...query.values).first<AccessRow>();
    if (!row) return null;
    return this.fromRow(actor, row);
  }
  /** Host-only bounded read batch. Each statement retains read()'s exact ACL
   * and bind parameters; D1.batch is one API call, not one broad permission. */
  async readMany(actor: TrustedActor, refs: { id: string; revision: number }[], now = this.clock()): Promise<(SourceRead | null)[]> {
    if (refs.length > 6) throw new Error("source_read_batch_limit");
    actor = Object.freeze({ ...actor }); refs = refs.map(ref => ({ ...ref }));
    if (!refs.length) return [];
    const queries = refs.map(ref => this.current(actor, ref.id, ref.revision, now));
    if (queries.some(query => !query) || actor.kind === "extractor") return refs.map(() => null);
    const rows = await this.db.batch<AccessRow>(queries.map(query => this.db.prepare(query!.sql).bind(...query!.values)));
    if (rows.length !== refs.length) throw new Error("source_read_batch_result");
    return rows.map(row => row.results[0] ? this.fromRow(actor, row.results[0]) : null);
  }
  fromRow(actor: TrustedActor, row: AccessRow): SourceRead {
    if (actor.kind === "extractor") throw new Error("source_access_denied");
    const needsMandate = actor.kind === "interlocutor" && row.audience === "restricted"
      && !(row.origin === "whatsapp" && row.conversation_id === actor.conversationId);
    const fence: SourceFence = {
      ...this.scope,
      actor: actorKey(actor),
      source: { id: row.id, revision: row.revision, version: row.version, hash: row.content_hash, audience: row.audience,
        origin: row.origin, conversationId: row.conversation_id, projectId: row.project_id },
      policy: actor.kind === "owner" ? null : { conversationId: actor.conversationId, kind: actor.conversationKind, revision: row.policy_revision!, mode: row.policy_mode! },
      identity: needsMandate ? { personId: row.person_id!, proofId: row.proof_source_id!, proofRevision: row.proof_source_revision! } : null,
      mandate: needsMandate ? { id: actor.kind === "interlocutor" ? actor.mandateId! : "", version: row.mandate_version!, expiresAt: row.mandate_expires_at!, action: actor.kind === "interlocutor" ? actor.action : "" } : null,
    };
    return { id: row.id, text: row.original_text, authorId: row.author_id, authorLabel: row.author_label, occurredAt: row.occurred_at, fence };
  }
  /** Internal authorized inventory: no caller-supplied permission expression.
   * Fingerprints include authorization, local pause/origin and extraction state;
   * bodies remain outside the persistent search manifest. Origin bindings have
   * a UNIQUE canonical_id. Seventeen relation refs detect the scorer's overflow
   * (maximum sixteen batches), without copying an unbounded extraction list. */
  inventory(actor: TrustedActor, projectId: string | undefined, now: number, control: { sourceEpoch?: string; sourceGeneration?: string; includePaused?: boolean } = {}): AccessGuard {
    const query = this.current(actor, null, undefined, now),relations=relationAudience(actor,'b',this.ownerRows(now));
    if (!query) return { sql: "SELECT NULL AS id,NULL AS fingerprint WHERE 0", values: [] };
    const authority = actor.kind === "owner" ? "'owner'" : "json_array(policy_revision,policy_mode,person_id,proof_source_id,proof_source_revision,mandate_version,mandate_expires_at)";
    const keys = [this.scope.installationId, this.scope.generation],ownerMeta=actor.kind==='owner'?ownerContextStamp(this.scope,this.ownerRows(now),control):null;
    return { sql: `WITH visible AS (${query.sql}), facts AS (
      SELECT visible.*,${ownerMeta?`${ownerMeta.sql} owner_catalog_state,(SELECT json_group_array(json_array(m.id,m.revision,m.state,m.project_id,m.objective,p.name,r.revision)) FROM assistant_missions m LEFT JOIN assistant_projects p ON p.installation_id=m.installation_id AND p.generation=m.generation AND p.id=m.project_id LEFT JOIN assistant_project_revisions r ON r.installation_id=p.installation_id AND r.generation=p.generation AND r.project_id=p.id WHERE m.installation_id=? AND m.generation=? AND m.source_id=visible.id AND m.source_revision=visible.revision) owner_mission_state,`:""}
       (SELECT json_group_array(json_array(source_epoch,source_generation,chat_id,revision,paused,applied_sequence,policy_revision,mode,coverage_from,received,gaps,watermark,access_state,current_kind,current_policy_kind,current_policy_revision,current_mode,unapplied)) FROM (
        SELECT o.source_epoch,o.source_generation,o.chat_id,c.revision,c.paused,c.applied_sequence,c.policy_revision,c.mode,c.coverage_from,o.watermark,o.access_state,o.kind AS current_kind,p.kind AS current_policy_kind,COALESCE(p.revision,0) AS current_policy_revision,
         COALESCE(p.effective_mode,CASE WHEN o.kind='private' THEN 'attend' ELSE 'ignore' END) AS current_mode,
         (SELECT COUNT(*) FROM assistant_capture_inbox u WHERE u.installation_id=o.installation_id AND u.generation=o.generation AND u.source_epoch=o.source_epoch AND u.source_generation=o.source_generation AND u.chat_id=o.chat_id AND u.application_state<>'applied') unapplied,
         (SELECT COALESCE(MAX(sequence),0) FROM assistant_capture_inbox i WHERE i.installation_id=o.installation_id AND i.generation=o.generation AND i.source_epoch=o.source_epoch AND i.source_generation=o.source_generation AND i.chat_id=o.chat_id) received,
         (SELECT COUNT(*) FROM assistant_conversation_replay r WHERE r.installation_id=o.installation_id AND r.generation=o.generation AND r.source_epoch=o.source_epoch AND r.source_generation=o.source_generation AND r.chat_id=o.chat_id AND r.state='gap') gaps
        FROM assistant_origin_conversations o LEFT JOIN assistant_conversations c ON c.installation_id=o.installation_id AND c.generation=o.generation AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id
        LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
        WHERE o.installation_id=? AND o.generation=? AND (o.chat_id=? OR o.chat_id=visible.conversation_id)
        AND (? IS NULL OR (o.source_epoch=? AND o.source_generation=?)) ORDER BY o.source_epoch,o.source_generation,o.chat_id)) conversations,
       (SELECT json_group_array(json_array(source_epoch,source_generation,chat_id,received,unapplied)) FROM (
        SELECT source_epoch,source_generation,chat_id,MAX(sequence) received,SUM(CASE WHEN application_state<>'applied' THEN 1 ELSE 0 END) unapplied
        FROM assistant_capture_inbox WHERE installation_id=? AND generation=? AND (chat_id=? OR chat_id=visible.conversation_id)
        AND (? IS NULL OR (source_epoch=? AND source_generation=?)) GROUP BY source_epoch,source_generation,chat_id ORDER BY source_epoch,source_generation,chat_id)) inboxes,
       (SELECT json_group_array(json_array(o.source_epoch,o.source_generation,o.source_kind,o.source_id,o.chat_id,o.watermark,o.observation_hash,o.tombstoned,c.watermark,c.kind,c.access_state,p.revision,p.effective_mode))
        FROM assistant_source_origins o LEFT JOIN assistant_origin_conversations c ON c.installation_id=o.installation_id AND c.generation=o.generation AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id
        LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
        WHERE o.installation_id=? AND o.generation=? AND o.canonical_id=visible.id) origins,
       (SELECT json_group_array(json_array(operation_key,request_hash)) FROM (SELECT operation_key,request_hash FROM assistant_relation_batches b WHERE b.installation_id=? AND b.generation=? AND b.source_id=visible.id AND b.source_revision=visible.revision AND b.source_version=visible.version AND b.source_hash=visible.content_hash AND (${relations.sql}) ORDER BY operation_key LIMIT 17)) relations,
       (SELECT json_group_array(json_array(operation_key,text_hash,config_hash,blob_hash)) FROM (SELECT operation_key,text_hash,config_hash,blob_hash FROM assistant_media_artifacts b WHERE b.installation_id=? AND b.generation=? AND b.source_id=visible.id AND b.source_revision=visible.revision AND b.source_version=visible.version AND b.source_hash=visible.content_hash ORDER BY operation_key)) media_artifacts
      FROM visible WHERE (? IS NULL OR project_id=?))
      SELECT facts.*,json_array(id,revision,version,content_hash,audience,origin,conversation_id,project_id,${authority},conversations,inboxes,origins,relations,media_artifacts${ownerMeta?",owner_catalog_state,owner_mission_state":""}) fingerprint
      FROM facts WHERE (?=1 OR NOT EXISTS(SELECT 1 FROM json_each(conversations) c WHERE json_extract(c.value,'$[4]')=1))`,
      values: [...query.values,...(ownerMeta?[...ownerMeta.values,...keys]:[]), ...keys, actor.kind === "interlocutor" ? actor.conversationId : null, control.sourceEpoch ?? null, control.sourceEpoch ?? null, control.sourceGeneration ?? null, ...keys, actor.kind === "interlocutor" ? actor.conversationId : null, control.sourceEpoch ?? null, control.sourceEpoch ?? null, control.sourceGeneration ?? null, ...keys, ...keys, ...relations.values, ...keys, projectId ?? null, projectId ?? null, control.includePaused ? 1 : 0] };
  }
  // Fixed SELECT shared with read(); embed this predicate in the protected mutation.
  guard(actor: TrustedActor, fence: SourceFence, now: number): AccessGuard {
    const deny: AccessGuard = { sql: "0", values: [] };
    if (actor.kind === "extractor" || fence.installationId !== this.scope.installationId
      || fence.generation !== this.scope.generation || fence.actor !== actorKey(actor)) return deny;
    const source = fence.source;
    const query = this.current(actor, source.id, source.revision, now);
    if (!query) return deny;
    const columns = ["id", "revision", "version", "content_hash", "audience", "origin", "conversation_id", "project_id"];
    const values: (string | number | null)[] = [source.id, source.revision, source.version, source.hash,
      source.audience, source.origin, source.conversationId, source.projectId];
    const needsMandate = actor.kind === "interlocutor" && source.audience === "restricted"
      && !(source.origin === "whatsapp" && source.conversationId === actor.conversationId);
    if (actor.kind === "owner") {
      if (fence.policy || fence.identity || fence.mandate) return deny;
    } else {
      if (fence.policy?.conversationId !== actor.conversationId || fence.policy.kind !== actor.conversationKind) return deny;
      columns.push("policy_revision", "policy_mode");
      values.push(fence.policy.revision, fence.policy.mode);
    }
    if (needsMandate && actor.kind === "interlocutor") {
      if (!fence.identity || !fence.mandate || fence.mandate.id !== actor.mandateId || fence.mandate.action !== actor.action) return deny;
      columns.push("person_id", "proof_source_id", "proof_source_revision", "mandate_version", "mandate_expires_at");
      values.push(fence.identity.personId, fence.identity.proofId, fence.identity.proofRevision, fence.mandate.version, fence.mandate.expiresAt);
    } else if (fence.identity || fence.mandate) return deny;
    return { sql: `EXISTS(SELECT 1 FROM (${query.sql}) authorized WHERE ${columns.map((column) => `authorized.${column} IS ?`).join(" AND ")})`,
      values: [...query.values, ...values] };
  }
  async revalidate(actor: TrustedActor, fence: SourceFence) {
    if (fence.installationId !== this.scope.installationId || fence.generation !== this.scope.generation) return false;
    const read = await this.read(actor, fence.source.id, fence.source.revision);
    return !!read && JSON.stringify(read.fence) === JSON.stringify(fence);
  }
}
