import type { AccessGuard } from "./access";
import type { SourceScope } from "./sources";

/** Execution admission only. Owner repair, metadata capture and settlement do
 * not use this guard. Repeat it in the transaction that claims an effect. */
export function retentionExecutionGuard(scope: SourceScope): AccessGuard {
  return { sql: `NOT EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1)
    AND NOT EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='quiescing')
    AND NOT EXISTS(SELECT 1 FROM assistant_retention_active_generation WHERE installation_id=? AND generation<>?)`,
    values: [scope.installationId, scope.installationId, scope.installationId, scope.generation] };
}
export async function assertRetentionExecution(db: D1Database, scope: SourceScope) {
  const guard = retentionExecutionGuard(scope);
  if (!await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()) throw new Error("restore_execution_blocked");
}
