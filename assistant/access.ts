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
type Row = {
  id: string; revision: number; version: number; content_hash: string; audience: Audience; origin: string;
  conversation_id: string | null; project_id: string | null; original_text: string | null;
  author_id: string | null; author_label: string | null; occurred_at: number;
  policy_revision?: number; policy_mode?: string;
  person_id?: string; proof_source_id?: string; proof_source_revision?: number;
  mandate_version?: number; mandate_expires_at?: number;
};
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
    this.scope = Object.freeze({ ...scope });
  }
  async read(actor: TrustedActor, id: string, expectedRevision?: number): Promise<SourceRead | null> {
    actor = Object.freeze({ ...actor });
    if (actor.kind === "extractor") return null;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return null;
    const keys = [this.scope.installationId, this.scope.generation, id, expectedRevision ?? null, expectedRevision ?? null];
    const current = `s.installation_id=? AND s.generation=? AND s.id=? AND (? IS NULL OR s.revision=?) AND s.status='active'`;
    let row: Row | null;
    if (actor.kind === "owner") {
      row = await this.db.prepare(`SELECT ${sourceColumns} FROM assistant_sources s ${versionJoin} WHERE ${current}`).bind(...keys).first<Row>();
    } else {
      // Select the latest mandate before testing its state, dates or permissions.
      row = await this.db.prepare(`SELECT ${sourceColumns},COALESCE(p.revision,0) AS policy_revision,
        COALESCE(p.effective_mode,CASE WHEN ?='private' THEN 'attend' ELSE 'ignore' END) AS policy_mode,
        i.person_id,i.proof_source_id,i.proof_source_revision,m.version AS mandate_version,m.expires_at AS mandate_expires_at
        FROM assistant_sources s ${versionJoin}
        LEFT JOIN assistant_conversation_modes p ON p.installation_id=s.installation_id AND p.generation=s.generation AND p.conversation_id=?
        LEFT JOIN assistant_provider_identities i ON i.installation_id=s.installation_id AND i.generation=s.generation AND i.provider=? AND i.address=?
        LEFT JOIN assistant_sources proof ON proof.installation_id=i.installation_id AND proof.generation=i.generation AND proof.id=i.proof_source_id
          AND proof.status='active' AND proof.revision=i.proof_source_revision
        LEFT JOIN assistant_mandates m ON m.installation_id=s.installation_id AND m.generation=s.generation AND m.id=?
          AND m.version=(SELECT MAX(latest.version) FROM assistant_mandates latest WHERE latest.installation_id=m.installation_id
            AND latest.generation=m.generation AND latest.id=m.id)
        WHERE ${current} AND COALESCE(p.kind,?)=?
        AND COALESCE(p.effective_mode,CASE WHEN ?='private' THEN 'attend' ELSE 'ignore' END)<>'ignore'
        AND (s.audience='public' OR (s.audience='restricted' AND (
          (s.origin='whatsapp' AND s.conversation_id=?) OR
          (proof.id IS NOT NULL AND m.conversation_id=? AND m.project_id IS s.project_id
            AND m.status='active' AND m.issued_at<=? AND m.expires_at>?
            AND EXISTS(SELECT 1 FROM assistant_mandate_actions a WHERE a.installation_id=m.installation_id AND a.generation=m.generation
              AND a.mandate_id=m.id AND a.mandate_version=m.version AND a.action=?)
            AND EXISTS(SELECT 1 FROM assistant_mandate_sources ms WHERE ms.installation_id=m.installation_id AND ms.generation=m.generation
              AND ms.mandate_id=m.id AND ms.mandate_version=m.version AND ms.source_id=s.id)))))`)
        .bind(actor.conversationKind, actor.conversationId, actor.provider, actor.address, actor.mandateId ?? null, ...keys,
          actor.conversationKind, actor.conversationKind, actor.conversationKind, actor.conversationId, actor.conversationId,
          this.clock(), this.clock(), actor.action).first<Row>();
    }
    if (!row) return null;
    const needsMandate = actor.kind === "interlocutor" && row.audience === "restricted"
      && !(row.origin === "whatsapp" && row.conversation_id === actor.conversationId);
    const fence: SourceFence = {
      ...this.scope,
      actor: actor.kind === "owner" ? "owner" : JSON.stringify([actor.provider, actor.address, actor.conversationId, actor.conversationKind, actor.action, actor.mandateId ?? null]),
      source: { id: row.id, revision: row.revision, version: row.version, hash: row.content_hash, audience: row.audience,
        origin: row.origin, conversationId: row.conversation_id, projectId: row.project_id },
      policy: actor.kind === "owner" ? null : { conversationId: actor.conversationId, kind: actor.conversationKind, revision: row.policy_revision!, mode: row.policy_mode! },
      identity: needsMandate ? { personId: row.person_id!, proofId: row.proof_source_id!, proofRevision: row.proof_source_revision! } : null,
      mandate: needsMandate ? { id: actor.kind === "interlocutor" ? actor.mandateId! : "", version: row.mandate_version!, expiresAt: row.mandate_expires_at!, action: actor.kind === "interlocutor" ? actor.action : "" } : null,
    };
    return { id: row.id, text: row.original_text, authorId: row.author_id, authorLabel: row.author_label, occurredAt: row.occurred_at, fence };
  }
  async revalidate(actor: TrustedActor, fence: SourceFence) {
    if (fence.installationId !== this.scope.installationId || fence.generation !== this.scope.generation) return false;
    const read = await this.read(actor, fence.source.id, fence.source.revision);
    return !!read && JSON.stringify(read.fence) === JSON.stringify(fence);
  }
}
