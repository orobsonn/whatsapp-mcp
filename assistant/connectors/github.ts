import { z } from "zod";
import type { TrustedActor } from "../access";
import { sourceTextHash, type SourceScope } from "../sources";
import { bridgeHash } from "../ingress";
import { connectorAuthority, ConnectorAccess, decodeCursor, encodeCursor, readJson, type ReadFetch } from "./read-only";

const id = z.string().min(1).max(256), sha = z.string().regex(/^[0-9a-f]{40}$/);
const path = z.string().max(1024).refine(value => !value || !/^[a-z][a-z0-9+.-]*:/i.test(value) && value.split("/").every(part => part && part !== "." && part !== ".." && !/[\\\u0000-\u001f\u007f?#%]/.test(part)));
export const githubQuery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github.list"), repository: id, commit: sha, path: path.default(""), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ kind: z.literal("github.read"), repository: id, commit: sha, path: path.refine(value => !!value) }).strict(),
]);
const ownerName = z.string().regex(/^[A-Za-z0-9-]{1,39}$/), repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(value => value !== "." && value !== "..");
export const githubOwner = connectorAuthority.extend({ owner: ownerName, ownerId: z.number().int().positive().safe() }).strict();
export const githubRepository = connectorAuthority.extend({ id, owner: ownerName, repo: repositoryName, ownerId: z.number().int().positive().safe().optional() }).strict();
export function verifyGitHubOwner(repository: z.infer<typeof githubRepository>, raw: unknown) {
  if (repository.ownerId === undefined) return;
  const metadata = z.object({ name: repositoryName, owner: z.object({ id: z.number().int().positive().safe(), login: ownerName }) }).parse(raw);
  if (metadata.owner.id !== repository.ownerId || metadata.owner.login.toLowerCase() !== repository.owner.toLowerCase() || metadata.name.toLowerCase() !== repository.repo.toLowerCase()) throw Error("github_owner_mismatch");
}
const entry = z.object({ name: z.string().min(1).max(512), path, sha, size: z.number().int().nonnegative(), type: z.enum(["file", "dir", "symlink", "submodule"]), submodule_git_url: z.string().nullable().optional() });
export function githubReadHeaders(token?: string) { return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "personal-assistant-shadow", ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }

/** Authenticated owner queries only; this does not publish/index external bodies as owner notes. */
export class GitHubReader {
  private readonly repositories: z.infer<typeof githubRepository>[];
  private readonly access: ConnectorAccess;
  constructor(db: D1Database, scope: SourceScope, repositories: unknown, private readonly token?: string,
    private readonly request: ReadFetch = request => fetch(request), private readonly clock = Date.now) {
    this.repositories = z.array(githubRepository).max(20).parse(repositories);
    if (new Set(this.repositories.map(item => item.id)).size !== this.repositories.length) throw new Error("github_configuration");
    this.access = new ConnectorAccess(db, scope, clock);
  }
  async execute(actor: TrustedActor, input: unknown): Promise<unknown> {
    const query = githubQuery.parse(input), repository = this.repositories.find(item => item.id === query.repository);
    if (!repository) return { state: "unavailable", reason: "repository_not_authorized" };
    const fence = await this.access.admit(actor, repository);
    if (!fence) return { state: "unavailable", reason: "source_denied" };
    const headers = githubReadHeaders(this.token);
    const url = new URL(`https://api.github.com/repos/${repository.owner}/${repository.repo}/contents/${query.path.split("/").map(encodeURIComponent).join("/")}`);
    url.searchParams.set("ref", query.commit);
    const observation = { origin: "github" as const, repository: repository.id, projectId: repository.projectId, configurationVersion: repository.version,
      commit: query.commit, path: query.path, audience: "owner" as const, execution: "unconfirmed" as const, deployment: "not_observed" as const };
    try {
      if (repository.ownerId !== undefined) {
        verifyGitHubOwner(repository, await readJson(new URL(`https://api.github.com/repos/${repository.owner}/${repository.repo}`), headers, this.request, 65536));
        if (!await this.access.current(actor, fence)) return { state: "unavailable", reason: "source_changed" };
      }
      const raw = await readJson(url, headers, this.request, query.kind === "github.list" ? 2097152 : 65536);
      let result: unknown;
      if (query.kind === "github.read") {
        const file = entry.extend({ encoding: z.literal("base64"), content: z.string().max(45000) }).parse(raw);
        if (file.path !== query.path || file.type !== "file" || file.submodule_git_url || file.size > 32768) throw new Error("github_file_unsupported");
        const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), c => c.charCodeAt(0));
        if (bytes.length !== file.size || bytes.length > 32768) throw new Error("github_file_limit");
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (text.includes("\u0000")) throw new Error("github_file_binary");
        result = { state: "available", ...observation, text, blobSha: file.sha, hash: await sourceTextHash(text), coverage: { kind: "single_file", complete: true }, observedAt: this.clock() };
      } else {
        const entries = z.array(entry).max(1000).parse(raw).map(item => ({ path: item.path, sha: item.sha, size: item.size,
          type: item.submodule_git_url ? "submodule" : item.type })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const prefix = query.path ? query.path + "/" : "";
        if (new Set(entries.map(item => item.path)).size !== entries.length || entries.some(item => !item.path.startsWith(prefix) || item.path.slice(prefix.length).includes("/"))) throw new Error("github_listing");
        const fingerprint = await bridgeHash(["github-contents-v1", repository, fence, query.commit, query.path, entries]);
        let offset = 0;
        if (query.cursor) offset = z.object({ fingerprint: z.literal(fingerprint), offset: z.number().int().min(0).max(entries.length) }).strict().parse(decodeCursor(query.cursor)).offset;
        const items = entries.slice(offset, offset + query.limit), more = offset + items.length < entries.length;
        result = { state: "available", ...observation, items, coverage: { kind: more ? "page" : entries.length === 1000 ? "api_capacity" : "directory_end", complete: !more && entries.length < 1000,
          observedEntries: entries.length, scope: "directory_only" }, ...(more ? { nextCursor: encodeCursor({ fingerprint, offset: offset + items.length }) } : {}) };
      }
      return await this.access.current(actor, fence) ? result : { state: "unavailable", reason: "source_changed" };
    } catch (error) {
      githubReadFailure("contents", error);
      return { state: "unavailable", reason: error instanceof Error && error.message === "github_rate_limited" ? "github_rate_limited" : "github_read_failed", ...observation, coverage: { kind: "unknown", complete: false } };
    }
  }
}

/** Static diagnostics only: never log a provider body, URL, token or source text. */
export function githubReadFailure(stage: "resolve" | "contents" | "admission" | "presentation", error: unknown) {
  const codes = new Set(["connector_unavailable", "connector_response_limit", "connector_timeout", "github_file_unsupported", "github_file_limit", "github_file_binary", "github_listing", "github_dialogue_expired", "github_authorization_changed", "dialogue_read_denied", "github_rate_limited", "github_owner_mismatch"]);
  const code = error instanceof Error && codes.has(error.message) ? error.message : error instanceof Error && error.name === "ZodError" ? "schema" : "unclassified";
  console.warn(JSON.stringify({ event: "github_read_failure", stage, code }));
}
