import { z } from "zod";
import { SourceAccess, type AccessGuard } from "./access";
import type { AssistantEnv } from "./env";
import { bridgeHash } from "./ingress";
import { DEFAULT_BROKER_CONFIG } from "./model-transport";
import { retentionExecutionGuard } from "./retention-execution";

const id = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const onceScope = z.object({ installationId: id, generation: id, sourceEpoch: id, sourceGeneration: id }).strict();
export type OnceScope = z.infer<typeof onceScope>;
export const onceReceipt = z.object({
  kind: z.literal("owner_once.plan"), id: hash, scope: onceScope, requestHash: hash,
  sourceId: id, expectedRevision: integer.min(1), projectId: id, queryHash: hash, jobId: id,
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), createdAt: integer, deadlineAt: integer,
  maxCostMicroUsd: integer.min(1).max(600000), capMicroUsd: integer.min(1).max(600000), configHash: hash,
  corpus: z.object({ sourceCount: integer.min(1).max(24), utf8Bytes: integer.max(24000),
    refs: z.array(z.object({ id, revision: integer.min(1), version: integer.min(1), fingerprintHash: hash }).strict()).min(1).max(24),
  }).strict(),
}).strict();
export type OnceReceipt = z.infer<typeof onceReceipt>;
export const onceKey = (id: string) => `owner-once-v1:${id}`;
export const onceAdmitKey = (id: string) => `owner-once-admit-v1:${id}`;
export const onceAdmittedReceipt = z.object({ kind: z.literal("owner_once.admit"), id: hash, scope: onceScope,
  planHash: hash, admittedAt: integer }).strict();
/** Internal service grant. It never enters prompts, tool responses or status. */
export const onceGrant = z.object({ id: hash, token: z.string().uuid() }).strict();
export type OnceGrant = z.infer<typeof onceGrant>;
export type OncePlanReader = (id: string) => Promise<{ receipt: OnceReceipt; grant: OnceGrant } | null>;
/** Historical completion only; review freshness belongs to the existing diary.
 * Kept free of native runtime imports for local operational adapters. */
export async function completedOwnerOnce(env: AssistantEnv, scope: OnceScope, receipt: OnceReceipt) {
  return env.DB!.prepare(`SELECT d.id FROM assistant_jobs j JOIN assistant_job_ledger l
    ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
    JOIN assistant_shadow_decisions d ON d.installation_id=j.installation_id AND d.generation=j.generation AND d.job_id=j.id
    JOIN assistant_episodes e ON e.installation_id=d.installation_id AND e.generation=d.generation AND e.id=d.episode_id
    WHERE j.installation_id=? AND j.generation=? AND j.id=? AND j.dedupe_key=? AND j.state='shadow_completed'
    AND e.state='settled' AND d.request_hash=l.request_hash AND d.binding_hash=e.binding_hash AND d.proposal_json=e.result_json
    AND d.proposal_json IS NOT NULL AND d.publication_nonce=e.search_nonce AND d.publication_nonce IS NOT NULL`)
    .bind(scope.installationId, scope.generation, receipt.jobId, onceKey(receipt.id)).first<string>("id");
}
export const oncePeriod = (now: number) => new Date(now).toISOString().slice(0, 10);

/** This configuration contains no credential values or source text. It pins the
 * fixed host contract; command bodies cannot select providers, actors or modes. */
export async function onceConfiguration(env: AssistantEnv, scope: OnceScope) {
  if (!env.DB || !env.COGNEE || !env.OPENAI_API_KEY || env.FLUE_EPISODES_ENABLED !== "shadow"
    || env.ROUTINES_ENABLED !== "shadow" || env.ROUTINES_PAUSED !== "true" || env.SEMANTIC_SEARCH_MODE !== "required"
    || env.INSTALLATION_ID !== scope.installationId || env.OPERATIONAL_GENERATION !== scope.generation
    || env.BRIDGE_SOURCE_EPOCH !== scope.sourceEpoch || env.BRIDGE_SOURCE_GENERATION !== scope.sourceGeneration)
    throw new Error("owner_once_configuration");
  return bridgeHash(["owner-once-config-v1", scope, DEFAULT_BROKER_CONFIG, env.FLUE_EPISODES_ENABLED,
    env.ROUTINES_ENABLED, env.ROUTINES_PAUSED, env.SEMANTIC_SEARCH_MODE, env.MEDIA_CONTEXT_ENABLED ?? null,
    env.RETENTION_GENERATION_SEAL ?? null, env.RETENTION_GENERATION_SEAL_REQUIRED ?? null,
    env.COGNEE.idFromName(JSON.stringify(["cognee", scope.installationId, scope.generation])).toString()]);
}
type InventoryRow = { id: string; revision: number; version: number; fingerprint: string; origin: string;
  audience: string; original_text: string | null; bytes: number };

