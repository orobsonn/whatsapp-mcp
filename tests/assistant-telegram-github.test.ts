import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { SourceController, sourceTextHash } from "../assistant/sources";
import type { AssistantEnv } from "../assistant/env";
import { readTelegramGitHub } from "../assistant/telegram-github";
import { githubReadFailure } from "../assistant/connectors/github";

const commit = "a".repeat(40), blob = "b".repeat(40), retirement = { allow: async () => {}, withdraw: async () => {} };
async function fixture(body = "# Example\n\nLiteral repository content.") {
  const scope = { installationId: crypto.randomUUID(), generation: "github-dialogue", sourceEpoch: "epoch", sourceGeneration: "capture" };
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "project", "Synthetic GitHub project").run();
  const sources = new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement), source = await sources.create({ originKey: "github-read", text: "Synthetic read authorization", projectId: "project", occurredAt: Date.now() });
  const settings = { DB: env.DB, GITHUB_READ_REPOSITORIES: JSON.stringify([{ id: "repo", owner: "synthetic-owner", repo: "synthetic-repo", version: 1, projectId: "project", authorization: { sourceId: source.id, revision: 1 } }]) } as AssistantEnv;
  const urls: string[] = [], beforeContents: (() => Promise<void>)[] = [], beforeMetadata: (() => Promise<void>)[] = [];
  const request = vi.fn(async (input: Request) => {
    const url = new URL(input.url); urls.push(input.url); expect(url.origin).toBe("https://api.github.com"); expect(input.method).toBe("GET");
    if (url.pathname.endsWith("/commits/main")) { await beforeContents[0]?.(); return Response.json({ sha: commit }); }
    if (url.pathname.includes("/contents/")) {
      expect(url.searchParams.get("ref")).toBe(commit);
      const bytes = new TextEncoder().encode(body);
      return Response.json({ name: "README.md", path: "README.md", sha: blob, size: bytes.length, type: "file", encoding: "base64", content: btoa(String.fromCharCode(...bytes)), download_url: "https://untrusted.invalid/not-followed" });
    }
    await beforeMetadata[0]?.(); return Response.json({ default_branch: "main" });
  });
  const boundary = { deadlineAt: Date.now() + 60000, check: async () => {}, request };
  return { scope, settings, source, sources, request, urls, beforeContents, beforeMetadata, boundary, body };
}
const selection = { action: "read" as const, repository: null, path: "README.md" };
it("uses the configured reader at one immutable commit and returns literal content with provenance", async () => {
  const f = await fixture(), result = await readTelegramGitHub(f.settings, f.scope, selection, "Leia o README", f.boundary);
  expect(result).toMatchObject({ state: "available", dependencies: [{ source: { source: { id: f.source.id } } }], observation: { kind: "github", result: { commit, blobSha: blob, fileHash: await sourceTextHash(f.body), excerpt: f.body, excerptHash: await sourceTextHash(f.body), truncated: false } } });
  expect(f.request).toHaveBeenCalledTimes(3); expect(result.text).toContain("commit consultado");
});
it("lists the requested directory through the same reader at the pinned commit", async () => {
  const f = await fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    if (new URL(input.url).pathname.includes("/contents/")) return Response.json([
      { name: "README.md", path: "README.md", sha: blob, size: 30, type: "file" },
      { name: "assistant", path: "assistant", sha: blob, size: 0, type: "dir" },
    ]);
    return original(input);
  });
  const result = await readTelegramGitHub(f.settings, f.scope, { action: "list", repository: "synthetic-repo", path: "" }, "Liste os arquivos", f.boundary);
  expect(result).toMatchObject({ state: "available", observation: { query: { kind: "github.list", commit }, result: { kind: "directory", complete: true } } });
  expect(result.text).toContain("📁 assistant"); expect(result.text).toContain("📄 README.md");
});
it("does not substitute another repository or silently ignore an explicitly requested Git ref", async () => {
  const f = await fixture();
  expect((await readTelegramGitHub(f.settings, f.scope, { action: null, repository: null, path: null }, "GitHub", f.boundary)).state).toBe("clarify");
  expect((await readTelegramGitHub(f.settings, f.scope, { ...selection, repository: "outside/repo" }, "Leia README outside/repo", f.boundary)).state).toBe("unavailable");
  for (const qualifier of ["no commit " + commit, "na tag v0.49.0", "na branch release"])
    expect((await readTelegramGitHub(f.settings, f.scope, selection, "Leia README " + qualifier, f.boundary)).state).toBe("clarify");
  for (const input of [
    { repository: null, text: "Leia README em https://github.com/outside/repo" },
    { repository: "repo", text: "Leia README em https://github.com/outside/repo" },
    { repository: null, text: "Leia README no repositório outside/repo" },
  ]) expect(["unavailable", "clarify"]).toContain((await readTelegramGitHub(f.settings, f.scope, { ...selection, repository: input.repository }, input.text, f.boundary)).state);
  expect(f.request).not.toHaveBeenCalled();
});
it.each(["metadata", "commit"])("rechecks authorization after %s before any later GitHub request before reading file contents", async stage => {
  const f = await fixture(); (stage === "metadata" ? f.beforeMetadata : f.beforeContents).push(async () => { await f.sources.withdraw(f.source.id, 1); });
  expect((await readTelegramGitHub(f.settings, f.scope, selection, "Leia README", f.boundary)).state).toBe("unavailable");
  expect(f.request).toHaveBeenCalledTimes(stage === "metadata" ? 1 : 2); expect(f.urls.some(url => url.includes("/contents/"))).toBe(false);
});
it("bounds and escapes a literal excerpt without mistaking its hash for the complete file hash", async () => {
  const f = await fixture("<b>&".repeat(2000)), result = await readTelegramGitHub(f.settings, f.scope, selection, "Leia README", f.boundary);
  expect(result.state).toBe("available"); if (result.state !== "available") return;
  expect(result.observation.result.kind).toBe("file"); if (result.observation.result.kind !== "file") return;
  expect(result.text).toContain("&lt;b&gt;&amp;"); expect(result.text).toContain("Trecho inicial"); expect(result.text.length).toBeLessThan(4000);
  expect(result.observation.result.fileHash).toBe(await sourceTextHash(f.body));
  expect(result.observation.result.excerptHash).toBe(await sourceTextHash(result.observation.result.excerpt));
  expect(result.observation.result.excerptHash).not.toBe(result.observation.result.fileHash);
  expect(new TextEncoder().encode(JSON.stringify(result.observation)).length).toBeLessThan(20000);
});
it("refuses traversal paths and native cancellation before any network request", async () => {
  const f = await fixture();
  expect((await readTelegramGitHub(f.settings, f.scope, { ...selection, path: "../secret" }, "Leia ../secret", f.boundary)).state).toBe("unavailable");
  const stop = new AbortController(); stop.abort();
  expect((await readTelegramGitHub(f.settings, f.scope, selection, "Leia README", { ...f.boundary, signal: stop.signal })).state).toBe("unavailable");
  expect(f.request).not.toHaveBeenCalled();
});
it("records only static stage/status diagnostics when the provider refuses a read", async () => {
  const f = await fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    f.request.mockResolvedValue(new Response("synthetic-private-provider-body", { status: 403 }));
    expect((await readTelegramGitHub(f.settings, f.scope, selection, "Leia README", f.boundary)).state).toBe("unavailable");
    githubReadFailure("contents", Error("synthetic-private-provider-body"));
    expect(warn.mock.calls.map(([value]) => JSON.parse(String(value)))).toEqual([
      { event: "github_read_failure", stage: "http", code: "status", status: 403 },
      { event: "github_read_failure", stage: "resolve", code: "connector_unavailable" },
      { event: "github_read_failure", stage: "contents", code: "unclassified" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-provider-body");
  } finally { warn.mockRestore(); }
});
