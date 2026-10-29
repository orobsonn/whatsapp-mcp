import type { AssistantEnv } from "./env";
import { receiveCapture } from "./ingress";
import { receiveTelegram } from "./telegram-webhook";
import { runScheduledAssistant } from "./scheduler";
export { CogneeContainer, CogneeBroker } from "./container";

export default {
  async scheduled(_controller: ScheduledController, env: AssistantEnv, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      if(env.NATIVE_CONVERSATIONS_MODE&&env.NATIVE_CONVERSATIONS_MODE!=='off'){
        const {NativeApplicationHost}=await import('./agent-runtime/native-host');
        const host=new NativeApplicationHost(env);
        // Pausing inference/effects must not strand physical cleanup of an
        // already tombstoned native context. This path never admits input.
        if(env.ROUTINES_PAUSED==='true')await host.sweepRetiredContexts();
        else await host.tick();
        // One inference path per input. Legacy materialization and native
        // canonical intake share the same capture store, never duplicate jobs.
        return;
      }
      if (env.TELEGRAM_OWNER_DIALOGUE_ENABLED === "shadow") {
        const { tickOwnerDialogues } = await import("./telegram-dialogue-runtime");
        await tickOwnerDialogues(env);
      }
      await runScheduledAssistant(env);
      if(env.WHATSAPP_APPROVED_SEND_ENABLED==='true'&&env.ROUTINES_PAUSED!=='true'){
        const {createTelegramApprovedSendReview}=await import('./telegram-approved-send');
        await (await createTelegramApprovedSendReview(env,{installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!})).reconcile();
      }
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
          capabilities: { whatsappSend: env.WHATSAPP_APPROVED_SEND_ENABLED==='true'&&!!env.WHATSAPP_APPROVED_SEND&&env.ROUTINES_PAUSED!=='true',whatsappAutonomousSend:false, calendarWrite: env.CALENDAR_OAUTH_PERMISSION === "write_owned" && !!env.CALENDAR_WRITE_CALENDAR },
        },
        { headers },
      );
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/internal/capture")
      return receiveCapture(request, env, async sequence => {
        const {NativeApplicationHost}=await import('./agent-runtime/native-host');
        await new NativeApplicationHost(env).receiveCapture(sequence);
      });

    if (request.method === "POST" && new URL(request.url).pathname === "/webhooks/telegram")
      return receiveTelegram(request, env);

    // Deny by default. Request content cannot grant an effect capability.
    return Response.json({ error: "shadow_only" }, { status: 403, headers });
  },
} satisfies ExportedHandler<AssistantEnv>;
