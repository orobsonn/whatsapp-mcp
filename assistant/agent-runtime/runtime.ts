import { z } from "zod";
import type { AssistantEnv } from "../env";
import { hostConfiguredSearch } from "../configured-search";
import { DEFAULT_BROKER_CONFIG, createOpenAIAdapter } from "../model-transport";
import { EpisodeController, type Purpose, type RuntimeIdentity, type OwnerOnceWork } from "../agent/controller";
import { assertRestoredGeneration } from "../retention-runtime";
import type { ModelAdapter } from "../model-broker";
import {outgoingPort} from '../outgoing';
import { onceScope, onceKey, readOncePlan, readOnceGrant, onceAuthority } from "../owner-once-guard";
import { jobRequest,parseBinding,type BoundEpisode } from "../agent/contracts";
import { bridgeHash } from "../ingress";
import {assertProactiveEpisode} from '../proactive-pilot';
import type {GroupScope} from '../group-scope';
/** No router or generic binding. Existing account limits must already be
 * configured; this factory neither configures a budget nor activates capture. */
export function runtimeHost(env: AssistantEnv, purpose: Purpose, options: { clock?: () => number; model?: ModelAdapter;contextMode?:'conversation_manifest';groupScope?:GroupScope } = {}) {
  if (env.FLUE_EPISODES_ENABLED !== "shadow" || !env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || !env.OPENAI_API_KEY) throw new Error("episode_unconfigured");
  const clock = options.clock ?? Date.now, { scope, search } = hostConfiguredSearch(env, purpose, clock,options.contextMode,options.groupScope);
  class PausedRestoreEpisode extends EpisodeController {
    protected override async check(episode:BoundEpisode){const started=clock();try{await assertProactiveEpisode(env,episode.id);}catch{console.warn('episode_check_denied',{stage:'pilot',episodeId:episode.id,elapsedMs:clock()-started});return false;}return super.check(episode);}
    override async prepare(...args: Parameters<EpisodeController["prepare"]>) { await assertRestoredGeneration(env); return super.prepare(...args); }
    override async dispatch(...args: Parameters<EpisodeController["dispatch"]>) { await assertRestoredGeneration(env); await assertProactiveEpisode(env,args[0]);return super.dispatch(...args); }
    override async model(...args: Parameters<EpisodeController["model"]>) { await assertRestoredGeneration(env); await assertProactiveEpisode(env,args[0]);return super.model(...args); }
    override async publish(...args: Parameters<EpisodeController["publish"]>) { await assertRestoredGeneration(env); await assertProactiveEpisode(env,args[0]);return super.publish(...args); }
    override async read(...args: Parameters<EpisodeController["read"]>) { await assertRestoredGeneration(env); await assertProactiveEpisode(env,args[0]);return super.read(...args); }
    override async reconcile(...args: Parameters<EpisodeController["reconcile"]>) { await assertRestoredGeneration(env); return super.reconcile(...args); }
  }
  const adapter = options.model ?? createOpenAIAdapter(env.OPENAI_API_KEY);
  const ownerOnceWork: OwnerOnceWork = async (jobId, rootId, runId) => {
    try {
      const affinity = onceScope.parse(scope), receipt = await readOncePlan(env, affinity, rootId);
      if (!receipt || receipt.jobId !== jobId || purpose !== "owner_read" || runId !== await bridgeHash([[scope.installationId, scope.generation], JSON.stringify({ kind: "owner" }), onceKey(rootId)])) return null;
      const grant = await readOnceGrant(env, receipt);
      if (!grant) return null;
      const row = await env.DB!.prepare(`SELECT j.dedupe_key,l.request_hash,l.request_json FROM assistant_jobs j JOIN assistant_job_ledger l
        ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
        WHERE j.installation_id=? AND j.generation=? AND j.id=?`).bind(scope.installationId, scope.generation, jobId)
        .first<{ dedupe_key: string; request_hash: string; request_json: string }>();
      if (!row || row.dedupe_key !== onceKey(rootId) || await bridgeHash(JSON.parse(row.request_json)) !== row.request_hash) return null;
      const request = jobRequest.parse(JSON.parse(row.request_json));
      if (request.kind !== "reasoning" || request.actor.kind !== "owner" || request.sourceId !== receipt.sourceId || request.sourceRevision !== receipt.expectedRevision
        || request.subject.kind !== "owner_request" || request.subject.requestKey !== onceKey(rootId) || request.subject.sourceId !== receipt.sourceId
        || request.subject.sourceRevision !== receipt.expectedRevision || await bridgeHash(request.input) !== receipt.queryHash) return null;
      const run = await env.DB!.prepare("SELECT actor_json,request_hash,request_json FROM assistant_retrieval_runs WHERE installation_id=? AND generation=? AND id=?")
        .bind(scope.installationId, scope.generation, runId).first<{ actor_json: string; request_hash: string; request_json: string }>();
      if (!run || run.actor_json !== JSON.stringify({ kind: "owner" }) || await bridgeHash(JSON.parse(run.request_json)) !== run.request_hash
        || JSON.parse(run.request_json).ownerOnceId !== rootId) return null;
      const authority = await onceAuthority(env, affinity, grant, clock());
      return clock() < receipt.deadlineAt ? { guard: authority.guard, deadlineAt: receipt.deadlineAt } : null;
    } catch { return null; }
  };
  return new PausedRestoreEpisode(env.DB, { ...scope, period: new Date(clock()).toISOString().slice(0, 10) }, search,
    async request => { await assertRestoredGeneration(env); return adapter(request); }, DEFAULT_BROKER_CONFIG, { purpose, clock,outgoing:outgoingPort(env), ownerOnceWork });
}
export async function resolveRuntimeEpisode(raw: Record<string, unknown>, identity: RuntimeIdentity) {
  // Cloudflare supplies env and the named DO supplies identity, not the model.
  const env = raw as AssistantEnv;
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION) throw new Error("episode_unconfigured");
  const row = await env.DB.prepare("SELECT id,binding_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND profile=? AND runtime_id=?")
    .bind(env.INSTALLATION_ID, env.OPERATIONAL_GENERATION, identity.profile, identity.runtimeId).first<{ id: string; binding_json: string }>();
  if (!row) throw new Error("episode_denied");
  const binding=parseBinding(JSON.parse(row.binding_json));
  const ledger=await env.DB.prepare('SELECT request_json,request_hash FROM assistant_job_ledger WHERE installation_id=? AND generation=? AND job_id=?').bind(env.INSTALLATION_ID,env.OPERATIONAL_GENERATION,binding.lease.id).first<{request_json:string;request_hash:string}>();
  if(!ledger||await bridgeHash(JSON.parse(ledger.request_json))!==ledger.request_hash)throw Error('episode_denied');const request=jobRequest.parse(JSON.parse(ledger.request_json));
  if(request.contextMode!==binding.contextMode||JSON.stringify(request.sourceRefs)!==JSON.stringify(binding.sourceRefs)||JSON.stringify(request.groupScope)!==JSON.stringify(binding.groupScope))throw Error('context_mode_denied');
  return { host: runtimeHost(env, binding.purpose,{...(binding.contextMode?{contextMode:binding.contextMode,...(binding.groupScope?{groupScope:binding.groupScope}:{})}:{})}), episodeId: row.id };
}
/** Installed dispatcher keeps the legacy shadow-controller contract separate. */
export async function resolveInstalledRuntime(raw: Record<string, unknown>, identity: RuntimeIdentity) {
  if (identity.profile !== "owner-dialogue") return resolveRuntimeEpisode(raw, identity);
  const env = raw as AssistantEnv;
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION) throw Error("episode_unconfigured");
  const row = await env.DB.prepare("SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=? AND profile='owner' AND runtime_id=? AND json_extract(binding_json,'$.kind')='telegram_owner_dialogue'")
    .bind(env.INSTALLATION_ID, env.OPERATIONAL_GENERATION, identity.runtimeId).first<{ id: string }>();
  if (!row) throw Error("episode_denied");
  const { TelegramDialogueHost } = await import("../telegram-dialogue-runtime");
  return { host: new TelegramDialogueHost(env), episodeId: row.id };
}
