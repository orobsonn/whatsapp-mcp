import { DurableObject } from "cloudflare:workers";
import { createOAuthProvider } from "./auth";
import { resolveRuntimeEnv } from "./connection";
import { OAuthStage, OAUTH_LIMITS, type OAuthRecord } from "./oauth-storage";
import type { Env } from "./env";
import { sha256 } from "./core";

type Grant = { clientId: string; scope: string[]; encryptedProps: string; expiresAt?: number;
  refreshTokenId?: string; refreshTokenWrappedKey?: string; previousRefreshTokenId?: string; previousRefreshTokenWrappedKey?: string };
type History = { hash: string; wrapped: string; expires_at: number };
type Receipt = { key: string; grant_key: string; client_key: string; fingerprint: string; cipher: string; expires_at: number };
type Packet = { body: string; status: number; headers: [string, string][] };
const unavailable = () => Response.json({ error: "temporarily_unavailable" }, { status: 503,
  headers: { "Cache-Control": "no-store", "Retry-After": "5" } });

/** One authority per personal installation. OAuth state never falls back to KV after import. */
export class OAuthCoordinator extends DurableObject<Env> {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_records(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);
      CREATE INDEX IF NOT EXISTS oauth_records_expiry ON oauth_records(expires_at);
      CREATE TABLE IF NOT EXISTS oauth_history(grant_key TEXT NOT NULL,hash TEXT NOT NULL,wrapped TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(grant_key,hash));
      CREATE INDEX IF NOT EXISTS oauth_history_expiry ON oauth_history(expires_at);
      CREATE TABLE IF NOT EXISTS oauth_receipts(key TEXT PRIMARY KEY,grant_key TEXT NOT NULL,client_key TEXT NOT NULL,fingerprint TEXT NOT NULL,cipher TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_receipts_expiry ON oauth_receipts(expires_at);`);
  }
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#pending >= OAUTH_LIMITS.queue) throw new Error("OAuth queue full");
    this.#pending++;
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    try { return await result; } finally { this.#pending--; }
  }
  #cleanup(now: number) {
    this.ctx.storage.sql.exec("DELETE FROM oauth_records WHERE expires_at<=?", now);
    this.ctx.storage.sql.exec("DELETE FROM oauth_receipts WHERE expires_at<=?", now);
    this.ctx.storage.sql.exec("DELETE FROM oauth_history WHERE expires_at<=?", now);
  }
  async #initialize(now: number) {
    if (this.ctx.storage.sql.exec("SELECT key FROM oauth_meta WHERE key='imported'").toArray().length) return;
    const records: OAuthRecord[] = [];
    let cursor: string | undefined, bytes = 0, seen = 0;
    do {
      const page = await this.env.OAUTH_KV.list({ cursor, limit: 100 });
      for (const key of page.keys) {
        if (++seen > OAUTH_LIMITS.records) throw new Error("OAuth import limit");
        if (!/^(client|grant|token):/.test(key.name) || (key.expiration !== undefined && key.expiration <= now)) continue;
        const value = await this.env.OAUTH_KV.get(key.name);
        if (value === null) continue;
        const size = new TextEncoder().encode(key.name + value).length;
        if (size > OAUTH_LIMITS.valueBytes || (bytes += size) > OAUTH_LIMITS.bytes) throw new Error("OAuth import limit");
        records.push({ key: key.name, value, expires_at: key.expiration ?? null });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    this.ctx.storage.transactionSync(() => {
      for (const record of records) {
        this.ctx.storage.sql.exec("INSERT INTO oauth_records(key,value,expires_at) VALUES (?,?,?)", record.key, record.value, record.expires_at);
        if (record.key.startsWith("grant:")) {
          const grant = JSON.parse(record.value) as Grant;
          if (grant.previousRefreshTokenId && grant.previousRefreshTokenWrappedKey)
            this.#history(record.key, grant.previousRefreshTokenId, grant.previousRefreshTokenWrappedKey, now + OAUTH_LIMITS.grace);
        }
      }
      this.ctx.storage.sql.exec("INSERT INTO oauth_meta(key,value) VALUES ('imported','1')");
    });
  }
  #history(grant: string, hash: string, wrapped: string, expires: number) {
    // An already superseded token never gets a sliding grace deadline.
    this.ctx.storage.sql.exec("INSERT INTO oauth_history(grant_key,hash,wrapped,expires_at) VALUES (?,?,?,?) ON CONFLICT(grant_key,hash) DO NOTHING", grant, hash, wrapped, expires);
  }
  #allowed(grantKey: string, hash: string, now: number) {
    return this.ctx.storage.sql.exec<History>("SELECT hash,wrapped,expires_at FROM oauth_history WHERE grant_key=? AND hash=? AND expires_at>?", grantKey, hash, now).toArray()[0];
  }
  /** Read-only RPC: bearer validation does not serialize the business tool itself. */
  async read(key: string): Promise<string | null> {
    return this.#exclusive(async () => {
      const now = Math.floor(Date.now() / 1000);
      await this.#initialize(now);
      return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM oauth_records WHERE key=? AND (expires_at IS NULL OR expires_at>?)", key, now).toArray()[0]?.value ?? null;
    });
  }
  async keys(options?: KVNamespaceListOptions) {
    return this.#exclusive(async () => {
      await this.#initialize(Math.floor(Date.now() / 1000));
      return new OAuthStage(this.ctx.storage.sql, Math.floor(Date.now() / 1000)).list(options);
    });
  }
  async #key(env: Env) {
    if (!env.ENCRYPTION_KEY) throw new Error("OAuth receipt key unavailable");
    const bytes = Uint8Array.from(atob(env.ENCRYPTION_KEY), char => char.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("OAuth receipt key unavailable");
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  #aad(env: Env, requestKey: string) {
    return new TextEncoder().encode(JSON.stringify(["zap-oauth-receipt-v1", env.PUBLIC_ORIGIN, env.OWNER_SUB, env.INSTALLATION_EPOCH, requestKey]));
  }
  async #seal(env: Env, key: string, packet: Packet) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.#aad(env, key) }, await this.#key(env), new TextEncoder().encode(JSON.stringify(packet))));
    return btoa(String.fromCharCode(...iv, ...cipher));
  }
  async #open(env: Env, key: string, cipher: string): Promise<Packet> {
    const data = Uint8Array.from(atob(cipher), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12), additionalData: this.#aad(env, key) }, await this.#key(env), data.slice(12))));
  }
  async #fingerprint(stage: OAuthStage, grantKey: string, clientKey: string) {
    const raw = stage.raw(grantKey), client = stage.raw(clientKey);
    if (!raw || !client) return null;
    const grant = JSON.parse(raw) as Grant;
    return sha256(JSON.stringify([client, grant.clientId, grant.scope, grant.encryptedProps, grant.expiresAt]));
  }
  async fetch(request: Request): Promise<Response> {
    try { return await this.#exclusive(() => this.#handle(request)); }
    catch { console.warn("oauth_authority_unavailable"); return unavailable(); }
  }
  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (new URL(request.url).origin !== this.env.PUBLIC_ORIGIN || !["/authorize", "/oauth/token", "/oauth/register"].includes(path))
      return new Response(null, { status: 404 });
    const env = await resolveRuntimeEnv(this.env, { failOnUnavailable: true });
    const now = Math.floor(Date.now() / 1000);
    await this.#initialize(now);
    this.ctx.storage.transactionSync(() => this.#cleanup(now));
    if (path === "/oauth/register" && request.method === "POST" &&
      this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_records WHERE key LIKE 'client:%'").one().n >= OAUTH_LIMITS.clients)
      return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "3600" } });
    const stage = new OAuthStage(this.ctx.storage.sql, now);
    const providerEnv = { ...env, OAUTH_COORDINATOR: undefined, OAUTH_KV: stage.kv() };
    const provider = createOAuthProvider({ fetch: async () => Response.json({ authorized: true }) });
    const context = { props: {}, waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise), passThroughOnException() {} } as ExecutionContext;
    // Never persist an unbounded body. The public wrapper enforces the same cap.
    const reader = request.clone().body?.getReader();
    let body = "";
    if (reader) {
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const item = await reader.read(); if (item.done) break;
        if ((length += item.value.byteLength) > 16384) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = new TextDecoder().decode(bytes);
    }
    let params: Record<string, string> = {};
    let canonicalBody = body;
    const contentType = request.headers.get("content-type")?.split(";")[0].trim();
    if (path === "/oauth/token") {
      try {
        if (contentType === "application/json") {
          params = JSON.parse(body);
          canonicalBody = JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))));
        } else {
          const form = new URLSearchParams(body); form.sort();
          params = Object.fromEntries(form); canonicalBody = form.toString();
        }
      } catch { /* Provider owns malformed input responses. */ }
    }
    const requestKey = await sha256(JSON.stringify([env.INSTALLATION_EPOCH, path, request.method, contentType, request.headers.get("authorization"), canonicalBody]));
    // Authorization codes remain single-use. Only refresh replies are recoverable.
    const isRefresh = path === "/oauth/token" && params?.grant_type === "refresh_token";
    const receipt = isRefresh ? this.ctx.storage.sql.exec<Receipt>("SELECT * FROM oauth_receipts WHERE key=? AND expires_at>?", requestKey, now).toArray()[0] : undefined;
    if (receipt && await this.#fingerprint(stage, receipt.grant_key, receipt.client_key) === receipt.fingerprint) {
      const packet = await this.#open(env, requestKey, receipt.cipher);
      const tokens = JSON.parse(packet.body) as { access_token: string; refresh_token: string };
      const grant = JSON.parse(stage.raw(receipt.grant_key)!) as Grant;
      const hash = await sha256(tokens.refresh_token);
      const usable = grant.refreshTokenId === hash || this.#allowed(receipt.grant_key, hash, now);
      const presentedHash = typeof params.refresh_token === "string" ? await sha256(params.refresh_token) : "";
      const presentedAllowed = grant.refreshTokenId === presentedHash || this.#allowed(receipt.grant_key, presentedHash, now);
      // Reuse the provider's decryption, subject, epoch, scope and maintenance checks.
      const check = await provider.fetch(new Request(env.PUBLIC_ORIGIN + "/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } }), providerEnv, context);
      if (presentedAllowed && usable && check.status === 200) return new Response(packet.body, { status: packet.status, headers: packet.headers });
    }
    let prior: { key: string; grant: Grant } | undefined;
    let recoveryDeadline = now + OAUTH_LIMITS.grace;
    if (isRefresh && typeof params.refresh_token === "string") {
      const parts = params.refresh_token.split(":");
      if (parts.length === 3) {
        const key = "grant:" + parts.slice(0, 2).join(":");
        const raw = stage.raw(key);
        if (raw) {
          prior = { key, grant: JSON.parse(raw) as Grant };
          const hash = await sha256(params.refresh_token);
          const history = this.#allowed(key, hash, now);
          if (hash !== prior.grant.refreshTokenId && history)
            recoveryDeadline = Math.min(recoveryDeadline, history.expires_at);
          stage.transform = (recordKey, value) => {
            if (recordKey !== key) return value;
            const grant = JSON.parse(value) as Grant;
            // The library's unbounded previous-token allowance is replaced here.
            delete grant.previousRefreshTokenId; delete grant.previousRefreshTokenWrappedKey;
            if (history) { grant.previousRefreshTokenId = hash; grant.previousRefreshTokenWrappedKey = history.wrapped; }
            return JSON.stringify(grant);
          };
        }
      }
    }
    const response = await provider.fetch(request, providerEnv, context);
    if (response.status >= 500) return response;
    const packet: Packet = { body: await response.text(), status: response.status, headers: [...response.headers] };
    let saved: Omit<Receipt, "cipher"> & { cipher: string } | undefined;
    if (isRefresh && response.status === 200) {
      const tokens = JSON.parse(packet.body) as { refresh_token?: string };
      if (tokens.refresh_token) {
        const grantKey = "grant:" + tokens.refresh_token.split(":").slice(0, 2).join(":");
        const grant = JSON.parse(stage.raw(grantKey)!) as Grant;
        const clientKey = "client:" + grant.clientId;
        const fingerprint = await this.#fingerprint(stage, grantKey, clientKey);
        if (!fingerprint) throw new Error("OAuth issuance incomplete");
        saved = { key: requestKey, grant_key: grantKey, client_key: clientKey, fingerprint,
          cipher: await this.#seal(env, requestKey, packet), expires_at: Math.min(recoveryDeadline, grant.expiresAt ?? Infinity) };
      }
    }
    this.ctx.storage.transactionSync(() => {
      const receiptCount = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_receipts").one().n;
      const historyCount = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_history").one().n;
      if (saved && (receiptCount >= OAUTH_LIMITS.records || historyCount >= OAUTH_LIMITS.records))
        throw new Error("OAuth recovery storage limit");
      stage.flush();
      if (saved) {
        if (prior?.grant.refreshTokenId && prior.grant.refreshTokenWrappedKey)
          this.#history(prior.key, prior.grant.refreshTokenId, prior.grant.refreshTokenWrappedKey, now + OAUTH_LIMITS.grace);
        this.ctx.storage.sql.exec("INSERT INTO oauth_receipts(key,grant_key,client_key,fingerprint,cipher,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET grant_key=excluded.grant_key,client_key=excluded.client_key,fingerprint=excluded.fingerprint,cipher=excluded.cipher,expires_at=excluded.expires_at",
          saved.key, saved.grant_key, saved.client_key, saved.fingerprint, saved.cipher, saved.expires_at);
      }
    });
    return new Response(packet.body || null, { status: packet.status, headers: packet.headers });
  }
}
