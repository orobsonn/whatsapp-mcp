import { SourceAccess, type AccessGuard } from "./access";
import type { AssistantEnv } from "./env";
import { jobRequest } from "./agent/contracts";
import { JobQueue } from "./queue";
import { sourceTextHash } from "./sources";
import { bridgeHash } from "./ingress";
import { combineOnceGuards, onceKey, onceReceipt, oncePeriod, onceConfiguration,
  readOnceGrant, type OnceScope } from "./owner-once-guard";

/** Deliberately first-bootstrap-only. Never use this gate on committed replay:
 * the newly admitted execution is expected to acquire its own paid history. */
export function recoveryNoPaidHistory(scope: OnceScope): AccessGuard {
  return { sql: `NOT EXISTS(SELECT 1 FROM assistant_budget_reservations WHERE installation_id=? AND generation=?)
    AND NOT EXISTS(SELECT 1 FROM assistant_model_receipts WHERE installation_id=? AND generation=?)`,
    values: [scope.installationId, scope.generation, scope.installationId, scope.generation] };
}

/** Private question is read from its owning ledger, never from a recovery
 * command. The exact predecessor is compared again in the admission batch. */
export async function resolveOwnerRecoveryPlan(env: AssistantEnv, scope: OnceScope, previousId: string, now: number, recoveryId: string) {
  const row = await env.DB!.prepare(`SELECT request_hash,result_json FROM assistant_owner_commands
    WHERE installation_id=? AND generation=? AND operation_id=?`).bind(scope.installationId, scope.generation, onceKey(previousId))
    .first<{ request_hash: string; result_json: string }>();
  if (!row) throw Error("owner_recovery_predecessor_missing");
  const previous = onceReceipt.parse(JSON.parse(row.result_json));
  if (previous.id !== previousId || previous.requestHash !== row.request_hash || previous.recovery
    || JSON.stringify(previous.scope) !== JSON.stringify(scope) || now < previous.deadlineAt
    || now < previous.createdAt || oncePeriod(now) !== previous.period
    || await onceConfiguration(env, scope) !== previous.configHash || !await readOnceGrant(env, previous))
    throw Error("owner_recovery_predecessor_ineligible");
  const queue = new JobQueue(env.DB!, scope), job = await queue.get(previous.jobId), ledger = await queue.ledger(previous.jobId);
  if (!job || !ledger || job.kind !== "reasoning" || job.state !== "pending" || job.attempts !== 0
    || job.lease_generation !== 0 || job.lease_until !== null || job.max_attempts !== 1
    || job.source_id !== previous.sourceId || job.source_revision !== previous.expectedRevision
    || ledger.state !== "prepared" || ledger.admitted_lease_generation !== null
    || await sourceTextHash(ledger.request_json) !== ledger.request_hash) throw Error("owner_recovery_job_ineligible");
  const request = jobRequest.parse(JSON.parse(ledger.request_json));
  const anchor = await new SourceAccess(env.DB!, scope).read({ kind: "owner" }, previous.sourceId, previous.expectedRevision, now);
  if (request.kind !== "reasoning" || request.actor.kind !== "owner" || request.runtime !== "flue" || request.conversation !== null
    || request.sourceId !== previous.sourceId || request.sourceRevision !== previous.expectedRevision
    || request.subject.kind !== "owner_request" || request.subject.requestKey !== onceKey(previousId)
    || request.subject.sourceId !== previous.sourceId || request.subject.sourceRevision !== previous.expectedRevision
    || request.outgoing || await bridgeHash(request.input) !== previous.queryHash || !anchor
    || await bridgeHash(anchor.fence) !== await bridgeHash(request.fence)) throw Error("owner_recovery_request_changed");
  const guard = combineOnceGuards({ sql: `EXISTS(SELECT 1 FROM assistant_owner_commands p
    JOIN assistant_jobs j ON j.installation_id=p.installation_id AND j.generation=p.generation AND j.id=?
    JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
    WHERE p.installation_id=? AND p.generation=? AND p.operation_id=? AND p.request_hash=? AND p.result_json=?
    AND j.dedupe_key=? AND j.kind='reasoning' AND j.state='pending' AND j.attempts=0 AND j.max_attempts=1
    AND j.lease_generation=0 AND j.lease_until IS NULL AND j.source_id=? AND j.source_revision=?
    AND l.state='prepared' AND l.admitted_lease_generation IS NULL AND l.request_hash=? AND l.request_json=?
    AND NOT EXISTS(SELECT 1 FROM assistant_episodes e WHERE e.installation_id=j.installation_id AND e.generation=j.generation AND e.job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM assistant_job_receipts r WHERE r.installation_id=j.installation_id AND r.generation=j.generation AND r.job_id=j.id))`,
    values: [previous.jobId, scope.installationId, scope.generation, onceKey(previousId), row.request_hash, row.result_json,
      onceKey(previousId), previous.sourceId, previous.expectedRevision, ledger.request_hash, ledger.request_json] }, recoveryNoPaidHistory(scope), {
    sql: `NOT EXISTS(SELECT 1 FROM assistant_owner_commands sibling WHERE sibling.installation_id=? AND sibling.generation=?
      AND json_extract(sibling.result_json,'$.kind')='owner_once.plan'
      AND json_extract(sibling.result_json,'$.recovery.previousId')=? AND sibling.operation_id<>?)`,
    values: [scope.installationId, scope.generation, previousId, onceKey(recoveryId)],
  });
  return { previous, query: request.input, previousPlanHash: await bridgeHash(previous), previousJobHash: ledger.request_hash, guard };
}
