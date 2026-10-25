import { JobQueue, type JobLease } from "./queue";

// A synthetic adapter only in this milestone. No fetch, model binding or effect
// credentials live here. Paid inference must first integrate budget reservation.
export interface ShadowProvider {
  // Persistent host-side budget reservation. A refusal never admits inference.
  prepare?(key: string, hash: string, effectiveRequest: string): Promise<"ready" | "budget_blocked">;
  execute(key: string, hash: string, effectiveRequest: string): Promise<string>;
  lookup(key: string, hash: string): Promise<{ state: "complete"; result: string } | { state: "not_found" | "unavailable" }>;
}
export class JobController {
  constructor(private readonly queue: JobQueue, private readonly provider: ShadowProvider, private readonly clock = Date.now) {}
  private async publish(lease: JobLease) {
    if (await this.queue.publish(lease, this.clock())) return "shadow_completed";
    return await this.queue.fail(lease, "publication_rejected", this.clock()) ? "blocked" : "stale";
  }
  async process(lease: JobLease): Promise<string> {
    lease = Object.freeze({ ...lease });
    if (!await this.queue.isCurrent(lease, this.clock())) return "stale";
    const ledger = await this.queue.ledger(lease.id);
    if (!ledger) {
      await this.queue.fail(lease, "missing_request_ledger", this.clock());
      return "blocked";
    }
    if (ledger.state === "complete") return this.publish(lease);
    if (ledger.state === "attempting" && ledger.admitted_lease_generation === lease.lease_generation) return "stale";
    const key = this.queue.operationKey(lease.id, ledger.request_hash);
    if (ledger.state !== "prepared") {
      // not_found is not proof that an old executor will never resume. Never
      // infer again after admission, even with the same external operation key.
      try {
        const found = await this.provider.lookup(key, ledger.request_hash);
        if (found.state === "complete") {
          if (await this.queue.complete(lease, found.result, this.clock())) return "shadow_completed";
          return await this.queue.fail(lease, "publication_rejected", this.clock()) ? "blocked" : "stale";
        }
      } catch { /* The operation remains uncertain; do not disclose provider errors. */ }
      await this.queue.uncertain(lease);
      await this.queue.fail(lease, "provider_result_uncertain", this.clock());
      return "uncertain";
    }
    if (this.provider.prepare) {
      let reason: string | null = null;
      try {
        if (await this.provider.prepare(key, ledger.request_hash, ledger.request_json) !== "ready") reason = "budget_blocked";
      } catch { reason = "budget_preparation_uncertain"; }
      if (reason) return await this.queue.fail(lease, reason, this.clock(), false, true) ? "blocked" : "stale";
    }
    let admitted;
    try { admitted = await this.queue.admit(lease, this.clock()); }
    catch {
      // This response cannot identify the CAS winner, including another caller
      // holding the same lease. Preserve its state and wait for lease expiry;
      // a later claimant inspects the ledger and only looks up attempted work.
      return "uncertain";
    }
    if (!admitted) {
      if ((await this.queue.ledger(lease.id))?.state !== "prepared") return "stale";
      return await this.queue.fail(lease, "admission_rejected", this.clock()) ? "blocked" : "stale";
    }
    try {
      const result = await this.provider.execute(key, admitted.request_hash, admitted.request_json);
      if (await this.queue.complete(lease, result, this.clock())) return "shadow_completed";
      return await this.queue.fail(lease, "publication_rejected", this.clock()) ? "blocked" : "stale";
    } catch {
      await this.queue.uncertain(lease);
      await this.queue.fail(lease, "provider_execution_uncertain", this.clock(), true);
      return "uncertain";
    }
  }
}
