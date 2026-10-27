import { z } from "zod";
import type { AssistantEnv } from "./env";
import { SourceAccess } from "./access";
import { InferenceBudget } from "./budget";
import { CommandLedger } from "./command-ledger";
import { bridgeHash } from "./ingress";
import { JobQueue } from "./queue";
import { assertRestoredGeneration } from "./retention-runtime";
import { retentionExecutionGuard } from "./retention-execution";
import { combineOnceGuards, currentOnceGuard, onceBudgetGuard, onceConfiguration, onceInventory, onceKey,
  oncePeriod, onceReceipt, type OnceReceipt, type OnceScope } from "./owner-once-guard";
import { onceAdmitKey, onceAdmittedReceipt, oncePlanGuard, readOnceGrant, onceAuthority } from "./owner-once-guard";

const id = z.string().min(1).max(256), integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationId = z.string().min(1).max(128).trim();
export const onceCommand = z.union([
  z.object({ kind: z.literal("owner_once.plan"), operationId, sourceId: id, expectedRevision: integer, projectId: id,
    query: z.string().min(1).refine(text => new TextEncoder().encode(text).length <= 2048), deadlineAt: integer,
    maxCostMicroUsd: integer.max(600000) }).strict(),
  z.object({ kind: z.literal("owner_once.status"), operationId }).strict(),
  z.object({ kind: z.literal("owner_once.advance"), operationId }).strict(),
]);

/** Internal Owner capability. Planning never claims a job or grants model,
 * bootstrap or Flue authority. Progress belongs to existing execution ledgers. */
export class OwnerOnce {
  constructor(private readonly env: AssistantEnv, private readonly scope: OnceScope, private readonly clock = Date.now) {}
  private async find(root: string) {
    const row = await this.env.DB!.prepare(`SELECT request_hash,result_json FROM assistant_owner_commands
      WHERE installation_id=? AND generation=? AND operation_id=?`)
      .bind(this.scope.installationId, this.scope.generation, onceKey(root)).first<{ request_hash: string; result_json: string }>();
    if (!row) return null;
    const receipt = onceReceipt.parse(JSON.parse(row.result_json));
    if (receipt.id !== root || receipt.requestHash !== row.request_hash || JSON.stringify(receipt.scope) !== JSON.stringify(this.scope)) throw new Error("owner_once_receipt_scope");
    return receipt;
  }
  private async status(receipt: OnceReceipt) {
    let state: "planned" | "admitted" | "blocked" = "planned";
    try {
      await assertRestoredGeneration(this.env);
      const grant = await readOnceGrant(this.env, receipt);
      if (grant) state = "admitted";
      const guard = grant ? (await onceAuthority(this.env, this.scope, grant, this.clock())).guard
        : combineOnceGuards(await currentOnceGuard(this.env, receipt, this.clock()), oncePlanGuard(receipt));
      if (!await this.env.DB!.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()) state = "blocked";
      if (this.clock() >= receipt.deadlineAt || this.clock() < receipt.createdAt || oncePeriod(this.clock()) !== receipt.period) state = "blocked";
    } catch { state = "blocked"; }
    return { state, id: receipt.id, jobId: receipt.jobId, period: receipt.period, deadlineAt: receipt.deadlineAt,
      maxCostMicroUsd: receipt.maxCostMicroUsd, corpus: { sourceCount: receipt.corpus.sourceCount, utf8Bytes: receipt.corpus.utf8Bytes } };
  }
  async execute(raw: unknown) {
    const command = onceCommand.parse(raw), root = await bridgeHash(["owner-once-v1", this.scope, command.operationId]);
    const existing = await this.find(root);
    if (command.kind === "owner_once.status") return existing ? this.status(existing) : { state: "unavailable", id: root };
    if (command.kind === "owner_once.advance") {
      if (!existing) return { state: "unavailable", id: root };
      if ((await this.status(existing)).state === "blocked") return this.status(existing);
      const ledger = new CommandLedger(this.env.DB!, this.scope, onceAdmitKey(root), await bridgeHash(existing));
      if (!await ledger.recover()) {
        const now = this.clock(), current = combineOnceGuards(await currentOnceGuard(this.env, existing, now), oncePlanGuard(existing));
        if (this.clock() >= existing.deadlineAt || oncePeriod(this.clock()) !== existing.period) return this.status(existing);
        await this.env.DB!.batch([ledger.admit(onceAdmittedReceipt.parse({ kind: "owner_once.admit", id: root,
          scope: this.scope, planHash: await bridgeHash(existing), admittedAt: now }), now, current.sql, current.values)]);
      }
      return this.status(existing);
    }
    const requestHash = await bridgeHash(command);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("control_operation_conflict");
      return this.status(existing);
    }
    const now = this.clock(), period = oncePeriod(now), nextDay = Date.parse(`${period}T00:00:00Z`) + 86400000;
    if (command.deadlineAt <= now || command.deadlineAt > Math.min(now + 900000, nextDay)) throw new Error("owner_once_deadline");
    const configHash = await onceConfiguration(this.env, this.scope);
    await assertRestoredGeneration(this.env);
    const anchor = await new SourceAccess(this.env.DB!, this.scope).read({ kind: "owner" }, command.sourceId, command.expectedRevision, now);
    if (!anchor || anchor.fence.source.origin !== "owner_note" || anchor.fence.source.audience !== "owner"
      || anchor.fence.source.projectId !== command.projectId) throw new Error("owner_once_anchor");
    const budget = await new InferenceBudget(this.env.DB!, { ...this.scope, period }).status();
    if (budget.blocked || budget.cap < 1 || budget.cap > command.maxCostMicroUsd || budget.committed >= budget.cap) throw new Error("owner_once_budget");
    const inventory = await onceInventory(this.env.DB!, this.scope, command.projectId, now);
    const jobId = crypto.randomUUID();
    const receipt = onceReceipt.parse({ kind: "owner_once.plan", id: root, scope: this.scope, requestHash,
      sourceId: command.sourceId, expectedRevision: command.expectedRevision, projectId: command.projectId,
      queryHash: await bridgeHash(command.query), jobId, period, createdAt: now, deadlineAt: command.deadlineAt,
      maxCostMicroUsd: command.maxCostMicroUsd, capMicroUsd: budget.cap, configHash, corpus: inventory.corpus });
    if (await onceConfiguration(this.env, this.scope) !== configHash || this.clock() >= command.deadlineAt || oncePeriod(this.clock()) !== period)
      throw new Error("owner_once_expired_or_changed");
    const guard = combineOnceGuards(inventory.guard, onceBudgetGuard(this.scope, period, budget.cap), retentionExecutionGuard(this.scope));
    const ledger = new CommandLedger(this.env.DB!, this.scope, onceKey(root), requestHash);
    const admitted = { sql: "EXISTS(SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id=? AND token=?)",
      values: [this.scope.installationId, this.scope.generation, onceKey(root), ledger.token] };
    await new JobQueue(this.env.DB!, this.scope).enqueue({ kind: "reasoning", dedupeKey: onceKey(root),
      sourceId: command.sourceId, sourceRevision: command.expectedRevision, request: command.query, maxAttempts: 1,
      runtime: "flue", subject: { kind: "owner_request", sourceId: command.sourceId, sourceRevision: command.expectedRevision, requestKey: onceKey(root) } }, now,
      { id: jobId, guard: admitted, statements: [ledger.admit(receipt, now, guard.sql, guard.values)] });
    const recovered = await ledger.recover<unknown>();
    if (!recovered) throw new Error("owner_once_admission_changed");
    return this.status(onceReceipt.parse(recovered));
  }
}
