import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  requireOwner,
  requireMcpOwner,
  humanConfirmation,
  createOAuthProvider,
  type AuthEnv,
} from "../src/auth";

const settings = () =>
  ({
    ...env,
    PUBLIC_ORIGIN: "https://personal.example",
    ACCESS_ISSUER: "https://owner.cloudflareaccess.com",
    ACCESS_AUD: "app-audience",
    OWNER_SUB: "owner-subject",
    INSTALLATION_EPOCH: "epoch-1",
    MAINTENANCE: "false",
  }) as AuthEnv;
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "synthetic-key",
    alg: "RS256",
  };
});
afterEach(() => vi.unstubAllGlobals());
async function jwt(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: settings().ACCESS_ISSUER,
    aud: settings().ACCESS_AUD,
    sub: settings().OWNER_SUB,
    iat: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .sign(privateKey);
}
function jwks() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "https://owner.cloudflareaccess.com/cdn-cgi/access/certs",
      );
      return Response.json({ keys: [publicJwk] });
    }),
  );
}
async function ownerRequest(
  path = "/confirm/send/action-1",
  init: RequestInit = {},
) {
  return new Request(`https://personal.example${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": await jwt(), ...init.headers },
  });
}
const proposal = {
  purpose: "send" as const,
  resourceId: "action-1",
  envelope: { text: "<script>steal()</script>", target: "group-1" },
  summary: "Grupo <img onerror=steal()>",
};

describe("owner identity and revocation", () => {
  it("verifies the synthetic Access signature, audience, issuer and fixed subject", async () => {
    jwks();
    await expect(
      requireOwner(await ownerRequest(), settings()),
    ).resolves.toEqual({ sub: "owner-subject", epoch: "epoch-1" });
  });
  it.each([
    { iss: "https://attacker.example" },
    { aud: "other-app" },
    { sub: "other-owner" },
    { exp: 1 },
    { exp: undefined },
  ])("rejects invalid Access claims %o", async (claims) => {
    jwks();
    const req = new Request("https://personal.example/confirm", {
      headers: { "Cf-Access-Jwt-Assertion": await jwt(claims) },
    });
    await expect(requireOwner(req, settings())).rejects.toThrow();
  });
  it("accepts an Access cookie but never substitutes a bearer MCP token", async () => {
    jwks();
    await expect(
      requireOwner(
        new Request("https://personal.example/", {
          headers: { cookie: `CF_Authorization=${await jwt()}` },
        }),
        settings(),
      ),
    ).resolves.toMatchObject({ sub: "owner-subject" });
    await expect(
      requireOwner(
        new Request("https://personal.example/", {
          headers: { Authorization: `Bearer ${await jwt()}` },
        }),
        settings(),
      ),
    ).rejects.toThrow();
  });
  it("blocks stale epochs, another subject, maintenance and missing configuration", () => {
    expect(() =>
      requireMcpOwner({ sub: "owner-subject", epoch: "epoch-0" }, settings()),
    ).toThrow();
    expect(() =>
      requireMcpOwner({ sub: "other", epoch: "epoch-1" }, settings()),
    ).toThrow();
    expect(() =>
      requireMcpOwner(
        { sub: "owner-subject", epoch: "epoch-1" },
        { ...settings(), MAINTENANCE: "true" },
      ),
    ).toThrow();
    expect(() =>
      requireMcpOwner(
        { sub: "owner-subject", epoch: "" },
        { ...settings(), INSTALLATION_EPOCH: "" },
      ),
    ).toThrow();
  });
});

describe("separate human confirmation", () => {
  it("GET escapes untrusted content, disallows frames and never invokes effects", async () => {
    jwks();
    const effect = vi.fn();
    const response = await humanConfirmation(
      await ownerRequest(),
      settings(),
      proposal,
      effect,
    );
    const body = await response.text();
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<img");
    expect(body).toContain('type="hidden" name="nonce"');
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(effect).not.toHaveBeenCalled();
  });
  it("requires exact Origin then consumes a nonce only once and binds its envelope", async () => {
    jwks();
    const effect = vi.fn(async (proof) => Response.json(proof));
    const get = await humanConfirmation(
      await ownerRequest(),
      settings(),
      proposal,
      effect,
    );
    const nonce = (await get.text()).match(/name="nonce" value="([^"]+)"/)![1];
    const submit = async (origin: string, data = proposal) =>
      humanConfirmation(
        await ownerRequest(undefined, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ nonce }),
        }),
        settings(),
        data,
        effect,
      );
    expect((await submit("null")).status).toBe(403);
    expect((await submit("https://attacker.example")).status).toBe(403);
    expect(
      (
        await submit("https://personal.example", {
          ...proposal,
          envelope: { text: "changed", target: "group-1" },
        })
      ).status,
    ).toBe(403);
    expect((await submit("https://personal.example")).status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect.mock.calls[0][0]).toMatchObject({
      sub: "owner-subject",
      epoch: "epoch-1",
      purpose: "send",
      resourceId: "action-1",
    });
    expect((await submit("https://personal.example")).status).toBe(403);
  });
  it("rejects old epoch and expired confirmations", async () => {
    jwks();
    const effect = vi.fn();
    const get = await humanConfirmation(
      await ownerRequest(),
      settings(),
      proposal,
      effect,
    );
    const nonce = (await get.text()).match(/name="nonce" value="([^"]+)"/)![1];
    const post = await ownerRequest(undefined, {
      method: "POST",
      headers: {
        Origin: "https://personal.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce }),
    });
    expect(
      (
        await humanConfirmation(
          post,
          { ...settings(), INSTALLATION_EPOCH: "epoch-2" },
          proposal,
          effect,
        )
      ).status,
    ).toBe(403);
    await env.DB.prepare("UPDATE auth_nonces SET expires_at = 0").run();
    const retry = await ownerRequest(undefined, {
      method: "POST",
      headers: {
        Origin: "https://personal.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce }),
    });
    expect(
      (await humanConfirmation(retry, settings(), proposal, effect)).status,
    ).toBe(403);
    expect(effect).not.toHaveBeenCalled();
  });
});

async function codeChallenge(verifier: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
describe("actual OAuth provider protocol", () => {
  it("uses PKCE, human Access consent and bounded tokens; stale epoch blocks access and refresh", async () => {
    jwks();
    let current = settings();
    const api = createOAuthProvider({
      fetch: async (_request, _env, ctx) => Response.json(ctx.props),
    });
    const call = (path: string, init: RequestInit = {}) =>
      api.fetch(
        new Request(`https://personal.example${path}`, init),
        current,
        createExecutionContext(),
      );
    const registered = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<img src=x>",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const verifier = "a".repeat(43);
    const query = new URLSearchParams({
      client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      scope: "mcp offline_access",
      state: "test-state",
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: "S256",
      resource: "https://personal.example/mcp",
    });
    const consent = await api.fetch(
      await ownerRequest(`/authorize?${query}`),
      current,
      createExecutionContext(),
    );
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("&lt;img");
    const nonce = html.match(/name="nonce" value="([^"]+)"/)![1];
    const approved = await api.fetch(
      await ownerRequest("/authorize", {
        method: "POST",
        headers: {
          Origin: "https://personal.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ nonce }),
      }),
      current,
      createExecutionContext(),
    );
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("test-state");
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      client_id,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      resource: "https://personal.example/mcp",
    });
    const tokenResponse = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    expect(tokenResponse.status).toBe(200);
    let token = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(token.expires_in).toBe(300);
    expect(token.refresh_token).toBeTruthy();
    const mcp = await call("/mcp", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toEqual({
      sub: "owner-subject",
      epoch: "epoch-1",
    });
    const narrowedResponse = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id,
        scope: "offline_access",
      }),
    });
    expect(narrowedResponse.status).toBe(200);
    const narrowed = (await narrowedResponse.json()) as typeof token;
    expect(
      (
        await call("/mcp", {
          headers: { Authorization: `Bearer ${narrowed.access_token}` },
        })
      ).status,
    ).toBe(403);
    token = { ...token, refresh_token: narrowed.refresh_token };
    current = { ...current, INSTALLATION_EPOCH: "epoch-rotated" };
    expect(
      (
        await call("/mcp", {
          headers: { Authorization: `Bearer ${token.access_token}` },
        })
      ).status,
    ).toBe(403);
    const refresh = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id,
      }),
    });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });
  it("refuses metadata URL clients, unsafe redirect registration and unconfigured origin", async () => {
    const api = createOAuthProvider({
      fetch: async () => new Response("protected"),
    });
    const call = (body: unknown, current = settings()) =>
      api.fetch(
        new Request("https://personal.example/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        current,
        createExecutionContext(),
      );
    expect(
      (await call({ redirect_uris: ["http://evil.example/callback"] })).status,
    ).toBe(400);
    expect(
      (await call({ redirect_uris: ["http://localhost:4567/callback"] }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          redirect_uris: ["https://client.example/callback"],
          jwks_uri: "https://attacker.example/keys",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          { redirect_uris: ["https://client.example/callback"] },
          { ...settings(), PUBLIC_ORIGIN: "" },
        )
      ).status,
    ).toBe(403);
    const metadata = await api.fetch(
      new Request(
        "https://personal.example/authorize?client_id=https%3A%2F%2Fattacker.example%2Fmetadata",
      ),
      settings(),
      createExecutionContext(),
    );
    expect(metadata.status).toBe(403);
  });
});

describe("bounded authentication requests", () => {
  it("rejects oversized registration before its JSON reaches the OAuth library", async () => {
    const api = createOAuthProvider({
      fetch: async () => new Response("protected"),
    });
    const response = await api.fetch(
      new Request("https://personal.example/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "x".repeat(17000),
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      settings(),
      createExecutionContext(),
    );
    expect(response.status).toBe(413);
  });
});
