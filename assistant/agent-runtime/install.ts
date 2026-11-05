import { AsyncLocalStorage } from "node:async_hooks";
import { instrument, setProvider, type FlueExecutionContext, type LlmTurnPurpose } from "@flue/runtime";
import { getCloudflareContext, getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import { createEpisodeProvider, type EpisodePayload } from "./provider";
import type { RuntimeIdentity } from "../agent/controller";
export type NativeExecutionContext=FlueExecutionContext&{nativeModelPurpose?:LlmTurnPurpose};
type ScopedExecutionContext=NativeExecutionContext&{modelPurposes?:Map<string,LlmTurnPurpose>};
type Resolver = (env: Record<string, unknown>, identity: RuntimeIdentity) => Promise<{
  host: { model(id: string, identity: RuntimeIdentity, payload: EpisodePayload, signal?: AbortSignal): Promise<string> }; episodeId: string;
}>;
/** Invocation-local host correlation; no global mutable active job/context. */
export function installEpisodeRuntime(resolve: Resolver,native?:{install(context:()=>NativeExecutionContext|undefined):void}) {
  const execution = new AsyncLocalStorage<ScopedExecutionContext>();
  instrument({ observe(event) {
    // Synchronous SDK metadata only. No request content or ambient active turn.
    const active=execution.getStore();if(event.type==='turn_request'&&active){
      active.modelPurposes??=new Map();if(active.modelPurposes.size>=32)active.modelPurposes.delete(active.modelPurposes.keys().next().value!);
      active.modelPurposes.set(event.turnId,event.purpose);
    }
  }, dispose() {}, async interceptor(operation, context, next) {
    // Model operations omit submissionId in Flue2.3; inherit the enclosing
    // native agent operation's trusted correlation, never message metadata.
    const defined = Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
    const inherited:ScopedExecutionContext={ ...execution.getStore(), ...defined,...(operation.type==='agent'?{modelPurposes:new Map<string,LlmTurnPurpose>()}:{}) };
    let nativeAgent=false;
    if(native){try{nativeAgent=getDurableObjectIdentity().className==='FlueConversationRuntimeAgent'&&inherited.agentName==='conversation-runtime';}catch{/* no agent authority outside a named native DO */}}
    if(operation.type==='task'||operation.type==='agent'&&operation.operationKind==='task'||operation.type==='tool'&&!nativeAgent)throw Error('episode_tools_disabled');
    // Native model operation identity includes compaction and may differ from
    // its enclosing prompt; the actual Flue turnId owns monetary idempotency.
    const purpose=nativeAgent&&operation.type==='model'?inherited.modelPurposes?.get(operation.turnId):undefined;
    if(nativeAgent&&operation.type==='model')inherited.modelPurposes?.delete(operation.turnId);
    return execution.run({ ...inherited,...(nativeAgent&&operation.type==='model'?{turnId:operation.turnId,nativeModelPurpose:purpose}:{}) }, next);
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
  native?.install(()=>execution.getStore());
}
