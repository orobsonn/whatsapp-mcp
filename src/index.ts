import type { Env } from "./env";
import {
  AppError,
  assertActive,
  currentFence,
  safeEqual,
  readBounded,
  json,
  errorResponse,
  LIMITS,
} from "./core";
import {
  createOAuthProvider,
  requireOwner,
  humanConfirmation,
  AuthError,
  publicOrigin,
} from "./auth";
import { ingestEvent, ingestStatus, normalizeZapiEvent } from "./capture";
import { getAction, approveAction, reconcileActions } from "./actions";
import { mcpFetch } from "./mcp";
import { getChat } from "./store";
import { readMedia, uploadMedia, processMediaJobs } from "./media";
import { getPolicyProposal, applyPolicyProposal, cleanup } from "./operations";
import { escapeHtml } from "./pages";
import { getGroupAction, approveGroupAction, getGroupInvite } from "./groups";
import pkg from "../package.json";

async function webhook(
  request: Request,
  env: Env,
  segments: string[],
): Promise<Response> {
  if (
    request.method !== "POST" ||
    segments.length !== 4 ||
    !env.WEBHOOK_SECRET ||
    env.WEBHOOK_SECRET.length < 24 ||
    segments[2] !== env.CONNECTION_GENERATION ||
    !(await safeEqual(segments[3]!, env.WEBHOOK_SECRET))
  )
    return json({ error: "not_found" }, 404);
  assertActive(env);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError("invalid_content_type", 415);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBounded(request)));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_json");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.instanceId !== env.ZAPI_INSTANCE_ID ||
    !env.ZAPI_INSTANCE_ID
  )
    throw new AppError("invalid_instance", 403);
  if (body.type === "MessageStatusCallback") {
    if (
      String(body.phoneDevice ?? "") !== env.CONNECTED_PHONE ||
      !env.CONNECTED_PHONE
    )
      throw new AppError("device_changed", 403);
    const statuses: Record<string, "sent" | "delivered" | "read"> = {
      SENT: "sent",
      RECEIVED: "delivered",
      READ: "read",
      PLAYED: "read",
    };
    const status = statuses[String(body.status)];
    if (!status) return json({ ignored: true });
    if (
      !Array.isArray(body.ids) ||
      body.ids.length > 100 ||
      body.ids.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 256,
      )
    )
      throw new AppError("invalid_status");
    for (const externalId of body.ids as string[]) {
      const event = {
        externalId,
        chatExternalId: typeof body.phone === "string" ? body.phone : undefined,
        status,
      };
      await ingestStatus(env, currentFence(env), event);
      await reconcileActions(env, event);
    }
    return json({ accepted: true });
  }
  if (body.type !== "ReceivedCallback") return json({ ignored: true });
  if (body.connectedPhone !== env.CONNECTED_PHONE || !env.CONNECTED_PHONE)
    throw new AppError("device_changed", 403);
  const result = await ingestEvent(
    env,
    currentFence(env),
    normalizeZapiEvent(body),
  );
  return json({ accepted: true, captured: result.captured });
}
async function browser(request: Request, env: Env): Promise<Response> {
  const u = new URL(request.url),
    parts = u.pathname.split("/");
  if (u.pathname === "/health")
    return json({
      service: "whatsapp-mcp",
      version: pkg.version,
      maintenance: env.MAINTENANCE !== "false",
    });
  if (parts[1] === "webhook") return webhook(request, env, parts);
  if (parts[1] === "confirm" && parts[2] === "send" && parts.length === 4) {
    await requireOwner(request, env);
    const action = await getAction(env, parts[3]!);
    if (
      action.redacted ||
      action.status !== "proposed" ||
      action.expiresAt <= Date.now()
    )
      throw new AppError("action_not_proposed", 409);
    return humanConfirmation(
      request,
      env,
      {
        purpose: "send",
        resourceId: action.id,
        envelope: action.envelope,
        summary: `Enviar para ${action.chat.name} (${action.chat.kind}). Confira o conteúdo e o hash.`,
      },
      async (proof) => {
        await approveAction(env, action.id, proof);
        return json({
          id: action.id,
          status: "approved",
          next: "Volte ao chat e execute a ação confirmada.",
        });
      },
    );
  }
  if (parts[1] === "confirm" && parts[2] === "group" && parts.length === 4) {
    await requireOwner(request, env);
    const action = await getGroupAction(env, parts[3]!);
    if (
      action.redacted ||
      action.status !== "proposed" ||
      action.expiresAt <= Date.now()
    )
      throw new AppError("action_not_proposed", 409);
    return humanConfirmation(
      request,
      env,
      {
        purpose: "group",
        resourceId: action.id,
        envelope: action.envelope,
        summary:
          "Alteração no WhatsApp. Confira a operação, os alvos e os avisos abaixo. Limpar/excluir chat altera o WhatsApp; o arquivo local é separado. Menção a todos alcança os membros presentes na execução. autoInvite pode enviar convites privados.",
      },
      async (proof) => {
        await approveGroupAction(env, action.id, proof);
        return json({
          id: action.id,
          status: "approved",
          next: "Volte ao chat e execute a ação confirmada.",
        });
      },
    );
  }
  if (
    parts[1] === "groups" &&
    parts[3] === "invite" &&
    parts.length === 4 &&
    request.method === "GET"
  ) {
    await requireOwner(request, env);
    const chat = await getChat(env, parts[2]!);
    const invite = await getGroupInvite(env, chat.id);
    return new Response(
      `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Convite do grupo</title><h1>Convite de ${escapeHtml(chat.name)}</h1><p>Quem receber este link poderá solicitar entrada. Compartilhe conscientemente.</p><p><a rel="noreferrer noopener" href="${escapeHtml(invite)}">${escapeHtml(invite)}</a></p></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }
  if (parts[1] === "confirm" && parts[2] === "policy" && parts.length === 4) {
    await requireOwner(request, env);
    const p = await getPolicyProposal(env, parts[3]!);
    const purpose =
      p.kind === "capture"
        ? "capture-policy"
        : p.kind === "retention"
          ? "retention"
          : "delete";
    const scope =
      "chatId" in p.envelope
        ? (await getChat(env, p.envelope.chatId)).name
        : "todo o arquivo";
    return humanConfirmation(
      request,
      env,
      {
        purpose,
        resourceId: p.id,
        envelope: p.envelope,
        summary: `Alteração de ${scope}. Confira o escopo; exclusões locais não podem ser desfeitas.`,
      },
      async (proof) => json(await applyPolicyProposal(env, p.id, proof)),
    );
  }
  if (parts[1] === "media" && parts.length === 3 && request.method === "GET") {
    await requireOwner(request, env);
    const { metadata, bytes } = await readMedia(env, parts[2]!);
    return new Response(bytes, {
      headers: {
        "content-type": metadata.mime!,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.filename ?? "arquivo")}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; sandbox; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      },
    });
  }
  if (parts[1] === "upload" && parts.length === 3) {
    await requireOwner(request, env);
    const chat = await getChat(env, parts[2]!);
    if (request.method === "GET")
      return new Response(
        `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Adicionar arquivo</title><h1>Arquivo para ${escapeHtml(chat.name)}</h1><p>Até 2 MiB. Arquivo privado; enviar exige confirmação posterior.</p><form method="post" enctype="multipart/form-data"><input type="file" name="file" required><button>Guardar arquivo</button></form></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            "cache-control": "no-store",
            "referrer-policy": "same-origin",
          },
        },
      );
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    if (request.headers.get("origin") !== publicOrigin(env))
      throw new AppError("invalid_origin", 403);
    const bytes = await readBounded(request, LIMITS.mediaBytes + 65536);
    const form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: bytes,
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || form.getAll("file").length !== 1)
      throw new AppError("invalid_file");
    return json(
      await uploadMedia(env, chat.id, {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: file.type,
        filename: file.name,
      }),
    );
  }
  if (u.pathname === "/")
    return new Response(
      "WhatsApp MCP pessoal. Conecte /mcp no seu cliente. Leia o manual de instalação.",
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  return json({ error: "not_found" }, 404);
}
const oauth = createOAuthProvider<Env>(
  { fetch: (request, env, ctx) => mcpFetch(request, env, ctx.props) },
  { fetch: browser },
);
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      if (
        new URL(request.url).pathname.startsWith("/webhook/") ||
        new URL(request.url).pathname === "/health"
      )
        return await browser(request, env);
      return await oauth.fetch(request, env, ctx);
    } catch (error) {
      return error instanceof AuthError
        ? json({ error: "access_denied" }, 403)
        : errorResponse(error);
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (env.MAINTENANCE !== "false") return;
    await processMediaJobs(env);
    await cleanup(env);
  },
};
