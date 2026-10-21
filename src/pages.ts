import { pageCss } from "./page-style";
import type { ConfirmationDisplay } from "./approval";
export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
const css =
  pageCss +
  `
p{line-height:1.65;overflow-wrap:anywhere}.lead{margin:0 0 24px;color:var(--secondary)}.context,.permissions{padding:16px;margin:20px 0;background:var(--soft);border:1px solid var(--line);border-radius:8px}.context p{margin:6px 0 0;font-weight:650}.label{font-size:13px;color:var(--muted)}.review-field{padding:13px 0;border-bottom:1px solid var(--line)}.review-field strong{font-size:13px;color:var(--muted);font-weight:550}.review-field p{white-space:pre-wrap;margin:6px 0}.success{display:inline-block;padding:7px 10px;background:var(--soft);color:var(--green);border-radius:7px;font-size:13px;font-weight:650;margin:0 0 18px}.panel-body .button{margin-top:22px}.fine{border-top:1px solid var(--line);padding-top:18px;margin-top:24px;font-size:12px;color:var(--muted)}.invite{overflow-wrap:anywhere}input[type=file]{display:block;width:100%;min-width:0;max-width:100%;padding:10px;border:1px solid #cbd7cd;border-radius:8px;background:#fff;font:inherit;font-size:14px;color:var(--secondary)}input::file-selector-button{border:0;border-radius:6px;padding:10px 12px;background:var(--soft);color:var(--green);font:inherit;font-weight:600;margin-right:12px;cursor:pointer}h1{overflow-wrap:anywhere}.permissions p{margin-bottom:0}
`;
function humanPage(input: {
  title: string;
  content: string;
  status?: number;
  formOrigin?: string;
  media?: boolean;
  headers?: HeadersInit;
}): Response {
  const headers = new Headers(input.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  for (const [k, v] of Object.entries({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; ${input.media ? "media-src 'self'; " : ""}form-action 'self'${input.formOrigin ? " " + input.formOrigin : ""}; frame-ancestors 'none'; base-uri 'none'`,
  }))
    headers.set(k, v);
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)} · Zap</title><style>${css}</style></head><body><div class="shell"><header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">W</span><span>WhatsApp MCP</span></div><span class="top-note">Conexão privada</span></header><main class="content"><p class="eyebrow">Seu WhatsApp</p><h1>${escapeHtml(input.title)}</h1><section class="panel" style="margin-top:32px"><div class="panel-body">${input.content}</div></section></main></div></body></html>`,
    { status: input.status ?? 200, headers },
  );
}
const context = (name: string) =>
  `<div class="context"><span class="label">Conversa</span><p>${escapeHtml(name)}</p></div>`;
export function confirmationPage(input: {
  title: string;
  summary: string;
  envelope: string;
  hash: string;
  nonce: string;
  action: string;
  display?: ConfirmationDisplay;
  oauth?: { clientName: string; redirectUri: string; scopes: string[] };
}): Response {
  const d = input.display,
    title = d?.title ?? input.title;
  const content = input.oauth
    ? `<p class="lead"><strong>${escapeHtml(input.oauth.clientName)}</strong> quer se conectar ao seu WhatsApp pessoal.</p><div class="permissions"><strong>O que você está autorizando</strong><p>Consultar seus dados autorizados e realizar ações conforme seus pedidos. Ações críticas continuam exigindo sua confirmação nesta página.</p></div><p class="hint">Após autorizar, você voltará para ${escapeHtml(new URL(input.oauth.redirectUri).hostname)}.</p>`
    : d
      ? `${d.fields.map((f) => `<div class="review-field"><strong>${escapeHtml(f.label)}</strong><p>${escapeHtml(f.value)}</p></div>`).join("")}${d.warnings.map((w) => `<p class="notice">${escapeHtml(w)}</p>`).join("")}`
      : `<p class="lead">${escapeHtml(input.summary)}</p>`;
  return humanPage({
    title,
    formOrigin: input.oauth
      ? new URL(input.oauth.redirectUri).origin
      : undefined,
    content: `${content}<form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="nonce" value="${escapeHtml(input.nonce)}"><button class="button" type="submit">${input.oauth ? "Autorizar conexão" : escapeHtml(d?.button ?? "Confirmar")}</button></form><p class="fine">Esta autorização vale por 10 minutos e pode ser usada uma vez. Se não quiser continuar, basta fechar a página.</p>`,
  });
}
export function confirmationResultPage(message: string): Response {
  return humanPage({
    title: "Confirmação registrada",
    content: `<span class="success">Tudo certo</span><p>${escapeHtml(message)}</p><p class="fine">Você já pode fechar esta página.</p>`,
  });
}
export function uploadPage(input: {
  chatName: string;
  chatId: string;
}): Response {
  return humanPage({
    title: "Adicionar arquivo",
    content: `<p class="lead">Guarde um arquivo para usar nesta conversa. O envio será feito depois, pelo chat.</p>${context(input.chatName)}<form method="post" enctype="multipart/form-data" action="/upload/${encodeURIComponent(input.chatId)}"><label for="file">Escolha o arquivo</label><input id="file" type="file" name="file" accept="image/png,image/jpeg,image/webp,application/pdf,audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/x-m4a" required><p class="hint">Imagem, PDF ou áudio · até 2 MB</p><button class="button" type="submit">Guardar arquivo</button></form><p class="fine">Seu arquivo fica privado. Nada será enviado ao WhatsApp ao clicar neste botão.</p>`,
  });
}
export function uploadResultPage(input: {
  chatName: string;
  chatId: string;
  filename: string;
  kind: string;
  size: number;
}): Response {
  const type =
    ({ image: "Imagem", pdf: "PDF", audio: "Áudio" } as Record<string, string>)[
      input.kind
    ] ?? "Arquivo";
  const size =
    input.size < 1048576
      ? `${Math.max(1, Math.round(input.size / 1024))} KB`
      : `${(input.size / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  return humanPage({
    title: "Arquivo guardado",
    content: `<span class="success">Pronto para usar</span><p class="lead">Nada foi enviado ao WhatsApp. Volte ao chat e diga o que deseja fazer com este arquivo.</p>${context(input.chatName)}<div class="review-field"><strong>Arquivo</strong><p>${escapeHtml(input.filename)}</p><span class="hint">${escapeHtml(type)} · ${escapeHtml(size)}</span></div><a class="button secondary" href="/upload/${encodeURIComponent(input.chatId)}">Adicionar outro arquivo</a><p class="fine">Não precisa copiar nenhum código. O GPT pode localizar o arquivo nesta conversa.</p>`,
  });
}
export function invitePage(name: string, invite: string): Response {
  const u = new URL(invite);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "chat.whatsapp.com" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !/^\/[A-Za-z0-9]+$/.test(u.pathname)
  )
    throw new Error("invalid_invite");
  const response = humanPage({
    title: "Convite do grupo",
    content: `<p class="lead">Abra o convite no WhatsApp ou copie o link abaixo para compartilhar.</p>${context(name)}<a class="button" href="${escapeHtml(invite)}" rel="noreferrer noopener">Abrir convite no WhatsApp</a><p><a class="invite" href="${escapeHtml(invite)}" rel="noreferrer noopener">${escapeHtml(invite)}</a></p><p class="notice">Quem receber este link poderá entrar ou solicitar entrada, conforme as regras do grupo. Compartilhe somente com quem você deseja convidar.</p>`,
  });
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export function audioPreviewPage(input: {
  id: string;
  chatName: string;
  text: string;
  voice: string;
  filename: string;
  size: number;
}): Response {
  return humanPage({
    title: "Ouvir áudio gerado",
    media: true,
    content: `${context(input.chatName)}<p class="success">Geração concluída</p><div class="review-field"><strong>Texto enviado ao Fish Audio</strong><p>${escapeHtml(input.text)}</p></div><div class="review-field"><strong>Voz</strong><p>${escapeHtml(input.voice)}</p></div><div class="review-field"><strong>Arquivo MP3</strong><p>${escapeHtml(input.filename)} · ${escapeHtml(input.size)} bytes</p></div><p><audio controls preload="none" src="/audio/${encodeURIComponent(input.id)}/file" style="width:100%">Seu navegador não suporta reprodução de áudio.</audio></p><p>Gerar não envia WhatsApp. O áudio só é enviado quando você pede no chat. Se já pediu para enviar, não precisa confirmar novamente.</p><p class="fine">A geração enviou este texto ao Fish Audio e pode ter consumido saldo da API. O arquivo permanece privado. Se a reprodução falhar, entre nesta página com seu login do Cloudflare Access.</p>`,
  });
}
export function isHumanPagePath(path: string): boolean {
  return (
    path === "/setup" ||
    path === "/authorize" ||
    /^\/audio\/[^/]+(?:\/file)?$/.test(path) ||
    /^\/(upload|media)\/[^/]+$/.test(path) ||
    /^\/confirm\/(send|group|policy)\/[^/]+$/.test(path) ||
    /^\/groups\/[^/]+\/invite$/.test(path)
  );
}
export function isProtocolPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/") ||
    path === "/health" ||
    path.startsWith("/webhook/") ||
    path === "/setup/status"
  );
}
export function humanErrorPage(
  code: string,
  status: number,
  options: { headers?: HeadersInit; retryPath?: string } = {},
): Response {
  let title = "Não foi possível concluir",
    message =
      "Tente novamente em alguns instantes. Se o problema continuar, volte ao chat e peça para retomar a operação.";
  if (status === 403 || status === 401) {
    title = "Não foi possível autorizar";
    message =
      "Seu acesso ou a confirmação não são mais válidos. Volte ao chat e peça uma nova confirmação. Se necessário, entre novamente com sua conta.";
  }
  if (status === 404) {
    title = "Não encontramos esta página";
    message =
      "O link pode ter expirado ou o arquivo não está mais disponível. Volte ao chat para pedir um novo acesso.";
  }
  if (
    code === "action_expired" ||
    code === "proposal_expired" ||
    code === "action_not_proposed" ||
    code === "confirmation_required"
  ) {
    title = "Esta confirmação expirou";
    message =
      "Ela já foi usada, cancelada ou passou do prazo. Volte ao chat e peça uma nova confirmação para continuar.";
  }
  if (status === 413) {
    title = "O arquivo é grande demais";
    message =
      "Escolha um arquivo de até 2 MB e tente novamente. Você pode reduzir a imagem ou comprimir o arquivo antes.";
  }
  if (
    [
      "invalid_file",
      "invalid_media",
      "unsupported_media",
      "media_mime_mismatch",
      "media_kind_mismatch",
      "invalid_media_filename",
      "media_filename_mismatch",
    ].includes(code) ||
    status === 415
  ) {
    title = "Não conseguimos guardar este arquivo";
    message =
      "Escolha uma imagem PNG, JPG ou WebP, um PDF ou um áudio compatível de até 2 MB. Confira se o arquivo abre normalmente e tente outra vez.";
  }
  if (status === 405) {
    title = "Abra o link novamente";
    message =
      "Esta página não pode ser usada dessa forma. Volte ao chat e abra o link da operação para continuar.";
  }
  if (status === 503) {
    title = "Estamos temporariamente indisponíveis";
    message =
      "Não conseguimos concluir agora. Aguarde um pouco e tente novamente, sem repetir envios que já estejam em andamento.";
  }
  if (code === "oauth_failed") {
    title = "Não foi possível conectar o GPT";
    message =
      "Volte ao GPT e abra a conexão novamente. Se esta página já foi usada ou ficou aberta por muito tempo, ela precisa ser substituída por uma nova autorização.";
  }
  const retry =
    options.retryPath && /^\/upload\/[A-Za-z0-9_-]+$/.test(options.retryPath)
      ? options.retryPath
      : undefined;
  return humanPage({
    title,
    status,
    headers: options.headers,
    content: `<p class="lead">${escapeHtml(message)}</p>${retry ? `<a class="button" href="${escapeHtml(retry)}">Escolher outro arquivo</a>` : '<a class="button secondary" href="/setup">Verificar minha conexão</a>'}<p class="fine">Se um envio já foi iniciado, consulte o resultado no chat antes de tentar novamente.</p>`,
  });
}
