import { z } from "zod";
import type { RetirementStore } from "./retention-authority";
import { bridgeHash } from "./ingress";
import { canonicalSnapshotTables, financialTables, snapshotManifest, verifyManifest } from "./retention-snapshot-contract";
import type { SnapshotAuthorityReceipt } from "./retention-snapshot";
const label = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().positive().safe();
const receiptSchema = z.object({ state: z.literal("sealed_snapshot"), installationId: label, generation: label, operationId: label, seal: digest, authorityRevision: integer }).strict();
const snapshotStored = z.object({ manifest: snapshotManifest, receipt: receiptSchema }).strict();
export const restoreReservation = z.object({ operationId: label, sourceOperationId: label, snapshotSeal: digest, targetGeneration: label, currentGeneration: label, quiescenceToken: label }).strict();
const restoreTicketSchema = restoreReservation.extend({ installationId: label, hash: digest, state: z.literal("reserved_inactive") }).strict();
export type RestoreTicket = z.infer<typeof restoreTicketSchema>;
type ReadStore = Pick<RetirementStore, "get">;
type Observe = (store?: ReadStore) => Promise<{ state: "sealed"; revision: number } | { state: "unavailable" }>;
/** Additional metadata in the same fixed installation DO, outside restorable
 * D1. Generations are reserved once; no body, model result or new budget lives here. */
export class SnapshotAuthorityCore {
  constructor(private readonly store: RetirementStore, private readonly installationId: string, private readonly observeParent: Observe) {}
  async observe() { const state = await this.observeParent(); if (state.state !== "sealed") throw new Error("retention_authority_unavailable"); return state; }
  private async snapshotKey(operationId: string) { return "snapshot:" + await bridgeHash([this.installationId, label.parse(operationId)]); }
  private async restoreKey(operationId: string) { return "restore:" + await bridgeHash([this.installationId, label.parse(operationId)]); }
  private async storedSnapshot(operationId: string, store: ReadStore = this.store) {
    const raw = await store.get<unknown>(await this.snapshotKey(operationId)); if (raw === undefined) return null;
    const value = snapshotStored.parse(raw), manifest = await verifyManifest(value.manifest);
    if (manifest.namespace.installationId !== this.installationId || manifest.operationId !== operationId || value.receipt.installationId !== this.installationId || value.receipt.operationId !== operationId || value.receipt.generation !== manifest.namespace.generation || value.receipt.seal !== manifest.seal || value.receipt.authorityRevision !== manifest.authorityRevision) throw new Error("snapshot_authority_corrupt");
    return value;
  }
  async snapshotReceipt(operationId: string): Promise<SnapshotAuthorityReceipt | null> { await this.observe(); return (await this.storedSnapshot(operationId))?.receipt ?? null; }
  async recordSnapshot(raw: unknown) {
    const manifest = await verifyManifest(raw), required = [...canonicalSnapshotTables, ...financialTables].sort();
    if (manifest.namespace.installationId !== this.installationId || manifest.tables.join("\n") !== required.join("\n")) throw new Error("snapshot_authority_affinity");
    const receipt = receiptSchema.parse({ state: "sealed_snapshot", installationId: this.installationId, generation: manifest.namespace.generation, operationId: manifest.operationId, seal: manifest.seal, authorityRevision: manifest.authorityRevision });
    const key = await this.snapshotKey(manifest.operationId);
    try { await this.store.transaction(async store => {
      const previous = await this.storedSnapshot(manifest.operationId, store);
      if (previous) { if (previous.manifest.seal !== manifest.seal) throw new Error("snapshot_authority_conflict"); return; }
      const parent = await this.observeParent(store); if (parent.state !== "sealed" || parent.revision !== manifest.authorityRevision) throw new Error("snapshot_authority_changed");
      await store.put(key, { manifest, receipt });
    }); } catch { const previous = await this.storedSnapshot(manifest.operationId); if (previous?.manifest.seal !== manifest.seal) throw new Error("snapshot_authority_uncertain"); }
    return receipt;
  }
  async restoreTicket(operationId: string): Promise<RestoreTicket | null> {
    await this.observe(); const raw = await this.store.get<unknown>(await this.restoreKey(operationId)); if (raw === undefined) return null;
    const value = restoreTicketSchema.parse(raw), { hash, state: _state, installationId, ...request } = value;
    if (installationId !== this.installationId || value.operationId !== operationId || await bridgeHash(["restore-reservation-v1", this.installationId, request]) !== hash) throw new Error("restore_authority_corrupt");
    const generation = await this.store.get<unknown>("generation:" + await bridgeHash([this.installationId, value.targetGeneration]));
    const marker = z.object({ operationId: label, hash: digest }).strict().parse(generation);
    if (marker.operationId !== operationId || marker.hash !== hash) throw new Error("restore_authority_corrupt"); return value;
  }
  async reserveRestore(raw: unknown) {
    const request = restoreReservation.parse(raw), hash = await bridgeHash(["restore-reservation-v1", this.installationId, request]), ticket = restoreTicketSchema.parse({ ...request, hash, installationId: this.installationId, state: "reserved_inactive" });
    const previous = await this.restoreTicket(request.operationId);
    if (previous) { if (previous.hash !== hash) throw new Error("restore_authority_conflict"); return previous; }
    const snapshot = await this.storedSnapshot(request.sourceOperationId);
    if (!snapshot || snapshot.manifest.seal !== request.snapshotSeal || request.targetGeneration === request.currentGeneration || request.targetGeneration === snapshot.manifest.namespace.generation) throw new Error("restore_new_external_generation_required");
    const key = await this.restoreKey(request.operationId), generationKey = "generation:" + await bridgeHash([this.installationId, request.targetGeneration]);
    try { await this.store.transaction(async store => {
      const parent = await this.observeParent(store); if (parent.state !== "sealed") throw new Error("retention_authority_unavailable");
      const existing = await store.get<unknown>(generationKey);
      if (existing !== undefined) { const marker = z.object({ operationId: label, hash: digest }).strict().parse(existing); if (marker.operationId !== request.operationId || marker.hash !== hash) throw new Error("restore_generation_already_reserved"); }
      const prior = await store.get<unknown>(key);
      if (prior !== undefined && restoreTicketSchema.parse(prior).hash !== hash) throw new Error("restore_authority_conflict");
      await store.put(generationKey, { operationId: request.operationId, hash }); await store.put(key, ticket);
    }); } catch { const observed = await this.restoreTicket(request.operationId); if (observed?.hash !== hash) throw new Error("restore_reservation_uncertain"); return observed; }
    return ticket;
  }
}
