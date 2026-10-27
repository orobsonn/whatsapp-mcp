import { env, createExecutionContext, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createOAuthProvider } from "../src/auth";
import type { Env } from "../src/env";
import { oauthCoordinator } from "../src/oauth-storage";

const settings = () => ({ ...env }) as Env;
const handler = { fetch: async () => Response.json({ ok: true }) };
type Tokens = { access_token: string; refresh_token: string; expires_in: number };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { pair = await generateKeyPair("RS256", { extractable: true }); });

// Issue with the unmodified provider first, then import the existing grant.
async function session() {
  const config = settings();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" }] })));
  const ownerJwt = await new SignJWT({ iss: config.ACCESS_ISSUER, aud: config.ACCESS_AUD,
    sub: config.OWNER_SUB, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(pair.privateKey);
  const legacy = createOAuthProvider(handler);
  const coordinated = createOAuthProvider(handler);
  const req = (path: string, init: RequestInit = {}) => new Request(config.PUBLIC_ORIGIN + path, init);
  const callLegacy = (path: string, init: RequestInit = {}) => legacy.fetch(req(path, init), { ...config, OAUTH_COORDINATOR: undefined }, createExecutionContext());
  const registered = await callLegacy("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }) });
  expect(registered.status).toBe(201);
  const { client_id } = await registered.json() as { client_id: string };
  const verifier = "v".repeat(43);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const query = new URLSearchParams({ client_id, redirect_uri: "https://client.example/callback", response_type: "code", scope: "mcp offline_access",
    code_challenge: challenge, code_challenge_method: "S256", resource: config.PUBLIC_ORIGIN + "/mcp" });
  const consent = await callLegacy("/authorize?" + query, { headers: { "Cf-Access-Jwt-Assertion": ownerJwt } });
  expect(consent.status).toBe(200);
  const nonce = (await consent.text()).match(/name="nonce" value="([^"]+)"/)![1];
  const approved = await callLegacy("/authorize", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": ownerJwt, Origin: config.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce }) });
  expect(approved.status).toBe(302);
  const codeResponse = await callLegacy("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id,
    grant_type: "authorization_code", code: new URL(approved.headers.get("location")!).searchParams.get("code")!, code_verifier: verifier, redirect_uri: "https://client.example/callback", resource: config.PUBLIC_ORIGIN + "/mcp" }) });
  expect(codeResponse.status).toBe(200);
  const token = await codeResponse.json() as Tokens;
  const stub = oauthCoordinator(config)!;
  const drain = async (response: Response) => new Response(await response.text(), { status: response.status, headers: response.headers });
  const exchange = async (refresh: string, extra: Record<string, string> = {}) => drain(await coordinated.fetch(req("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id, grant_type: "refresh_token", refresh_token: refresh, ...extra }) }), config, createExecutionContext()));
  const use = async (token: Tokens) => drain(await coordinated.fetch(req("/mcp", { headers: { Authorization: `Bearer ${token.access_token}` } }), config, createExecutionContext()));
  return { token, exchange, use, stub, client_id, grantKey: "grant:" + token.refresh_token.split(":").slice(0, 2).join(":") };
}
beforeEach(async () => {
  const stub = oauthCoordinator(settings())!;
  await runInDurableObject(stub, async (_object, state) => { await state.storage.deleteAll(); });
  await evictDurableObject(stub);
  const page = await env.OAUTH_KV.list();
  await Promise.all(page.keys.map(key => env.OAUTH_KV.delete(key.name)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native OAuth authority", () => {
  it("imports existing credentials and returns the identical successor under concurrent refresh", async () => {
    const s = await session();
    const responses = await Promise.all(Array.from({ length: 8 }, () => s.exchange(s.token.refresh_token)));
    expect(responses.map(r => r.status)).toEqual(Array(8).fill(200));
    const tokens = await Promise.all(responses.map(r => r.json() as Promise<Tokens>));
    expect(new Set(tokens.map(t => t.refresh_token)).size).toBe(1);
    expect((await s.use(tokens[0])).status).toBe(200);
    expect((await s.exchange(tokens[0].refresh_token)).status).toBe(200);
  });
  it("recovers a lost reply after eviction and keeps earlier returned branches usable", async () => {
    const s = await session();
    const first = await (await s.exchange(s.token.refresh_token)).json() as Tokens;
    const second = await (await s.exchange(first.refresh_token)).json() as Tokens;
    const third = await (await s.exchange(second.refresh_token)).json() as Tokens;
    await evictDurableObject(s.stub);
    const recovered = await s.exchange(s.token.refresh_token);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(first);
    expect((await s.exchange(first.refresh_token)).status).toBe(200);
    expect((await s.exchange(third.refresh_token)).status).toBe(200);
  });
  it("does not rotate partly if the atomic commit fails", async () => {
    const s = await session();
    await s.use(s.token);
    await runInDurableObject(s.stub, (_object, state) => {
      state.storage.sql.exec("CREATE TRIGGER reject_tokens BEFORE INSERT ON oauth_records WHEN NEW.key LIKE 'token:%' BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END");
    });
    expect((await s.exchange(s.token.refresh_token)).status).toBe(503);
    await runInDurableObject(s.stub, (_object, state) => { state.storage.sql.exec("DROP TRIGGER reject_tokens"); });
    await evictDurableObject(s.stub);
    const good = await s.exchange(s.token.refresh_token);
    expect(good.status).toBe(200);
    expect((await s.use(await good.json() as Tokens)).status).toBe(200);
  });
  it("keeps scope/resource/client failures out of the replay cache", async () => {
    const s = await session();
    expect((await s.exchange(s.token.refresh_token)).status).toBe(200);
    expect((await s.exchange(s.token.refresh_token, { resource: "https://foreign.example/mcp" })).status).toBe(400);
    expect((await s.exchange(s.token.refresh_token, { client_id: "foreign-client" })).status).toBe(401);
    const narrowed = await s.exchange(s.token.refresh_token, { scope: "mcp" });
    expect(narrowed.status).toBe(200);
    expect(await narrowed.json()).toMatchObject({ scope: "mcp" });
  });
  it("never resurrects a revoked imported grant from KV or a cached response", async () => {
    const s = await session();
    const first = await (await s.exchange(s.token.refresh_token)).json() as Tokens;
    await runInDurableObject(s.stub, (_object, state) => { state.storage.sql.exec("DELETE FROM oauth_records WHERE key=?", s.grantKey); });
    await evictDurableObject(s.stub);
    expect((await s.exchange(s.token.refresh_token)).status).toBe(400);
    expect((await s.exchange(first.refresh_token)).status).toBe(400);
  });
  it("expires prior-token grace and replay receipts without revoking the current successor", async () => {
    const s = await session();
    const first = await (await s.exchange(s.token.refresh_token)).json() as Tokens;
    await runInDurableObject(s.stub, (_object, state) => {
      const deadline = state.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM oauth_history").one().expires_at;
      expect(deadline - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
      state.storage.sql.exec("UPDATE oauth_history SET expires_at=0");
      state.storage.sql.exec("UPDATE oauth_receipts SET expires_at=0");
    });
    expect((await s.exchange(s.token.refresh_token)).status).toBe(400);
    expect((await s.exchange(first.refresh_token)).status).toBe(200);
  });
  it.each([{ MAINTENANCE: "true" }, { INSTALLATION_EPOCH: "revoked" }])("never replays through a current owner fence %o", async overrides => {
    const s = await session();
    expect((await s.exchange(s.token.refresh_token)).status).toBe(200);
    await runInDurableObject(s.stub, object => { Object.assign((object as unknown as { env: Env }).env, overrides); });
    const rejected = await s.exchange(s.token.refresh_token);
    expect(rejected.status).toBe(400);
    await runInDurableObject(s.stub, object => { Object.assign((object as unknown as { env: Env }).env, { MAINTENANCE: "false", INSTALLATION_EPOCH: "epoch" }); });
    expect((await s.exchange(s.token.refresh_token)).status).toBe(400);
  });
  it("fails an interrupted/oversized legacy import atomically and retries it safely", async () => {
    const s = await session();
    await env.OAUTH_KV.put("client:oversized", "x".repeat(129 * 1024));
    expect((await s.exchange(s.token.refresh_token)).status).toBe(503);
    await runInDurableObject(s.stub, (_object, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_meta").one().n).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_records").one().n).toBe(0);
    });
    await env.OAUTH_KV.delete("client:oversized");
    expect((await s.exchange(s.token.refresh_token)).status).toBe(200);
  });
  it("keeps token replies encrypted and does not rotate again after receipt corruption", async () => {
    const s = await session();
    const first = await (await s.exchange(s.token.refresh_token)).json() as Tokens;
    await runInDurableObject(s.stub, (_object, state) => {
      const receipt = state.storage.sql.exec<{ cipher: string }>("SELECT cipher FROM oauth_receipts").one();
      expect(receipt.cipher).not.toContain(first.refresh_token);
      state.storage.sql.exec("UPDATE oauth_receipts SET cipher='corrupted'");
    });
    expect((await s.exchange(s.token.refresh_token)).status).toBe(503);
    expect((await s.exchange(first.refresh_token)).status).toBe(200);
  });
  it("reserves issuance capacity when the public registration quota is full", async () => {
    const s = await session(); await s.use(s.token);
    await runInDurableObject(s.stub, (_object, state) => {
      for (let i = 0; i < 128; i++) state.storage.sql.exec("INSERT INTO oauth_records(key,value,expires_at) VALUES (?, '{}', NULL)", "client:synthetic-" + i);
    });
    const registration = await s.stub.fetch(new Request(settings().PUBLIC_ORIGIN + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }) }));
    expect(registration.status).toBe(429); await registration.text();
    expect((await s.exchange(s.token.refresh_token)).status).toBe(200);
  });
  it("does not extend a predecessor's deadline via a different-body replay", async () => {
    const s = await session();
    expect((await s.exchange(s.token.refresh_token)).status).toBe(200);
    await runInDurableObject(s.stub, (_object, state) => {
      state.storage.sql.exec("UPDATE oauth_history SET expires_at=?", Math.floor(Date.now() / 1000) + 5);
    });
    const changed = await s.exchange(s.token.refresh_token, { scope: "mcp" });
    expect(changed.status).toBe(200);
    await runInDurableObject(s.stub, (_object, state) => {
      const deadlines = state.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM oauth_receipts ORDER BY expires_at").toArray();
      expect(deadlines[0].expires_at - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(5);
      state.storage.sql.exec("UPDATE oauth_history SET expires_at=0");
      // Even a stale live receipt cannot bypass the presented token's deadline.
      state.storage.sql.exec("UPDATE oauth_receipts SET expires_at=?", Math.floor(Date.now() / 1000) + 30);
    });
    expect((await s.exchange(s.token.refresh_token, { scope: "mcp" })).status).toBe(400);
  });
  it("does not replay after client deletion and keeps malformed input a protocol error", async () => {
    const s = await session();
    expect((await s.exchange(s.token.refresh_token)).status).toBe(200);
    await runInDurableObject(s.stub, (_object, state) => { state.storage.sql.exec("DELETE FROM oauth_records WHERE key=?", "client:" + s.client_id); });
    expect((await s.exchange(s.token.refresh_token)).status).toBe(401);
    const bad = await s.stub.fetch(new Request(settings().PUBLIC_ORIGIN + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" }));
    expect(bad.status).toBe(400); await bad.text();
  });
});
