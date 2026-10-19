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

const css = `
:root{color-scheme:light;--ink:#18241e;--secondary:#4c5a50;--muted:#6c796f;--line:#dfe6df;--paper:#f6f8f5;--white:#fff;--green:#17623d;--green-dark:#104a2e;--soft:#eaf3ec;--focus:#126541}
*{box-sizing:border-box}
html{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink)}
body{margin:0;min-width:320px}
a{color:var(--green);text-underline-offset:3px}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.shell{max-width:1120px;margin:0 auto;padding:28px 32px 64px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;font-size:16px;font-weight:700;letter-spacing:-.025em}
.brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--green);color:#fff;font-size:16px;font-weight:750;letter-spacing:-.06em}
.top-note{color:var(--muted);font-size:13px}
.content{max-width:680px;margin:0 auto;padding-top:64px}
.eyebrow{margin:0 0 12px;color:var(--green);font-size:12px;font-weight:700;letter-spacing:.11em;text-transform:uppercase}
h1{margin:0;font-size:clamp(30px,4vw,42px);font-weight:650;line-height:1.13;letter-spacing:-.045em}
.intro{max-width:580px;margin:16px 0 32px;color:var(--secondary);font-size:16px;line-height:1.65}
.panel{background:var(--white);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 3px rgba(20,40,27,.04);overflow:hidden}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:24px 28px;border-bottom:1px solid var(--line)}
h2{margin:0;font-size:18px;font-weight:650;line-height:1.35;letter-spacing:-.025em}
.panel-subtitle{margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.5}
.badge{display:inline-flex;align-items:center;gap:8px;flex:none;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#f8faf8;color:var(--secondary);font-size:12px;font-weight:650;white-space:nowrap}
.badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#9aa79d}
.badge.pending:before{background:#b78018}.badge.active:before{background:var(--green)}
.panel-body{padding:28px}
.field{margin-bottom:20px}
label{display:block;margin-bottom:8px;font-size:13px;font-weight:650;color:var(--ink)}
.hint{display:block;margin-top:8px;color:var(--muted);font-size:12px;line-height:1.5}
input[type=text],input[type=password],input[type=url]{display:block;width:100%;min-height:46px;padding:11px 13px;border:1px solid #cbd7cd;border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:15px;transition:border-color .15s ease,box-shadow .15s ease}
input::placeholder{color:#8c988e}
input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(23,98,61,.1);outline:0}
.check-row{display:flex;align-items:flex-start;gap:12px;margin:24px 0;padding:16px;border:1px solid var(--line);border-radius:8px;background:#fafcf9}
.check-row input{width:18px;height:18px;min-width:18px;margin:1px 0 0;accent-color:var(--green)}
.check-row label{margin:0;font-size:13px;line-height:1.55;font-weight:550}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:11px 18px;border:1px solid var(--green);border-radius:8px;background:var(--green);color:#fff;font:inherit;font-size:14px;font-weight:650;text-decoration:none;cursor:pointer;transition:background .15s ease}
.button:hover{background:var(--green-dark)}
.button.secondary{background:#fff;color:var(--green)}.button.secondary:hover{background:var(--soft)}
.button-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.state-copy{margin:0 0 24px;color:var(--secondary);font-size:14px;line-height:1.6}
.notice{margin:0 0 20px;padding:12px 16px;border:1px solid #bdd6c1;border-radius:8px;background:var(--soft);color:#174c31;font-size:13px;line-height:1.5}
.next{margin-top:24px;padding:24px 28px;border:1px solid var(--line);border-radius:12px;background:#fff}
.next h2{font-size:16px}.next p{margin:8px 0 0;color:var(--secondary);font-size:14px;line-height:1.6}
.steps{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.step{padding:7px 10px;border:1px solid var(--line);border-radius:7px;color:var(--muted);font-size:12px;font-weight:600}
.step.current{background:var(--soft);border-color:#bdd6c1;color:var(--green)}
.mcp-label{display:block;margin:24px 0 8px;font-size:13px;font-weight:650}.mcp-url{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
.footnote{max-width:620px;margin:24px 0 0;color:var(--muted);font-size:12px;line-height:1.65}
@media(max-width:600px){.shell{padding:20px 16px 40px}.topbar{padding-bottom:20px}.top-note{display:none}.content{padding-top:40px}.intro{font-size:15px;margin-bottom:24px}.panel-head{display:block;padding:20px}.badge{margin-top:16px}.panel-body{padding:20px}.next{padding:20px}.button{width:100%}.button-row{display:block}}
`;

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
      <section class="next" aria-labelledby="next-title"><h2 id="next-title">Depois de conectar</h2><p>Nenhuma conversa ou grupo é liberado automaticamente. O download de fotos, PDFs e áudios recebidos será conferido no primeiro teste de mídia. Escolha os chats que o MCP poderá acessar e faça um teste com um grupo seu antes do uso diário.</p><div class="steps" aria-label="Etapas"><span class="step ${input.status.state !== "active" ? "current" : ""}">1 · Conectar Z-API</span><span class="step ${input.status.state === "active" ? "current" : ""}">2 · Adicionar ao ChatGPT</span><span class="step">3 · Liberar e testar chats</span></div></section>
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
