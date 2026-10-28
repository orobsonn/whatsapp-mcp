import { z } from "zod";
import type { AssistantEnv } from "../env";
import type { SourceScope } from "../sources";
import { GitHubReader, githubRepository, githubReadHeaders } from "./github";
import { readJson, type OwnerReadBoundary, type ReadFetch } from "./read-only";

export function configuredGitHubRepositories(env: AssistantEnv) {
  return env.GITHUB_READ_REPOSITORIES ? z.array(githubRepository).max(20).parse(JSON.parse(env.GITHUB_READ_REPOSITORIES)) : [];
}
/** Host configuration shared by MCP and the owner dialogue. All URLs stay fixed. */
export function configuredGitHub(env: AssistantEnv, scope: SourceScope, boundary?: OwnerReadBoundary) {
  if (!env.DB || !env.GITHUB_READ_REPOSITORIES) return { state: "pending_configuration", dependency: "github_read" } as const;
  const repositories = configuredGitHubRepositories(env);
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
    if (response.status !== 200) console.warn(JSON.stringify({ event: "github_read_failure", stage: "http", code: "status", status: response.status }));
    return response;
  };
  const resolveDefault = async (id: string) => {
    const repository = repositories.find(r => r.id === id); if (!repository) throw Error("repository_not_authorized");
    const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}`, headers = githubReadHeaders(env.GITHUB_READ_TOKEN);
    await check(); const metadata = z.object({ default_branch: z.string().min(1).max(256) }).parse(await readJson(new URL(base), headers, request, 65536));
    await check(); const commit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).parse(await readJson(new URL(base + "/commits/" + encodeURIComponent(metadata.default_branch)), headers, request, 65536));
    await check(); return commit.sha;
  };
  return { state: "ready", repositories, check, resolveDefault, reader: new GitHubReader(env.DB, scope, repositories, env.GITHUB_READ_TOKEN, request) } as const;
}
