import { z } from "zod";
import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
import { retentionAuthorityName, sourceRetirementGuard } from "./retention-authority";
import { SnapshotProducer } from "./retention-snapshot";
import { CanonicalRestore, type RestoreAuthorityPort } from "./retention-restore";
import { OriginGuard } from "./origin-guard";
/** Async startup proof, not a configuration diagnostic or an activation API.
 * A restored generation needs the exact externally configured seal. Its
 * execution hold is never released by any #55 command. */
export async function assertRestoredGeneration(env: AssistantEnv, execution = true) {
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION) throw new Error("restore_runtime_configuration");
  if (env.RETENTION_GENERATION_SEAL_REQUIRED !== undefined && !["true", "false"].includes(env.RETENTION_GENERATION_SEAL_REQUIRED)) throw new Error("restore_runtime_configuration");
  const configured = env.RETENTION_GENERATION_SEAL;
  if (configured !== undefined) z.string().regex(/^[a-f0-9]{64}$/).parse(configured);
  // Old fixtures without25 are explicit legacy, never a readiness assertion.
  const installed = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_retention_generation_seals'").first();
  if (!installed) { if (configured || env.RETENTION_GENERATION_SEAL_REQUIRED === "true") throw new Error("restore_generation_seal_required"); return; }
  const active = await env.DB.prepare("SELECT generation FROM assistant_retention_active_generation WHERE installation_id=?").bind(env.INSTALLATION_ID).first<string>("generation");
  if (active && active !== env.OPERATIONAL_GENERATION) throw new Error("restore_generation_inactive");
  const seal = await env.DB.prepare(`SELECT g.seal,g.state,EXISTS(SELECT 1 FROM assistant_retention_restore_sessions s WHERE s.installation_id=g.installation_id AND s.generation=g.generation AND s.ticket_hash=g.ticket_hash AND s.snapshot_seal=g.snapshot_seal AND s.state='inactive_complete' AND s.released=1) AS released
    FROM assistant_retention_generation_seals g WHERE g.installation_id=? AND g.generation=?`).bind(env.INSTALLATION_ID, env.OPERATIONAL_GENERATION).first<{ seal: string; state: string; released: number }>();
  if (seal || configured || env.RETENTION_GENERATION_SEAL_REQUIRED === "true") {
    if (!seal || seal.state !== "inactive_complete" || seal.released !== 1 || !configured || seal.seal !== configured) throw new Error("restore_generation_seal_required");
  }
  if (execution && await env.DB.prepare("SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=? AND active=1").bind(env.INSTALLATION_ID).first()) throw new Error("restore_runtime_paused");
  if (execution && await env.DB.prepare("SELECT 1 FROM assistant_retention_installation_gate WHERE installation_id=? AND state='quiescing'").bind(env.INSTALLATION_ID).first()) throw new Error("canonical_writers_quiesced");
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
