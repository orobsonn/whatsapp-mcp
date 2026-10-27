import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AssistantEnv } from "./env";
import { SourceAccess, type SourceFence, type TrustedActor } from "./access";
import { CogneeEngine, type ContainerPort, type EngineGuard, type EngineIngest, type EnginePermit, type EngineSearch, type SearchTicket,type InitialIngestAdmission,type InitialIngestTicket,type InitialIngestCheckInput } from "./engine";
import { RetrievalRuns, type CoverageProof } from "./retrieval-runs";
import { CogneeModelBroker } from "./model-broker";
import { createOpenAIAdapter, DEFAULT_BROKER_CONFIG } from "./model-transport";
import { OriginGuard, checkOriginsWithin, type OriginFence } from "./origin-guard";
import { bridgeHash } from "./ingress";
import { CheckpointController, type CheckpointFence, type CheckpointManifest, type CheckpointPlan, type CheckpointResult, type CheckpointState, type CheckpointStore, type IndexProof, type SnapshotHandle } from "./checkpoints";
import build from "./cognee/build-fingerprint.json";
import { RebuildController, validIndexProof, type RebuildState, type RebuildStore } from "./rebuild";
import type { SourceStamp } from "./checkpoints";
import { z } from "zod";
import { assertRestoredGeneration } from "./retention-runtime";
import {retentionExecutionGuard} from './retention-execution';
import { onceAuthority, onceScope } from "./owner-once-guard";
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
type Grant = { token: string; period: string; mode?: "replay_only"; coverage?: CoverageProof };
type Authority = { authorize(epoch: string): Promise<Grant | null> };
type Broker = { invoke(token: string, path: string, body: unknown): Promise<{ state: string; body?: unknown }>; replay?(token: string, path: string, body: unknown): Promise<{ state: string; body?: unknown }> };
type LifecycleCheck = () => Promise<void>;
async function checked<T>(check: LifecycleCheck | undefined, effect: () => Promise<T>): Promise<T> {
  if (check) await check();
  try { const value = await effect(); if (check) await check(); return value; }
  catch (error) { if (check) await check(); throw error; }
}
/** Fixed outbound route only. It never forwards caller headers or provider errors. */
export async function handleBrokerRequest(request: Request, epoch: string, host: Authority, makeBroker: (period: string, coverage?: CoverageProof) => Broker): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.protocol !== "http:" || url.host !== "broker.internal" || url.search || !["/v1/chat/completions", "/v1/embeddings"].includes(url.pathname)) return deny();
    const body = await boundedJson(request), grant = await host.authorize(epoch); if (!grant) return deny();
    const broker = makeBroker(grant.period,grant.coverage);
    const result = grant.mode === "replay_only" ? await broker.replay?.(grant.token, url.pathname, body) : await broker.invoke(grant.token, url.pathname, body);
    if (result?.state !== "complete" || !await host.authorize(epoch)) return deny();
    return Response.json(result.body, { headers: { "Cache-Control": "no-store" } });
  } catch { return deny(); }
}
export class DirectContainerPort implements ContainerPort {
  constructor(private container: Container, private outbound: (epoch: string) => Fetcher,
    private scope: { installationId: string; generation: string }) {}
  get running() { return this.container.running; }
  async start(check?:LifecycleCheck) {
    if(check&&this.container.running)throw Error('initial_process_not_stopped');return this.boot(undefined,check);
  }
  private async boot(snapshot?: SnapshotHandle, check?: LifecycleCheck) {
    if (!this.container.running) {
      const hash = await checked(check, () => bridgeHash(DEFAULT_BROKER_CONFIG));
      if (check) await check();
      if(check&&!snapshot&&this.container.running)throw Error('initial_process_not_stopped');
      this.container.start({ ...(snapshot ? { containerSnapshot: { id: snapshot.id } } : { image: this.container.images.cognee }), instance: "standard-1", enableInternet: false,
        env: { ASSISTANT_INSTALLATION_ID: this.scope.installationId, ASSISTANT_GENERATION: this.scope.generation, ASSISTANT_CONFIGURATION_HASH: hash } });
    }
    await checked(check, () => this.container.setInactivityTimeout(60000));
    // running means process allocated, not ready. Initialization receives no model permit.
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1500);
      try { const response = await checked(check, () => this.container.getTcpPort(8080).fetch("http://container/health", { signal: controller.signal })); await checked(check, async () => { await response.body?.cancel(); }); if (response.ok) return; }
      catch { if (check) await check(); /* Port may not yet be listening. */ } finally { clearTimeout(timer); }
      await checked(check, () => new Promise(resolve => setTimeout(resolve, 250)));
    }
    throw new Error("engine_start_timeout");
  }
  intercept(epoch: string) { return this.container.interceptOutboundHttp("broker.internal", this.outbound(epoch)); }
  deny(check?: LifecycleCheck) { return checked(check, () => this.intercept("")); }
  async destroy(check?: LifecycleCheck) {
    if (check) await check();
    if (this.container.running) await checked(check, () => this.container.destroy());
    if (this.container.running) throw new Error("checkpoint_destroy_uncertain");
  }
  async snapshot(name: string, check?: LifecycleCheck): Promise<SnapshotHandle> {
    const handle = await checked(check, () => this.container.snapshotContainer({ name })); return { id: handle.id, size: handle.size };
  }
  async restore(snapshot: SnapshotHandle, check?: LifecycleCheck) {
    if (check) await check();
    if (this.container.running) throw new Error("checkpoint_requires_stopped_instance");
    await checked(check, () => this.boot(snapshot, check)); await this.deny(check);
  }
  async quiesce(manifest: CheckpointManifest, check?: LifecycleCheck): Promise<IndexProof> { return this.proof("/quiesce", { manifest }, check); }
  async inspect(check?: LifecycleCheck): Promise<IndexProof> { return this.proof("/inspect-index", {}, check); }
  async verify(manifest: CheckpointManifest): Promise<IndexProof> { return this.proof("/verify-index", { manifest }); }
  private async proof(path: string, body: unknown, check?: LifecycleCheck): Promise<IndexProof> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    try {
      const result = await checked(check, () => this.request(path, body, controller.signal)) as { ok?: boolean; result?: IndexProof };
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
function coverageHost(env:AssistantEnv,proof:CoverageProof) {
  const scope=configured(env);
  const origin=env.CAPTURE_READER && env.BRIDGE_SECRET && env.BRIDGE_SOURCE_EPOCH && env.BRIDGE_SOURCE_GENERATION ? new OriginGuard(scope.db,()=>({installationId:scope.installationId,generation:scope.generation,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!}),env.CAPTURE_READER,env.BRIDGE_SECRET) : undefined;
  // Proof is an internal capability persisted by RetrievalRuns, never MCP input.
  return new RetrievalRuns(scope.db,{installationId:scope.installationId,generation:scope.generation,...(env.BRIDGE_SOURCE_EPOCH ? {sourceEpoch:env.BRIDGE_SOURCE_EPOCH,sourceGeneration:env.BRIDGE_SOURCE_GENERATION}: {})},{purpose:proof.purpose,origin,semantic:{mode:proof.configuration.mode,engine:null as never}});
}
export class CanonicalEngineGuard implements EngineGuard {
  private access: SourceAccess;
  constructor(private env: AssistantEnv) { const scope = configured(env); this.access = new SourceAccess(scope.db, { installationId: scope.installationId, generation: scope.generation }); }
  async checkInitialAdmission(admission:InitialIngestAdmission,input:InitialIngestCheckInput,indexEpoch?:string){
    try{
      const base = { itemId: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().min(1).max(256) };
      admission = z.union([z.object(base).strict(), z.object({ ...base, kind: z.literal("owner_once"), owner: z.string().uuid() }).strict()]).parse(admission);
      if (admission.kind === "owner_once") {
        await assertRestoredGeneration(this.env);
        const scope = onceScope.parse({ installationId: this.env.INSTALLATION_ID, generation: this.env.OPERATIONAL_GENERATION,
          sourceEpoch: this.env.BRIDGE_SOURCE_EPOCH, sourceGeneration: this.env.BRIDGE_SOURCE_GENERATION });
        const authority = await onceAuthority(this.env, scope, { id: admission.itemId, token: admission.owner }, Date.now());
        const ref = input.source.fence.source;
        if (input.actor.kind !== "owner" || ref.origin !== "owner_note" || ref.audience !== "owner" || ref.projectId !== authority.receipt.projectId
          || !authority.receipt.corpus.refs.some(pin => pin.id === ref.id && pin.revision === ref.revision && pin.version === ref.version)
          || (indexEpoch !== undefined && !z.string().uuid().safeParse(indexEpoch).success) || Date.now() >= authority.receipt.deadlineAt) return false;
        const access = this.access.guard(input.actor, input.source.fence, Date.now());
        const valid = !!await this.env.DB!.prepare(`SELECT 1 WHERE (${authority.guard.sql}) AND (${access.sql})`)
          .bind(...authority.guard.values, ...access.values).first();
        return valid && Date.now() < authority.receipt.deadlineAt;
      }
      if(this.env.ROUTINES_ENABLED!=='shadow'||this.env.ROUTINES_PAUSED==='true')return false;
      await assertRestoredGeneration(this.env);const scope=configured(this.env),now=Date.now(),ref=input.source.fence.source,guard=this.access.guard(input.actor,input.source.fence,now),execution=retentionExecutionGuard(scope);
      return !!await scope.db.prepare(`SELECT 1 FROM assistant_routine_state c JOIN assistant_routine_items r USING(installation_id,generation,source_epoch,source_generation)
        WHERE c.installation_id=? AND c.generation=? AND c.source_epoch=? AND c.source_generation=? AND c.owner_token=? AND c.state='running' AND c.paused=0 AND c.lease_until>? AND c.active_item_id=r.id AND r.id=? AND r.actor_json=?
        AND EXISTS(SELECT 1 FROM json_each(r.index_sources_json) j WHERE json_extract(j.value,'$.id')=? AND json_extract(j.value,'$.revision')=? AND json_extract(j.value,'$.version')=? AND json_extract(j.value,'$.hash')=?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM assistant_routine_ingestions i WHERE i.installation_id=r.installation_id AND i.generation=r.generation AND i.source_epoch=r.source_epoch AND i.source_generation=r.source_generation AND i.item_id=r.id AND i.source_id=? AND i.index_epoch=? AND i.state='attempting' AND json_extract(i.source_ref_json,'$.revision')=? AND json_extract(i.source_ref_json,'$.version')=? AND json_extract(i.source_ref_json,'$.hash')=?))
        AND (${guard.sql}) AND (${execution.sql})`).bind(scope.installationId,scope.generation,this.env.BRIDGE_SOURCE_EPOCH!,this.env.BRIDGE_SOURCE_GENERATION!,admission.owner,now,admission.itemId,JSON.stringify(input.actor),ref.id,ref.revision,ref.version,ref.hash,indexEpoch??null,ref.id,indexEpoch??null,ref.revision,ref.version,ref.hash,...guard.values,...execution.values).first();
    }catch{return false;}
  }
  async check(actor: TrustedActor, permits: EnginePermit[], isCurrent:()=>boolean=()=>true) {
    try {
      if(!isCurrent())return false; await assertRestoredGeneration(this.env); if(!isCurrent())return false;
      const scope = configured(this.env);
      const local = async () => {
        // Original ACL statements retain independent bind-parameter budgets.
        for (let offset=0;offset<permits.length;offset+=6) {
          if(!isCurrent())return false;
          const rows=await scope.db.batch(permits.slice(offset,offset+6).map(permit=>{const guard=this.access.guard(actor,permit.source,Date.now());return scope.db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values);}));
          if(!isCurrent()||rows.length!==Math.min(6,permits.length-offset)||rows.some(row=>row.results.length!==1))return false;
        }
        return true;
      };
      for (const permit of permits) {
        if(!isCurrent())return false;
        if (permit.source.source.origin === "whatsapp" && !permit.origin) return false;
        if (permit.origin) {
          if (permit.origin.canonicalId !== permit.source.source.id || permit.origin.revision !== permit.source.source.revision || permit.origin.version !== permit.source.source.version) return false;
          if (!this.env.CAPTURE_READER || !this.env.BRIDGE_SECRET || !this.env.BRIDGE_SOURCE_EPOCH || !this.env.BRIDGE_SOURCE_GENERATION) return false;
          // Remote checks run together below with one fixed deadline.
        }
      }
      if(!await local())return false;
      const origins=permits.filter(permit=>permit.origin).map(permit=>permit.origin!);
      if(!origins.length){await assertRestoredGeneration(this.env);return isCurrent();}
      const origin=new OriginGuard(scope.db,()=>({installationId:scope.installationId,generation:scope.generation,sourceEpoch:this.env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:this.env.BRIDGE_SOURCE_GENERATION!}),this.env.CAPTURE_READER!,this.env.BRIDGE_SECRET!);
      if(!await checkOriginsWithin(origins,fence=>isCurrent()?origin.check(fence,isCurrent):Promise.resolve(false))||!isCurrent())return false;
      // Recheck local ACLs after the remote observations, before returning.
      if(!await local())return false;
      if(!isCurrent())return false;await assertRestoredGeneration(this.env);return isCurrent();
    } catch { return false; }
  }
  async checkCoverage(proof:CoverageProof) { await assertRestoredGeneration(this.env);const valid=await coverageHost(this.env,proof).checkProof(proof);await assertRestoredGeneration(this.env);return valid; }
  async issue(source: SourceFence, expiresAt: number) {
    await assertRestoredGeneration(this.env);
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
type IndexMetadata = { namespace: string; epoch: string; revision: string; sources: SourceStamp[]; lost?: boolean; indexState?: string };
export type IndexPreflight = { state: "verified" | "current_metadata"; indexEpoch: string; indexRevision: string; sourceCount: number }
  | { state: "maintenance_required" | "unavailable"; reason: string };
const indexExpectation = z.object({ indexEpoch:z.string().min(1).max(128),indexRevision:z.union([z.literal("empty"),z.string().regex(/^[a-f0-9]{64}$/)]) }).strict();
const indexStamp = z.object({id:z.string().min(1).max(256),revision:z.number().int().positive().safe(),version:z.number().int().positive().max(2147483647),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
function samePlan(plan: CheckpointPlan, index: Pick<IndexMetadata, "epoch" | "revision" | "sources">) {
  const stamps = (values: SourceStamp[]) => values.map(({ id, revision, version, hash }) => ({ id, revision, version, hash })).sort((a, b) => a.id.localeCompare(b.id));
  return plan.indexEpoch === index.epoch && plan.indexRevision === index.revision && Array.isArray(index.sources) &&
    JSON.stringify(stamps(plan.sources)) === JSON.stringify(stamps(index.sources));
}
/** The checkpoint and usable index are one owner/epoch-fenced publication.
 * Rebuild may replace the index without touching checkpoint history. */
export function makeCheckpointStore(storage: DurableObjectStorage, scope: { installationId: string; generation: string }): CheckpointStore {
  const namespace = JSON.stringify({ installationId: scope.installationId, generation: scope.generation });
  return {
    read: async () => await storage.get<CheckpointState>("checkpoint") ?? null,
    owns: fence => storage.transaction(async tx => {
      const state = await tx.get<CheckpointState>("checkpoint"), index = await tx.get<IndexMetadata>("index");
      return !!state?.index && !!index && state.owner === fence.owner && state.revision === fence.revision &&
        ["preparing", "restoring"].includes(state.phase) && state.index.indexEpoch === fence.indexEpoch &&
        index.namespace === namespace && samePlan(state.index, index) && await tx.get<boolean>("maintenance") === true;
    }),
    compareAndSet: (revision, next) => storage.transaction(async tx => {
      const prior = await tx.get<CheckpointState>("checkpoint"), index = await tx.get<IndexMetadata>("index");
      if ((prior?.revision ?? null) !== revision || !next.index || !index || index.namespace !== namespace || !samePlan(next.index, index)) return false;
      if (next.phase === "confirmed") {
        const record = next.confirmed;
        if (!record || prior?.owner !== next.owner || prior.phase !== "restoring" || prior.candidate?.id !== record.id ||
          prior.candidate.manifestHash !== record.manifestHash || prior.candidate.snapshot.id !== record.snapshot.id || prior.candidate.snapshot.size !== record.snapshot.size ||
          !samePlan(next.index, { epoch: record.manifest.indexEpoch, revision: record.manifest.indexRevision, sources: record.manifest.sources })) return false;
        await tx.put("checkpoint", next);
        await tx.put("index", { ...index, lost: false, indexState: "checkpoint_confirmed" });
        await tx.put("maintenance", false); await tx.put("quarantine", false); await tx.put("active", null);
      } else { await tx.put("checkpoint", next); await tx.put("maintenance", true); }
      return true;
    }),
  };
}
export class CogneeContainer extends DurableObject<AssistantEnv> {
  private engine?: CogneeEngine;
  private port?: DirectContainerPort;
  /** Global index health, independent of the current guest/project pack. Six
   * remote checks share one deadline; late observations cannot publish or queue
   * more work. The body stays on the host, never in the returned metadata. */
  private async indexedSourcesCurrent(sources:SourceStamp[]):Promise<"current"|"stale"|"unavailable"> {
    const scope=configured(this.env),access=new SourceAccess(scope.db,{installationId:scope.installationId,generation:scope.generation});
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const deadlineAt=Date.now()+5000,current=()=>!stopped&&Date.now()<deadlineAt;
    const work=(async()=>{
      try {
        const actor={kind:"owner"} as const,guard=new CanonicalEngineGuard(this.env);
        for(let offset=0;current()&&offset<sources.length;offset+=6){
          const stamps=sources.slice(offset,offset+6),rows=await access.readMany(actor,stamps);
          if(!current())return "unavailable" as const;
          if(rows.some((source,i)=>!source||source.fence.source.version!==stamps[i].version||source.fence.source.hash!==stamps[i].hash))return "stale" as const;
          const remote=rows.filter(source=>source!.fence.source.origin==="whatsapp");
          let origins:(OriginFence|null)[]=[];
          if(remote.length){
            if(!this.env.CAPTURE_READER||!this.env.BRIDGE_SECRET||!this.env.BRIDGE_SOURCE_EPOCH||!this.env.BRIDGE_SOURCE_GENERATION)return "unavailable" as const;
            origins=await new OriginGuard(scope.db,()=>({installationId:scope.installationId,generation:scope.generation,sourceEpoch:this.env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:this.env.BRIDGE_SOURCE_GENERATION!}),this.env.CAPTURE_READER,this.env.BRIDGE_SECRET).fences(remote.map(source=>source!.id));
            if(!current()||origins.some(origin=>!origin))return "unavailable" as const;
          }
          const byId=new Map(origins.map(origin=>[origin!.canonicalId,origin!]));
          if(!current()||!await guard.check(actor,rows.map(source=>({source:source!.fence,...(byId.has(source!.id)?{origin:byId.get(source!.id)!}:{})})),current))return "unavailable" as const;
        }
      }catch{return "unavailable" as const;}
      return current()?"current" as const:"unavailable" as const;
    })();
    try{return await Promise.race([work,new Promise<"unavailable">(resolve=>{timer=setTimeout(()=>{stopped=true;resolve("unavailable");},5000);})]);}
    finally{stopped=true;clearTimeout(timer);}
  }
  /** Read-only host boundary. Never starts/restores/quiesces, creates a model
   * permit, changes checkpoint phase, or touches receipts and cost ledgers. */
  async indexPreflight(raw: {indexEpoch:string;indexRevision:string}):Promise<IndexPreflight> {
    try{await assertRestoredGeneration(this.env);}catch{return {state:"unavailable",reason:"restore_execution_blocked"};}
    const parsed=indexExpectation.safeParse(raw);if(!parsed.success)return {state:"unavailable",reason:"index_preflight_input"};
    const expected=parsed.data,host=this.host(),scope=configured(this.env);
    const read=()=>this.ctx.storage.transaction(async tx=>({index:await tx.get<IndexMetadata>("index"),active:await tx.get<unknown>("active"),maintenance:await tx.get<unknown>("maintenance"),quarantine:await tx.get<unknown>("quarantine"),checkpoint:await tx.get<CheckpointState>("checkpoint")}));
    const check=(state:Awaited<ReturnType<typeof read>>):IndexPreflight|null=>{
      const index=state.index;
      if(!index||index.namespace!==JSON.stringify({installationId:scope.installationId,generation:scope.generation})||!Array.isArray(index.sources)||index.sources.length>128||!z.array(indexStamp).safeParse(index.sources).success||new Set(index.sources.map(source=>source.id)).size!==index.sources.length)return {state:"unavailable",reason:"index_metadata_invalid"};
      if(index.epoch!==expected.indexEpoch||index.revision!==expected.indexRevision)return {state:"unavailable",reason:"index_changed"};
      if(state.active!==undefined&&state.active!==null)return {state:"unavailable",reason:"index_operation_uncertain"};
      if(state.maintenance!==undefined&&state.maintenance!==false||state.quarantine!==undefined&&state.quarantine!==false||index.lost!==undefined&&index.lost!==false)return {state:"maintenance_required",reason:"index_not_ready"};
      if(state.checkpoint!==undefined&&(!state.checkpoint||state.checkpoint.phase!=="confirmed"))return {state:"maintenance_required",reason:"checkpoint_not_idle"};
      return null;
    };
    const outcome=await host.maintain<IndexPreflight>(async()=>{
      try{
        await assertRestoredGeneration(this.env);
        const before=await read(),denied=check(before);if(denied)return {value:denied};
        const index=before.index!,current=await this.indexedSourcesCurrent(index.sources);
        if(current!=="current")return {value:{state:current==="stale"?"maintenance_required":"unavailable",reason:current==="stale"?"canonical_sources_changed":"origin_unavailable"}};
        const after=await read(),changed=check(after);if(changed)return {value:changed};
        if(!samePlan({indexEpoch:index.epoch,indexRevision:index.revision,sources:index.sources},after.index!))return {value:{state:"unavailable",reason:"index_changed"}};
        await assertRestoredGeneration(this.env);
        const metadata={indexEpoch:index.epoch,indexRevision:index.revision,sourceCount:index.sources.length};
        if(!this.port!.running)return {value:{state:"current_metadata",...metadata}};
        const manifest:CheckpointManifest={identity:{installationId:scope.installationId,generation:scope.generation,imageRef:this.ctx.container!.images.cognee,buildFingerprint:build.buildFingerprint,configurationHash:await bridgeHash(DEFAULT_BROKER_CONFIG),engineVersion:"1.6.5"},indexEpoch:index.epoch,indexRevision:index.revision,sources:index.sources};
        // Retain physical exclusion even when TCP/body ignores its AbortSignal.
        const physical=host.checkpointEffect(()=>this.port!.verify(manifest));let timer:ReturnType<typeof setTimeout>|undefined;
        let proof:IndexProof;
        try{proof=await Promise.race([physical,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("preflight_timeout")),60000);})]);}
        catch{return {value:{state:"unavailable",reason:"index_verification_unavailable"}};}
        finally{clearTimeout(timer);}
        if(!await validIndexProof(proof,manifest))return {value:{state:"maintenance_required",reason:"index_proof_invalid"}};
        const finalCurrent=await this.indexedSourcesCurrent(index.sources),final=await read(),finalDenied=check(final);if(finalDenied)return {value:finalDenied};
        if(finalCurrent!=="current")return {value:{state:finalCurrent==="stale"?"maintenance_required":"unavailable",reason:finalCurrent==="stale"?"canonical_sources_changed":"origin_unavailable"}};
        if(!this.port!.running||!samePlan(manifest,final.index!))return {value:{state:"unavailable",reason:"index_changed"}};
        await assertRestoredGeneration(this.env);
        return {value:{state:"verified",...metadata}};
      }catch{return {value:{state:"unavailable",reason:"index_preflight_unavailable"}};}
    },true);
    return outcome.state==="verified"||outcome.state==="current_metadata"||outcome.state==="maintenance_required"||outcome.state==="unavailable"?outcome:{state:"unavailable",reason:"index_preflight_busy"};
  }
  private async rebuildSource(stamp: SourceStamp,isCurrent:()=>boolean=()=>true): Promise<EngineIngest | null> {
    if(!isCurrent())return null;
    await assertRestoredGeneration(this.env);if(!isCurrent())return null;
    const scope = configured(this.env), actor = { kind: "owner" } as const;
    const source = await new SourceAccess(scope.db, { installationId: scope.installationId, generation: scope.generation }).read(actor, stamp.id, stamp.revision);
    if (!isCurrent()||!source || source.fence.source.version !== stamp.version || source.fence.source.hash !== stamp.hash) return null;
    let origin;
    if (source.fence.source.origin === "whatsapp") {
      if (!this.env.CAPTURE_READER || !this.env.BRIDGE_SECRET || !this.env.BRIDGE_SOURCE_EPOCH || !this.env.BRIDGE_SOURCE_GENERATION) return null;
      origin = await new OriginGuard(scope.db, () => ({ installationId: scope.installationId, generation: scope.generation,
        sourceEpoch: this.env.BRIDGE_SOURCE_EPOCH!, sourceGeneration: this.env.BRIDGE_SOURCE_GENERATION! }), this.env.CAPTURE_READER, this.env.BRIDGE_SECRET).fence(stamp.id);
      if (!origin||!isCurrent()) return null;
    }
    return isCurrent()&&await new CanonicalEngineGuard(this.env).check(actor, [{ source: source.fence, ...(origin ? { origin } : {}) }],isCurrent)&&isCurrent() ? { actor, source, ...(origin ? { origin } : {}) } : null;
  }
  private async rebuilds() {
    const host = this.host(), scope = configured(this.env);
    const owned = async (epoch: string, owner: string) => {
      await assertRestoredGeneration(this.env);
      const run = await this.ctx.storage.get<RebuildState>("rebuild");
      await assertRestoredGeneration(this.env);
      return !!run && run.indexEpoch === epoch && run.owner === owner;
    };
    const requireOwner = async (epoch: string, owner: string) => { if (!await owned(epoch, owner)) throw new Error("rebuild_fenced"); };
    const store: RebuildStore = { read: async () => await this.ctx.storage.get<RebuildState>("rebuild") ?? null,
      compareAndSet: (revision, expectedEpoch, next) => this.ctx.storage.transaction(async transaction => {
        const prior = await transaction.get<RebuildState>("rebuild"), index = await transaction.get<{ epoch?: string; namespace: string }>("index");
        if ((prior?.revision ?? null) !== revision || index?.epoch !== expectedEpoch || index.namespace !== JSON.stringify({ installationId: scope.installationId, generation: scope.generation })) return false;
        await transaction.put("rebuild", next); await transaction.put("maintenance", next.phase !== "ready");
        if (next.phase === "preparing") await transaction.put("index", { namespace: index.namespace, epoch: next.indexEpoch, revision: "empty", sources: [], lost: true, indexState: "needs_checkpoint" });
        else if (next.phase === "ready") await transaction.put("index", { namespace: index.namespace, epoch: next.indexEpoch, revision: next.indexRevision, sources: next.sources, lost: false, indexState: "needs_checkpoint" });
        else if (next.phase === "blocked") await transaction.put("index", { ...index, lost: true });
        return true;
      }) };
    return new RebuildController({ installationId: scope.installationId, generation: scope.generation, imageRef: this.ctx.container!.images.cognee,
      buildFingerprint: build.buildFingerprint, configurationHash: await bridgeHash(DEFAULT_BROKER_CONFIG), engineVersion: "1.6.5" }, store, {
      deny: async (epoch, owner) => { await requireOwner(epoch, owner); await this.port!.deny(); },
      destroy: (epoch, owner) => host.destroyForRebuild(() => owned(epoch, owner)),
      fresh: (epoch, owner) => host.freshForRebuild(epoch, owner, () => owned(epoch, owner)),
      materialize: async (epoch, owner, stamp) => { const source = await this.rebuildSource(stamp); await requireOwner(epoch, owner);
        return source ? await host.ingestForRebuild(source, epoch, owner) as { state: string; indexRevision?: string } : { state: "blocked" }; },
      inspect: async (manifest, owner) => { await requireOwner(manifest.indexEpoch, owner); return this.port!.verify(manifest); },
    }, async sources => { for (const source of sources) if (!await this.rebuildSource(source)) return false; return true; });
  }
  private checkpointStore(): CheckpointStore {
    return makeCheckpointStore(this.ctx.storage, configured(this.env));
  }
  private async checkpoints() {
    const host = this.host(), scope = configured(this.env), store = this.checkpointStore();
    const effect = <T>(fence: CheckpointFence, action: (check: LifecycleCheck) => Promise<T>) => host.checkpointEffect(async () => {
      const check = async () => { await assertRestoredGeneration(this.env);if (!await store.owns!(fence)) throw new Error("checkpoint_fenced");await assertRestoredGeneration(this.env); };
      return checked(check, () => action(check));
    });
    return new CheckpointController({ installationId: scope.installationId, generation: scope.generation,
      imageRef: this.ctx.container!.images.cognee, buildFingerprint: build.buildFingerprint, configurationHash: await bridgeHash(DEFAULT_BROKER_CONFIG), engineVersion: "1.6.5" },
    store, {
      deny: fence => effect(fence, check => this.port!.deny(check)),
      destroy: fence => effect(fence, check => this.port!.destroy(check)),
      snapshot: (name, fence) => effect(fence, check => this.port!.snapshot(name, check)),
      restore: (snapshot, fence) => effect(fence, check => this.port!.restore(snapshot, check)),
      quiesce: (manifest, fence) => effect(fence, check => this.port!.quiesce(manifest, check)),
      inspect: fence => effect(fence, check => this.port!.inspect(check)),
    }, async manifest => {
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
      this.engine = new CogneeEngine(scope, { transaction: operation => this.ctx.storage.transaction(transaction => operation({get:key=>transaction.get(key),put:(key,value)=>transaction.put(key,value),list:options=>transaction.list(options)})), get: key => this.ctx.storage.get(key), put: (key, value) => this.ctx.storage.put(key, value),
        putFenced: (key, value, indexEpoch, owner) => this.ctx.storage.transaction(async transaction => {
          const run = await transaction.get<RebuildState>("rebuild"), index = await transaction.get<{ epoch: string }>("index");
          if (run?.indexEpoch !== indexEpoch || run.owner !== owner || index?.epoch !== indexEpoch || !["preparing", "materializing"].includes(run.phase)) throw new Error("rebuild_fenced");
          await transaction.put(key, value);
        }) }, port, new CanonicalEngineGuard(this.env));
    }
    return this.engine;
  }
  fetch() { return Promise.resolve(deny()); }
  async ingest(input: EngineIngest) { const host=this.host(); await assertRestoredGeneration(this.env); return host.ingest(input); }
  async reserveInitialIngest(input:EngineIngest,admission:InitialIngestAdmission){await assertRestoredGeneration(this.env);return this.host().reserveInitialIngest(input,admission);}
  async commitInitialIngest(input:EngineIngest,ticket:InitialIngestTicket,admission:InitialIngestAdmission){await assertRestoredGeneration(this.env);return this.host().commitInitialIngest(input,ticket,admission);}
  async initialIngestReceipt(input:EngineIngest,itemId:string,indexEpoch:string){await assertRestoredGeneration(this.env);const result=await this.host().initialIngestReceipt(input,itemId,indexEpoch);return result.state==='complete'?{state:'complete' as const,operationId:result.operationId,indexRevision:result.indexRevision}:{state:'uncertain' as const};}
  async ingestReceipt(input: EngineIngest, indexEpoch: string) { await assertRestoredGeneration(this.env); const result=await this.host().ingestReceipt(input,indexEpoch);return result.state==="complete"?{state:"complete" as const,operationId:result.operationId,indexRevision:result.indexRevision}:{state:"uncertain" as const}; }
  /** Host-only metadata: no source bodies, broker tokens or snapshot handles. */
  async lifecycleState() {
    this.host(); const index = await this.ctx.storage.get<IndexMetadata>("index"), checkpoint = await this.checkpointStore().read();
    const record = checkpoint?.phase === "restoring" ? checkpoint.candidate ?? checkpoint.confirmed : checkpoint?.confirmed;
    return { running: this.port!.running, index: index ? { epoch:index.epoch,revision:index.revision,lost:!!index.lost,state:index.indexState??"needs_checkpoint",sources:index.sources??[] } : null,
      maintenance:!!await this.ctx.storage.get<boolean>("maintenance"),quarantine:!!await this.ctx.storage.get<boolean>("quarantine"),
      checkpoint: record ? {id:record.id,epoch:record.manifest.indexEpoch,revision:record.manifest.indexRevision,phase:checkpoint!.phase} : null };
  }
  async search(input: EngineSearch) { const host=this.host(); await assertRestoredGeneration(this.env); return host.search(input); }
  async lookup(id: string) { const host=this.host(); await assertRestoredGeneration(this.env); return host.lookup(id); }
  async prepare(alias:string,input:EngineSearch) { const host=this.host(); await assertRestoredGeneration(this.env); return host.prepare(alias,input); }
  async submit(ticket:SearchTicket) { const host=this.host(); await assertRestoredGeneration(this.env); return host.submit(ticket); }
  async lookupTicket(ticket:SearchTicket) { const host=this.host(); await assertRestoredGeneration(this.env); return host.lookupTicket(ticket); }
  async authorize(epoch: string) { if(!epoch)return null; const host=this.host(); await assertRestoredGeneration(this.env); return host.authorize(epoch); }
  async rebuildBegin(expectedIndexEpoch: string, sources: SourceStamp[]) {
    this.host(); await assertRestoredGeneration(this.env);
    try { sources = JSON.parse(JSON.stringify(sources)) as SourceStamp[]; }
    catch { return Promise.resolve({ state: "blocked" as const, reason: "rebuild_input" }); }
    return this.host().rebuildExclusive(async () => (await this.rebuilds()).begin(expectedIndexEpoch, sources));
  }
  async rebuildStep(indexEpoch: string, cursor: number) {
    this.host(); await assertRestoredGeneration(this.env);
    return this.host().rebuildExclusive(async () => (await this.rebuilds()).step(indexEpoch, cursor));
  }
  async rebuildRecover(indexEpoch: string) {
    this.host(); await assertRestoredGeneration(this.env);
    return this.host().rebuildExclusive(async () => (await this.rebuilds()).recover(indexEpoch));
  }
  async rebuildStatus() {
    this.host(); const state = await this.ctx.storage.get<RebuildState>("rebuild");
    return state ? { state: state.phase, indexEpoch: state.indexEpoch, next: state.next, reason: state.reason ?? null } : { state: "missing" };
  }
  async checkpoint(expected?: {indexEpoch:string;indexRevision:string}) {
    this.host(); await assertRestoredGeneration(this.env);
    return this.host().maintain<CheckpointResult>(async plan => {
      if(expected && (!plan || plan.indexEpoch!==expected.indexEpoch || plan.indexRevision!==expected.indexRevision))return {value:{state:"blocked",reason:"index_changed"}};
      if (!plan) return { value: { state: "rebuild_required", reason: "index_lost" } };
      const result = await (await this.checkpoints()).create(plan), state = await this.checkpointStore().read();
      return { value: result, ...(result.state === "checkpoint_confirmed" ? { restored: state!.confirmed!.manifest } : {}) };
    });
  }
  async restoreCheckpoint(expected?: {checkpointId:string;indexEpoch:string;indexRevision:string}) {
    this.host(); await assertRestoredGeneration(this.env);
    return this.host().maintain<CheckpointResult>(async () => {
      if(expected){
        const state=await this.checkpointStore().read(),record=state?.phase==="restoring"?state.candidate??state.confirmed:state?.confirmed,index=await this.ctx.storage.get<IndexMetadata>("index");
        if(!record||!index||record.id!==expected.checkpointId||record.manifest.indexEpoch!==expected.indexEpoch||record.manifest.indexRevision!==expected.indexRevision||!samePlan(record.manifest,index))return {value:{state:"blocked",reason:"checkpoint_changed"}};
      }
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
      await assertRestoredGeneration(this.env);
      const { epoch, owner } = this.ctx.props;
      if (!epoch || !owner || !this.env.COGNEE) return deny();
      const scope = configured(this.env), host = this.env.COGNEE.get(this.env.COGNEE.idFromString(owner));
      return await handleBrokerRequest(request, epoch, host, (period,proof) => new CogneeModelBroker(scope.db,
        { installationId: scope.installationId, generation: scope.generation, period }, DEFAULT_BROKER_CONFIG, async input=>{await assertRestoredGeneration(this.env);return createOpenAIAdapter(this.env.OPENAI_API_KEY!)(input);}, Date.now, proof ? {prepare:async()=>{await assertRestoredGeneration(this.env);const host=coverageHost(this.env,proof);if(!await host.checkProof(proof))return null;await assertRestoredGeneration(this.env);return {guard:await host.proofGuard(proof),statements:[]};},uncertain:async()=>{}} : undefined));
    } catch { return deny(); }
  }
}
