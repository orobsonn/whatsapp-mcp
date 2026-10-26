import { z } from "zod";
import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
import { retentionAuthorityName, sourceRetirementGuard } from "./retention-authority";
import { SnapshotProducer } from "./retention-snapshot";
import { CanonicalRestore, type RestoreAuthorityPort } from "./retention-restore";
import { OriginGuard } from "./origin-guard";
/** Async startup proof, not a configuration diagnostic or an activation API.
 * A restored generation needs the exact externally configured seal. Its
 * execution hold is released only by the separate explicit owner activation,
 * never by import, finish, release, background work or configuration alone. */
export async function assertRestoredGeneration(env: AssistantEnv, execution = true) {
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION) throw new Error("restore_runtime_configuration");
  if (env.RETENTION_GENERATION_SEAL_REQUIRED !== undefined && !["true", "false"].includes(env.RETENTION_GENERATION_SEAL_REQUIRED)) throw new Error("restore_runtime_configuration");
  const configured = env.RETENTION_GENERATION_SEAL;
  if (configured !== undefined) z.string().regex(/^[a-f0-9]{64}$/).parse(configured);
  // Old fixtures without25 are explicit legacy, never a readiness assertion.
  const installed = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_retention_generation_seals'").first();
  if (!installed) { if (configured || env.RETENTION_GENERATION_SEAL_REQUIRED === "true") throw new Error("restore_generation_seal_required"); return; }
  // One current SQLite snapshot after the explicit legacy-schema guard. Every
  // call is fresh; no authorization or execution result is cached across awaits.
  const view = await env.DB.prepare(`SELECT
    (SELECT generation FROM assistant_retention_active_generation WHERE installation_id=?) AS active,
    g.seal,g.state,
    EXISTS(SELECT 1 FROM assistant_retention_restore_sessions s WHERE s.installation_id=g.installation_id AND s.generation=g.generation AND s.ticket_hash=g.ticket_hash AND s.snapshot_seal=g.snapshot_seal AND s.state='inactive_complete' AND s.released=1) AS released,
    EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1) AS held,
    EXISTS(SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='quiescing') AS quiescing
    FROM (SELECT 1) LEFT JOIN assistant_retention_generation_seals g ON g.installation_id=? AND g.generation=?`)
    .bind(env.INSTALLATION_ID, env.INSTALLATION_ID, env.INSTALLATION_ID, env.INSTALLATION_ID, env.OPERATIONAL_GENERATION)
    .first<{ active: string | null; seal: string | null; state: string | null; released: number; held: number; quiescing: number }>();
  if (!view) throw new Error("restore_runtime_configuration");
  const active = view.active;
  if (active && active !== env.OPERATIONAL_GENERATION) throw new Error("restore_generation_inactive");
  if (view.seal !== null || configured || env.RETENTION_GENERATION_SEAL_REQUIRED === "true") {
    if (!view.seal || view.state !== "inactive_complete" || view.released !== 1 || !configured || view.seal !== configured) throw new Error("restore_generation_seal_required");
  }
  if (execution && view.held) throw new Error("restore_runtime_paused");
  if (execution && view.quiescing) throw new Error("canonical_writers_quiesced");
}
/** Only the named OwnerAssistant capability creates these services. No actor,
 * database, URL, target generation or binding can come from a command body. */
export function retentionServices(env: AssistantEnv, scope: SourceScope & { sourceEpoch: string; sourceGeneration: string }) {
  if (!env.DB || !env.RETENTION_AUTHORITY || env.INSTALLATION_ID !== scope.installationId || env.OPERATIONAL_GENERATION !== scope.generation || env.BRIDGE_SOURCE_EPOCH !== scope.sourceEpoch || env.BRIDGE_SOURCE_GENERATION !== scope.sourceGeneration) throw new Error("retention_host_configuration");
  const stub = env.RETENTION_AUTHORITY.get(env.RETENTION_AUTHORITY.idFromName(retentionAuthorityName(scope.installationId)));
  const authority: RestoreAuthorityPort = { observe: () => stub.snapshotObserve(), recordSnapshot: manifest => stub.recordSnapshot(manifest), snapshotReceipt: operation => stub.snapshotReceipt(operation), restoreTicket: operation => stub.restoreTicket(operation), reserveRestore: input => stub.reserveRestore(input), lookup: (id, keys) => stub.lookup(id, keys), record: (id, keys) => stub.record(id, keys) };
  return {
    snapshot: new SnapshotProducer(env.DB, scope, { kind: "owner" }, authority),
    restore() {
      const generation = z.string().min(1).max(256).parse(env.RETENTION_RESTORE_GENERATION), target = { ...scope, generation };
      const origin = env.CAPTURE_READER && env.BRIDGE_SECRET ? new OriginGuard(env.DB!, () => target, env.CAPTURE_READER, env.BRIDGE_SECRET) : undefined;
      return new CanonicalRestore(env.DB!, scope, generation, { kind: "owner" }, authority, sourceRetirementGuard(scope.installationId, authority), scope, Date.now, origin, env.CAPTURE_READER && env.BRIDGE_SECRET ? { reader: env.CAPTURE_READER, secret: env.BRIDGE_SECRET } : undefined, env.RETENTION_GENERATION_SEAL ? { externalSeal: env.RETENTION_GENERATION_SEAL, shadow: env.FLUE_EPISODES_ENABLED === "shadow" } : undefined);
    },
  };
}