/** Raw inventory fingerprints contain private catalog text. They exist only in
 * transient query parameters; durable receipts contain their SHA256 digests. */
export async function onceInventory(db: D1Database, scope: OnceScope, projectId: string, now: number) {
  const authorized = new SourceAccess(db, scope).inventory({ kind: "owner" }, projectId, now, { ...scope, includePaused: true });
  // Ingestion may add relations/media. Those are fenced by RetrievalRuns when
  // used; they cannot invalidate the original-source authority that admits the
  // ingestion itself. Preserve every conversation, origin and Owner catalog pin.
  const inventory = { sql: `SELECT facts.*,json_array(facts.id,facts.revision,facts.version,facts.content_hash,
      facts.audience,facts.origin,facts.conversation_id,facts.project_id,'owner',facts.conversations,facts.inboxes,
      facts.origins,facts.owner_catalog_state,facts.owner_mission_state,p.name,r.revision) AS once_fingerprint
    FROM (${authorized.sql}) facts JOIN assistant_projects p ON p.installation_id=? AND p.generation=? AND p.id=facts.project_id
    LEFT JOIN assistant_project_revisions r ON r.installation_id=p.installation_id AND r.generation=p.generation AND r.project_id=p.id`,
    values: [...authorized.values, scope.installationId, scope.generation] };
  const rows = (await db.prepare(`SELECT id,revision,version,once_fingerprint AS fingerprint,origin,audience,original_text,
    LENGTH(CAST(original_text AS BLOB)) AS bytes FROM (${inventory.sql}) ORDER BY id LIMIT 25`)
    .bind(...inventory.values).all<InventoryRow>()).results;
  if (!rows.length || rows.length > 24 || rows.some(row => row.origin !== "owner_note" || row.audience !== "owner" || row.original_text === null)
    || rows.reduce((sum, row) => sum + row.bytes, 0) > 24000) throw new Error("owner_once_corpus");
  const refs = await Promise.all(rows.map(async row => ({ id: row.id, revision: row.revision, version: row.version,
    fingerprintHash: await bridgeHash(row.fingerprint) })));
  const corpus = { sourceCount: rows.length, utf8Bytes: rows.reduce((sum, row) => sum + row.bytes, 0), refs };
  const transient = JSON.stringify(rows.map(row => ({ id: row.id, fingerprint: row.fingerprint })));
  if (new TextEncoder().encode(transient).length > 32768) throw new Error("owner_once_manifest_capacity");
  const guard: AccessGuard = { sql: `EXISTS(WITH live AS MATERIALIZED (${inventory.sql}) SELECT 1
    WHERE (SELECT COUNT(*) FROM live)=? AND NOT EXISTS(SELECT 1 FROM live l WHERE NOT EXISTS(
      SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.id')=l.id AND json_extract(e.value,'$.fingerprint')=l.once_fingerprint))
    AND (SELECT SUM(LENGTH(CAST(original_text AS BLOB))) FROM live)=?
    AND NOT EXISTS(SELECT 1 FROM live WHERE origin<>'owner_note' OR audience<>'owner' OR original_text IS NULL))`,
    values: [...inventory.values, rows.length, transient, corpus.utf8Bytes] };
  return { corpus, guard };
}

export function onceBudgetGuard(scope: OnceScope, period: string, cap: number): AccessGuard {
  return { sql: `EXISTS(SELECT 1 FROM assistant_budget_accounts a WHERE a.installation_id=? AND a.generation=?
    AND a.period=? AND a.cap_units=? AND NOT EXISTS(SELECT 1 FROM assistant_budget_accounts b
      WHERE b.installation_id=a.installation_id AND b.generation=a.generation AND b.blocked=1)
    AND a.cap_units>COALESCE((SELECT SUM(CASE WHEN r.state='settled' THEN r.actual_units ELSE r.ceiling_units END)
      FROM assistant_budget_reservations r WHERE r.installation_id=a.installation_id AND r.generation=a.generation AND r.period=a.period),0))`,
    values: [scope.installationId, scope.generation, period, cap] };
}
export function combineOnceGuards(...guards: AccessGuard[]): AccessGuard {
  return { sql: guards.map(g => `(${g.sql})`).join(" AND "), values: guards.flatMap(g => g.values) };
}
export async function currentOnceGuard(env: AssistantEnv, receipt: OnceReceipt, now: number): Promise<AccessGuard> {
  if (now >= receipt.deadlineAt || now < receipt.createdAt || oncePeriod(now) !== receipt.period
    || await onceConfiguration(env, receipt.scope) !== receipt.configHash) throw new Error("owner_once_expired_or_changed");
  const current = await onceInventory(env.DB!, receipt.scope, receipt.projectId, now);
  if (JSON.stringify(current.corpus) !== JSON.stringify(receipt.corpus)) throw new Error("owner_once_corpus_changed");
  return combineOnceGuards(current.guard, onceBudgetGuard(receipt.scope, receipt.period, receipt.capMicroUsd), retentionExecutionGuard(receipt.scope));
}

