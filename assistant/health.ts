import type { AssistantEnv } from "./env";
import type { TrustedActor } from "./access";
import { installationHealth } from "./installation-health";
/** Local pipeline and private binding evidence. No provider/model/index probe. */
export async function assistantHealth(env: AssistantEnv, actor: TrustedActor, now = Date.now()) {
  if (actor.kind !== "owner") throw new Error("owner_required");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("health_clock");
  const mode = env.SEMANTIC_SEARCH_MODE ?? (env.COGNEE ? "required" : "legacy_lexical");
  const configuration = { database: !!env.DB, captureReader: !!env.CAPTURE_READER, bridge: !!env.BRIDGE_SECRET && !!env.BRIDGE_SOURCE_EPOCH && !!env.BRIDGE_SOURCE_GENERATION,
    modelKey: !!env.OPENAI_API_KEY, episodeMode: env.FLUE_EPISODES_ENABLED === "shadow", semanticBinding: !!env.COGNEE,
    semanticPolicy: env.SEMANTIC_SEARCH_MODE === undefined || (["required", "lexical_fallback"].includes(mode) && !!env.COGNEE) ? mode : "invalid" };
  const installation = await installationHealth(env);
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || !installation.schema.coreReady) return { state: "unknown", configuration, installation, observation: "configuration_or_schema_only", clientHealth: "not_observed" };
  const keys = [env.INSTALLATION_ID, env.OPERATIONAL_GENERATION, env.BRIDGE_SOURCE_EPOCH ?? "", env.BRIDGE_SOURCE_GENERATION ?? ""];
  try {
  const pipeline = await env.DB.prepare(`SELECT COUNT(*) received,COALESCE(SUM(application_state='applied'),0) applied,COALESCE(SUM(application_state='blocked'),0) blocked,COALESCE(SUM(application_state='pending'),0) pending,
    MAX(received_at) lastReceivedAt FROM assistant_capture_inbox WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=?`).bind(...keys)
    .first<{ received: number; applied: number; blocked: number; lastReceivedAt: number | null }>();
  const conversations = await env.DB.prepare(`SELECT COUNT(*) observed,COALESCE(SUM(paused=1),0) paused FROM assistant_conversations WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=?`).bind(...keys).first();
  const replay = await env.DB.prepare(`SELECT COUNT(*) gaps FROM assistant_conversation_replay WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND state='gap'`).bind(...keys).first();
  const currentPeriod = new Date(now).toISOString().slice(0, 10);
  const accounts = await env.DB.prepare(`SELECT COUNT(*) configured,COALESCE(SUM(blocked=1),0) blocked,COALESCE(MAX(period=?),0) currentConfigured
    FROM assistant_budget_accounts WHERE installation_id=? AND generation=?`).bind(currentPeriod, ...keys.slice(0, 2)).first<{ configured: number; blocked: number; currentConfigured: number }>();
  const budget = { scope: "current_generation_all_periods", configuredAccounts: accounts!.configured, blockedAccounts: accounts!.blocked, currentPeriod, currentAccountConfigured: accounts!.currentConfigured === 1 };
  return { state: pipeline!.received ? "observed_local_pipeline" : "unknown", observedAt: now, configuration, installation, pipeline, conversations, replay, budget,
    coverage: { capturedEvents: pipeline!.received, appliedEvents: pipeline!.applied, appliedFraction: pipeline!.received ? pipeline!.applied / pipeline!.received : null, scope: "received_events_only", upstreamCompleteness: "unknown" },
    recency: { lastReceivedAt: pipeline!.lastReceivedAt, ageMs: pipeline!.lastReceivedAt === null ? null : Math.max(0, now - pipeline!.lastReceivedAt), interpretation: "no_new_event_does_not_prove_failure" },
    capabilities: { whatsappSend: env.WHATSAPP_APPROVED_SEND_ENABLED==='true'&&!!env.WHATSAPP_APPROVED_SEND&&env.ROUTINES_PAUSED!=='true',whatsappAutonomousSend:false, calendarWrite: env.CALENDAR_OAUTH_PERMISSION === "write_owned" && !!env.CALENDAR_WRITE_CALENDAR, basis: "configured_capabilities_not_live_probe" }, clientHealth: "not_observed", schedulerHealth: installation.scheduler.observation, snapshot: "not_atomic" };
  } catch { return { state: "unknown", configuration, installation, observation: "schema_or_pipeline_unavailable", clientHealth: "not_observed" }; }
}
