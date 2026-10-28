import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Model, ProviderStreams, TranscriptContext } from "@earendil-works/pi-ai";
export type EpisodePayload = { messages: { role: "system" | "user" | "assistant"; content: string }[] };
export type EpisodeLane = "shadow" | "owner-dialogue";
export const OWNER_DIALOGUE_COMPLETION = "owner_dialogue_complete";
const bytes = (value: string) => new TextEncoder().encode(value).length;
function payload(context: TranscriptContext): EpisodePayload {
  const copy: TranscriptContext = JSON.parse(JSON.stringify(context));
  if (!Array.isArray(copy.messages) || copy.messages.length > 64) throw 0;
  const messages = copy.messages.map(message => {
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") throw 0;
    // Flue always declares its reserved task tool. These profiles have no
    // children: omit that declaration and reject every other tool/history call.
    if (message.role === "system" && (message.toolsAdded ?? []).some(tool => tool.name !== "task")) throw 0;
    const content = typeof message.content === "string" ? message.content : message.content.map(part => {
      if (part.type !== "text" || typeof part.text !== "string") throw 0; return part.text;
    }).join("\n");
    const sections = Object.values(message.role === "system" ? message.sections ?? {} : {}).filter(value => value !== null);
    if (sections.some(value => typeof value !== "string")) throw 0;
    return { role: message.role, content: [content, ...sections].join("\n") };
  });
  const result = { messages }; if (bytes(JSON.stringify(result)) > 60000) throw 0; return result;
}
/** Native Pi adapter. The host returns only a complete, revalidated JSON
 * proposal. No partial token/event crosses this boundary before that check. */
export function createEpisodeProvider(call: (payload: EpisodePayload, lane: EpisodeLane) => Promise<string>) {
  const model: Model<"assistant-shadow"> = { id: "shadow", name: "Fenced shadow episode", provider: "assistant-host", api: "assistant-shadow", baseUrl: "",
    reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = [model, { ...model, id: "owner-dialogue", name: "Private owner dialogue" }];
  const stream: ProviderStreams["streamSimple"] = (requested, context, options) => {
    const selected = models.find(candidate => candidate.id === requested.id && candidate.provider === requested.provider && candidate.api === requested.api);
    const active = selected ?? model;
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", api: active.api, provider: active.provider, model: active.id, content: [],
      // Billing authority is the host's persistent budget/receipt, not Pi usage.
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    void (async () => {
      try {
        if (!selected) throw 0;
        const request = payload(context);
        if (options?.signal?.aborted) throw 0;
        const text = await call(request, selected.id as EpisodeLane);
        if (options?.signal?.aborted || typeof text !== "string" || bytes(text) > 24000) throw 0;
        // Dialogue questions, context and answers stay in the host's private
        // journal. Even a faulty host cannot stream them into Flue history.
        if (selected.id === "owner-dialogue" && text !== OWNER_DIALOGUE_COMPLETION) throw 0;
        output.push({ type: "start", partial: message });
        message.content = [{ type: "text", text }];
        output.push({ type: "text_start", contentIndex: 0, partial: message });
        output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        output.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        output.push({ type: "done", reason: "stop", message });
      } catch { message.content = []; message.stopReason = "error"; message.errorMessage = "episode_model_blocked"; output.push({ type: "error", reason: "error", error: message }); }
      finally { output.end(); }
    })();
    return output;
  };
  return createProvider({ id: "assistant-host", models, auth: { apiKey: { name: "Host admission", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } });
}