export function oncePlanGuard(receipt: OnceReceipt): AccessGuard {
  return { sql: `EXISTS(SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=?
    AND operation_id=? AND request_hash=? AND result_json=?)`, values: [receipt.scope.installationId, receipt.scope.generation,
    onceKey(receipt.id), receipt.requestHash, JSON.stringify(receipt)] };
}
export async function readOnceGrant(env: AssistantEnv, receipt: OnceReceipt): Promise<OnceGrant | null> {
  const row = await env.DB!.prepare(`SELECT request_hash,result_json,token FROM assistant_owner_commands
    WHERE installation_id=? AND generation=? AND operation_id=?`).bind(receipt.scope.installationId, receipt.scope.generation,
    onceAdmitKey(receipt.id)).first<{ request_hash: string; result_json: string; token: string }>();
  if (!row) return null;
  const admitted = onceAdmittedReceipt.parse(JSON.parse(row.result_json)), planHash = await bridgeHash(receipt);
  if (admitted.id !== receipt.id || admitted.planHash !== planHash || row.request_hash !== planHash
    || JSON.stringify(admitted.scope) !== JSON.stringify(receipt.scope) || admitted.admittedAt < receipt.createdAt
    || admitted.admittedAt >= receipt.deadlineAt) throw new Error("owner_once_admission_receipt");
  return onceGrant.parse({ id: receipt.id, token: row.token });
}
export async function readOncePlan(env: AssistantEnv, scope: OnceScope, id: string): Promise<OnceReceipt | null> {
  hash.parse(id);
  const row = await env.DB!.prepare(`SELECT request_hash,result_json FROM assistant_owner_commands
    WHERE installation_id=? AND generation=? AND operation_id=?`).bind(scope.installationId, scope.generation, onceKey(id))
    .first<{ request_hash: string; result_json: string }>();
  if (!row) return null;
  const receipt = onceReceipt.parse(JSON.parse(row.result_json));
  if (receipt.id !== id || receipt.requestHash !== row.request_hash || JSON.stringify(receipt.scope) !== JSON.stringify(scope))
    throw new Error("owner_once_receipt_scope");
  return receipt;
}
/** Composition-only reader; no new RPC grants authority from a known root ID.
 * Recovery reads preserve the original token even after execution expires. */
export function oncePlanReader(env: AssistantEnv): OncePlanReader | undefined {
  const scope = onceScope.safeParse({ installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION,
    sourceEpoch: env.BRIDGE_SOURCE_EPOCH, sourceGeneration: env.BRIDGE_SOURCE_GENERATION });
  if (!scope.success || !env.DB) return undefined;
  return async id => {
    const receipt = await readOncePlan(env, scope.data, id);
    if (!receipt) return null;
    const grant = await readOnceGrant(env, receipt);
    return grant ? { receipt, grant } : null;
  };
}
/** Resolve authority from the original two receipts, then fence the live corpus
 * in the protected batch. An operation ID or a new ledger instance is no grant. */
export async function onceAuthority(env: AssistantEnv, scope: OnceScope, raw: OnceGrant, now: number) {
  const grant = onceGrant.parse(raw), receipt = await readOncePlan(env, scope, grant.id);
  if (!receipt) throw new Error("owner_once_plan_missing");
  const durable = await readOnceGrant(env, receipt);
  if (!durable || durable.token !== grant.token) throw new Error("owner_once_not_admitted");
  const current = await currentOnceGuard(env, receipt, now);
  const guard = combineOnceGuards(current, oncePlanGuard(receipt), { sql: `EXISTS(SELECT 1 FROM assistant_owner_commands
    WHERE installation_id=? AND generation=? AND operation_id=? AND token=? AND request_hash=?)`,
    values: [scope.installationId, scope.generation, onceAdmitKey(grant.id), grant.token, await bridgeHash(receipt)] });
  return { receipt, guard };
}
