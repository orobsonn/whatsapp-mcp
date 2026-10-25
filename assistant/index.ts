import type { AssistantEnv } from "./env";

export default {
  fetch(request: Request, _env: AssistantEnv): Response {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json(
        {
          mode: "shadow",
          capabilities: { whatsappSend: false, calendarWrite: false },
        },
        { headers },
      );
    }

    // Deny by default. Request content cannot grant an effect capability.
    return Response.json({ error: "shadow_only" }, { status: 403, headers });
  },
} satisfies ExportedHandler<AssistantEnv>;
