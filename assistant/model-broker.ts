import { z } from "zod";
import { InferenceBudget, type BudgetScope } from "./budget";
import { SourceAccess, type AccessGuard, type SourceFence } from "./access";
import { bridgeHash } from "./ingress";
import { retentionExecutionGuard, assertRetentionExecution } from "./retention-execution";
export type ModelPath = "/v1/chat/completions" | "/v1/embeddings";
export type BrokerConfig = { extractionConfig: string; priceVersion: string; chatModel: string; embeddingModel: string;
  maxOutputTokens: number; chatCeiling: number; embeddingCeiling: number };
export type ModelAdapter = (request: Readonly<{ path: ModelPath; body: string; signal: AbortSignal }>) => Promise<{ status: number; body: string; actualUnits: number }>;
// Host-only admission. Statements and the model receipt share one transaction;
// callers supply no SQL through messages, Flue metadata or model responses.
export interface ModelAdmission {
  prepare(request: Readonly<{ key: string; hash: string; recovered: boolean }>): Promise<{ guard: AccessGuard; statements: D1PreparedStatement[] } | null>;
  uncertain(): Promise<void>;
}
type Result = { state: string; body?: unknown; operationKey?: string };
type Receipt = { state: string; response_json: string | null; actual_units: number | null };
const owner = { kind: "owner" } as const;
const ns = "installation_id=? AND generation=?";
const bytes = (value: string) => new TextEncoder().encode(value).length;
const safeInteger = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
/** One canonical configuration identity shared by admission and private projections. */
export function brokerConfigurationHash(config:BrokerConfig){return bridgeHash(canonical(config));}

// JSON is copied and bounded before hashing yields; the adapter receives an immutable string.
function normalize(path: string, payload: unknown, config: BrokerConfig): { path: ModelPath; body: string } {
  try {
    const raw = JSON.stringify(payload); if (!raw || bytes(raw) > 65536) throw 0;
    const input = JSON.parse(raw);
    let value: Record<string, unknown>;
    if (path === "/v1/chat/completions") {
      const count = z.number().int().positive().max(config.maxOutputTokens);
      const parsed = z.object({ model: z.literal(config.chatModel), messages: z.array(z.object({
        role: z.enum(["system", "user", "assistant", "developer"]), content: z.string(),
      }).strict()).min(1).max(64), max_tokens: count.optional(), max_completion_tokens: count.optional(),
      temperature: z.number().min(0).max(2).optional(), stream: z.literal(false).optional(), n: z.literal(1).optional(),
      response_format: z.union([z.object({ type: z.literal("json_object") }).strict(), z.object({ type: z.literal("json_schema"),
        json_schema: z.object({ name: z.string().min(1).max(256), schema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict(),
      }).strict()]).optional(),
      }).strict().parse(input);
      if (parsed.max_tokens !== undefined && parsed.max_completion_tokens !== undefined) throw 0;
      const { max_tokens, max_completion_tokens, stream: _stream, n: _n, ...rest } = parsed;
      value = { ...rest, max_completion_tokens: max_completion_tokens ?? max_tokens ?? config.maxOutputTokens };
    } else if (path === "/v1/embeddings") {
      value = z.object({ model: z.literal(config.embeddingModel), input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(4)]),
        dimensions: z.literal(1536).default(1536), encoding_format: z.literal("float").default("float"),
      }).strict().parse(input);
    } else throw 0;
    const body = JSON.stringify(canonical(value)); if (bytes(body) > 65536) throw 0;
    return { path, body };
  } catch { throw new Error("broker_invalid_request"); }
}
function response(request: { path: ModelPath; body: string }, body: string): string {
  if (typeof body !== "string" || bytes(body) > 262144) throw 0;
  const integer = z.number().int().nonnegative().safe(), usage = z.object({ prompt_tokens: integer,
    total_tokens: integer, completion_tokens: integer.optional() }).optional();
  const input = JSON.parse(body); if (input.error !== undefined) throw 0;
  if (request.path === "/v1/chat/completions") return JSON.stringify(z.object({
    choices: z.array(z.object({ index: integer.optional(), message: z.object({ role: z.literal("assistant").optional(), content: z.string() }),
      finish_reason: z.string().nullable().optional() })).length(1), usage,
  }).parse(input));
  const count = JSON.parse(request.body).input;
  const value = z.object({ data: z.array(z.object({ index: integer, embedding: z.array(z.number().finite()).length(1536) }))
    .length(Array.isArray(count) ? count.length : 1), usage }).parse(input);
  if (!value.data.every((item, index) => item.index === index)) throw 0;
  return JSON.stringify(value);
}

