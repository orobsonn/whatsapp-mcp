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
}): Response {
  const body = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.summary)}</p><pre>${escapeHtml(input.envelope)}</pre><p>Hash do conteúdo: <code>${escapeHtml(input.hash)}</code></p><p>Confira o destino e o conteúdo. A confirmação vence em dez minutos e funciona uma única vez.</p><form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="nonce" value="${escapeHtml(input.nonce)}"><button type="submit">Confirmar</button></form></main></body></html>`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
