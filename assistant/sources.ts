import { z } from "zod";
import type { TrustedActor } from "./access";
import { bridgeHash } from "./ingress";
import { CommandLedger, type CommandValue } from "./command-ledger";
import type { SourceRetirementGuard } from "./retention-authority";
import { WithdrawalBarrier } from "./retention-barrier";
export type SourceScope = Readonly<{
    installationId: string;
    generation: string;
}>;
export type Audience = "owner" | "restricted" | "public";
export type SourceRef = {
    id: string;
    revision: number;
    version: number;
};
export type SourceInput = {
    originKey: string;
    text: string;
    authorId?: string;
    authorLabel?: string;
    occurredAt: number;
    title?: string;
    audience?: Audience;
    projectId?: string;
    conversationId?: string;
};
const id = z.string().min(1).max(256), labelSchema = z.string().max(512);
const time = z.number().int().nonnegative().safe(), revision = z.number().int().min(1).max(2147483646);
const visibility = z.enum(["owner", "restricted", "public"]);
const inputSchema = z.object({ originKey: labelSchema.min(1), text: z.string().max(32768), occurredAt: time,
    authorId: labelSchema.optional(), authorLabel: labelSchema.optional(), title: labelSchema.optional(),
    audience: visibility.default("owner"), projectId: labelSchema.optional(), conversationId: labelSchema.optional() }).strict();
