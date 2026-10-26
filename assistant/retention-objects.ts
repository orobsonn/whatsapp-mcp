import { z } from "zod";
import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
import type { TrustedActor } from "./access";
const label = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
export const objectCommand = z.object({ kind: z.literal("object.collect"), operationId: label, key: z.string().min(1).max(1024) }).strict();
export function retentionObjectPrefix(scope: SourceScope) { return `assistant-artifacts/v1/${encodeURIComponent(label.parse(scope.installationId))}/${encodeURIComponent(label.parse(scope.generation))}/`; }
/** The host owns one separate ARTIFACTS binding. No bucket, URL or namespace
 * arrives from source/model input. Binding identity needs provisioning evidence;
 * these private markers prove configuration affinity, not R2's actual bucket ID. */
export class RetentionObjects {
  private readonly scope: SourceScope;
  private readonly actor: TrustedActor;
  private readonly env: Pick<AssistantEnv, "DB" | "ARTIFACTS" | "ARTIFACTS_INSTALLATION_ID" | "ARTIFACTS_GENERATION">;
  constructor(env: Pick<AssistantEnv, "DB" | "ARTIFACTS" | "ARTIFACTS_INSTALLATION_ID" | "ARTIFACTS_GENERATION">, scope: SourceScope, actor: TrustedActor, private readonly clock = Date.now) {
    this.env = Object.freeze({ DB: env.DB, ARTIFACTS: env.ARTIFACTS, ARTIFACTS_INSTALLATION_ID: env.ARTIFACTS_INSTALLATION_ID, ARTIFACTS_GENERATION: env.ARTIFACTS_GENERATION });
    this.scope = Object.freeze({ ...scope }); this.actor = Object.freeze({ ...actor });
  }
  async collect(raw: unknown) {
    if (this.actor.kind !== "owner") throw new Error("owner_required");
    const command = objectCommand.parse(raw), prefix = retentionObjectPrefix(this.scope);
    if (!command.key.startsWith(prefix) || command.key.length === prefix.length) throw new Error("retention_object_namespace");
    if (!this.env.DB || !this.env.ARTIFACTS || this.env.ARTIFACTS_INSTALLATION_ID !== this.scope.installationId || this.env.ARTIFACTS_GENERATION !== this.scope.generation) return { state: "pending_configuration", dependency: "separate_artifacts_bucket_affinity" };
    const db = this.env.DB, args = [this.scope.installationId, this.scope.generation, command.key], sql = (query: string) => db.prepare(query).bind(...args);
    const read = () => sql(`SELECT operation_id,state,attempts FROM assistant_retention_object_claims WHERE installation_id=? AND generation=? AND object_key=?`).first<{ operation_id: string; state: string; attempts: number }>();
    const prior = await read(); if (prior && prior.operation_id !== command.operationId) throw new Error("retention_operation_conflict");
    if (prior?.state === "deleted") return { state: "deleted", attempts: prior.attempts, scope: "own_artifacts_object_only", externalCopies: "pending" };
    if (!prior) {
      try { await db.prepare(`INSERT INTO assistant_retention_object_claims(installation_id,generation,object_key,operation_id,state,created_at)
        SELECT ?,?,?,?,'claimed',? WHERE NOT EXISTS(SELECT 1 FROM assistant_source_versions WHERE original_object_key=?) ON CONFLICT DO NOTHING`).bind(...args, command.operationId, this.clock(), command.key).run(); }
      catch { const proof = await read(); if (!proof || proof.operation_id !== command.operationId) throw new Error("retention_object_claim_uncertain"); }
    }
    const claim = await read();
    if (!claim) return { state: "retained", reason: "referenced_in_any_namespace" };
    if (claim.operation_id !== command.operationId) throw new Error("retention_operation_conflict");
    // A persisted claim globally prevents future references. Repeating DELETE
    // after an uncertain acknowledgement is safe while that barrier survives.
    try {
      await sql(`UPDATE assistant_retention_object_claims SET state='uncertain',attempts=attempts+1 WHERE installation_id=? AND generation=? AND object_key=? AND state<>'deleted'`).run();
      await this.env.ARTIFACTS.delete(command.key);
      await sql(`UPDATE assistant_retention_object_claims SET state='deleted' WHERE installation_id=? AND generation=? AND object_key=?`).run();
    } catch { return { state: "uncertain", reason: "object_delete_or_ack_uncertain", attempts: (await read())?.attempts, externalCopies: "pending" }; }
    return { state: "deleted", attempts: (await read())!.attempts, scope: "own_artifacts_object_only", externalCopies: "pending" };
  }
}
