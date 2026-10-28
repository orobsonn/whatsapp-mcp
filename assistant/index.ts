import type { AssistantEnv } from "./env";
import { receiveCapture } from "./ingress";
import { receiveTelegram } from "./telegram-webhook";
import { runScheduledAssistant } from "./scheduler";
export { CogneeContainer, CogneeBroker } from "./container";

export default {
  async scheduled(_controller: ScheduledController, env: AssistantEnv, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      if (env.TELEGRAM_OWNER_DIALOGUE_ENABLED === "shadow") {
        const { tickOwnerDialogues } = await import("./telegram-dialogue-runtime");
        await tickOwnerDialogues(env);
      }
      await runScheduledAssistant(env);
    })());
  },
  async fetch(request: Request, env: AssistantEnv): Promise<Response> {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json(
        {
          mode: "shadow",
          capabilities: { whatsappSend: false, calendarWrite: env.CALENDAR_OAUTH_PERMISSION === "write_owned" && !!env.CALENDAR_WRITE_CALENDAR },
        },
        { headers },
      );
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/internal/capture")
      return receiveCapture(request, env);

    if (request.method === "POST" && new URL(request.url).pathname === "/webhooks/telegram")
      return receiveTelegram(request, env);

    // Deny by default. Request content cannot grant an effect capability.
    return Response.json({ error: "shadow_only" }, { status: 403, headers });
  },
} satisfies ExportedHandler<AssistantEnv>;
