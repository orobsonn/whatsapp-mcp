import type { TrustedActor } from "./access";
export type SourceScope = Readonly<{ installationId: string; generation: string }>;
export type Audience = "owner" | "restricted" | "public";
export type SourceRef = { id: string; revision: number; version: number };
export type SourceInput = {
  originKey: string; text: string; authorId?: string; authorLabel?: string; occurredAt: number;
  title?: string; audience?: Audience; projectId?: string; conversationId?: string;
};
export async function sourceTextHash(text: string) {
  if (typeof text !== "string") throw new Error("invalid_source_text");
  if (new TextEncoder().encode(text).length > 32768) throw new Error("source_text_too_large");
  return sha256(text);
}
async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
function integer(value: number, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error("invalid_source_revision_or_time");
}
function label(value: string | undefined, maximum = 512) {
  if (value !== undefined && (typeof value !== "string" || value.length > maximum)) throw new Error("invalid_source_metadata");
  return value ?? null;
}
function audience(value: Audience) {
  if (!["owner", "restricted", "public"].includes(value)) throw new Error("invalid_source_audience");
  return value;
}
// The authenticated adapter supplies this actor; source text never selects it.
// This internal controller does not claim HTTP authentication (#46).
export class SourceController {
  private readonly scope: SourceScope;
  private readonly actor: TrustedActor;
  constructor(private readonly db: D1Database, scope: SourceScope, actor: TrustedActor, private readonly clock = Date.now) {
    if (!scope.installationId || !scope.generation) throw new Error("invalid_source_scope");
    this.scope = Object.freeze({ ...scope });
    this.actor = Object.freeze({ ...actor });
  }
  private owner() { if (this.actor.kind !== "owner") throw new Error("owner_required"); }
  private statement(query: string, ...values: (string | number | null)[]) { return this.db.prepare(query).bind(...values); }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  async create(input: SourceInput): Promise<SourceRef> {
    // Own every scalar before hashing yields, so body, metadata and hash agree.
    input = { ...input };
    this.owner(); integer(input.occurredAt); integer(this.clock());
    if (!input.originKey || !label(input.originKey)) throw new Error("invalid_source_metadata");
    const contentHash = await sourceTextHash(input.text);
    const metadata = [label(input.title), label(input.conversationId), label(input.projectId), audience(input.audience ?? "owner"),
      label(input.authorId), label(input.authorLabel), input.occurredAt];
    const requestHash = await sha256(JSON.stringify([contentHash, ...metadata]));
    const [title, conversation, project, visibility, authorId, authorLabel] = metadata;
    const id = crypto.randomUUID();
    const keys = this.keys();
    await this.db.batch([
      this.statement(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,title,conversation_id,project_id,audience)
        VALUES(?,?,?,'owner_note',?,?,?,?,?) ON CONFLICT(installation_id,generation,origin,origin_key) DO NOTHING`,
      ...keys, id, input.originKey, title, conversation, project, visibility),
      this.statement(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,author_id,author_label,original_text,content_hash,occurred_at)
        SELECT installation_id,generation,id,1,?,?,?,?,? FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?`,
      authorId, authorLabel, input.text, contentHash, input.occurredAt, ...keys, id),
      this.statement(`INSERT INTO assistant_source_admissions SELECT installation_id,generation,id,? FROM assistant_sources
        WHERE installation_id=? AND generation=? AND id=?`, requestHash, ...keys, id),
      this.statement(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
        SELECT installation_id,generation,id,1,1,'created',? FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?`, this.clock(), ...keys, id),
    ]);
    const row = await this.statement(`SELECT s.id,s.revision,s.current_version AS version,a.request_hash FROM assistant_sources s
      JOIN assistant_source_admissions a ON a.installation_id=s.installation_id AND a.generation=s.generation AND a.source_id=s.id
      WHERE s.installation_id=? AND s.generation=? AND s.origin='owner_note' AND s.origin_key=?`, ...keys, input.originKey)
      .first<SourceRef & { request_hash: string }>();
    if (!row || row.request_hash !== requestHash) throw new Error("source_origin_conflict");
    return { id: row.id, revision: row.revision, version: row.version };
  }
  private change(id: string, expected: number, kind: string, now: number) {
    return this.statement(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
      SELECT installation_id,generation,id,revision,current_version,?,? FROM assistant_sources
      WHERE installation_id=? AND generation=? AND id=? AND revision=? ON CONFLICT DO NOTHING`, kind, now, ...this.keys(), id, expected + 1);
  }
  async correct(id: string, expected: number, input: { text: string; occurredAt: number }): Promise<SourceRef> {
    input = { ...input };
    this.owner(); integer(expected, 1); integer(input.occurredAt); integer(this.clock());
    const hash = await sourceTextHash(input.text);
    const results = await this.db.batch([
      this.statement(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,author_id,author_label,original_text,content_hash,occurred_at)
        SELECT s.installation_id,s.generation,s.id,s.current_version+1,v.author_id,v.author_label,?,?,?
        FROM assistant_sources s JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation
        AND v.source_id=s.id AND v.version=s.current_version
        WHERE s.installation_id=? AND s.generation=? AND s.id=? AND s.revision=? AND s.status='active'`, input.text, hash, input.occurredAt, ...this.keys(), id, expected),
      this.statement(`UPDATE assistant_sources SET revision=revision+1,current_version=current_version+1
        WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active' RETURNING id,revision,current_version AS version`, ...this.keys(), id, expected),
      this.change(id, expected, "corrected", this.clock()),
    ]);
    const changed = results[1].results[0] as SourceRef | undefined;
    if (!changed) throw new Error("source_revision_conflict");
    return changed;
  }
  async changeAudience(id: string, expected: number, visibility: Audience) {
    this.owner(); audience(visibility);
    return this.update(id, expected, "access_changed", "audience=?", [visibility]);
  }
  async withdraw(id: string, expected: number) {
    this.owner();
    return this.update(id, expected, "withdrawn", "status='withdrawn'", []);
  }
  private async update(id: string, expected: number, kind: string, assignment: string, values: string[]) {
    integer(expected, 1); integer(this.clock());
    const result = await this.db.batch([
      this.statement(`UPDATE assistant_sources SET revision=revision+1,${assignment}
        WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active' RETURNING id,revision,current_version AS version`, ...values, ...this.keys(), id, expected),
      this.change(id, expected, kind, this.clock()),
    ]);
    const changed = result[0].results[0] as SourceRef | undefined;
    if (!changed) throw new Error("source_revision_conflict");
    return changed;
  }
}
