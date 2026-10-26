import { metricStatement } from "./capture-policy";
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
import {
  uploadPage,
  audioPreviewPage,
  uploadResultPage,
  invitePage,
  humanErrorPage,
  isHumanPagePath,
  isProtocolPath,
  confirmationResultPage,
} from "./pages";
import { getGroupAction, approveGroupAction, getGroupInvite } from "./groups";
import pkg from "../package.json";
import { resolveRuntimeEnv } from "./connection";
import { setupFetch } from "./setup";
import { processTranscriptions } from "./transcription";
import { getGeneratedAudio, cleanupAudioGenerations } from "./tts";
import { deliverCaptureChanges } from "./assistant-bridge";

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
  if (body.type !== "ReceivedCallback" && body.type !== "DeletedCallback")
    return json({ ignored: true });
  if (body.connectedPhone !== env.CONNECTED_PHONE || !env.CONNECTED_PHONE)
    throw new AppError("device_changed", 403);
  try {
    const result = await ingestEvent(
      env,
      currentFence(env),
      normalizeZapiEvent(body),
      true,
    );
    return json({ accepted: true, captured: result.captured });
  } catch (error) {
    // No payload, names, addresses or exception messages in metrics. DB outages may also prevent this counter.
    try {
      await env.DB.batch([
        metricStatement(env, "received"),
        metricStatement(env, "failed"),
      ]);
    } catch {}
    throw error;
  }
}
async function browserRoute(request: Request, env: Env): Promise<Response> {
  const u = new URL(request.url),
    parts = u.pathname.split("/");
  if (u.pathname === "/health")
    return json({
      service: "whatsapp-mcp",
      version: pkg.version,
      maintenance: env.MAINTENANCE !== "false",
      connectionConfigured: Boolean(
        env.ZAPI_INSTANCE_ID &&
          env.ZAPI_TOKEN &&
          env.ZAPI_CLIENT_TOKEN &&
          env.MAINTENANCE === "false",
      ),
    });
  if (parts[1] === "webhook") return webhook(request, env, parts);
  if (
    parts[1] === "audio" &&
    (parts.length === 3 || (parts.length === 4 && parts[3] === "file"))
  ) {
    await requireOwner(request, env);
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405);
    const generation = await getGeneratedAudio(env, parts[2]!);
    if (
      generation.status !== "ready" ||
      !generation.media ||
      generation.text === null ||
      generation.voice === null
    )
      throw new AppError("tts_media_unavailable", 409);
    if (parts.length === 3)
      return audioPreviewPage({
        id: generation.id,
        chatName: (await getChat(env, generation.media.chatId)).name,
        text: generation.text,
        voice: generation.voice,
        filename: generation.media.filename ?? "audio.mp3",
        size: generation.media.size!,
      });
    const { metadata, bytes } = await readMedia(env, generation.media.id);
    const headers = new Headers({
      "content-type": "audio/mpeg",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(metadata.filename ?? "audio.mp3")}`,
      "cache-control": "private, no-store",
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    let start = 0,
      end = bytes.length - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        headers.set("content-range", `bytes */${bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= bytes.length ||
        (!match[1] && Number(match[2]) === 0)
      ) {
        headers.set("content-range", `bytes */${bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set("content-range", `bytes ${start}-${end}/${bytes.length}`);
    }
    headers.set("content-length", String(end - start + 1));
    return new Response(bytes.slice(start, end + 1), {
      status: range ? 206 : 200,
      headers,
    });
  }
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
        context: action.chat.name,
        resourceId: action.id,
        envelope: action.envelope,
        summary: `Enviar para ${action.chat.name} (${action.chat.kind}). Confira o conteúdo e o hash.`,
      },
      async (proof) => {
        await approveAction(env, action.id, proof);
        return confirmationResultPage(
          "A ação foi autorizada. Volte ao chat para concluir a execução.",
        );
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
        return confirmationResultPage(
          "A ação foi autorizada. Volte ao chat para concluir a execução.",
        );
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
    return invitePage(chat.name, invite);
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
        context: scope,
        resourceId: p.id,
        envelope: p.envelope,
        summary: `Alteração de ${scope}. Confira o escopo; exclusões locais não podem ser desfeitas.`,
      },
      async (proof) => {
        await applyPolicyProposal(env, p.id, proof);
        return confirmationResultPage("A alteração do arquivo foi aplicada.");
      },
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
      return uploadPage({ chatName: chat.name, chatId: chat.id });
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
    const media = await uploadMedia(env, chat.id, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      filename: file.name,
    });
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/json") && !accept.includes("text/html"))
      return json(media);
    return uploadResultPage({
      chatName: chat.name,
      chatId: chat.id,
      filename: media.filename ?? "Arquivo",
      size: media.size ?? 0,
      kind: media.kind,
    });
  }
  if (u.pathname === "/")
    return new Response(null, {
      status: 302,
      headers: { location: "/setup", "cache-control": "no-store" },
    });
  return json({ error: "not_found" }, 404);
}
function jsonUpload(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return (
    /^\/upload\/[^/]+$/.test(new URL(request.url).pathname) &&
    accept.includes("application/json") &&
    !accept.includes("text/html")
  );
}
async function browser(request: Request, env: Env): Promise<Response> {
  try {
    return await browserRoute(request, env);
  } catch (error) {
    if (jsonUpload(request))
      return error instanceof AuthError
        ? json({ error: "access_denied" }, 403)
        : errorResponse(error);
    if (isHumanPagePath(new URL(request.url).pathname))
      return humanErrorPage(
        error instanceof AppError ? error.code : "access_denied",
        error instanceof AppError
          ? error.status
          : error instanceof AuthError
            ? 403
            : 500,
        { retryPath: new URL(request.url).pathname },
      );
    throw error;
  }
}
function presentBrowserError(request: Request, response: Response): Response {
  const path = new URL(request.url).pathname;
  if (
    response.status < 400 ||
    response.headers.get("content-type")?.includes("text/html") ||
    isProtocolPath(path) ||
    jsonUpload(request)
  )
    return response;
  if (
    isHumanPagePath(path) ||
    (request.headers.get("accept")?.includes("text/html") &&
      !isProtocolPath(path))
  )
    return humanErrorPage("", response.status, {
      headers: response.headers,
      retryPath: path,
    });
  return response;
}
const oauth = createOAuthProvider<Env>(
  { fetch: (request, env, ctx) => mcpFetch(request, env, ctx.props) },
  { fetch: browser },
);
export default {
  async fetch(
    request: Request,
    rawEnv: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/setup" || path.startsWith("/setup/"))
        return presentBrowserError(request, await setupFetch(request, rawEnv));
      const env = await resolveRuntimeEnv(rawEnv);
      if (
        new URL(request.url).pathname.startsWith("/webhook/") ||
        new URL(request.url).pathname === "/health"
      )
        return await browser(request, env);
      return presentBrowserError(request, await oauth.fetch(request, env, ctx));
    } catch (error) {
      return presentBrowserError(
        request,
        error instanceof AuthError
          ? json({ error: "access_denied" }, 403)
          : errorResponse(error),
      );
    }
  },
  async scheduled(
    _event: ScheduledController,
    rawEnv: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const env = await resolveRuntimeEnv(rawEnv);
    if (env.MAINTENANCE !== "false") return;
    _ctx.waitUntil(deliverCaptureChanges(env).catch(() => {
      console.warn("assistant_bridge_failed");
    }));
    await processMediaJobs(env);
    await cleanupAudioGenerations(env);
    await cleanup(env);
    await processTranscriptions(env);
  },
};

export { CaptureReader } from "./assistant-source-reader";
export { CaptureMediaReader } from "./assistant-media-reader";
