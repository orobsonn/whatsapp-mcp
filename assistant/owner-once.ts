import type { AssistantEnv } from "./env";
import { SourceAccess } from "./access";
import { InferenceBudget } from "./budget";
import { CommandLedger } from "./command-ledger";
import { bridgeHash } from "./ingress";
import { JobQueue } from "./queue";
import { normalizeRetrievalInput } from "./retrieval";
import type { OnceExecutionOptions } from "./owner-once-execution";
import { assertRestoredGeneration } from "./retention-runtime";
import { retentionExecutionGuard } from "./retention-execution";
import { combineOnceGuards, currentOnceGuard, onceBudgetGuard, onceConfiguration, onceInventory, onceKey,
  oncePeriod, onceReceipt, type OnceReceipt, type OnceScope } from "./owner-once-guard";
import { onceAdmitKey, onceAdmittedReceipt, oncePlanGuard, readOnceGrant, onceAuthority, completedOwnerOnce } from "./owner-once-guard";
import { onceCommand, onceExecutionMetadata } from "./owner-once-contract";
import { resolveOwnerRecoveryPlan } from "./owner-once-recovery";

export { onceCommand } from "./owner-once-contract";

/** Internal Owner capability. Planning never claims a job or grants model,
 * bootstrap or Flue authority. Progress belongs to existing execution ledgers. */
export class OwnerOnce {
  constructor(private readonly env: AssistantEnv, private readonly scope: OnceScope, private readonly clock = Date.now, private readonly options: OnceExecutionOptions = {}) {}
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
    const completed = await completedOwnerOnce(this.env, this.scope, receipt);
    if (completed) return { state: "complete", id: receipt.id, jobId: receipt.jobId, decisionId: completed, observation: "historical_shadow_completion" };
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
    if (command.kind === "owner_once.inspect") {
      if (!existing) return {state:"unavailable",id:root};
      try {
        await assertRestoredGeneration(this.env,false);
        const raw=await this.env.COGNEE!.get(this.env.COGNEE!.idFromName(JSON.stringify(["cognee",this.scope.installationId,this.scope.generation]))).initialObservation();
        // Pick the metadata DTO explicitly; a remote extra field is never echoed.
        const metadata=onceExecutionMetadata.parse({state:raw.state,imageConfigured:raw.imageConfigured,activePresent:raw.activePresent,
          quarantine:raw.quarantine,index:raw.index,initial:raw.initial});
        if(metadata.initial.state==="present"&&metadata.initial.itemId!==existing.id)throw Error("initial_root_mismatch");
        const status=await this.status(existing);await assertRestoredGeneration(this.env,false);
        return {...status,executionMetadata:metadata};
      } catch {return {state:"blocked",id:root,reason:"execution_metadata_unavailable"};}
    }
    if (command.kind === "owner_once.advance") {
      if (!existing) return { state: "unavailable", id: root };
      const status = await this.status(existing);
      if (status.state === "blocked" || status.state === "complete") return status;
      const grant = await readOnceGrant(this.env, existing);
      if (grant) { const { OnceExecution } = await import("./owner-once-execution"); return new OnceExecution(this.env, this.scope, existing, grant, this.clock, this.options).advance(); }
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
    const predecessor = command.kind === "owner_once.recovery_plan" ? await resolveOwnerRecoveryPlan(this.env, this.scope,
      await bridgeHash(["owner-once-v1", this.scope, command.previousOperationId]), now, root) : null;
    const planning = command.kind === "owner_once.plan" ? command : { ...command,
      sourceId: predecessor!.previous.sourceId, expectedRevision: predecessor!.previous.expectedRevision,
      projectId: predecessor!.previous.projectId, query: predecessor!.query };
    normalizeRetrievalInput({ query: planning.query, projectId: planning.projectId, limit: 10 });
    const configHash = await onceConfiguration(this.env, this.scope);
    await assertRestoredGeneration(this.env);
    const anchor = await new SourceAccess(this.env.DB!, this.scope).read({ kind: "owner" }, planning.sourceId, planning.expectedRevision, now);
    if (!anchor || anchor.fence.source.origin !== "owner_note" || anchor.fence.source.audience !== "owner"
      || anchor.fence.source.projectId !== planning.projectId) throw new Error("owner_once_anchor");
    const budget = await new InferenceBudget(this.env.DB!, { ...this.scope, period }).status();
    if (budget.blocked || budget.cap < 1 || budget.cap > command.maxCostMicroUsd || budget.committed >= budget.cap) throw new Error("owner_once_budget");
    const inventory = await onceInventory(this.env.DB!, this.scope, planning.projectId, now);
    if (predecessor && (predecessor.previous.capMicroUsd !== budget.cap || predecessor.previous.maxCostMicroUsd !== command.maxCostMicroUsd
      || JSON.stringify(predecessor.previous.corpus) !== JSON.stringify(inventory.corpus))) throw Error("owner_recovery_scope_changed");
    const witness = predecessor ? await this.env.COGNEE!.get(this.env.COGNEE!.idFromName(JSON.stringify(["cognee", this.scope.installationId, this.scope.generation])))
      .prepareInitialRecovery(predecessor.previous.id) : null;
    if (predecessor && (!witness || witness.state !== "available")) throw Error("owner_recovery_witness_unavailable");
    const jobId = crypto.randomUUID();
    const receipt = onceReceipt.parse({ kind: "owner_once.plan", id: root, scope: this.scope, requestHash,
      sourceId: planning.sourceId, expectedRevision: planning.expectedRevision, projectId: planning.projectId,
      queryHash: await bridgeHash(planning.query), jobId, period, createdAt: now, deadlineAt: command.deadlineAt,
      maxCostMicroUsd: command.maxCostMicroUsd, capMicroUsd: budget.cap, configHash, corpus: inventory.corpus,
      ...(predecessor && witness?.state === "available" ? { recovery: { previousId: predecessor.previous.id,
        previousPlanHash: predecessor.previousPlanHash, previousJobHash: predecessor.previousJobHash,
        indexEpoch: witness.indexEpoch, operationId: witness.operationId, witnessHash: witness.witnessHash } } : {}) });
    if (await onceConfiguration(this.env, this.scope) !== configHash || this.clock() >= command.deadlineAt || oncePeriod(this.clock()) !== period)
      throw new Error("owner_once_expired_or_changed");
    const guard = combineOnceGuards(inventory.guard, onceBudgetGuard(this.scope, period, budget.cap), retentionExecutionGuard(this.scope),
      ...(predecessor ? [predecessor.guard] : []));
    const ledger = new CommandLedger(this.env.DB!, this.scope, onceKey(root), requestHash);
    const admitted = { sql: "EXISTS(SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id=? AND token=?)",
      values: [this.scope.installationId, this.scope.generation, onceKey(root), ledger.token] };
    await new JobQueue(this.env.DB!, this.scope).enqueue({ kind: "reasoning", dedupeKey: onceKey(root),
      sourceId: planning.sourceId, sourceRevision: planning.expectedRevision, request: planning.query, maxAttempts: 1,
      runtime: "flue", subject: { kind: "owner_request", sourceId: planning.sourceId, sourceRevision: planning.expectedRevision, requestKey: onceKey(root) } }, now,
      { id: jobId, guard: admitted, statements: [ledger.admit(receipt, now, guard.sql, guard.values)] });
    const recovered = await ledger.recover<unknown>();
    if (!recovered) throw new Error("owner_once_admission_changed");
    return this.status(onceReceipt.parse(recovered));
  }
}
