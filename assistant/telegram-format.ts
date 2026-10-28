/** Keep literal data distinct from formatting, including at a truncation edge. */
export function telegramExcerpt(value: unknown, maximum = 3000) {
  let html = "", text = "";
  for (const char of String(value ?? "")) {
    const escaped = char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char;
    if (html.length + escaped.length > maximum) return { html: html + "…", text, truncated: true };
    html += escaped; text += char;
  }
  return { html, text, truncated: false };
}
export const telegramText = (value: unknown, maximum = 3000) => telegramExcerpt(value, maximum).html;
