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
    await check(); const commit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).parse(await readJson(new URL(base + "/commits/" + encodeURIComponent(metadata.default_branch)), headers, request, 65536));
    await check(); return commit.sha;
  };
  const canonical = requested === undefined ? [] : repositories.filter(r => [r.id, r.repo, r.owner + "/" + r.repo].some(value => value.toLowerCase() === requested.toLowerCase()));
  return { state: "ready", repositories, canonicalRepository: canonical.length === 1 ? canonical[0].id : undefined, check, resolveDefault, reader: new GitHubReader(env.DB, scope, repositories, env.GITHUB_READ_TOKEN, request) } as const;
}
