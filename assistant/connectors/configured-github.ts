import { z } from "zod";
import type { AssistantEnv } from "../env";
import type { SourceScope } from "../sources";
import { GitHubReader, githubRepository, githubOwner, githubReadHeaders, verifyGitHubOwner } from "./github";
import { readJson, type OwnerReadBoundary, type ReadFetch } from "./read-only";

export function configuredGitHubRepositories(env: AssistantEnv, requested?: string) {
  const repositories = env.GITHUB_READ_REPOSITORIES ? z.array(githubRepository).max(20).parse(JSON.parse(env.GITHUB_READ_REPOSITORIES)) : [];
  if (!env.GITHUB_READ_OWNER) return repositories;
  const owner = githubOwner.parse(JSON.parse(env.GITHUB_READ_OWNER)), sameOwner = (name: string) => name.toLowerCase() === owner.owner.toLowerCase();
  const owned = (repo: string, id = owner.owner + "/" + repo) => githubRepository.parse({ id, owner: owner.owner, repo, ownerId: owner.ownerId, projectId: owner.projectId, version: owner.version, authorization: owner.authorization });
  // Owner-wide authority replaces old descriptors for that owner. In
  // particular, revocation cannot fall back to an old public-only grant while
  // using the new credential capable of reading private repositories.
  const mapped = repositories.map(r => sameOwner(r.owner) ? owned(r.repo, r.id) : r);
  if (requested === undefined) return mapped;
  const byId = mapped.filter(r => r.id.toLowerCase() === requested.toLowerCase()); if (byId.length) return byId;
  const parts = requested.split("/");
  if (parts.length === 2 && !sameOwner(parts[0])) return mapped.filter(r => (r.owner + "/" + r.repo).toLowerCase() === requested.toLowerCase());
  if (parts.length > 2) return [];
  const repo = parts.at(-1)!;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === "..") return [];
  const existing = mapped.find(r => sameOwner(r.owner) && r.repo.toLowerCase() === repo.toLowerCase());
  return [existing ?? owned(repo)];
}
/** Host configuration shared by MCP and the owner dialogue. All URLs stay fixed. */
export function configuredGitHub(env: AssistantEnv, scope: SourceScope, boundary?: OwnerReadBoundary, requested?: string) {
  if (!env.DB || (!env.GITHUB_READ_REPOSITORIES && !env.GITHUB_READ_OWNER)) return { state: "pending_configuration", dependency: "github_read" } as const;
  const repositories = configuredGitHubRepositories(env, requested);
  const catalogueOwner = env.GITHUB_READ_OWNER ? githubOwner.parse(JSON.parse(env.GITHUB_READ_OWNER)) : undefined;
  const signal = boundary ? AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(15000, boundary.deadlineAt - Date.now()))), ...(boundary.signal ? [boundary.signal] : [])]) : undefined;
  const check = async () => {
    if (!boundary) return;
    if (signal!.aborted || Date.now() >= boundary.deadlineAt) throw Error("github_dialogue_expired");
    await boundary.check();
    if (signal!.aborted || Date.now() >= boundary.deadlineAt) throw Error("github_dialogue_expired");
  };
  const request: ReadFetch = async input => {
    await check();
    const response = await (boundary?.request ?? fetch)(signal ? new Request(input, { signal: AbortSignal.any([input.signal, signal]) }) : input);
    if (response.status !== 200) {
      const rate: Record<string, number> = {};
      for (const [header, field] of [["x-ratelimit-limit", "rateLimit"], ["x-ratelimit-remaining", "remaining"], ["x-ratelimit-reset", "resetAt"]]) {
        const value = response.headers.get(header);
        if (value && /^\d{1,12}$/.test(value)) rate[field] = Number(value);
      }
      console.warn(JSON.stringify({ event: "github_read_failure", stage: "http", code: "status", status: response.status, ...rate }));
      if ((response.status === 403 || response.status === 429) && rate.remaining === 0) {
        void response.body?.cancel().catch(() => {});
        throw Error("github_rate_limited");
      }
    }
    return response;
  };
  const resolveDefault = async (id: string) => {
    const repository = repositories.find(r => r.id === id); if (!repository) throw Error("repository_not_authorized");
    const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}`, headers = githubReadHeaders(env.GITHUB_READ_TOKEN);
    await check(); const raw = await readJson(new URL(base), headers, request, 65536); verifyGitHubOwner(repository, raw);
    const metadata = z.object({ default_branch: z.string().min(1).max(256) }).parse(raw);
    const parts = metadata.default_branch.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) throw Error("github_ref_unsupported");
    // Only the immutable pointer is needed. The commit endpoint also includes
    // patches, whose size can exceed the bounded connector response.
    await check(); const commit = z.object({ ref: z.literal("refs/heads/" + metadata.default_branch), object: z.object({ type: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{40}$/) }) })
      .parse(await readJson(new URL(base + "/git/ref/heads/" + parts.map(encodeURIComponent).join("/")), headers, request, 16384));
    await check(); return commit.object.sha;
  };
  const canonical = requested === undefined ? [] : repositories.filter(r => [r.id, r.repo, r.owner + "/" + r.repo].some(value => value.toLowerCase() === requested.toLowerCase()));
  const repositoryCatalogue = async (raw: unknown) => {
    const { page } = z.object({ page: z.number().int().positive().safe().default(1) }).strict().parse(raw);
    await check();
    if (!catalogueOwner) {
      const items = page === 1 ? repositories.map(r => ({ repository: r.id, name: r.repo, fullName: r.owner + "/" + r.repo })) : [];
      return { state: "available", items, coverage: { scope: "configured_repositories", complete: true } };
    }
    if (!env.GITHUB_READ_TOKEN) return { state: "unavailable", reason: "github_credential_unconfigured" };
    const url = new URL("https://api.github.com/user/repos");
    for (const [key, value] of Object.entries({ affiliation: "owner", visibility: "all", sort: "full_name", direction: "asc", per_page: "20", page: String(page) })) url.searchParams.set(key, value);
    const result = z.array(z.object({ name: githubRepository.shape.repo, full_name: z.string().max(256), owner: z.object({ id: z.number().int().positive().safe(), login: githubOwner.shape.owner }), private: z.boolean(), description: z.string().max(4096).nullable(), default_branch: z.string().max(256) })).max(20)
      .parse(await readJson(url, githubReadHeaders(env.GITHUB_READ_TOKEN), request, 1024 * 1024));
    for (const item of result) {
      if (item.owner.id !== catalogueOwner.ownerId || item.owner.login.toLowerCase() !== catalogueOwner.owner.toLowerCase() || item.full_name.toLowerCase() !== (catalogueOwner.owner + "/" + item.name).toLowerCase()) throw Error("github_owner_mismatch");
    }
    await check();
    const nextPage = result.length === 20 ? page + 1 : undefined;
    if (nextPage !== undefined && !Number.isSafeInteger(nextPage)) throw Error("github_page_invalid");
    return { state: "available", items: result.map(item => ({ repository: catalogueOwner.owner + "/" + item.name, name: item.name, fullName: item.full_name, private: item.private, description: item.description, defaultBranch: item.default_branch })),
      ...(nextPage ? { nextPage } : {}), coverage: { scope: "owner_authorized_repositories_page", complete: nextPage === undefined, consistency: "live_paginated", code: "not_read" } };
  };
  return { state: "ready", repositories, catalogueAuthorities: catalogueOwner ? [catalogueOwner] : repositories, repositoryCatalogue, canonicalRepository: canonical.length === 1 ? canonical[0].id : undefined, check, resolveDefault, reader: new GitHubReader(env.DB, scope, repositories, env.GITHUB_READ_TOKEN, request) } as const;
}