/** Host-only Cognee broker: no HTTP endpoint, network transport or provider secrets. */
export class CogneeModelBroker {
  private readonly scope: Readonly<BudgetScope>;
  private readonly config: Readonly<BrokerConfig>;
  private readonly configHash: Promise<string>;
  private readonly budget: InferenceBudget;
  private readonly access: SourceAccess;
  constructor(private readonly db: D1Database, scope: BudgetScope, config: BrokerConfig,
    private readonly adapter: ModelAdapter, private readonly clock = Date.now, private readonly admission?: ModelAdmission) {
    this.scope = Object.freeze({ ...scope }); this.config = Object.freeze({ ...config });
    if (!Object.values(this.config).every(value => typeof value === "number" || (typeof value === "string" && value.length > 0 && value.length <= 256)) ||
      !safeInteger(config.maxOutputTokens, 1) || config.maxOutputTokens > 6000 || !safeInteger(config.chatCeiling, 1) || !safeInteger(config.embeddingCeiling, 1)) throw new Error("broker_invalid_configuration");
    this.configHash = brokerConfigurationHash(this.config); this.budget = new InferenceBudget(db, this.scope);
    this.access = new SourceAccess(db, this.scope, clock);
  }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  async issuePermit(sourceId: string, revision: number, expiresAt: number): Promise<string> {
    if (!safeInteger(expiresAt) || expiresAt <= this.clock() || expiresAt > this.clock() + 3600000) throw new Error("broker_denied");
    const source = await this.access.read(owner, sourceId, revision); if (!source) throw new Error("broker_denied");
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
    const tokenHash = await bridgeHash(token), configHash = await this.configHash;
    const guard = this.access.guard(owner, source.fence, this.clock()), execution = retentionExecutionGuard(this.scope);
    const inserted = await this.db.prepare(`INSERT INTO assistant_model_permits
      SELECT ?,?,?,?,?,?,? WHERE ? > ? AND ${guard.sql} AND ${execution.sql} RETURNING token_hash`)
      .bind(...this.keys(), tokenHash, sourceId, JSON.stringify(source.fence), configHash, expiresAt, expiresAt, this.clock(), ...guard.values, ...execution.values).all();
    if (inserted.results.length !== 1) throw new Error("broker_denied"); return token;
  }
  private async permit(token: string): Promise<{ tokenHash: string; fence: SourceFence }> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("broker_denied");
    const tokenHash = await bridgeHash(token);
    const row = await this.db.prepare(`SELECT fence_json FROM assistant_model_permits WHERE ${ns} AND token_hash=? AND config_hash=? AND expires_at>?`)
      .bind(...this.keys(), tokenHash, await this.configHash, this.clock()).first<{ fence_json: string }>();
    if (!row) throw new Error("broker_denied");
    const fence = JSON.parse(row.fence_json) as SourceFence, guard = this.access.guard(owner, fence, this.clock());
    if (!await this.db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()) throw new Error("broker_denied");
    return { tokenHash, fence };
  }
  private receipt(key: string) {
    return this.db.prepare(`SELECT state,response_json,actual_units FROM assistant_model_receipts WHERE ${ns} AND operation_key=?`)
      .bind(...this.keys(), key).first<Receipt>();
  }
  private async currentReceipt(key: string, hash: string, token: string, expected: Receipt, additional?: AccessGuard) {
    const permit = await this.permit(token), guard = this.access.guard(owner, permit.fence, this.clock()), execution = retentionExecutionGuard(this.scope);
    // Last local snapshot: a purged body cannot escape from an earlier JS copy
    // while its unrelated anchor source/permit remains active.
    return this.db.prepare(`SELECT response_json FROM assistant_model_receipts WHERE ${ns} AND operation_key=? AND request_hash=? AND state='complete' AND response_json IS ? AND actual_units IS ?
      AND EXISTS(SELECT 1 FROM assistant_model_permits WHERE ${ns} AND token_hash=? AND config_hash=? AND expires_at>?) AND (${guard.sql}) AND (${execution.sql}) ${additional ? `AND (${additional.sql})` : ""}`)
      .bind(...this.keys(), key, hash, expected.response_json, expected.actual_units, ...this.keys(), permit.tokenHash, await this.configHash, this.clock(), ...guard.values, ...execution.values, ...(additional?.values ?? [])).first<{ response_json: string }>();
  }
  private async requestKey(fence: SourceFence, request: { path: ModelPath; body: string }) {
    const configHash = await this.configHash, requestHash = await bridgeHash([configHash, request.path, request.body]);
    const key = "cognee:" + await bridgeHash([...this.keys(), fence.source.id, fence.source.revision,
      fence.source.version, fence.source.hash, configHash, requestHash]);
    return { key, requestHash, configHash };
  }
  /** Reconstruction capability: exact completed receipts only. Deliberately
   * never calls recover(), budget methods or the network adapter. */
  async replay(token: string, path: string, payload: unknown): Promise<Result> {
    const request = Object.freeze(normalize(path, payload, this.config)), permit = await this.permit(token);
    const { key, requestHash } = await this.requestKey(permit.fence, request), row = await this.receipt(key);
    if (!row || row.state !== "complete" || row.actual_units === null || row.response_json === null) return { state: "blocked", operationKey: key };
    let body: unknown;
    try { body = JSON.parse(response(request, row.response_json)); }
    catch { return { state: "blocked", operationKey: key }; }
    if (!await this.currentReceipt(key, requestHash, token, row)) return { state: "blocked", operationKey: key };
    return { state: "complete", operationKey: key, body };
  }
  private async recover(key: string, hash: string, token: string): Promise<Result> {
    const row = await this.receipt(key);
    if (!row || row.actual_units === null) return { state: "uncertain", operationKey: key };
    try {
      await this.budget.settle(key, hash, row.actual_units!);
      if (row.state === "uncertain") return { state: "uncertain", operationKey: key };
      await this.db.prepare(`UPDATE assistant_model_receipts SET state='complete' WHERE ${ns} AND operation_key=? AND state='response_ready'`)
        .bind(...this.keys(), key).run();
    } catch { return { state: "uncertain", operationKey: key }; }
    // Settlement preserves paid truth; returning content still needs a current permit/source.
    const current = await this.currentReceipt(key, hash, token, row);
    return current ? { state: "complete", operationKey: key, body: JSON.parse(current.response_json) } : { state: "uncertain", operationKey: key };
  }
  private async uncertainAdmission(key: string): Promise<Result> {
    // A failed latch write still returns no body and performs no adapter call.
    // The host's persistent exclusive call slot remains occupied for recovery.
    await this.admission?.uncertain();
    return { state: "uncertain", operationKey: key };
  }
  private async recoveredAdmission(key: string, hash: string, token: string, request: { path: ModelPath; body: string }): Promise<Result> {
    try {
      const row = await this.receipt(key);
      if (!row || row.state !== "complete" || row.actual_units === null || row.response_json === null) return this.uncertainAdmission(key);
      const settled = await this.db.prepare(`SELECT 1 FROM assistant_budget_reservations WHERE ${ns} AND operation_key=? AND request_hash=? AND state='settled' AND actual_units=?`)
        .bind(...this.keys(), key, hash, row.actual_units).first();
      if (!settled) return this.uncertainAdmission(key);
      const host = await this.admission!.prepare({ key, hash, recovered: true });
      if (!host) return this.uncertainAdmission(key);
      const result = await this.db.batch([...host.statements, this.db.prepare(`SELECT 1 WHERE ${host.guard.sql}`).bind(...host.guard.values)]);
      if (result.at(-1)!.results.length !== 1) return this.uncertainAdmission(key);
      const current = await this.currentReceipt(key, hash, token, row, host.guard);
      if (!current) return this.uncertainAdmission(key);
      return { state: "complete", operationKey: key, body: JSON.parse(response(request, current.response_json)) };
    } catch { return this.uncertainAdmission(key); }
  }
  async invoke(token: string, path: string, payload: unknown, jobAlias?: string): Promise<Result> {
    const request = Object.freeze(normalize(path, payload, this.config));
    if (jobAlias !== undefined && (typeof jobAlias !== "string" || jobAlias.length > 256)) throw new Error("broker_invalid_request");
    const permit = await this.permit(token), { key, requestHash, configHash } = await this.requestKey(permit.fence, request);
    if (await this.receipt(key)) return this.admission ? this.recoveredAdmission(key, requestHash, token, request) : this.recover(key, requestHash, token);
    let reserved;
    try { reserved = await this.budget.reserve(key, requestHash, path === "/v1/embeddings" ? this.config.embeddingCeiling : this.config.chatCeiling); }
    catch (error) {
      if (error instanceof Error && ["budget_exhausted", "budget_blocked"].includes(error.message)) throw new Error("broker_budget_exhausted");
      return this.admission ? this.uncertainAdmission(key) : { state: "uncertain", operationKey: key };
    }
    // The reservation CAS owns the sole attempt. A prior reservation is never a retry permit.
    if (!reserved.created) return this.admission ? this.recoveredAdmission(key, requestHash, token, request) : this.recover(key, requestHash, token);
    const guard = this.access.guard(owner, permit.fence, this.clock()), execution = retentionExecutionGuard(this.scope);
    let admitted;
    try {
      const host = this.admission ? await this.admission.prepare({ key, hash: requestHash, recovered: false }) : null;
      if (this.admission && !host) return this.uncertainAdmission(key);
      const statement = this.db.prepare(`INSERT INTO assistant_model_receipts
        (installation_id,generation,operation_key,request_hash,source_id,source_revision,config_hash,state,created_at)
        SELECT ?,?,?,?,?,?,?,'attempting',? WHERE ${guard.sql} AND ${execution.sql} AND EXISTS(SELECT 1 FROM assistant_model_permits
          WHERE ${ns} AND token_hash=? AND config_hash=? AND expires_at>?) ${host ? `AND (${host.guard.sql})` : ""} ON CONFLICT DO NOTHING RETURNING operation_key`)
        .bind(...this.keys(), key, requestHash, permit.fence.source.id, permit.fence.source.revision, configHash, this.clock(),
          ...guard.values, ...execution.values, ...this.keys(), permit.tokenHash, configHash, this.clock(), ...(host?.guard.values ?? []));
      admitted = host ? (await this.db.batch([...host.statements, statement])).at(-1)! : await statement.all();
    } catch { return this.admission ? this.uncertainAdmission(key) : { state: "uncertain", operationKey: key }; }
    if (admitted.results.length !== 1) {
      if (this.admission) return this.uncertainAdmission(key);
      throw new Error("broker_denied");
    }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, knownActual: number | undefined;
    try {
      await assertRetentionExecution(this.db, this.scope);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("broker_timeout")); }, 45000);
      });
      const result = await Promise.race([this.adapter(Object.freeze({ ...request, signal: controller.signal })), deadline]);
      if (safeInteger(result.actualUnits)) knownActual = result.actualUnits;
      if (result.status !== 200 || knownActual === undefined) throw 0;
      const body = response(request, result.body);
      const saved = await this.db.prepare(`UPDATE assistant_model_receipts SET state='response_ready',response_json=?,actual_units=?
        WHERE ${ns} AND operation_key=? AND state='attempting' RETURNING operation_key`).bind(body, knownActual, ...this.keys(), key).all();
      // A retention purge can remove the payload receipt while an already paid
      // attempt is in flight. Never recreate it; keep financial truth in #37.
      if (saved.results.length !== 1) {
        await this.budget.settle(key, requestHash, knownActual);
        return this.admission ? this.uncertainAdmission(key) : { state: "uncertain", operationKey: key };
      }
    } catch {
      await Promise.allSettled([
        this.db.prepare(`UPDATE assistant_model_receipts SET state='uncertain',actual_units=? WHERE ${ns} AND operation_key=? AND state='attempting'`).bind(knownActual ?? null, ...this.keys(), key).run(),
        knownActual === undefined ? this.budget.uncertain(key) : this.budget.settle(key, requestHash, knownActual),
      ]);
      return this.admission ? this.uncertainAdmission(key) : { state: "uncertain", operationKey: key };
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
    const recovered = await this.recover(key, requestHash, token);
    return this.admission && recovered.state !== "complete" ? this.uncertainAdmission(key) : recovered;
  }
}
