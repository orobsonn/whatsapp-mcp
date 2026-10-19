import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Env } from "../src/env";
import {
  issueSetupNonce,
  consumeSetupNonce,
  requireOwner,
  requireMcpOwner,
} from "../src/auth";
import { setupFetch } from "../src/setup";
const settings = () =>
  ({
    ...env,
    PUBLIC_ORIGIN: "https://personal.example",
    ACCESS_ISSUER: "https://setup.cloudflareaccess.com",
    ACCESS_AUD: "setup-app",
    OWNER_SUB: "owner-setup",
    INSTALLATION_EPOCH: "epoch-setup",
    MAINTENANCE: "true",
    RUNTIME_CONFIG: "database",
    ENCRYPTION_KEY: btoa("k".repeat(32)),
  }) as Env;
let privateKey: CryptoKey, jwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "setup-key",
    alg: "RS256",
  };
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM connection_state").run();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      expect(String(input)).toBe(
        "https://setup.cloudflareaccess.com/cdn-cgi/access/certs",
      );
      return Response.json({ keys: [jwk] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
async function request(
  params?: Record<string, string>,
  options: { origin?: string; sub?: string; type?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: settings().ACCESS_ISSUER,
    aud: settings().ACCESS_AUD,
    sub: options.sub ?? settings().OWNER_SUB,
    iat: now,
    exp: now + 300,
  })
    .setProtectedHeader({ alg: "RS256", kid: "setup-key" })
    .sign(privateKey);
  return new Request("https://personal.example/setup", {
    method: params ? "POST" : "GET",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      ...(params
        ? {
            Origin: options.origin ?? "https://personal.example",
            "Content-Type": options.type ?? "application/x-www-form-urlencoded",
          }
        : {}),
    },
    ...(params ? { body: new URLSearchParams(params) } : {}),
  });
}
describe("private setup owner and CSRF", () => {
  it("allows setup while maintenance is active but leaves MCP/browser confirmation gates closed", async () => {
    const req = await request();
    const nonce = await issueSetupNonce(
      settings(),
      req,
      "connection",
      "epoch-setup:empty",
    );
    expect(nonce).toMatch(/^[a-f0-9]{64}$/);
    await expect(requireOwner(req, settings())).rejects.toThrow();
    expect(() =>
      requireMcpOwner({ sub: "owner-setup", epoch: "epoch-setup" }, settings()),
    ).toThrow();
  });
  it("consumes setup nonce only once with owner, revision and epoch binding", async () => {
    const nonce = await issueSetupNonce(
      settings(),
      await request(),
      "connection",
      "rev-1",
    );
    const params = {
      nonce,
      action: "connect",
      revision: "rev-1",
      instance_token: "never-store-this",
    };
    const accepted = await consumeSetupNonce(
      settings(),
      await request(params),
      "connection",
      "rev-1",
    );
    expect(accepted.get("instance_token")).toBe("never-store-this");
    await expect(
      consumeSetupNonce(
        settings(),
        await request(params),
        "connection",
        "rev-1",
      ),
    ).rejects.toThrow();
    const rows = await env.DB.prepare(
      "SELECT payload_json FROM auth_nonces WHERE purpose='setup'",
    ).all();
    expect(JSON.stringify(rows)).not.toContain("never-store-this");
  });
  it.each([
    { origin: "https://evil.example" },
    { sub: "other-owner" },
    { type: "text/plain" },
  ])("rejects bad origin/owner/content type %o", async (options) => {
    const nonce = await issueSetupNonce(
      settings(),
      await request(),
      "connection",
      "rev-1",
    );
    await expect(
      consumeSetupNonce(
        settings(),
        await request({ nonce }, options),
        "connection",
        "rev-1",
      ),
    ).rejects.toThrow();
  });
  it("rejects stale revision, wrong nonce purpose and oversized body", async () => {
    const nonce = await issueSetupNonce(
      settings(),
      await request(),
      "connection",
      "rev-1",
    );
    await expect(
      consumeSetupNonce(
        settings(),
        await request({ nonce }),
        "connection",
        "rev-2",
      ),
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE auth_nonces SET purpose='send' WHERE purpose='setup'",
    ).run();
    await expect(
      consumeSetupNonce(
        settings(),
        await request({ nonce }),
        "connection",
        "rev-1",
      ),
    ).rejects.toThrow();
    const fresh = await issueSetupNonce(
      settings(),
      await request(),
      "connection",
      "rev-1",
    );
    await expect(
      consumeSetupNonce(
        settings(),
        await request({ nonce: fresh, instance_token: "x".repeat(9000) }),
        "connection",
        "rev-1",
      ),
    ).rejects.toThrow();
  });
  it("renders an empty fresh form with a fixed explanation after invalid credentials", async () => {
    const nonce = await issueSetupNonce(
      settings(),
      await request(),
      "connection",
      "epoch-setup:empty",
    );
    const response = await setupFetch(
      await request({
        nonce,
        revision: "epoch-setup:empty",
        action: "connect",
        instance_id: "invalid value",
        instance_token: "secret-token",
        client_token: "secret-client",
        exclusive_instance: "on",
      }),
      settings(),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("O ID da instância está vazio ou com formato inválido.");
    expect(html).toMatch(/name="nonce" value="[a-f0-9]{64}"/);
    expect(html).not.toMatch(/secret-token|secret-client|invalid value/);
  });
  it("never echoes submitted credentials in errors and refuses unknown/duplicate fields before Z-API", async () => {
    const get = await setupFetch(await request(), settings());
    expect(get.status).toBe(200);
    const html = await get.text(),
      nonce = html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const post = await setupFetch(
      await request({
        nonce,
        revision: "epoch-setup:empty",
        action: "connect",
        instance_id: "secret-instance",
        instance_token: "secret-token",
        client_token: "secret-client",
        exclusive_instance: "on",
        unexpected: "true",
      }),
      settings(),
    );
    expect(post.status).toBe(400);
    expect(await post.text()).not.toMatch(
      /secret-instance|secret-token|secret-client/,
    );
  });
});
