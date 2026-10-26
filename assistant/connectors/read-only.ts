import { z } from "zod";
import { SourceAccess, type SourceFence, type TrustedActor } from "../access";
import type { SourceScope } from "../sources";

export const connectorAuthority = z.object({ projectId: z.string().min(1).max(256), version: z.number().int().positive(),
  authorization: z.object({ sourceId: z.string().min(1).max(256), revision: z.number().int().positive() }).strict() });
export type ConnectorAuthority = z.infer<typeof connectorAuthority>;
export type ReadFetch = (request: Request) => Promise<Response>;

/** No model receives this transport or its credentials. All callers build fixed GET endpoints. */
export async function readJson(url: URL, headers: HeadersInit, request: ReadFetch, maximum = 262144, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("connector_timeout")); }, timeoutMs); });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([request(new Request(url, { method: "GET", headers, redirect: "manual", signal: controller.signal })), deadline]);
    if (response.status !== 200 || !response.body) throw new Error("connector_unavailable");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error("connector_response_limit");
    reader = response.body.getReader(); let size = 0, text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    while (true) {
      const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
      size += part.value.length; if (size > maximum) throw new Error("connector_response_limit");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}

/** Configuration is host-owned. Its canonical support is an explicit revocation/version fence. */
export class ConnectorAccess {
  private readonly access: SourceAccess;
  constructor(private readonly db: D1Database, private readonly scope: SourceScope, private readonly clock = Date.now) { this.access = new SourceAccess(db, scope, clock); }
  async admit(actor: TrustedActor, authority: ConnectorAuthority): Promise<SourceFence | null> {
    if (actor.kind !== "owner") return null;
    const read = await this.access.read(actor, authority.authorization.sourceId, authority.authorization.revision, this.clock());
    return read?.fence.source.origin === "owner_note" && read.fence.source.projectId === authority.projectId && read.fence.source.audience === "owner" && await this.current(actor, read.fence) ? read.fence : null;
  }
  async current(actor: TrustedActor, fence: SourceFence) {
    return this.currentMany(actor, [fence]);
  }
  async currentMany(actor: TrustedActor, fences: SourceFence[]) {
    const statements = fences.map(fence => {
    const gate = this.access.guard(actor, fence, this.clock());
    return this.db.prepare(`SELECT 1 WHERE (${gate.sql}) AND EXISTS(SELECT 1 FROM assistant_projects WHERE installation_id=? AND generation=? AND id=?)`)
      .bind(...gate.values, this.scope.installationId, this.scope.generation, fence.source.projectId);
    });
    return (await this.db.batch(statements)).every(result => result.results.length === 1);
  }
}

export function encodeCursor(value: unknown) { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))); }
export function decodeCursor(value: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)))); }
  catch { throw new Error("connector_cursor"); }
}
