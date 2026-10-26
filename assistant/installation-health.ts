import type { AssistantEnv } from "./env";
import { retentionAuthorityName } from "./retention-authority";
import { retentionObjectPrefix } from "./retention-objects";
const features = { memory: "assistant_sources", capture: "assistant_capture_inbox", budget: "assistant_budget_accounts", models: "assistant_model_receipts",
  episodes: "assistant_episodes", semantic: "assistant_retrieval_semantic", decisions: "assistant_shadow_decisions", owner: "assistant_owner_commands",
  telegram: "assistant_telegram_links", review: "assistant_telegram_topics", followUps: "assistant_fup_provenance", media: "assistant_media_receipts", routines: "assistant_routine_state" };
type InstallEnv = AssistantEnv & { ARTIFACTS?: R2Bucket; ROUTINES_ENABLED?: string; ROUTINES_PAUSED?: string; TELEGRAM_SUMMARIES_ENABLED?: string; MEDIA_CONTEXT_ENABLED?: string };
async function bounded<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([action(), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), 2000); })]); }
  catch { return fallback; } finally { clearTimeout(timer); }
}
/** Owner-only host diagnostics: no bodies, secrets, inference, wake or refresh. */
export async function installationHealth(env: InstallEnv) {
  const schema = await bounded(async () => {
    if (!env.DB) return { state: "unconfigured", missingFeatures: Object.keys(features), coreReady: false };
    const names = Object.values(features), rows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(() => "?").join(",")})`).bind(...names).all<{ name: string }>();
    const found = new Set(rows.results.map(row => row.name)), missingFeatures = Object.entries(features).filter(([, table]) => !found.has(table)).map(([feature]) => feature);
    const core = ["assistant_capture_inbox", "assistant_conversations", "assistant_conversation_replay", "assistant_budget_accounts", "assistant_budget_reservations"];
    const count = await env.DB.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN (${core.map(() => "?").join(",")})`).bind(...core).first<number>("n");
    return { state: missingFeatures.length ? "incomplete" : "complete", missingFeatures, coreReady: count === core.length };
  }, { state: "unavailable", missingFeatures: Object.keys(features), coreReady: false });
  const capture = await bounded(async () => {
    if (!env.CAPTURE_READER?.installationAffinity || !env.BRIDGE_SECRET || !env.BRIDGE_SOURCE_EPOCH || !env.BRIDGE_SOURCE_GENERATION) return "unconfigured_or_upgrade_pending";
    const raw = await env.CAPTURE_READER.installationAffinity({ secret: env.BRIDGE_SECRET });
    if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join(",") !== "fence,observation,state" || !("observation" in raw) || raw.observation !== "capture_installation_affinity" || !("state" in raw) || raw.state !== "available" || !("fence" in raw) || !raw.fence || typeof raw.fence !== "object" || Object.keys(raw.fence).sort().join(",") !== "epoch,generation") return "unavailable";
    const fence = raw.fence as { epoch?: unknown; generation?: unknown };
    return fence.epoch === env.BRIDGE_SOURCE_EPOCH && fence.generation === env.BRIDGE_SOURCE_GENERATION ? "affinity_verified" : "affinity_changed";
  }, "unavailable");
  let artifactAffinity: "verified" | "changed" | "unconfigured" = "unconfigured", artifactPrefix: string | undefined;
  if (env.ARTIFACTS && env.INSTALLATION_ID && env.OPERATIONAL_GENERATION && env.ARTIFACTS_INSTALLATION_ID && env.ARTIFACTS_GENERATION) {
    try {
      artifactPrefix = retentionObjectPrefix({ installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION });
      artifactAffinity = env.ARTIFACTS_INSTALLATION_ID === env.INSTALLATION_ID && env.ARTIFACTS_GENERATION === env.OPERATIONAL_GENERATION ? "verified" : "changed";
    } catch { /* Invalid host scope never authorizes a bucket probe. */ }
  }
  const [artifacts, retention] = await Promise.all([
    bounded(async () => { if (!env.ARTIFACTS) return "unconfigured"; if (artifactAffinity !== "verified" || !artifactPrefix) return "not_probed_affinity";
      await env.ARTIFACTS.head(artifactPrefix + "installation-health/no-private-body"); return "reachable"; }, "unavailable"),
    bounded(async () => { if (!env.RETENTION_AUTHORITY || !env.INSTALLATION_ID) return "unconfigured";
      const state = await env.RETENTION_AUTHORITY.get(env.RETENTION_AUTHORITY.idFromName(retentionAuthorityName(env.INSTALLATION_ID))).lookup(env.INSTALLATION_ID, ["0".repeat(64)]);
      return state.state === "sealed" ? "sealed" : "bootstrap_pending";
    }, "unavailable"),
  ]);
  const scheduler = await bounded(async () => {
    if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || schema.missingFeatures.includes("routines")) return { observation: "not_observed", lastRunAt: null as number | null };
    const lastRunAt = await env.DB.prepare("SELECT MAX(last_run_at) FROM assistant_routine_state WHERE installation_id=? AND generation=?").bind(env.INSTALLATION_ID, env.OPERATIONAL_GENERATION).first<number>("MAX(last_run_at)");
    return { observation: lastRunAt === null ? "not_observed" : "host_scheduler_receipt", lastRunAt };
  }, { observation: "unavailable", lastRunAt: null as number | null });
  return { infrastructure: schema.state === "complete" && schema.coreReady && artifactAffinity === "verified" && capture === "affinity_verified" && artifacts === "reachable" && retention === "sealed" ? "observed_bindings" : "pending",
    schema: { ...schema, observation: "required_feature_table_inventory_not_full_migration_proof" }, capture, artifacts, artifactAffinity, artifactBindingIdentity: "requires_cloud_binding_api_verification", retention, scheduler: { ...scheduler, cloudCron: "requires_platform_schedule_and_live_smoke" },
    gates: { routineMode: env.ROUTINES_ENABLED ?? "off", paused: env.ROUTINES_PAUSED === "true", pauseConfigured: env.ROUTINES_PAUSED !== undefined, semanticRequired: env.SEMANTIC_SEARCH_MODE === "required",
      episodesShadow: env.FLUE_EPISODES_ENABLED === "shadow", retentionRequired: env.RETENTION_AUTHORITY_REQUIRED === "true", modelKeyConfigured: !!env.OPENAI_API_KEY,
      mediaEnabled: env.MEDIA_CONTEXT_ENABLED === "true", telegramSummariesEnabled: env.TELEGRAM_SUMMARIES_ENABLED === "true", calendarOAuthBinding: !!env.CALENDAR_OAUTH },
    functionalHomologation: "not_proven_by_health", checkpointHealth: "not_probed_no_container_wake", scope: "host_diagnostics_only" };
}
