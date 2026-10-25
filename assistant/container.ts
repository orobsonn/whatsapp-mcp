import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AssistantEnv } from "./env";
import { SourceAccess, type SourceFence, type TrustedActor } from "./access";
import { CogneeEngine, type ContainerPort, type EngineGuard, type EngineIngest, type EnginePermit, type EngineSearch } from "./engine";
import { CogneeModelBroker } from "./model-broker";
import { createOpenAIAdapter, DEFAULT_BROKER_CONFIG } from "./model-transport";
import { OriginGuard } from "./origin-guard";
import { bridgeHash } from "./ingress";
import { CheckpointController, type CheckpointManifest, type CheckpointResult, type CheckpointState, type CheckpointStore, type IndexProof, type SnapshotHandle } from "./checkpoints";
import build from "./cognee/build-fingerprint.json";
const deny = () => Response.json({ error: "engine_denied" }, { status: 403, headers: { "Cache-Control": "no-store" } });
export const engineName = (installationId: string, generation: string) => JSON.stringify(["cognee", installationId, generation]);
export async function boundedJson(request: Request | Response, max = 65536): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw 0;
  let size = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw 0; text += decoder.decode(part.value, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
type Grant = { token: string; period: string };
type Authority = { authorize(epoch: string): Promise<Grant | null> };
type Broker = { invoke(token: string, path: string, body: unknown): Promise<{ state: string; body?: unknown }> };
/** Fixed outbound route only. It never forwards caller headers or provider errors. */
export async function handleBrokerRequest(request: Request, epoch: string, host: Authority, makeBroker: (period: string) => Broker): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.protocol !== "http:" || url.host !== "broker.internal" || url.search || !["/v1/chat/completions", "/v1/embeddings"].includes(url.pathname)) return deny();
    const body = await boundedJson(request), grant = await host.authorize(epoch); if (!grant) return deny();
    const result = await makeBroker(grant.period).invoke(grant.token, url.pathname, body);
    if (result.state !== "complete" || !await host.authorize(epoch)) return deny();
    return Response.json(result.body, { headers: { "Cache-Control": "no-store" } });
  } catch { return deny(); }
}
export class DirectContainerPort implements ContainerPort {
  constructor(private container: Container, private outbound: (epoch: string) => Fetcher,
    private scope: { installationId: string; generation: string }) {}
  get running() { return this.container.running; }
  async start() {
    return this.boot();
  }
  private async boot(snapshot?: SnapshotHandle) {
    if (!this.container.running) this.container.start({ ...(snapshot ? { containerSnapshot: { id: snapshot.id } } : { image: this.container.images.cognee }), instance: "standard-1", enableInternet: false,
      env: { ASSISTANT_INSTALLATION_ID: this.scope.installationId, ASSISTANT_GENERATION: this.scope.generation, ASSISTANT_CONFIGURATION_HASH: await bridgeHash(DEFAULT_BROKER_CONFIG) } });
    await this.container.setInactivityTimeout(60000);
    // running means process allocated, not ready. Initialization receives no model permit.
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1500);
      try { const response = await this.container.getTcpPort(8080).fetch("http://container/health", { signal: controller.signal }); await response.body?.cancel(); if (response.ok) return; }
      catch { /* Port may not yet be listening. */ } finally { clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("engine_start_timeout");
  }
  intercept(epoch: string) { return this.container.interceptOutboundHttp("broker.internal", this.outbound(epoch)); }
  deny() { return this.intercept(""); }
  async destroy() { if (this.container.running) await this.container.destroy(); }
  async snapshot(name: string): Promise<SnapshotHandle> {
    const handle = await this.container.snapshotContainer({ name }); return { id: handle.id, size: handle.size };
  }
  async restore(snapshot: SnapshotHandle) {
    if (this.container.running) throw new Error("checkpoint_requires_stopped_instance");
    await this.boot(snapshot); await this.deny();
  }
  async quiesce(manifest: CheckpointManifest): Promise<IndexProof> { return this.proof("/quiesce", { manifest }); }
  async inspect(): Promise<IndexProof> { return this.proof("/inspect-index", {}); }
  private async proof(path: string, body: unknown): Promise<IndexProof> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    try {
      const result = await this.request(path, body, controller.signal) as { ok?: boolean; result?: IndexProof };
      if (result.ok !== true || !result.result) throw new Error("checkpoint_response"); return result.result;
    } finally { clearTimeout(timer); }
  }
  async request(path: string, body: unknown, signal?: AbortSignal) {
    const controller = new AbortController(), timer = signal ? undefined : setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.container.getTcpPort(8080).fetch("http://container" + path,
        path === "/health" ? { signal: signal ?? controller.signal } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal ?? controller.signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("engine_request_failed"); }
      return await boundedJson(response);
    } finally { clearTimeout(timer); }
  }
}
function configured(env: AssistantEnv) {
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || !env.OPENAI_API_KEY) throw new Error("engine_unconfigured");
  return { db: env.DB, installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION };
}
export class CanonicalEngineGuard implements EngineGuard {
  private access: SourceAccess;
  constructor(private env: AssistantEnv) { const scope = configured(env); this.access = new SourceAccess(scope.db, { installationId: scope.installationId, generation: scope.generation }); }
  async check(actor: TrustedActor, permits: EnginePermit[]) {
    try {
      const scope = configured(this.env);
      for (const permit of permits) {
        const guard = this.access.guard(actor, permit.source, Date.now());
        if (!await scope.db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()) return false;
        if (permit.source.source.origin === "whatsapp" && !permit.origin) return false;
        if (permit.origin) {
          if (permit.origin.canonicalId !== permit.source.source.id || permit.origin.revision !== permit.source.source.revision || permit.origin.version !== permit.source.source.version) return false;
          if (!this.env.CAPTURE_READER || !this.env.BRIDGE_SECRET || !this.env.BRIDGE_SOURCE_EPOCH || !this.env.BRIDGE_SOURCE_GENERATION) return false;
          const origin = new OriginGuard(scope.db, () => ({ ...scope, sourceEpoch: this.env.BRIDGE_SOURCE_EPOCH!, sourceGeneration: this.env.BRIDGE_SOURCE_GENERATION! }), this.env.CAPTURE_READER, this.env.BRIDGE_SECRET);
          if (!await origin.check(permit.origin)) return false;
        }
      }
      return true;
    } catch { return false; }
  }
  issue(source: SourceFence, expiresAt: number) {
    const scope = configured(this.env);
    return new CogneeModelBroker(scope.db, { installationId: scope.installationId, generation: scope.generation, period: new Date().toISOString().slice(0, 10) }, DEFAULT_BROKER_CONFIG, createOpenAIAdapter(this.env.OPENAI_API_KEY!))
      .issuePermit(source.source.id, source.source.revision, expiresAt);
  }
  async revoke(token: string) {
    const scope = configured(this.env);
    await scope.db.prepare("DELETE FROM assistant_model_permits WHERE installation_id=? AND generation=? AND token_hash=?")
      .bind(scope.installationId, scope.generation, await bridgeHash(token)).run();
  }
}
export class CogneeContainer extends DurableObject<AssistantEnv> {
  private engine?: CogneeEngine;
  private port?: DirectContainerPort;
  private checkpointStore(): CheckpointStore {
    return { read: async () => await this.ctx.storage.get<CheckpointState>("checkpoint") ?? null,
      compareAndSet: (revision, next) => this.ctx.storage.transaction(async transaction => {
        const prior = await transaction.get<CheckpointState>("checkpoint"); if ((prior?.revision ?? null) !== revision) return false;
        await transaction.put("checkpoint", next); return true;
      }) };
  }
  private async checkpoints() {
    this.host(); const scope = configured(this.env);
    return new CheckpointController({ installationId: scope.installationId, generation: scope.generation,
      imageRef: this.ctx.container!.images.cognee, buildFingerprint: build.buildFingerprint, configurationHash: await bridgeHash(DEFAULT_BROKER_CONFIG), engineVersion: "1.6.5" },
    this.checkpointStore(), this.port!, async manifest => {
      const access = new SourceAccess(scope.db, { installationId: scope.installationId, generation: scope.generation });
      const guard = new CanonicalEngineGuard(this.env);
      for (const stamp of manifest.sources) {
        const source = await access.read({ kind: "owner" }, stamp.id, stamp.revision);
        if (!source || source.fence.source.version !== stamp.version || source.fence.source.hash !== stamp.hash) return false;
        let origin;
        if (source.fence.source.origin === "whatsapp") {
          if (!this.env.CAPTURE_READER || !this.env.BRIDGE_SECRET || !this.env.BRIDGE_SOURCE_EPOCH || !this.env.BRIDGE_SOURCE_GENERATION) return false;
          origin = await new OriginGuard(scope.db, () => ({ installationId: scope.installationId, generation: scope.generation,
            sourceEpoch: this.env.BRIDGE_SOURCE_EPOCH!, sourceGeneration: this.env.BRIDGE_SOURCE_GENERATION! }), this.env.CAPTURE_READER, this.env.BRIDGE_SECRET).fence(stamp.id);
          if (!origin) return false;
        }
        if (!await guard.check({ kind: "owner" }, [{ source: source.fence, ...(origin ? { origin } : {}) }])) return false;
      }
      return true;
    });
  }
  private host() {
    if (!this.engine) {
      const scope = configured(this.env);
      if (!this.ctx.container || !this.env.COGNEE || this.ctx.id.toString() !== this.env.COGNEE.idFromName(engineName(scope.installationId, scope.generation)).toString()) throw new Error("engine_unconfigured");
      const exports = this.ctx.exports as unknown as { CogneeBroker(options: { props: { epoch: string; owner: string } }): Fetcher };
      const port = new DirectContainerPort(this.ctx.container, epoch => exports.CogneeBroker({ props: { epoch, owner: this.ctx.id.toString() } }), scope);
      this.port = port;
      this.engine = new CogneeEngine(scope, this.ctx.storage, port, new CanonicalEngineGuard(this.env));
    }
    return this.engine;
  }
  fetch() { return Promise.resolve(deny()); }
  ingest(input: EngineIngest) { return this.host().ingest(input); }
  search(input: EngineSearch) { return this.host().search(input); }
  lookup(id: string) { return this.host().lookup(id); }
  authorize(epoch: string) { return epoch ? this.host().authorize(epoch) : Promise.resolve(null); }
  checkpoint() {
    return this.host().maintain<CheckpointResult>(async plan => {
      if (!plan) return { value: { state: "rebuild_required", reason: "index_lost" } };
      const result = await (await this.checkpoints()).create(plan), state = await this.checkpointStore().read();
      return { value: result, ...(result.state === "checkpoint_confirmed" ? { restored: state!.confirmed!.manifest } : {}) };
    });
  }
  restoreCheckpoint() {
    return this.host().maintain(async () => {
      const result = await (await this.checkpoints()).restore(), state = await this.checkpointStore().read();
      return { value: result, ...(result.state === "checkpoint_confirmed" ? { restored: state!.confirmed!.manifest } : {}) };
    }, true);
  }
  async checkpointStatus() {
    this.host(); const state = await this.checkpointStore().read(), record = state?.confirmed;
    return { state: state?.phase ?? "missing", checkpointId: record?.id ?? null, indexRevision: record?.manifest.indexRevision ?? null,
      sourceCount: record?.manifest.sources.length ?? 0, snapshotBytes: record?.snapshot.size ?? null, restoredAt: record?.restoredAt ?? null };
  }
}
export class CogneeBroker extends WorkerEntrypoint<AssistantEnv, { epoch: string; owner: string }> {
  async fetch(request: Request) {
    try {
      const { epoch, owner } = this.ctx.props;
      if (!epoch || !owner || !this.env.COGNEE) return deny();
      const scope = configured(this.env), host = this.env.COGNEE.get(this.env.COGNEE.idFromString(owner));
      return await handleBrokerRequest(request, epoch, host, period => new CogneeModelBroker(scope.db,
        { installationId: scope.installationId, generation: scope.generation, period }, DEFAULT_BROKER_CONFIG, createOpenAIAdapter(this.env.OPENAI_API_KEY!)));
    } catch { return deny(); }
  }
}
