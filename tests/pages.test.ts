import { expect, it } from "vitest";
import {
  uploadPage,
  uploadResultPage,
  invitePage,
  humanErrorPage,
  isHumanPagePath,
} from "../src/pages";
it("makes upload and its result readable without internal references", async () => {
  const html = await uploadPage({
    chatName: "Equipe <script>x</script>",
    chatId: "chat-1",
  }).text();
  expect(html).toContain("Adicionar arquivo");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("2 MB");
  expect(html).toContain('type="file"');
  const result = await uploadResultPage({
    chatName: "Equipe",
    filename: "<img>.pdf",
    size: 1024,
    kind: "pdf",
    chatId: "chat-1",
  }).text();
  expect(result).toContain("Arquivo guardado");
  expect(result).toContain("&lt;img&gt;.pdf");
  expect(result).toContain("Nada foi enviado");
  expect(result).not.toContain("sha256");
  expect(result).not.toContain("<pre>");
});
it("escapes invitation names and refuses non-WhatsApp links", async () => {
  const html = await invitePage(
    "Grupo <x>",
    "https://chat.whatsapp.com/AbCdEf123",
  ).text();
  expect(html).toContain("Grupo &lt;x&gt;");
  expect(html).toContain("Abrir convite");
  expect(html).not.toContain("<pre>");
  expect(() => invitePage("Grupo", "javascript:alert(1)")).toThrow();
});
it("renders actionable errors and keeps protocol routes outside human formatting", async () => {
  const r = humanErrorPage("action_expired", 409);
  expect(r.status).toBe(409);
  const html = await r.text();
  expect(html).toContain("expirou");
  expect(html).not.toContain("action_expired");
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(r.headers.get("Content-Security-Policy")).toContain(
    "frame-ancestors 'none'",
  );
  for (const path of [
    "/mcp",
    "/oauth/token",
    "/oauth/register",
    "/health",
    "/.well-known/oauth-authorization-server",
    "/setup/status",
    "/webhook/x",
  ])
    expect(isHumanPagePath(path)).toBe(false);
  for (const path of [
    "/setup",
    "/authorize",
    "/upload/x",
    "/confirm/send/x",
    "/confirm/group/x",
    "/confirm/policy/x",
    "/media/x",
    "/groups/x/invite",
  ])
    expect(isHumanPagePath(path)).toBe(true);
});
