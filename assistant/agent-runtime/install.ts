import { AsyncLocalStorage } from "node:async_hooks";
import { instrument, setProvider, type FlueExecutionContext } from "@flue/runtime";
import { getCloudflareContext, getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import { createEpisodeProvider } from "./provider";
import type { EpisodeController, RuntimeIdentity } from "../agent/controller";
type Resolver = (env: Record<string, unknown>, identity: RuntimeIdentity) => Promise<{ host: EpisodeController; episodeId: string }>;
/** Invocation-local host correlation; no global mutable active job/context. */
export function installEpisodeRuntime(resolve: Resolver) {
  const execution = new AsyncLocalStorage<FlueExecutionContext>();
  instrument({ observe() {}, dispose() {}, async interceptor(operation, context, next) {
    if (operation.type === "tool" || operation.type === "task" || (operation.type === "agent" && operation.operationKind === "task")) throw new Error("episode_tools_disabled");
    // Model operations omit submissionId in Flue2.3; inherit the enclosing
    // native agent operation's trusted correlation, never message metadata.
    const defined = Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
    return execution.run({ ...execution.getStore(), ...defined }, next);
  } });
  setProvider(createEpisodeProvider(async payload => {
    const { env } = getCloudflareContext(), identity = getDurableObjectIdentity(), context = execution.getStore();
    const profile = identity.className === "FlueOwnerRuntimeAgent" ? "owner" : identity.className === "FlueInterlocutorRuntimeAgent" ? "interlocutor" : null;
    if (!profile || !context?.submissionId || context.agentName !== profile + "-runtime") throw new Error("episode_denied");
    const nominal = { profile, runtimeId: identity.name, submissionId: context.submissionId };
    const { host, episodeId } = await resolve(env, nominal);
    return host.model(episodeId, nominal, payload);
  }));
}
