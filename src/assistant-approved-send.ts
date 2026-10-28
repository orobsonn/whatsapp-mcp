import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "./env";
import { AppError, assertActive, currentFence, safeEqual } from "./core";
import { resolveRuntimeEnv, runtimeConnectionGuard } from "./connection";
import { actionDigest, canonicalEnvelope } from "./send-envelope";
import { resolveSendEnvelope, sendEnvelopeGuard } from "./send-envelope-validation";
import { executeAction, type SendProvider } from "./actions";
import { ZapiClient } from "./zapi";
import {
  approvedSendPrepareInput, approvedSendExecuteInput, approvedSendStatusInput, approvedSendEnvelope,
  type ApprovedSendScope, type ApprovedSendPrepared, type ApprovedSendReceipt, type ApprovedSendActuatorRPC,
} from "./approved-send-contract";
const ns = "s.installation_id=? AND s.generation=? AND s.source_epoch=? AND s.source_generation=?";
const keys = (scope: ApprovedSendScope) => [scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration];
const targetSchema = z.object({ chatId: z.string(), name: z.string(), address: z.string(), kind: z.enum(["individual", "group"]) }).strict();
const authorizationSchema = z.object({ authorized: z.literal(true), actionId: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), approvalId: z.string().min(1).max(256), expiresAt: z.number().int().positive().safe() }).strict();
interface MappedAction {
  action_id: string; hash: string; target_json: string; envelope_json: string; status: string; expires_at: number;
  provider_message_id: string | null; provider_zaap_id: string | null; last_error: string | null;
}
async function authenticate(raw: Env, secret: string, scope: ApprovedSendScope): Promise<Env> {
  if (!raw.ASSISTANT_APPROVED_SEND_SECRET || raw.ASSISTANT_APPROVED_SEND_SECRET.length < 32 || !await safeEqual(raw.ASSISTANT_APPROVED_SEND_SECRET, secret)) throw new AppError("approved_send_denied", 403);
  const env = await resolveRuntimeEnv(raw); assertActive(env); const fence = currentFence(env);
  if (scope.installationId !== env.ASSISTANT_INSTALLATION_ID || scope.generation !== env.ASSISTANT_GENERATION || scope.sourceEpoch !== fence.epoch || scope.sourceGeneration !== fence.generation) throw new AppError("approved_send_denied", 403);
  return env;
}
async function mapped(env: Env, scope: ApprovedSendScope, field: "action_id" | "operation_id", value: string): Promise<MappedAction> {
  const row = await env.DB.prepare(`SELECT s.action_id,s.hash,s.target_json,a.envelope_json,a.status,a.expires_at,a.provider_message_id,a.provider_zaap_id,a.last_error
    FROM approved_sends s JOIN actions a ON a.id=s.action_id AND a.epoch=s.source_epoch AND a.generation=s.source_generation AND a.hash=s.hash WHERE ${ns} AND s.${field}=?`).bind(...keys(scope), value).first<MappedAction>();
  if (!row) throw new AppError("approved_send_not_found", 404);
  return row;
}
function receipt(row: MappedAction): ApprovedSendReceipt {
  return { actionId: row.action_id, hash: row.hash, status: row.status === "attempting" ? "uncertain" : ["proposed", "approved"].includes(row.status) && row.expires_at <= Date.now() ? "expired" : row.status,
    providerMessageId: row.provider_message_id, providerZaapId: row.provider_zaap_id, error: row.last_error, expiresAt: row.expires_at };
}
export async function prepareApprovedSend(raw: Env, input: unknown): Promise<ApprovedSendPrepared> {
  const q = approvedSendPrepareInput.parse(input), env = await authenticate(raw, q.secret, q.scope);
  const selected = await resolveSendEnvelope(env, q.envelope), envelope = approvedSendEnvelope.parse(selected.envelope);
  const hash = await actionDigest(envelope), actionId = crypto.randomUUID(), now = Date.now();
  const target = { chatId: selected.chat.id, name: selected.chat.name, address: selected.chat.external_id, kind: selected.chat.kind };
  const targetJson = JSON.stringify(target), local = sendEnvelopeGuard(selected), connection = await runtimeConnectionGuard(env);
  // The unique operation and its action commit together. Losing/concurrent callers reuse the winner.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO approved_sends(installation_id,generation,source_epoch,source_generation,operation_id,action_id,hash,target_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (${connection.sql}) AND (${local.sql}) ON CONFLICT DO NOTHING`).bind(...keys(q.scope), q.operationId, actionId, hash, targetJson, now, ...connection.values, ...local.values),
    env.DB.prepare(`INSERT INTO actions(id,epoch,generation,chat_id,envelope_json,hash,status,expires_at,created_at)
      SELECT action_id,source_epoch,source_generation,?,?,hash,'proposed',?,? FROM approved_sends s WHERE ${ns} AND s.operation_id=? AND s.action_id=? AND s.hash=?`).bind(selected.chat.id, canonicalEnvelope(envelope), now + 600000, now, ...keys(q.scope), q.operationId, actionId, hash),
  ]);
  const saved = await mapped(env, q.scope, "operation_id", q.operationId);
  if (saved.hash !== hash) throw new AppError("approved_send_conflict", 409);
  if (saved.envelope_json === "{}" || saved.expires_at <= Date.now()) throw new AppError("approved_send_expired", 409);
  const savedEnvelope = approvedSendEnvelope.parse(JSON.parse(saved.envelope_json));
  if (await actionDigest(savedEnvelope) !== hash) throw new AppError("approved_send_conflict", 409);
  return { actionId: saved.action_id, hash, envelope: savedEnvelope, target: targetSchema.parse(JSON.parse(saved.target_json)), expiresAt: saved.expires_at };
}
export async function approvedSendStatus(raw: Env, input: unknown): Promise<ApprovedSendReceipt> {
  const q = approvedSendStatusInput.parse(input), env = await authenticate(raw, q.secret, q.scope);
  return receipt(await mapped(env, q.scope, "action_id", q.actionId));
}
export async function executeApprovedSend(raw: Env, input: unknown, provider?: SendProvider): Promise<ApprovedSendReceipt> {
  const q = approvedSendExecuteInput.parse(input), env = await authenticate(raw, q.secret, q.scope);
  const saved = await mapped(env, q.scope, "action_id", q.actionId);
  // Even a revoked/expired approval can safely reconcile the same completed/uncertain attempt.
  if (!["proposed", "approved"].includes(saved.status)) return receipt(saved);
  if (saved.envelope_json === "{}" || saved.expires_at <= Date.now()) throw new AppError("approved_send_expired", 409);
  const envelope = approvedSendEnvelope.parse(JSON.parse(saved.envelope_json));
  if (await actionDigest(envelope) !== saved.hash) throw new AppError("approved_send_conflict", 409);
  const target = targetSchema.parse(JSON.parse(saved.target_json));
  const selected = await resolveSendEnvelope(env, envelope), local = sendEnvelopeGuard(selected), connection = await runtimeConnectionGuard(env);
  const owner = env.ASSISTANT_OWNER;
  if (!owner?.approvedSendAuthorization) throw new AppError("approved_send_unavailable", 503);
  await executeAction(env, saved.action_id, provider ?? new ZapiClient(env), { confirmed: true, hash: saved.hash }, {
    beforeClaim: async (snapshot) => {
      // This callback runs after provider.status(), immediately before Source's sole attempt claim.
      // Check the actual cached send snapshot as well as current SQL state: an A→B→A
      // directory change must not make a stale B destination pass the final A guard.
      if (snapshot.chat.id !== target.chatId || snapshot.chat.name !== target.name || snapshot.chat.external_id !== target.address || snapshot.chat.kind !== target.kind || snapshot.chat.epoch !== q.scope.sourceEpoch || snapshot.chat.generation !== q.scope.sourceGeneration || canonicalEnvelope(snapshot.envelope) !== canonicalEnvelope(envelope))
        throw new AppError("approved_send_changed", 409);
      await authenticate(raw, q.secret, q.scope);
      const proof = authorizationSchema.safeParse(await owner.approvedSendAuthorization(q.scope, { secret: q.secret, approvalId: q.approvalId, actionId: q.actionId, hash: saved.hash }));
      const now = Date.now();
      if (!proof.success || proof.data.actionId !== q.actionId || proof.data.hash !== saved.hash || proof.data.approvalId !== q.approvalId || proof.data.expiresAt <= now || proof.data.expiresAt > now + 10000) throw new AppError("approved_send_denied", 403);
      const mapping = `EXISTS(SELECT 1 FROM approved_sends s WHERE ${ns} AND s.action_id=? AND s.hash=? AND s.target_json=?)`;
      const exactTarget = "EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=? AND name=? AND external_id=? AND kind=?)";
      return { sql: `(${connection.sql}) AND (${local.sql}) AND (${mapping}) AND (${exactTarget}) AND ?>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`, values: [...connection.values, ...local.values, ...keys(q.scope), q.actionId, saved.hash, saved.target_json, target.chatId, q.scope.sourceEpoch, q.scope.sourceGeneration, target.name, target.address, target.kind, proof.data.expiresAt] };
    },
  });
  return receipt(await mapped(env, q.scope, "action_id", q.actionId));
}
/** Named private capability only. The model cannot choose a provider, URL or execution guard. */
export class ApprovedSendActuator extends WorkerEntrypoint<Env> implements ApprovedSendActuatorRPC {
  prepare(input: unknown) { return prepareApprovedSend(this.env, input); }
  execute(input: unknown) { return executeApprovedSend(this.env, input); }
  status(input: unknown) { return approvedSendStatus(this.env, input); }
}
