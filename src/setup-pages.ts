import { pageCss as css } from "./page-style";
import type { ConnectionStatus } from "./connection";
import { escapeHtml } from "./pages";

type SetupPageInput = {
  nonce: string;
  status: ConnectionStatus;
  gptUrl?: string;
  origin: string;
  notice?: string;
};

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        )) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function safeGptUrl(
  value: string | undefined,
  origin: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.protocol !== "https:")
      return undefined;
    if (
      url.origin !== origin &&
      url.hostname !== "chatgpt.com" &&
      !url.hostname.endsWith(".chatgpt.com")
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function statusDetails(status: ConnectionStatus): {
  label: string;
  badgeClass: string;
  body: string;
} {
  switch (status.state) {
    case "active":
      return {
        label: "Conectado",
        badgeClass: "active",
        body: "A conexão foi verificada. Agora você pode adicionar este MCP ao ChatGPT e escolher quais conversas terão acesso.",
      };
    case "pending":
      return {
        label: "Verificação pendente",
        badgeClass: "pending",
        body: "A configuração foi recebida, mas a verificação ainda não terminou. Retome a mesma tentativa para conferir o resultado; não cadastre outra instância agora.",
      };
    case "unavailable":
      return {
        label: "Indisponível",
        badgeClass: "",
        body: "Não foi possível consultar a conexão agora. Recarregue esta página em alguns instantes.",
      };
    default:
      return {
        label: "Não configurado",
        badgeClass: "",
        body: "Use uma instância Z-API exclusiva deste MCP. Os três dados ficam protegidos no servidor e não voltam a aparecer nesta página.",
      };
  }
}

export function renderSetupPage(input: SetupPageInput): Response {
  const details = statusDetails(input.status);
  const origin = safeOrigin(input.origin);
  const gptUrl = safeGptUrl(input.gptUrl, origin);
  const mcpUrl = origin ? `${origin}/mcp` : undefined;
  const nonce = escapeHtml(input.nonce);
  const revision = escapeHtml(input.status.revision);
  const notice = input.notice
    ? `<p class="notice" role="status">${escapeHtml(input.notice)}</p>`
    : "";
  let panelContent: string;

  if (input.status.state === "unconfigured") {
    panelContent = `${notice}<p class="state-copy">${details.body}</p>
      <form method="post" action="/setup" autocomplete="off">
        <input type="hidden" name="nonce" value="${nonce}">
        <input type="hidden" name="revision" value="${revision}">
        <input type="hidden" name="action" value="connect">
        <div class="field"><label for="instance-id">ID da instância</label><input id="instance-id" name="instance_id" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Cole o ID da Z-API"></div>
        <div class="field"><label for="instance-token">Token da instância</label><input id="instance-token" name="instance_token" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Cole o token da instância"></div>
        <div class="field"><label for="client-token">Client-Token</label><input id="client-token" name="client_token" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Cole o Client-Token"><span class="hint">Você encontra esses dados no painel da sua instância Z-API.</span></div>
        <div class="check-row"><input id="exclusive-instance" name="exclusive_instance" type="checkbox" value="on" required><label for="exclusive-instance">Confirmo que esta instância é exclusiva deste WhatsApp MCP e não está ligada ao Elo nem a outra integração.</label></div>
        <button class="button" type="submit">Salvar e verificar</button>
      </form>`;
  } else if (input.status.state === "pending") {
    panelContent = `${notice}<p class="state-copy">${details.body}</p>
      <form method="post" action="/setup">
        <input type="hidden" name="nonce" value="${nonce}">
        <input type="hidden" name="revision" value="${revision}">
        <input type="hidden" name="attempt_id" value="${escapeHtml(input.status.attemptId ?? "")}">
        <input type="hidden" name="action" value="retry">
        <button class="button" type="submit">Retomar configuração</button>
      </form>`;
  } else if (input.status.state === "active") {
    panelContent = `${notice}<p class="state-copy">${details.body}</p>
      ${gptUrl ? `<div class="button-row"><a class="button" href="${escapeHtml(gptUrl)}" rel="noopener noreferrer">Conectar no GPT</a></div>` : ""}
      ${mcpUrl ? `<label class="mcp-label" for="mcp-url">Endereço do MCP para conexão manual</label><input class="mcp-url" id="mcp-url" type="url" readonly value="${escapeHtml(mcpUrl)}" aria-describedby="mcp-help"><span class="hint" id="mcp-help">Use este endereço se o botão de conexão não estiver disponível no seu ChatGPT.</span>` : ""}`;
  } else {
    panelContent = `${notice}<p class="state-copy">${details.body}</p>`;
  }

  const body = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Configurar conexão · WhatsApp MCP</title>
  <style>${css}</style>
</head>
<body>
  <div class="shell">
    <header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">W</span><span>WhatsApp MCP</span></div><span class="top-note">Configuração privada</span></header>
    <main class="content">
      <p class="eyebrow">Sua conexão</p>
      <h1>Conecte seu WhatsApp ao MCP</h1>
      <p class="intro">Adicione os dados da sua instância Z-API. Depois da verificação, conecte o MCP ao ChatGPT para começar a usar.</p>
      <section class="panel" aria-labelledby="connection-title">
        <div class="panel-head"><div><h2 id="connection-title">Conexão Z-API</h2><p class="panel-subtitle">Dados da instância e estado da configuração</p></div><span class="badge ${details.badgeClass}">${escapeHtml(details.label)}</span></div>
        <div class="panel-body">${panelContent}</div>
      </section>
      <section class="next" aria-labelledby="next-title"><h2 id="next-title">Depois de conectar</h2><p>Novas conversas e grupos seguem o padrão automático de captura. Exceções desativadas e conversas antigas pendentes de revisão permanecem bloqueadas. O download de fotos, PDFs e áudios recebidos será conferido no primeiro teste de mídia. Revise as exceções e a retenção e faça um teste com um grupo seu antes do uso diário.</p><div class="steps" aria-label="Etapas"><span class="step ${input.status.state !== "active" ? "current" : ""}">1 · Conectar Z-API</span><span class="step ${input.status.state === "active" ? "current" : ""}">2 · Adicionar ao ChatGPT</span><span class="step">3 · Revisar captura e testar</span></div></section>
      <p class="footnote">Esta página exige seu acesso privado. Não compartilhe tokens em conversas nem salve capturas de tela do formulário preenchido.</p>
    </main>
  </div>
</body>
</html>`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
