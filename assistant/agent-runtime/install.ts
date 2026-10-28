import { AsyncLocalStorage } from "node:async_hooks";
import { instrument, setProvider, type FlueExecutionContext } from "@flue/runtime";
import { getCloudflareContext, getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import { createEpisodeProvider, type EpisodePayload } from "./provider";
import type { RuntimeIdentity } from "../agent/controller";
type Resolver = (env: Record<string, unknown>, identity: RuntimeIdentity) => Promise<{
  host: { model(id: string, identity: RuntimeIdentity, payload: EpisodePayload, signal?: AbortSignal): Promise<string> }; episodeId: string;
}>;
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
  setProvider(createEpisodeProvider(async (payload, lane, signal) => {
    const { env } = getCloudflareContext(), identity = getDurableObjectIdentity(), context = execution.getStore();
    const profiles = {
      FlueOwnerRuntimeAgent: { profile: "owner", agentName: "owner-runtime", lane: "shadow" },
      FlueInterlocutorRuntimeAgent: { profile: "interlocutor", agentName: "interlocutor-runtime", lane: "shadow" },
      FlueOwnerDialogueRuntimeAgent: { profile: "owner-dialogue", agentName: "owner-dialogue-runtime", lane: "owner-dialogue" },
    };
    const selected = profiles[identity.className as keyof typeof profiles];
    if (!selected || lane !== selected.lane || !context?.submissionId || context.agentName !== selected.agentName) throw new Error("episode_denied");
    const nominal = { profile: selected.profile, runtimeId: identity.name, submissionId: context.submissionId };
    const { host, episodeId } = await resolve(env, nominal);
    return host.model(episodeId, nominal, payload, signal);
  }));
}
