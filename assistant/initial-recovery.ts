import { z } from "zod";
import { bridgeHash } from "./ingress";
import { initialRecoveryProof, initialStateSchema, initialTicketSchema, sameInitial,
  type InitialIngestTicket, type InitialRecoveryProof } from "./initial-ingest-contract";
import type { EngineStore } from "./engine";

const prefix = "initial-recovery-v1:";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const emptyIndex = z.object({ namespace: z.string().max(1024), revision: z.literal("empty"),
  epoch: z.string().uuid(), sources: z.tuple([]), indexState: z.literal("needs_checkpoint"), lost: z.literal(true),
}).strict();
const previousState = z.object({ initial: initialStateSchema, index: emptyIndex,
  quarantine: z.literal(true), activePresent: z.boolean(), active: z.null(),
}).strict();
const recoveryRecord = z.object({ version: z.literal(1), proof: initialRecoveryProof,
  ticket: initialTicketSchema, previous: previousState,
}).strict();
type Previous = z.infer<typeof previousState>;
type Refusal = { state: "blocked"; reason: string };
type Reserved = { state: "reserved" | "already_admitted"; ticket: InitialIngestTicket; created: boolean; clearQuarantine: boolean };

/** Internal, metadata-only journal. The Engine owns the mutex and process fence. */
export class InitialRecoveryJournal {
  constructor(private store: EngineStore, private scope: { installationId: string; generation: string }) {}
  private async snapshot(store: EngineStore, previousId: string): Promise<Previous> {
    digest.parse(previousId);
    if (!store.list) throw Error("initial_recovery_storage_unavailable");
    const initial = initialStateSchema.parse(await store.get("initial-ingest-v1"));
    const index = emptyIndex.parse(await store.get("index"));
    const quarantine = await store.get("quarantine"), active = await store.get("active");
    if (initial.state !== "uncertain" || initial.ticket.admissionKind !== "owner_once"
      || initial.ticket.itemId !== previousId || index.namespace !== JSON.stringify(this.scope)
      || index.epoch !== initial.ticket.indexEpoch || quarantine !== true || (active !== undefined && active !== null))
      throw Error("initial_recovery_not_eligible");
    for (const key of ["checkpoint", "rebuild", "maintenance"])
      if (await store.get(key) !== undefined) throw Error("initial_recovery_history_present");
    for (const keyPrefix of ["access:", "receipt:", "search-ticket:", "search-operation:", "search-operation-history-v1", prefix])
      if ((await store.list({ prefix: keyPrefix, limit: 1 })).size) throw Error("initial_recovery_history_present");
    return { initial, index, quarantine: true, activePresent: active !== undefined, active: null };
  }
  private hash(previous: Previous) { return bridgeHash(["initial-recovery-v1", this.scope, previous]); }
  async witness(previousId: string, stopped: () => boolean) {
    try {
      if (!stopped() || !this.store.transaction) throw Error("initial_recovery_unavailable");
      return await this.store.transaction(async tx => {
        const previous = await this.snapshot(tx, previousId), witnessHash = await this.hash(previous);
        if (!stopped()) throw Error("initial_recovery_process_active");
        return { state: "available" as const, indexEpoch: previous.index.epoch,
          operationId: previous.initial.ticket.operationId, witnessHash };
      });
    } catch { return { state: "blocked" as const, reason: "initial_recovery_not_eligible" }; }
  }
  async reserve(ticket: InitialIngestTicket, proof: InitialRecoveryProof, stopped: () => boolean,
    authorizeCreation: () => Promise<boolean>): Promise<Reserved | Refusal> {
    proof = initialRecoveryProof.parse(proof); ticket = initialTicketSchema.parse(ticket);
    if (!this.store.transaction || proof.previousId === ticket.itemId || ticket.admissionKind !== "owner_once"
      || ticket.indexEpoch !== proof.indexEpoch || ticket.operationId !== proof.operationId)
      return { state: "blocked", reason: "initial_recovery_input_changed" };
    return this.store.transaction(async tx => {
      const raw = await tx.get(prefix + proof.previousId);
      if (raw !== undefined) {
        const record = recoveryRecord.parse(raw), current = initialStateSchema.parse(await tx.get("initial-ingest-v1"));
        if (await bridgeHash(record.proof) !== await bridgeHash(proof) || !sameInitial(record.ticket, ticket)
          || !sameInitial(current.ticket, ticket) || record.previous.initial.state !== "uncertain"
          || record.previous.initial.ticket.itemId !== proof.previousId || record.previous.initial.ticket.admissionKind !== "owner_once"
          || record.previous.index.namespace !== JSON.stringify(this.scope) || record.previous.index.epoch !== proof.indexEpoch
          || record.previous.initial.ticket.indexEpoch !== proof.indexEpoch || record.previous.initial.ticket.operationId !== proof.operationId
          || await this.hash(record.previous) !== proof.witnessHash) throw Error("initial_recovery_record_changed");
        // A later failed dispatch must keep its own quarantine. A committed journal
        // only releases memory quarantine while its reservation is still pristine.
        if (current.state !== "reserved") return { state: "already_admitted", created: false, ticket, clearQuarantine: false };
        if (!stopped()) throw Error("initial_recovery_process_active");
        for (const key of ["index", "active", "quarantine", "checkpoint", "rebuild", "maintenance"])
          if (await tx.get(key) !== undefined) throw Error("initial_recovery_projection_changed");
        if (!tx.list) throw Error("initial_recovery_storage_unavailable");
        for (const history of ["access:", "receipt:", "search-ticket:", "search-operation:", "search-operation-history-v1"])
          if ((await tx.list({ prefix: history, limit: 1 })).size) throw Error("initial_recovery_projection_changed");
        return { state: "reserved", created: false, ticket, clearQuarantine: true };
      }
      if (!stopped() || !tx.delete || !await authorizeCreation()) throw Error("initial_recovery_denied");
      const previous = await this.snapshot(tx, proof.previousId);
      if (previous.index.epoch !== proof.indexEpoch || previous.initial.ticket.operationId !== ticket.operationId
        || await this.hash(previous) !== proof.witnessHash || !stopped()) throw Error("initial_recovery_witness_changed");
      await tx.put(prefix + proof.previousId, recoveryRecord.parse({ version: 1, proof, ticket, previous }));
      await tx.put("initial-ingest-v1", { state: "reserved", ticket });
      for (const key of ["index", "quarantine", "active"]) await tx.delete(key);
      return { state: "reserved", created: true, ticket, clearQuarantine: true };
    });
  }
}
