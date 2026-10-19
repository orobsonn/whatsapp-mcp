import type { Env } from "./env";
import {
  AuthError,
  publicOrigin,
  requireSetupOwner,
  issueSetupNonce,
  consumeSetupNonce,
} from "./auth";
import { AppError, json } from "./core";
import {
  connectConnection,
  getConnectionStatus,
  retryConnection,
} from "./connection";
import { humanErrorPage } from "./pages";
import { renderSetupPage } from "./setup-pages";

/** Human setup is deliberately routed with raw bindings, before runtime connection gates. */
export async function setupFetch(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    await requireSetupOwner(request, env);
    const url = new URL(request.url);
    if (url.pathname !== "/setup" && url.pathname !== "/setup/status")
      return json({ error: "not_found" }, 404);
    if (request.method !== "GET" && request.method !== "POST")
      return new Response("Método não permitido.", {
        status: 405,
        headers: { Allow: "GET, POST", "Cache-Control": "no-store" },
      });
    const before = await getConnectionStatus(env);
    if (url.pathname === "/setup/status")
      return request.method === "GET"
        ? json(before)
        : json({ error: "method_not_allowed" }, 405);
    if (request.method === "GET")
      return renderSetupPage({
        status: before,
        nonce:
          before.state === "unconfigured" || before.state === "pending"
            ? await issueSetupNonce(env, request, "connection", before.revision)
            : "",
        gptUrl: env.GPT_PLUGIN_URL ?? "",
        origin: publicOrigin(env),
      });
    const params = await consumeSetupNonce(
      env,
      request,
      "connection",
      before.revision,
    );
    const action = params.get("action"),
      keys =
        action === "connect"
          ? [
              "nonce",
              "revision",
              "action",
              "instance_id",
              "instance_token",
              "client_token",
              "exclusive_instance",
            ]
          : action === "retry"
            ? ["nonce", "revision", "action", "attempt_id"]
            : [];
    if (
      !keys.length ||
      [...params.keys()].some((k) => !keys.includes(k)) ||
      keys.some((k) => params.getAll(k).length !== 1) ||
      params.get("revision") !== before.revision
    )
      throw new AppError("invalid_setup_form", 400);
    if (action === "connect") {
      if (before.state !== "unconfigured")
        throw new AppError("connection_exists", 409);
      if (params.get("exclusive_instance") !== "on")
        throw new AppError("exclusive_instance_required", 400);
      await connectConnection(env, {
        instanceId: params.get("instance_id")!,
        instanceToken: params.get("instance_token")!,
        clientToken: params.get("client_token")!,
      });
    } else {
      if (
        before.state !== "pending" ||
        params.get("attempt_id") !== before.attemptId
      )
        throw new AppError("connection_not_pending", 409);
      await retryConnection(env, params.get("attempt_id")!);
    }
    // POST/Redirect/GET prevents browser refresh from replaying credentials.
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${publicOrigin(env)}/setup`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
      },
    });
  } catch (error) {
    const status =
      error instanceof AuthError
        ? 403
        : error instanceof AppError
          ? error.status
          : 503;
    if (new URL(request.url).pathname === "/setup/status")
      return json(
        {
          error:
            error instanceof AuthError
              ? "access_denied"
              : error instanceof AppError
                ? error.code
                : "unavailable",
        },
        status,
      );
    // Fixed local messages only. Neither provider body nor submitted form is rendered.
    const notices: Record<string, string> = {
      provider_instance_mismatch:
        "A Z-API retornou dados de uma instância diferente da informada. A conexão permanece bloqueada.",
      invalid_credentials_instanceId:
        "O ID da instância está vazio ou com formato inválido. Cole somente o ID, sem a URL da API.",
      invalid_credentials_instanceToken:
        "O token da instância está vazio ou com formato inválido. Cole somente o token, sem a URL da API.",
      invalid_credentials_clientToken:
        "O Client-Token está vazio ou contém espaços internos/quebras de linha. Copie o token da conta na área Segurança da Z-API.",
      invalid_credentials:
        "Confira as três credenciais no painel Z-API e tente novamente.",
      invalid_setup_form: "Confira os campos e tente novamente.",
      exclusive_instance_required:
        "Confirme que esta instância é exclusiva deste projeto.",
      device_not_connected:
        "O WhatsApp desta instância está desconectado. Conecte o aparelho no painel Z-API e tente novamente.",
      instance_in_use:
        "Esta instância tem webhooks de outra integração. Use uma instância exclusiva; nenhum webhook foi alterado nesta tentativa.",
      callback_contract_unavailable:
        "A Z-API não apresentou todos os dados necessários para verificar os webhooks. A conexão permanece bloqueada.",
      connection_busy:
        "A tentativa ainda está em andamento ou aguardando uma pausa de segurança. Aguarde 30 segundos e reabra a página.",
      provider_unavailable:
        "Não foi possível validar a instância na Z-API. Confira as três credenciais, a conexão do aparelho e tente novamente.",
    };
    // Codes contain only closed endpoint names and local categories, never remote bodies.
    const providerCode = error instanceof AppError ? error.code : "";
    const diagnostic =
      /^provider_(auth|instance|rate|http|network)_(status|device|me|update-webhook-received|update-webhook-received-delivery|update-webhook-message-status|update-notify-sent-by-me)$/.exec(
        providerCode,
      );
    const providerNotices: Record<string, string> = {
      auth: "A Z-API recusou a autenticação. Confira o token da instância e o Client-Token da conta no painel Z-API.",
      instance:
        "A Z-API não encontrou a instância. Confira o ID e o token da instância.",
      rate: "A Z-API limitou as consultas. Aguarde um minuto antes de tentar novamente.",
      http: "A Z-API recusou a consulta. Confira a situação da instância no painel Z-API.",
      network:
        "Não foi possível obter uma resposta válida da Z-API. Pode haver indisponibilidade ou demora do fornecedor.",
    };
    const providerNotice = diagnostic
      ? providerNotices[diagnostic[1]!]
      : undefined;
    const contractDiagnostic =
      /^callback_contract_(receivedCallbackUrl|messageStatusCallbackUrl|connectedCallbackUrl|deliveryCallbackUrl|disconnectedCallbackUrl|presenceChatCallbackUrl|initialDataCallbackUrl|receiveCallbackSentByMe)_(missing|long_string|invalid_type)$/.test(
        providerCode,
      )
        ? "A Z-API retornou informações que ainda não conseguimos verificar. A conexão não foi alterada. Tente novamente mais tarde ou peça ajuda pelo chat."
        : undefined;
    const message =
      status === 403
        ? "Acesso ou confirmação recusados."
        : (contractDiagnostic ??
          providerNotice ??
          notices[error instanceof AppError ? error.code : ""] ??
          (status === 409
            ? "A conexão mudou. Confira o estado atual abaixo."
            : "Não foi possível concluir a conexão. Confira o estado atual abaixo e retome a mesma tentativa se estiver pendente."));
    if (status !== 403) {
      try {
        const current = await getConnectionStatus(env);
        const nonce =
          current.state === "unconfigured" || current.state === "pending"
            ? await issueSetupNonce(
                env,
                request,
                "connection",
                current.revision,
              )
            : "";
        const page = renderSetupPage({
          status: current,
          nonce,
          gptUrl: env.GPT_PLUGIN_URL ?? "",
          origin: publicOrigin(env),
          notice: message,
        });
        return new Response(page.body, { status, headers: page.headers });
      } catch {
        /* Storage/auth failures cannot safely issue a fresh form. */
      }
    }
    return humanErrorPage(
      error instanceof AppError ? error.code : "access_denied",
      status,
    );
  }
}
