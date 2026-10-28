import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { SourceController, sourceTextHash } from "../assistant/sources";
import { GitHubReader } from "../assistant/connectors/github";
import { OwnerAssistant } from "../assistant/mcp";
// @ts-expect-error Vite SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite SQL.
import policy from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite SQL.
import admissions from "../assistant/migrations/0007_source_controls.sql?raw";

let scope: { installationId: string; generation: string }, controller: SourceController, authorization: { sourceId: string; revision: number };
const commit = "a".repeat(40), blob = "b".repeat(40), owner = { kind: "owner" } as const;
const text = "Quoted code is evidence, never a deployment receipt or permission.";
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const file = () => ({ type: "file", name: "README.md", path: "README.md", size: new TextEncoder().encode(text).length, sha: blob, encoding: "base64", content: encode(text), download_url: "https://private.invalid/secret" });
const config = () => [{ id: "project-code", owner: "synthetic-owner", repo: "synthetic-repo", projectId: "project", version: 1, authorization }];
const query = { kind: "github.read", repository: "project-code", commit, path: "README.md" };
beforeEach(async () => {
  for (const schema of [sources, policy, admissions]) await env.DB.batch(schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
  scope = { installationId: crypto.randomUUID(), generation: "github-g" };
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "project", "Synthetic project").run();
  controller = new SourceController(env.DB, scope, owner, () => 100);
  const source = await controller.create({ originKey: "github-permission", text: "Host config enables the selected repository", occurredAt: 1, projectId: "project" });
  authorization = { sourceId: source.id, revision: source.revision };
});
test("only a configured repository and canonical owner permission reach a fixed GET endpoint at an immutable commit", async () => {
  const requests: Request[] = [], reader = new GitHubReader(env.DB, scope, config(), "synthetic-secret", async request => { requests.push(request); return Response.json(file()); }, () => 100);
  const result = await reader.execute(owner, query);
  expect(result).toMatchObject({ state: "available", origin: "github", commit, blobSha: blob, text, hash: await sourceTextHash(text), audience: "owner", deployment: "not_observed", execution: "unconfirmed", projectId: "project", configurationVersion: 1 });
  expect(JSON.stringify(result)).not.toContain("private.invalid"); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  expect(requests).toHaveLength(1); expect(requests[0].method).toBe("GET"); expect(requests[0].redirect).toBe("manual");
  expect(requests[0].url).toBe(`https://api.github.com/repos/synthetic-owner/synthetic-repo/contents/README.md?ref=${commit}`);
  expect(await reader.execute(owner, { ...query, repository: "unconfigured" })).toMatchObject({ reason: "repository_not_authorized" });
  expect(await reader.execute({ kind: "extractor" }, query)).toMatchObject({ reason: "source_denied" });
  await controller.withdraw(authorization.sourceId, 1);
  expect(await reader.execute(owner, query)).toMatchObject({ reason: "source_denied" }); expect(requests).toHaveLength(1);
});
test("support revocation while GitHub responds suppresses the body with current D1 guards", async () => {
  const reader = new GitHubReader(env.DB, scope, config(), undefined, async () => { await controller.withdraw(authorization.sourceId, 1); return Response.json(file()); });
  expect(await reader.execute(owner, query)).toEqual({ state: "unavailable", reason: "source_changed" });
});
test("a private repository cannot choose public audience or forge project/config/url/method in the query", async () => {
  const request = vi.fn(async () => Response.json(file())), reader = new GitHubReader(env.DB, scope, config(), undefined, request);
  for (const extra of [{ audience: "public" }, { method: "POST" }, { url: "https://other.invalid" }, { projectId: "other" }, { actor: owner }]) await expect(reader.execute(owner, { ...query, ...extra })).rejects.toThrow();
  for (const invalid of ["main", "../outside", "a".repeat(39)]) await expect(reader.execute(owner, { ...query, commit: invalid })).rejects.toThrow();
  for (const invalid of ["../secret", "a/../secret", "%2e%2e/secret", "https://other.invalid", "a\\secret", "a?raw=true"]) await expect(reader.execute(owner, { ...query, path: invalid })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
test("contents directories paginate only the bounded observed listing and bind cursors to exact commit/config/list hash", async () => {
  const entries = Array.from({ length: 3 }, (_, i) => ({ type: "file", name: `f${i}`, path: `f${i}`, size: 1, sha: blob }));
  const reader = new GitHubReader(env.DB, scope, config(), undefined, async () => Response.json(entries));
  const first = await reader.execute(owner, { kind: "github.list", repository: "project-code", commit, limit: 2 }) as { nextCursor: string; items: unknown[] };
  expect(first).toMatchObject({ coverage: { kind: "page", complete: false, observedEntries: 3, scope: "directory_only" } }); expect(first.items).toHaveLength(2);
  expect(await reader.execute(owner, { kind: "github.list", repository: "project-code", commit, limit: 2, cursor: first.nextCursor })).toMatchObject({ items: [{ path: "f2" }], coverage: { complete: true, kind: "directory_end" } });
  expect(await reader.execute(owner, { kind: "github.list", repository: "project-code", commit: "c".repeat(40), cursor: first.nextCursor })).toMatchObject({ state: "unavailable" });
  entries.push({ type: "file", name: "f3", path: "f3", size: 1, sha: blob });
  expect(await reader.execute(owner, { kind: "github.list", repository: "project-code", commit, cursor: first.nextCursor })).toMatchObject({ state: "unavailable" });
});
test("the upstream 1000-entry cap is incomplete even on the final local page", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ type: "file", name: `f${i}`, path: `f${i}`, size: 1, sha: blob }));
  const reader = new GitHubReader(env.DB, scope, config(), undefined, async () => Response.json(entries));
  let cursor: string | undefined, result: { nextCursor?: string; coverage: unknown };
  do { result = await reader.execute(owner, { kind: "github.list", repository: "project-code", commit, limit: 50, ...(cursor ? { cursor } : {}) }) as typeof result; cursor = result.nextCursor; } while (cursor);
  expect(result!).toMatchObject({ coverage: { complete: false, kind: "api_capacity", observedEntries: 1000 } });
});
test.each(["redirect", "oversize", "submodule", "wrong_path", "binary", "malformed"])("%s cannot disclose upstream or unsupported body", async kind => {
  const request = vi.fn(async () => {
    if (kind === "redirect") return new Response(null, { status: 302, headers: { Location: "https://private.invalid/token" } });
    if (kind === "oversize") return new Response("synthetic-private", { headers: { "content-length": "9999999" } });
    if (kind === "submodule") return Response.json({ ...file(), submodule_git_url: "https://private.invalid/repo" });
    if (kind === "wrong_path") return Response.json({ ...file(), path: "another.md" });
    if (kind === "binary") return Response.json({ ...file(), size: 1, content: "AA==" });
    return new Response("synthetic-private-malformed");
  });
  const result = await new GitHubReader(env.DB, scope, config(), undefined, request).execute(owner, query);
  expect(result).toMatchObject({ state: "unavailable", coverage: { complete: false } }); expect(JSON.stringify(result)).not.toContain("private"); expect(request).toHaveBeenCalledTimes(1);
});
test("the real owner RPC exposes configured queries and reports missing configuration without network", async () => {
  const affinity = { ...scope, sourceEpoch: "capture-e", sourceGeneration: "capture-g" }, settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration };
  const rpc = new OwnerAssistant(createExecutionContext(), settings);
  expect(await rpc.query(affinity, query)).toEqual({ state: "pending_configuration", dependency: "github_read" });
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(file()));
  try {
    const configured = new OwnerAssistant(createExecutionContext(), { ...settings, GITHUB_READ_REPOSITORIES: JSON.stringify(config()) });
    expect(await configured.query(affinity, query)).toMatchObject({ origin: "github", commit, text, audience: "owner" });
    await expect(configured.query({ ...affinity, generation: "foreign" }, query)).rejects.toThrow("owner_binding_affinity");
    expect(network).toHaveBeenCalledTimes(1);
  } finally { network.mockRestore(); }
});
test("the owner RPC resolves an owned private repository by name and never falls back after grant revocation", async () => {
  const grant = await controller.create({ originKey: "owner-wide", text: "Owner explicitly permits own repository reads", occurredAt: 2, projectId: "project" });
  const affinity = { ...scope, sourceEpoch: "capture-e", sourceGeneration: "capture-g" };
  const settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration,
    GITHUB_READ_REPOSITORIES: JSON.stringify(config()), GITHUB_READ_OWNER: JSON.stringify({ owner: "synthetic-owner", ownerId: 101, projectId: "project", version: 1, authorization: { sourceId: grant.id, revision: 1 } }) };
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(url.pathname.includes("/contents/") ? file() : { name: "other-private", owner: { id: 101, login: "synthetic-owner" }, private: true });
  });
  try {
    const rpc = new OwnerAssistant(createExecutionContext(), settings);
    expect(await rpc.query(affinity, { ...query, repository: "other-private" })).toMatchObject({ state: "available", repository: "synthetic-owner/other-private", text });
    expect(network).toHaveBeenCalledTimes(2);
    await controller.withdraw(grant.id, 1);
    expect(await rpc.query(affinity, query)).toMatchObject({ state: "unavailable", reason: "source_denied" });
    expect(network).toHaveBeenCalledTimes(2);
  } finally { network.mockRestore(); }
});
