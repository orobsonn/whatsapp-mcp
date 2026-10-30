import type { AssistantEnv } from "./env";
import type { Purpose } from "./agent/controller";
import { engineName } from "./container";
import { OriginGuard } from "./origin-guard";
import { RetrievalRuns } from "./retrieval-runs";
import type { SemanticEnginePort } from "./engine";
import { oncePlanReader } from "./owner-once-guard";
import type {GroupScope} from './group-scope';

/** Host configuration fixes the same scope, origin and ranking contract for
 * preparation, runtime callbacks and owner reads. It grants no lifecycle effect. */
export function hostConfiguredSearch(env: AssistantEnv, purpose: Purpose, clock = Date.now,contextMode?:'conversation_manifest',groupScope?:GroupScope) {
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION) throw new Error("search_unconfigured");
  const configuredMode = env.SEMANTIC_SEARCH_MODE;
  if (configuredMode !== undefined && configuredMode !== "required" && configuredMode !== "lexical_fallback") throw new Error("semantic_configuration");
  if(contextMode!==undefined&&(contextMode!=='conversation_manifest'||purpose!=='automation'))throw Error('context_mode_denied');
  if(groupScope&&!contextMode)throw Error('context_mode_denied');
  if (configuredMode && !env.COGNEE&&!contextMode) throw new Error("semantic_unconfigured");
  const scope = Object.freeze({ installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION,
    ...(env.BRIDGE_SOURCE_EPOCH && env.BRIDGE_SOURCE_GENERATION ? { sourceEpoch: env.BRIDGE_SOURCE_EPOCH, sourceGeneration: env.BRIDGE_SOURCE_GENERATION } : {}) });
  const origin = scope.sourceEpoch && scope.sourceGeneration && env.CAPTURE_READER && env.BRIDGE_SECRET
    ? new OriginGuard(env.DB, () => ({ ...scope, sourceEpoch: scope.sourceEpoch!, sourceGeneration: scope.sourceGeneration! }), env.CAPTURE_READER, env.BRIDGE_SECRET) : undefined;
  const semantic: { mode: "required" | "lexical_fallback"; engine: SemanticEnginePort } | undefined = env.COGNEE&&!contextMode ? { mode: configuredMode ?? "required",
    engine: env.COGNEE.get(env.COGNEE.idFromName(engineName(scope.installationId, scope.generation))) } : undefined;
  const ownerOncePlan = oncePlanReader(env);
  return { scope, origin, semantic, ownerOncePlan, search: new RetrievalRuns(env.DB, scope, { purpose, origin, clock, semantic, ownerOncePlan,...(contextMode?{contextMode,...(groupScope?{groupScope}:{})}:{}) }) };
}
