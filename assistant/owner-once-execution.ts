import type { AssistantEnv } from "./env";
import { SourceAccess } from "./access";
import { onceAuthority, onceKey, completedOwnerOnce, type OnceGrant, type OnceReceipt, type OnceScope } from "./owner-once-guard";
import { engineName } from "./container";
import { JobQueue, type JobLease } from "./queue";
import { jobRequest } from "./agent/contracts";
import { bridgeHash } from "./ingress";
import { hostConfiguredSearch } from "./configured-search";
import { runtimeHost } from "./agent-runtime/runtime";
import { episodeDriver } from "./agent-runtime/driver";
import type { EpisodeDriver } from "./agent/controller";
import type { ModelAdapter } from "./model-broker";
import type { EngineIngest, InitialIngestTicket } from "./engine";
export type OnceExecutionOptions = { model?: ModelAdapter; driver?: EpisodeDriver };
type Slot = { state: string; index_epoch: string; source_ref_json: string };
const ns = "installation_id=? AND generation=? AND source_epoch=? AND source_generation=?";

/** One selected bounded step. Existing ingestion/search/episode ledgers own all
 * attempts and uncertainty; these receipts never become a second state machine. */
export class OnceExecution {
  constructor(private env: AssistantEnv, private scope: OnceScope, private receipt: OnceReceipt, private grant: OnceGrant,
    private clock = Date.now, private options: OnceExecutionOptions = {}) {}
  private keys() { return [this.scope.installationId, this.scope.generation, this.scope.sourceEpoch, this.scope.sourceGeneration]; }
  private sql(text: string, ...values: (string | number | null)[]) { return this.env.DB!.prepare(text).bind(...values); }
  private result(state: string, phase: string, reason?: string) { return { state, phase, id: this.receipt.id, jobId: this.receipt.jobId, ...(reason ? { reason } : {}) }; }
  private async authority() {
    const authority = await onceAuthority(this.env, this.scope, this.grant, this.clock());
    if (this.clock() >= this.receipt.deadlineAt || !await this.sql(`SELECT 1 WHERE ${authority.guard.sql}`, ...authority.guard.values).first())
      throw new Error("owner_once_execution_changed");
    return authority.guard;
  }
  private slot(sourceId: string) {
    return this.sql(`SELECT state,index_epoch,source_ref_json FROM assistant_routine_ingestions WHERE ${ns} AND item_id=? AND source_id=?`,
      ...this.keys(), this.receipt.id, sourceId).first<Slot>();
  }
  private async finishSlot(sourceId: string, epoch: string) {
    await this.sql(`UPDATE assistant_routine_ingestions SET state='complete' WHERE ${ns} AND item_id=? AND source_id=?
      AND index_epoch=? AND state IN ('attempting','uncertain')`, ...this.keys(), this.receipt.id, sourceId, epoch).run();
  }
  private async ensureRecovery(): Promise<ReturnType<OnceExecution["result"]> | null> {
    if (!this.receipt.recovery) return null;
    const source = await new SourceAccess(this.env.DB!, this.scope).read({ kind: "owner" }, this.receipt.sourceId, this.receipt.expectedRevision, this.clock());
    if (!source || !source.text?.trim()) return this.result("blocked", "recovery", "source_changed");
    const engine = this.env.COGNEE!.get(this.env.COGNEE!.idFromName(engineName(this.scope.installationId, this.scope.generation)));
    const input: EngineIngest = { actor: { kind: "owner" }, source, ownerOnce: this.grant };
    await this.authority();
    const result = await engine.reserveRecoveredInitialIngest(input,
      { kind: "owner_once", itemId: this.receipt.id, owner: this.grant.token }, this.receipt.recovery);
    if (result.state === "blocked" || result.state === "uncertain") return this.result(result.state, "recovery", result.reason);
    return result.created ? this.result("pending", "recovery_reserved") : null;
  }
  private async index(): Promise<ReturnType<OnceExecution["result"]> | null> {
    const engine = this.env.COGNEE!.get(this.env.COGNEE!.idFromName(engineName(this.scope.installationId, this.scope.generation)));
    const state = await engine.lifecycleState();
    if (state.busy) return this.result("pending", "index_busy");
    if (state.quarantine || state.index?.lost || state.maintenance) return this.result("blocked", "index", "index_maintenance_required");
    if (!state.index && !state.imageConfigured) return this.result("blocked", "index", "engine_image_unconfigured");
    // The shared Cognee dataset may process pending documents. This first
    // capability therefore refuses foreign/stale indexed originals entirely.
    if (state.index?.sources.some(ref => !this.receipt.corpus.refs.some(pin => pin.id === ref.id && pin.revision === ref.revision && pin.version === ref.version)))
      return this.result("blocked", "index", "index_outside_owner_corpus");
    const access = new SourceAccess(this.env.DB!, this.scope), ordered = [...this.receipt.corpus.refs].sort((a, b) =>
      a.id === this.receipt.sourceId ? -1 : b.id === this.receipt.sourceId ? 1 : a.id.localeCompare(b.id));
    for (const pin of ordered) {
      const source = await access.read({ kind: "owner" }, pin.id, pin.revision, this.clock());
      if (!source || source.fence.source.version !== pin.version || !source.text?.trim()) return this.result("blocked", "index", "source_changed");
      const ref = { id: source.id, revision: pin.revision, version: pin.version, hash: source.fence.source.hash }, serialized = JSON.stringify(ref);
      const input: EngineIngest = { actor: { kind: "owner" }, source, ownerOnce: this.grant,
        ...(state.index ? { expectedIndex: { indexEpoch: state.index.epoch, indexRevision: state.index.revision } } : {}) };
      let slot = await this.slot(source.id);
      if (slot && (slot.source_ref_json !== serialized || state.index && slot.index_epoch !== state.index.epoch)) return this.result("blocked", "index", "ingestion_pin_changed");
      if (slot && slot.state !== "prepared") {
        const observed = state.index ? await engine.ingestReceipt(input, slot.index_epoch) : await engine.initialIngestReceipt(input, this.receipt.id, slot.index_epoch);
        if (observed.state !== "complete") return this.result("uncertain", "index", "ingestion_receipt_unconfirmed");
        await this.finishSlot(source.id, slot.index_epoch);
        if (!state.index?.sources.some(item => item.id === ref.id && item.revision === ref.revision && item.version === ref.version && item.hash === ref.hash))
          return this.result("blocked", "index", "completed_source_missing_from_index");
        continue;
      }
      if (state.index?.sources.some(item => item.id === ref.id)) {
        if (!state.index.sources.some(item => item.id === ref.id && item.revision === ref.revision && item.version === ref.version && item.hash === ref.hash)
          || (await engine.ingestReceipt(input, state.index.epoch)).state !== "complete") return this.result("uncertain", "index", "existing_ingestion_unconfirmed");
        continue;
      }
      let ticket: InitialIngestTicket | undefined;
      const admission = { kind: "owner_once" as const, itemId: this.receipt.id, owner: this.grant.token };
      if (!state.index) {
        const reserved = await engine.reserveInitialIngest(input, admission);
        if (reserved.state !== "reserved") return this.result(reserved.state === "uncertain" ? "uncertain" : "blocked", "index", reserved.reason);
        ticket = reserved.ticket;
      } else {
        if (!state.running) return this.warm(engine, state);
        const preflight = await engine.indexPreflight({ indexEpoch: state.index.epoch, indexRevision: state.index.revision });
        if (preflight.state !== "verified") return this.result("blocked", "index", "index_preflight_unavailable");
      }
      const epoch = ticket?.indexEpoch ?? state.index!.epoch, guard = await this.authority();
      await this.sql(`INSERT INTO assistant_routine_ingestions SELECT ?,?,?,?,?,?,?,?,'prepared' WHERE ${guard.sql} ON CONFLICT DO NOTHING`,
        ...this.keys(), this.receipt.id, source.id, serialized, epoch, ...guard.values).run();
      slot = await this.slot(source.id);
      if (!slot || slot.source_ref_json !== serialized || slot.index_epoch !== epoch) return this.result("blocked", "index", "ingestion_pin_changed");
      const claimed = await this.sql(`UPDATE assistant_routine_ingestions SET state='attempting' WHERE ${ns} AND item_id=? AND source_id=?
        AND source_ref_json=? AND index_epoch=? AND state='prepared' AND (${guard.sql}) RETURNING source_id`,
        ...this.keys(), this.receipt.id, source.id, serialized, epoch, ...guard.values).first();
      if (!claimed) return this.result("pending", "index_busy");
      let outcome: { state?: string; indexRevision?: string };
      try { outcome = await (ticket ? engine.commitInitialIngest(input, ticket, admission) : engine.ingest(input)) as { state?: string; indexRevision?: string }; }
      catch { return this.result("uncertain", "index", "ingestion_ack_unconfirmed"); }
      if (outcome.state !== "complete") {
        await this.sql(`UPDATE assistant_routine_ingestions SET state='uncertain' WHERE ${ns} AND item_id=? AND source_id=? AND state='attempting'`,
          ...this.keys(), this.receipt.id, source.id).run();
        return this.result("uncertain", "index", "ingestion_unconfirmed");
      }
      await this.finishSlot(source.id, epoch);
      // Persist the derived filesystem before yielding to another operator RPC:
      // inactivity or a DO restart can stop the process between selected steps.
      const fresh = await engine.lifecycleState();
      if (!fresh.running || fresh.busy || fresh.quarantine || fresh.maintenance || !fresh.index || fresh.index.lost
        || fresh.index.epoch !== epoch || fresh.index.revision !== outcome.indexRevision)
        return this.result("blocked", "checkpoint", "indexed_projection_changed");
      await this.authority();
      try {
        const checkpoint = await engine.checkpoint({ indexEpoch: epoch, indexRevision: fresh.index.revision });
        if (checkpoint.state !== "checkpoint_confirmed") return this.result("uncertain", "checkpoint", "checkpoint_unconfirmed");
      } catch { return this.result("uncertain", "checkpoint", "checkpoint_ack_unconfirmed"); }
      return this.result("pending", "indexed");
    }
    if (!state.index) return this.result("blocked", "index", "index_unavailable");
    if (!state.running) return this.warm(engine, state);
    const preflight = await engine.indexPreflight({ indexEpoch: state.index.epoch, indexRevision: state.index.revision });
    if (preflight.state !== "verified") return this.result("blocked", "index", "index_preflight_unavailable");
    if (state.index.state !== "checkpoint_confirmed") {
      await this.authority();
      const result = await engine.checkpoint({ indexEpoch: state.index.epoch, indexRevision: state.index.revision });
      return this.result(result.state === "checkpoint_confirmed" ? "pending" : "uncertain", "checkpoint");
    }
    return null;
  }
  private async warm(engine: ReturnType<NonNullable<AssistantEnv["COGNEE"]>["get"]>, state: Awaited<ReturnType<typeof engine.lifecycleState>>) {
    const index = state.index, checkpoint = state.checkpoint;
    if (!index || !checkpoint || checkpoint.phase !== "confirmed" || checkpoint.epoch !== index.epoch || checkpoint.revision !== index.revision)
      return this.result("blocked", "index", "compatible_checkpoint_required");
    const preflight = await engine.indexPreflight({ indexEpoch: index.epoch, indexRevision: index.revision });
    if (preflight.state !== "current_metadata") return this.result("blocked", "index", "index_preflight_unavailable");
    await this.authority();
    const restored = await engine.restoreCheckpoint({ checkpointId: checkpoint.id, indexEpoch: index.epoch, indexRevision: index.revision });
    return this.result(restored.state === "checkpoint_confirmed" ? "pending" : "uncertain", "restored");
  }
  async advance() {
    const completed = await completedOwnerOnce(this.env, this.scope, this.receipt);
    if (completed) return { ...this.result("complete", "published"), decisionId: completed };
    await this.authority();
    const queue = new JobQueue(this.env.DB!, this.scope), job = await queue.get(this.receipt.jobId), ledger = await queue.ledger(this.receipt.jobId);
    if (!job || !ledger) return this.result("blocked", "job", "job_unavailable");
    const request = jobRequest.parse(JSON.parse(ledger.request_json));
    if (await bridgeHash(request.input) !== this.receipt.queryHash || request.subject.kind !== "owner_request"
      || request.subject.requestKey !== onceKey(this.receipt.id)) return this.result("blocked", "job", "job_changed");
    const host = runtimeHost(this.env, "owner_read", { clock: this.clock, model: this.options.model }), driver = this.options.driver ?? episodeDriver;
    const existing = await this.sql("SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=? AND job_id=? ORDER BY episode_generation DESC LIMIT 1",
      this.scope.installationId, this.scope.generation, job.id).first<{ id: string }>();
    if (existing) {
      const episode = await host.episodes.get(existing.id);
      if (!episode) return this.result("uncertain", "episode", "episode_unavailable");
      if (!episode.receipt) {
        const result = episode.state === "prepared" ? await host.dispatch(episode.id, driver) : await host.reconcile(episode.id, driver);
        return this.result(result.state === "accepted" ? "pending" : result.state, "dispatched");
      }
      const result = await host.read(episode.id, driver);
      return result.state === "shadow_completed" ? { ...this.result("complete", "published"), decisionId: result.decisionId }
        : this.result(result.state, "episode");
    }
    if (!["pending", "processing"].includes(job.state) || ledger.state !== "prepared") return this.result("uncertain", "job", "job_not_retriable");
    const recovered = await this.ensureRecovery(); if (recovered) return recovered;
    const indexed = await this.index(); if (indexed) return indexed;
    const { search } = hostConfiguredSearch(this.env, "owner_read", this.clock), guard = await this.authority();
    const progress = await search.start({ kind: "owner" }, onceKey(this.receipt.id), { query: request.input, projectId: this.receipt.projectId }, { ownerOnceId: this.receipt.id, guard });
    if (progress.state === "pending") {
      await search.step({ kind: "owner" }, { runId: progress.runId, stepId: `owner-once-${progress.checkpoint}`, expectedCheckpoint: progress.checkpoint });
      return this.result("pending", "search");
    }
    const found = await search.result({ kind: "owner" }, progress.runId);
    if (found.state !== "ready") {
      await this.authority(); await search.advanceSemantic({ kind: "owner" }, progress.runId);
      return this.result("pending", "semantic");
    }
    const lease = job.state === "pending" ? await queue.claimId(job.id, this.clock(), 90000, await this.authority())
      : job.lease_until !== null && job.lease_until > this.clock() ? job as JobLease : null;
    if (!lease) return this.result("uncertain", "job", "lease_unavailable");
    const episode = await host.prepare(lease, "owner", progress.runId);
    return { ...this.result("pending", "prepared"), episodeId: episode.id };
  }
}
