import { z } from "zod";
import type { AssistantEnv } from "../env";
import { hostConfiguredSearch } from "../configured-search";
import { DEFAULT_BROKER_CONFIG, createOpenAIAdapter } from "../model-transport";
import { EpisodeController, type Purpose, type RuntimeIdentity } from "../agent/controller";
import { assertRestoredGeneration } from "../retention-runtime";
/** No router or generic binding. Existing account limits must already be
 * configured; this factory neither configures a budget nor activates capture. */
export function runtimeHost(env: AssistantEnv, purpose: Purpose) {
  if (env.FLUE_EPISODES_ENABLED !== "shadow" || !env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || !env.OPENAI_API_KEY) throw new Error("episode_unconfigured");
  const { scope, search } = hostConfiguredSearch(env, purpose);
  class PausedRestoreEpisode extends EpisodeController {
    override async prepare(...args: Parameters<EpisodeController["prepare"]>) { await assertRestoredGeneration(env); return super.prepare(...args); }
    override async dispatch(...args: Parameters<EpisodeController["dispatch"]>) { await assertRestoredGeneration(env); return super.dispatch(...args); }
    override async model(...args: Parameters<EpisodeController["model"]>) { await assertRestoredGeneration(env); return super.model(...args); }
    override async publish(...args: Parameters<EpisodeController["publish"]>) { await assertRestoredGeneration(env); return super.publish(...args); }
  }
  return new PausedRestoreEpisode(env.DB, { ...scope, period: new Date().toISOString().slice(0, 10) }, search,
    createOpenAIAdapter(env.OPENAI_API_KEY), DEFAULT_BROKER_CONFIG, { purpose });
}
export async function resolveRuntimeEpisode(raw: Record<string, unknown>, identity: RuntimeIdentity) {
  // Cloudflare supplies env and the named DO supplies identity, not the model.
  const env = raw as AssistantEnv;
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION) throw new Error("episode_unconfigured");
  const row = await env.DB.prepare("SELECT id,binding_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND profile=? AND runtime_id=?")
    .bind(env.INSTALLATION_ID, env.OPERATIONAL_GENERATION, identity.profile, identity.runtimeId).first<{ id: string; binding_json: string }>();
  if (!row) throw new Error("episode_denied");
  const { purpose } = z.object({ purpose: z.enum(["automation", "owner_read"]) }).parse(JSON.parse(row.binding_json));
  return { host: runtimeHost(env, purpose), episodeId: row.id };
}
