import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { automaticGitHubPath, githubQuestionRepository, githubQuestionExplicitReference, redactGitHubSecrets, prepareGitHubQuestion, readGitHubQuestionFiles } from "../assistant/telegram-github-question";
import { groundedAnswerPayload, renderGroundedAnswer } from "../assistant/telegram-grounded-answer";
import { SourceController } from "../assistant/sources";
import type { AssistantEnv } from "../assistant/env";

it("binds the repository literally and never mistakes a source filename for a second repo", () => {
  expect(githubQuestionRepository("Como funciona src/auth.ts no repo app?", ["owner"])).toBe("app");
  expect(githubQuestionRepository("Como funciona a autenticação no owner/app?", ["owner"], ["app"])).toBe("owner/app");
  expect(githubQuestionRepository("Compare o repo app e o repo other?", ["owner"])).toBeNull();
  expect(githubQuestionRepository("Crie uma missão para o repo app", ["owner"])).toBeNull();
  expect(githubQuestionRepository("Como funciona a aplicação?", ["owner"], ["app"])).toBeNull();
});
it("excludes known credential paths and non-text entries from automatic AI selection", () => {
  for (const path of [".env", ".env.production", ".dev.vars", "service/credentials.json", "private.key", ".npmrc", "secrets/token.json", "../auth.ts", "image.png"]) expect(automaticGitHubPath(path), path).toBe(false);
  for (const path of ["src/auth.ts", "docs/oauth.md", "package.json", "wrangler.jsonc"]) expect(automaticGitHubPath(path), path).toBe(true);
});
async function fixture() {
  const scope = { installationId: crypto.randomUUID(), generation: "github-question" };
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "project", "Technical project").run();
  const sources = new SourceController(env.DB, scope, { kind: "owner" });
  const grant = await sources.create({ originKey: "github-question-grant", text: "Technical owner read grant", occurredAt: Date.now(), projectId: "project" });
  const repository = { id: "app", owner: "owner", ownerId: 123, repo: "app", version: 1, projectId: "project", authorization: { sourceId: grant.id, revision: 1 } };
  const settings = { DB: env.DB, GITHUB_READ_REPOSITORIES: JSON.stringify([repository]), GITHUB_READ_TOKEN: "synthetic-token" } as AssistantEnv;
  const metadata = { name: "app", default_branch: "main", owner: { id: 123, login: "owner" } };
  const requests: Request[] = [];
  const request = vi.fn(async (req: Request) => {
    requests.push(req); const path = new URL(req.url).pathname;
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } });
    if (path.includes("/git/trees/")) return Response.json({ sha: "b".repeat(40), truncated: false, tree: [{ path: "src/auth.ts", mode: "100644", type: "blob", size: 200 }, { path: ".env", mode: "100644", type: "blob", size: 50 }, { path: "link.ts", mode: "120000", type: "blob", size: 10 }] });
    if (path.includes("/contents/")) { const text = 'OAuth validates the owner before access.\nconst api_key = "synthetic-secret-not-for-the-model";'; return Response.json({ name: "auth.ts", path: "src/auth.ts", sha: "c".repeat(40), size: new TextEncoder().encode(text).length, type: "file", encoding: "base64", content: btoa(text) }); }
    return Response.json(metadata);
  });
  const boundary = { deadlineAt: Date.now() + 30000, check: async () => {}, request };
  return { scope, sources, grant, settings, repository, boundary, request, requests };
}
it("reads a manifest and selected implementation in the same immutable commit, with credential redaction", async () => {
  const f = await fixture(), snapshot = await prepareGitHubQuestion(f.settings, f.scope, "app", "Como funciona OAuth no repo app?", f.boundary);
  expect(snapshot.paths).toEqual(["src/auth.ts"]);
  const selected = { choices: [{ message: { content: JSON.stringify({ paths: ["src/auth.ts"] }) } }] };
  const context = await readGitHubQuestionFiles(f.settings, f.scope, snapshot, selected, f.boundary);
  expect(context.documents?.[0].text).toContain("OAuth validates the owner"); expect(context.documents?.[0].text).not.toContain("synthetic-secret-not-for-the-model");
  expect(f.requests.filter(r => r.url.includes("/contents/")).every(r => new URL(r.url).searchParams.get("ref") === "a".repeat(40))).toBe(true);
  expect(f.requests.every(r => r.method === "GET")).toBe(true);
});
it("model-selected paths outside the host manifest never reach GitHub", async () => {
  const f = await fixture(), snapshot = await prepareGitHubQuestion(f.settings, f.scope, "app", "Pergunta", f.boundary), before = f.request.mock.calls.length;
  await expect(readGitHubQuestionFiles(f.settings, f.scope, snapshot, { choices: [{ message: { content: '{"paths":[".env"]}' } }] }, f.boundary)).rejects.toThrow("paths");
  expect(f.request).toHaveBeenCalledTimes(before);
});
it("answers the question with an explanation and validates citations against the exact sent text", () => {
  const docs = [{ id: "src/auth.ts", label: "src/auth.ts", text: "OAuth validates the owner before access." }];
  const body = (quote: string) => ({ choices: [{ message: { content: JSON.stringify({ claims: [{ text: "O acesso usa OAuth e verifica se você é o dono antes de liberar o projeto.", basis: "observed", citations: [{ id: "src/auth.ts", quote }] }], missing: null }) } }] });
  const rendered = renderGroundedAnswer(body(docs[0].text), docs);
  expect(rendered).toContain("O acesso usa OAuth"); expect(rendered).not.toContain(docs[0].text); expect(rendered).toContain("src/auth.ts");
  expect(() => renderGroundedAnswer(body("invented evidence"), docs)).toThrow("literal");
  expect(JSON.stringify(groundedAnswerPayload("gpt-6-luna", "Pergunta", docs, {}))).toContain("Não despeje");
});

it("does not silently answer about default branch when another reference was requested", () => {
  expect(githubQuestionExplicitReference("Como funciona o repo app na branch develop?")).toBe(true);
  expect(githubQuestionExplicitReference("Explique https://github.com/owner/app/blob/main/src/auth.ts")).toBe(true);
  expect(githubQuestionExplicitReference("Como funciona autenticação no repo app?")).toBe(false);
});
it("redacts short quoted, JSON and unquoted known credentials while keeping environment references", () => {
  const redacted = redactGitHubSecrets('password: abc12345\npassword = "abc12345"\n"client_secret": "short",\nconst api_key = process.env.API_KEY;');
  expect(redacted).not.toContain("abc12345"); expect(redacted).not.toContain('"short"'); expect(redacted).toContain("process.env.API_KEY");
});

it("accepts formatting-only quote differences while refusing changed negation and numbers", () => {
 const docs = [{ id: "message-one", label: "Mensagem", text: "Não aprovei.\n  Confirmar 3 dias depois." }];
 const body = (quote: string) => ({ choices: [{ message: { content: JSON.stringify({ claims: [{ text: "A aprovação ainda não foi dada; a confirmação foi adiada.", basis: "observed", citations: [{ id: "message-one", quote }] }], missing: null }) } }] });
 expect(renderGroundedAnswer(body("Não aprovei. Confirmar 3 dias depois."), docs)).toContain("ainda não foi dada");
 expect(() => renderGroundedAnswer(body("Aprovei. Confirmar 3 dias depois."), docs)).toThrow("literal");
 expect(() => renderGroundedAnswer(body("Não aprovei. Confirmar 5 dias depois."), docs)).toThrow("literal");
});
