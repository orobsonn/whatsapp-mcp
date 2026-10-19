/** Client metadata, message text and names are untrusted even on an owner's page. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}

export function confirmationPage(input: {
  title: string;
  summary: string;
  envelope: string;
  hash: string;
  nonce: string;
  action: string;
  oauth?: { clientName: string; redirectUri: string; scopes: string[] };
}): Response {
  const css = `:root{color-scheme:light;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18241e;background:#f6f8f5}*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:620px;margin:6vh auto}.brand{font-size:15px;font-weight:700;color:#17623d;margin:0 0 28px}.card{padding:32px;background:#fff;border:1px solid #dfe6df;border-radius:14px}h1{font-size:30px;line-height:1.2;letter-spacing:-.04em;margin:0 0 16px}p{line-height:1.6;color:#4c5a50}.app{font-size:20px;font-weight:650;color:#18241e}.permissions{padding:16px;background:#eaf3ec;border-radius:8px}button{width:100%;min-height:48px;background:#17623d;color:#fff;border:0;border-radius:8px;font:inherit;font-weight:650;cursor:pointer;margin-top:20px}button:focus-visible,summary:focus-visible{outline:3px solid #17623d;outline-offset:4px}.hint{font-size:13px;color:#6c796f}details{margin-top:24px;font-size:13px}summary{cursor:pointer;color:#4c5a50}pre,code{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:12px}pre{padding:14px;background:#f6f8f5;border-radius:8px}@media(max-width:480px){body{padding:24px 16px}main{margin:24px auto}.card{padding:24px}h1{font-size:27px}}`;
  const technical = `<pre>${escapeHtml(input.envelope)}</pre><p class="hint">Identificação desta autorização: <code>${escapeHtml(input.hash)}</code></p>`;
  const content = input.oauth
    ? `<p class="app">${escapeHtml(input.oauth.clientName)}</p><p>Você está conectando este aplicativo ao seu WhatsApp pessoal.</p><div class="permissions"><strong>O que será autorizado</strong><p>Acesso às ferramentas do MCP para consultar seus dados autorizados e preparar ações. Envios e alterações em grupos exigem sua confirmação.</p></div><p class="hint">Após autorizar, você voltará para <strong>${escapeHtml(new URL(input.oauth.redirectUri).hostname)}</strong>.</p><details><summary>Detalhes técnicos da autorização</summary><p>Permissões: ${escapeHtml(input.oauth.scopes.join(", "))}</p>${technical}</details>`
    : `<p>${escapeHtml(input.summary)}</p>${technical}`;
  const body = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>${css}</style></head><body><main><p class="brand">WhatsApp pessoal · Conexão privada</p><section class="card"><h1>${escapeHtml(input.title)}</h1>${content}<form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="nonce" value="${escapeHtml(input.nonce)}"><button type="submit">${input.oauth ? "Autorizar conexão" : "Confirmar"}</button></form><p class="hint">Confirmação válida por dez minutos e usada uma única vez. Se não quiser continuar, feche esta página.</p></section></main></body></html>`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Chrome also checks form-action against redirects after a form POST.
      // OAuth caller validates this URI against the registered client's allowlist first.
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${input.oauth ? ` ${new URL(input.oauth.redirectUri).origin}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      // no-referrer causes Origin:null on some real form submissions. same-origin
      // suppresses cross-origin referrers while preserving same-origin form CSRF checks.
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
