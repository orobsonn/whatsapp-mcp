import type { OAuthCoordinator } from "./oauth-coordinator";

export type OAuthRecord = { key: string; value: string; expires_at: number | null };
export const OAUTH_LIMITS = { records: 10000, clients: 128, bytes: 8 * 1024 * 1024, valueBytes: 128 * 1024, grace: 60, queue: 32 } as const;
export type AuthorityEnv = {
  OAUTH_COORDINATOR?: DurableObjectNamespace<OAuthCoordinator>;
  OWNER_SUB: string;
  PUBLIC_ORIGIN: string;
};
export function oauthCoordinator(env: AuthorityEnv) {
  return env.OAUTH_COORDINATOR?.getByName(`oauth-v1:${env.PUBLIC_ORIGIN}:${env.OWNER_SUB}`);
}

/** Only the read operations used by bearer validation leave the authority. */
export function remoteOAuthKv(stub: DurableObjectStub<OAuthCoordinator>): KVNamespace {
  return {
    async get(key: string, options?: string | { type?: string }) {
      const value = await stub.read(key);
      return decode(value, options);
    },
    list: (options?: KVNamespaceListOptions) => stub.keys(options),
    put: async () => { throw new Error("OAuth writes require the authority transaction"); },
    delete: async () => { throw new Error("OAuth writes require the authority transaction"); },
  } as unknown as KVNamespace;
}
function decode(value: string | null, options?: string | { type?: string }) {
  if (value === null) return null;
  const type = typeof options === "string" ? options : options?.type;
  if (type === "json") return JSON.parse(value);
  if (type && type !== "text") throw new Error("Unsupported OAuth storage read");
  return value;
}

/** Request-local provider writes. Flush is called inside one SQLite transaction. */
export class OAuthStage {
  readonly records = new Map<string, OAuthRecord>();
  readonly changes = new Map<string, OAuthRecord | null>();
  transform?: (key: string, value: string) => string;
  constructor(readonly sql: SqlStorage, readonly now: number) {
    for (const record of sql.exec<OAuthRecord>("SELECT key,value,expires_at FROM oauth_records WHERE expires_at IS NULL OR expires_at>?", now))
      this.records.set(record.key, record);
  }
  raw(key: string): string | null { return this.records.get(key)?.value ?? null; }
  kv(): KVNamespace {
    return {
      get: async (key: string, options?: string | { type?: string }) => {
        const value = this.raw(key);
        return decode(value === null ? null : this.transform?.(key, value) ?? value, options);
      },
      put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
        if (typeof value !== "string" || key.length > 512 || new TextEncoder().encode(value).length > OAUTH_LIMITS.valueBytes)
          throw new Error("OAuth storage limit");
        const record = { key, value, expires_at: options?.expiration ?? (options?.expirationTtl === undefined ? null : this.now + options.expirationTtl) };
        this.records.set(key, record); this.changes.set(key, record);
      },
      delete: async (key: string) => { this.records.delete(key); this.changes.set(key, null); },
      list: async (options?: KVNamespaceListOptions) => this.list(options),
    } as unknown as KVNamespace;
  }
  list(options: KVNamespaceListOptions = {}) {
    const prefix = options.prefix ?? "";
    const cursor = options.cursor ? JSON.parse(atob(options.cursor)) as { prefix: string; after: string } : { prefix, after: "" };
    if (cursor.prefix !== prefix) throw new Error("Invalid OAuth cursor");
    const sorted = [...this.records.values()].filter(row => row.key.startsWith(prefix) && row.key > cursor.after).sort((a, b) => a.key < b.key ? -1 : 1);
    const page = sorted.slice(0, Math.min(options.limit ?? 1000, 1000));
    const complete = page.length === sorted.length;
    return { keys: page.map(row => ({ name: row.key, ...(row.expires_at === null ? {} : { expiration: row.expires_at }) })),
      list_complete: complete, cacheStatus: null,
      ...(complete ? {} : { cursor: btoa(JSON.stringify({ prefix, after: page.at(-1)!.key })) }) };
  }
  flush() {
    let bytes = 0;
    if (this.records.size > OAUTH_LIMITS.records) throw new Error("OAuth storage limit");
    for (const row of this.records.values()) bytes += new TextEncoder().encode(row.key + row.value).length;
    if (bytes > OAUTH_LIMITS.bytes) throw new Error("OAuth storage limit");
    for (const [key, row] of this.changes) {
      if (row === null) this.sql.exec("DELETE FROM oauth_records WHERE key=?", key);
      else this.sql.exec("INSERT INTO oauth_records(key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at", row.key, row.value, row.expires_at);
    }
  }
}