export const sourceCommandSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source.create"), operationId: id, input: inputSchema }).strict(),
    z.object({ kind: z.literal("source.correct"), operationId: id, id, expectedRevision: revision, text: z.string().max(32768), occurredAt: time }).strict(),
    z.object({ kind: z.literal("source.change_audience"), operationId: id, id, expectedRevision: revision, audience: visibility }).strict(),
    z.object({ kind: z.literal("source.withdraw"), operationId: id, id, expectedRevision: revision }).strict(),
]);
export type SourceCommand = z.input<typeof sourceCommandSchema>;
export type SourceCommandReceipt = SourceRef & {
    operationId: string;
    kind: SourceCommand["kind"];
    shadow: true;
};
export async function sourceTextHash(text: string) {
    if (typeof text !== "string")
        throw new Error("invalid_source_text");
    if (text.length > 32768 || new TextEncoder().encode(text).length > 32768)
        throw new Error("source_text_too_large");
    return sha256(text);
}
async function sha256(text: string) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
function integer(value: number, min = 0) {
    if (!Number.isSafeInteger(value) || value < min)
        throw new Error("invalid_source_revision_or_time");
}
function label(value: string | undefined, maximum = 512) {
    if (value !== undefined && (typeof value !== "string" || value.length > maximum))
        throw new Error("invalid_source_metadata");
    return value ?? null;
}
function audience(value: Audience) {
    if (!["owner", "restricted", "public"].includes(value))
        throw new Error("invalid_source_audience");
    return value;
}
type Statement = (sql: string, ...values: CommandValue[]) => D1PreparedStatement;
/** Internal host API: the authenticated adapter supplies the principal. Text is data. */
export class SourceController {
    private readonly scope: SourceScope;
    private readonly actor: TrustedActor;
    constructor(private readonly db: D1Database, scope: SourceScope, actor: TrustedActor, private readonly clock = Date.now, private readonly retirement?: SourceRetirementGuard) {
        if (!scope.installationId || !scope.generation)
            throw new Error("invalid_source_scope");
        this.scope = Object.freeze({ ...scope });
        this.actor = Object.freeze({ ...actor });
    }
    private owner() { if (this.actor.kind !== "owner")
        throw new Error("owner_required"); }
    private statement = (query: string, ...values: CommandValue[]) => this.db.prepare(query).bind(...values);
    private plain: Statement = (query, ...values) => this.statement(query.replaceAll("$gate", "1"), ...values);
    private keys() { return [this.scope.installationId, this.scope.generation]; }
    private async retirementCheck(id: string, expected: number) {
        if (!this.retirement) return;
        const row = await this.statement(`SELECT origin,origin_key,revision,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?`, ...this.keys(), id)
            .first<{ origin: string; origin_key: string; revision: number; status: string }>();
        if (!row || row.revision !== expected || row.status !== 'active') throw new Error("source_revision_conflict");
        await this.retirement.allow(row.origin, row.origin_key, id);
    }
    private async prepared(input: SourceInput) {
        integer(input.occurredAt);
        if (!input.originKey || !label(input.originKey))
            throw new Error("invalid_source_metadata");
        const metadata = [label(input.title), label(input.conversationId), label(input.projectId), audience(input.audience ?? "owner"),
            label(input.authorId), label(input.authorLabel), input.occurredAt];
        const contentHash = await sourceTextHash(input.text);
        return { input, metadata, contentHash, requestHash: await sha256(JSON.stringify([contentHash, ...metadata])) };
    }
    private creation(s: Statement, id: string, data: Awaited<ReturnType<SourceController["prepared"]>>, now: number) {
        const { input, metadata, contentHash, requestHash } = data, [title, conversation, project, visibility, authorId, authorLabel] = metadata, keys = this.keys();
        return [
            s(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,title,conversation_id,project_id,audience)
        SELECT ?,?,?,'owner_note',?,?,?,?,? WHERE $gate ON CONFLICT(installation_id,generation,origin,origin_key) DO NOTHING`, ...keys, id, input.originKey, title, conversation, project, visibility),
            s(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,author_id,author_label,original_text,content_hash,occurred_at)
        SELECT installation_id,generation,id,1,?,?,?,?,? FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND $gate`, authorId, authorLabel, input.text, contentHash, input.occurredAt, ...keys, id),
            s(`INSERT INTO assistant_source_admissions SELECT installation_id,generation,id,? FROM assistant_sources
        WHERE installation_id=? AND generation=? AND id=? AND $gate`, requestHash, ...keys, id),
            s(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
        SELECT installation_id,generation,id,1,1,'created',? FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND $gate`, now, ...keys, id),
        ];
    }
    private origin(key: string) {
        return this.statement(`SELECT s.id,s.revision,s.current_version AS version,a.request_hash FROM assistant_sources s
      JOIN assistant_source_admissions a ON a.installation_id=s.installation_id AND a.generation=s.generation AND a.source_id=s.id
      WHERE s.installation_id=? AND s.generation=? AND s.origin='owner_note' AND s.origin_key=?`, ...this.keys(), key)
            .first<SourceRef & {
            request_hash: string;
        }>();
    }
    async create(input: SourceInput): Promise<SourceRef> {
        input = { ...input };
        this.owner();
        const now = this.clock();
        integer(now);
        const data = await this.prepared(input);
        await this.retirement?.allow('owner_note', input.originKey);
        await this.db.batch(this.creation(this.plain, crypto.randomUUID(), data, now));
        const row = await this.origin(input.originKey);
        if (!row || row.request_hash !== data.requestHash)
            throw new Error("source_origin_conflict");
        return { id: row.id, revision: 1, version: 1 };
    }
    private change(s: Statement, id: string, expected: number, kind: string, now: number) {
        return s(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
      SELECT installation_id,generation,id,revision,current_version,?,? FROM assistant_sources
      WHERE installation_id=? AND generation=? AND id=? AND revision=? AND changes()=1 AND $gate`, kind, now, ...this.keys(), id, expected + 1);
    }
    private correction(s: Statement, id: string, expected: number, input: {
        text: string;
        occurredAt: number;
    }, hash: string, now: number) {
        return [s(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,author_id,author_label,original_text,content_hash,occurred_at)
      SELECT s.installation_id,s.generation,s.id,s.current_version+1,v.author_id,v.author_label,?,?,?
      FROM assistant_sources s JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation
      AND v.source_id=s.id AND v.version=s.current_version WHERE s.installation_id=? AND s.generation=? AND s.id=?
      AND s.revision=? AND s.status='active' AND s.origin='owner_note' AND $gate`, input.text, hash, input.occurredAt, ...this.keys(), id, expected),
            s(`UPDATE assistant_sources SET revision=revision+1,current_version=current_version+1
      WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active' AND origin='owner_note' AND $gate
      RETURNING id,revision,current_version AS version`, ...this.keys(), id, expected), this.change(s, id, expected, "corrected", now)];
    }
    async correct(id: string, expected: number, input: {
        text: string;
        occurredAt: number;
    }): Promise<SourceRef> {
        input = { ...input };
        this.owner();
        integer(expected, 1);
        integer(input.occurredAt);
        const now = this.clock();
        integer(now);
        const hash = await sourceTextHash(input.text);
        await this.retirementCheck(id, expected);
        const results = await this.db.batch(this.correction(this.plain, id, expected, input, hash, now));
        const changed = results[1].results[0] as SourceRef | undefined;
        if (!changed)
            throw new Error("source_revision_conflict");
        return changed;
    }
    private updatePlan(s: Statement, id: string, expected: number, kind: string, assignment: string, values: string[], now: number) {
        return [s(`UPDATE assistant_sources SET revision=revision+1,${assignment} WHERE installation_id=? AND generation=? AND id=?
      AND revision=? AND status='active' AND $gate RETURNING id,revision,current_version AS version`, ...values, ...this.keys(), id, expected), this.change(s, id, expected, kind, now)];
    }
    async changeAudience(id: string, expected: number, visibility: Audience) { this.owner(); audience(visibility); return this.update(id, expected, "access_changed", "audience=?", [visibility]); }
    async withdraw(id: string, expected: number) { this.owner(); integer(expected, 1); const now = this.clock(); integer(now); return new WithdrawalBarrier(this.db, this.scope, this.retirement).direct(id, expected, now); }
    private async update(id: string, expected: number, kind: string, assignment: string, values: string[]) {
        integer(expected, 1);
        const now = this.clock();
        integer(now);
        const result = await this.db.batch(this.updatePlan(this.plain, id, expected, kind, assignment, values, now));
        const changed = result[0].results[0] as SourceRef | undefined;
        if (!changed)
            throw new Error("source_revision_conflict");
        return changed;
    }
    async execute(input: unknown): Promise<SourceCommandReceipt> {
        this.owner(); // Zod owns nested scalars synchronously, before hashing yields.
        const item = sourceCommandSchema.parse(input), requestHash = await bridgeHash(item), ledger = new CommandLedger(this.db, this.scope, item.operationId, requestHash);
        const previous = await ledger.recover<SourceCommandReceipt>();
        if (previous)
            return previous;
        const now = this.clock();
        integer(now);
        if (item.kind === 'source.withdraw') {
            const barrier = new WithdrawalBarrier(this.db, this.scope, this.retirement), ref = await barrier.begin(item.id, item.expectedRevision, item.operationId, requestHash, now);
            const result: SourceCommandReceipt = { ...ref, operationId: item.operationId, kind: item.kind, shadow: true };
            await this.db.batch([ledger.admit(result, now, `EXISTS(SELECT 1 FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=? AND operation_id=? AND request_hash=?)`, [...this.keys(), item.id, item.operationId, requestHash]), barrier.finish(item.id, item.operationId, requestHash)]);
            const receipt = await ledger.recover<SourceCommandReceipt>(); if (!receipt) throw new Error("retention_withdraw_uncertain"); return receipt;
        }
        const s: Statement = (query, ...values) => ledger.statement(query, ...values);
        let batch: D1PreparedStatement[];
        if (item.kind === 'source.create') {
            const data = await this.prepared(item.input), existing = await this.origin(item.input.originKey);
            await this.retirement?.allow('owner_note', item.input.originKey);
            if (existing && existing.request_hash !== data.requestHash)
                throw new Error("source_origin_conflict");
            const condition = `NOT EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=? AND generation=? AND origin='owner_note' AND origin_key=?)
        OR EXISTS(SELECT 1 FROM assistant_sources s JOIN assistant_source_admissions a ON a.installation_id=s.installation_id AND a.generation=s.generation AND a.source_id=s.id
        WHERE s.installation_id=? AND s.generation=? AND s.origin='owner_note' AND s.origin_key=? AND a.request_hash=?)`;
            batch = [ledger.admit({}, now, condition, [...this.keys(), item.input.originKey, ...this.keys(), item.input.originKey, data.requestHash]),
                ...this.creation(s, crypto.randomUUID(), data, now),
                // Resolve a concurrent origin alias inside the admitting transaction.
                s(`UPDATE assistant_owner_commands SET result_json=(SELECT json_object('operationId',?,'kind',?,'id',id,'revision',1,'version',1,'shadow',json('true'))
          FROM assistant_sources WHERE installation_id=? AND generation=? AND origin='owner_note' AND origin_key=?)
          WHERE installation_id=? AND generation=? AND operation_id=? AND $gate`, item.operationId, item.kind, ...this.keys(), item.input.originKey, ...this.keys(), item.operationId)];
        }
        else {
            const row = await this.statement(`SELECT id,revision,current_version AS version FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?`, ...this.keys(), item.id).first<SourceRef>();
            if (!row)
                throw new Error("source_revision_conflict");
            await this.retirementCheck(item.id, item.expectedRevision);
            const result: SourceCommandReceipt = { operationId: item.operationId, kind: item.kind, id: item.id, revision: item.expectedRevision + 1, version: row.version + (item.kind === 'source.correct' ? 1 : 0), shadow: true };
            // A future expectedRevision must not make a previously read version
            // valid after somebody else's correction wins before this batch.
            batch = [ledger.admit(result, now, `EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active' AND current_version=? ${item.kind === 'source.correct' ? "AND origin='owner_note'" : ""})`, [...this.keys(), item.id, item.expectedRevision, row.version])];
            if (item.kind === 'source.correct')
                batch.push(...this.correction(s, item.id, item.expectedRevision, item, await sourceTextHash(item.text), now));
            else
                batch.push(...this.updatePlan(s, item.id, item.expectedRevision, 'access_changed', "audience=?", [item.audience], now));
            // A restored public/restricted audience is historical until this
            // exact fresh owner command wins its CAS. Body edits, legacy
            // revision changes and replay of an old receipt never clear it.
            if (item.kind === 'source.change_audience' && await this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_retention_quarantines'").first())
                batch.push(s(`UPDATE assistant_retention_quarantines SET active=0,reason='owner_confirmed_current_audience'
                  WHERE installation_id=? AND generation=? AND kind='source_authorization' AND source_id=? AND active=1 AND version<=?
                  AND EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=? AND generation=? AND id=? AND revision=? AND status='active' AND audience=?) AND $gate`,
                  ...this.keys(), item.id, item.expectedRevision + 1, ...this.keys(), item.id, item.expectedRevision + 1, item.audience));
        }
        await this.db.batch(batch);
        const receipt = await ledger.recover<SourceCommandReceipt>();
        if (!receipt)
            throw new Error("source_revision_conflict");
        return receipt;
    }
}
