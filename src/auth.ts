import OAuthProvider, {
  OAuthError,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { confirmationPage } from "./pages";

export interface AuthEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  PUBLIC_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  OWNER_SUB: string;
  INSTALLATION_EPOCH: string;
  MAINTENANCE?: string;
  DEVELOPMENT?: string;
}
export interface OwnerIdentity {
  sub: string;
  epoch: string;
}
export type ConfirmationPurpose =
  | "send"
  | "capture-policy"
  | "retention"
  | "delete"
  | "group";
export interface ConfirmationProposal {
  purpose: ConfirmationPurpose;
  resourceId: string;
  envelope: unknown;
  summary: string;
}
export interface ConfirmationProof extends OwnerIdentity {
  purpose: ConfirmationPurpose;
  resourceId: string;
  envelopeHash: string;
}
export class AuthError extends Error {
  readonly status = 403;
  constructor() {
    super("Acesso ou confirmação recusados.");
  }
}
const denied = () =>
  new Response("Acesso ou confirmação recusados.", {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
const purposes = new Set<string>([
  "send",
  "capture-policy",
  "retention",
  "delete",
  "group",
]);
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const TTL = 600;

function configured(env: AuthEnv): void {
  if (
    !env.OWNER_SUB ||
    !env.INSTALLATION_EPOCH ||
    env.INSTALLATION_EPOCH === "unconfigured" ||
    env.MAINTENANCE !== "false"
  )
    throw new AuthError();
}
function isLoopback(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(host);
}
export function publicOrigin(env: AuthEnv): string {
  if (!env.PUBLIC_ORIGIN) throw new AuthError();
  const url = new URL(env.PUBLIC_ORIGIN);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        env.DEVELOPMENT === "true" &&
        url.protocol === "http:" &&
        isLoopback(url.hostname)
      ))
  )
    throw new AuthError();
  return url.origin;
}
function issuer(env: AuthEnv): string {
  const url = new URL(env.ACCESS_ISSUER);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !env.ACCESS_AUD
  )
    throw new AuthError();
  // Claims must equal the configured string exactly; never derive trust from a JWT claim.
  if (env.ACCESS_ISSUER !== url.origin) throw new AuthError();
  return url.origin;
}
export function requireMcpOwner(props: unknown, env: AuthEnv): OwnerIdentity {
  configured(env);
  if (
    !props ||
    typeof props !== "object" ||
    !("sub" in props) ||
    !("epoch" in props) ||
    props.sub !== env.OWNER_SUB ||
    props.epoch !== env.INSTALLATION_EPOCH
  )
    throw new AuthError();
  return { sub: env.OWNER_SUB, epoch: env.INSTALLATION_EPOCH };
}
/** Only an independently verified Access assertion/cookie authenticates browser actions. */
export async function requireOwner(
  request: Request,
  env: AuthEnv,
): Promise<OwnerIdentity> {
  try {
    configured(env);
    const trustedIssuer = issuer(env);
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("CF_Authorization="))
      ?.slice("CF_Authorization=".length);
    const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie;
    if (!token || token.length > 16384) throw new AuthError();
    let jwks = jwksByIssuer.get(trustedIssuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(
        new URL(`${trustedIssuer}/cdn-cgi/access/certs`),
        { timeoutDuration: 5000 },
      );
      jwksByIssuer.set(trustedIssuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: trustedIssuer,
      audience: env.ACCESS_AUD,
      subject: env.OWNER_SUB,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "aud", "iss"],
    });
    if (payload.type && payload.type !== "app") throw new AuthError();
    return { sub: env.OWNER_SUB, epoch: env.INSTALLATION_EPOCH };
  } catch {
    throw new AuthError();
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  throw new AuthError();
}
async function digest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function hashEnvelope(value: unknown): Promise<string> {
  return digest(canonical(value));
}
async function issueNonce(
  env: AuthEnv,
  owner: OwnerIdentity,
  purpose: string,
  resourceId: string,
  hash: string,
  payload: string | null = null,
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  await env.DB.prepare(
    "INSERT INTO auth_nonces (nonce_hash,sub,epoch,purpose,resource_id,envelope_hash,payload_json,expires_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(
      await digest(nonce),
      owner.sub,
      owner.epoch,
      purpose,
      resourceId,
      hash,
      payload,
      Math.floor(Date.now() / 1000) + TTL,
    )
    .run();
  return nonce;
}
async function postNonce(request: Request, env: AuthEnv): Promise<string> {
  if (
    request.headers.get("Origin") !== publicOrigin(env) ||
    new URL(request.url).origin !== publicOrigin(env) ||
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
      "application/x-www-form-urlencoded"
  )
    throw new AuthError();
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > 512) {
      await reader.cancel();
      throw new AuthError();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const params = new URLSearchParams(new TextDecoder().decode(bytes));
  if (
    params.getAll("nonce").length !== 1 ||
    [...params.keys()].some((key) => key !== "nonce")
  )
    throw new AuthError();
  const nonce = params.get("nonce")!;
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new AuthError();
  return nonce;
}
async function consumeNonce(
  env: AuthEnv,
  nonce: string,
  owner: OwnerIdentity,
  purpose: string,
  resourceId: string,
  hash: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    "UPDATE auth_nonces SET consumed_at=? WHERE nonce_hash=? AND sub=? AND epoch=? AND purpose=? AND resource_id=? AND envelope_hash=? AND expires_at>? AND consumed_at IS NULL RETURNING nonce_hash",
  )
    .bind(
      now,
      await digest(nonce),
      owner.sub,
      owner.epoch,
      purpose,
      resourceId,
      hash,
      now,
    )
    .first();
  if (!result) throw new AuthError();
}

/** The callback receives evidence only after a successful one-time browser confirmation.
 * The caller still atomically validates the resource snapshot/current epoch before effects. */
export async function humanConfirmation(
  request: Request,
  env: AuthEnv,
  proposal: ConfirmationProposal,
  confirmed: (proof: ConfirmationProof) => Promise<Response>,
): Promise<Response> {
  try {
    const owner = await requireOwner(request, env);
    const origin = publicOrigin(env);
    if (
      new URL(request.url).origin !== origin ||
      !purposes.has(proposal.purpose) ||
      !proposal.resourceId ||
      proposal.resourceId.length > 200
    )
      throw new AuthError();
    const envelope = canonical(proposal.envelope);
    if (envelope.length > 32000) throw new AuthError();
    const hash = await digest(envelope);
    if (request.method === "GET") {
      const nonce = await issueNonce(
        env,
        owner,
        proposal.purpose,
        proposal.resourceId,
        hash,
      );
      return confirmationPage({
        title: "Confirmar operação",
        summary: proposal.summary,
        envelope,
        hash,
        nonce,
        action: new URL(request.url).pathname,
      });
    }
    if (request.method !== "POST")
      return new Response("Método não permitido.", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    const nonce = await postNonce(request, env);
    await consumeNonce(
      env,
      nonce,
      owner,
      proposal.purpose,
      proposal.resourceId,
      hash,
    );
    return await confirmed({
      ...owner,
      purpose: proposal.purpose,
      resourceId: proposal.resourceId,
      envelopeHash: hash,
    });
  } catch {
    return denied();
  }
}

function safeRedirect(uri: string, env: AuthEnv): boolean {
  try {
    const url = new URL(uri);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (env.DEVELOPMENT === "true" &&
          url.protocol === "http:" &&
          isLoopback(url.hostname)))
    );
  } catch {
    return false;
  }
}
function validateAuthRequest(auth: AuthRequest, env: AuthEnv): void {
  if (
    !safeRedirect(auth.redirectUri, env) ||
    auth.responseType !== "code" ||
    auth.codeChallengeMethod !== "S256" ||
    !auth.codeChallenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(auth.codeChallenge) ||
    !auth.scope.includes("mcp") ||
    auth.scope.some((scope) => scope !== "mcp" && scope !== "offline_access")
  )
    throw new AuthError();
}
async function authorize(request: Request, env: AuthEnv): Promise<Response> {
  try {
    const oauth = (env as AuthEnv & { OAUTH_PROVIDER: OAuthHelpers })
      .OAUTH_PROVIDER;
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      validateAuthRequest(auth, env);
      const owner = await requireOwner(request, env);
      const client = await oauth.lookupClient(auth.clientId);
      if (!client) throw new AuthError();
      const envelope = canonical(auth);
      const hash = await digest(envelope);
      const nonce = await issueNonce(
        env,
        owner,
        "oauth",
        auth.clientId,
        hash,
        JSON.stringify(auth),
      );
      return confirmationPage({
        title: "Autorizar MCP pessoal",
        summary: `Aplicativo: ${client.clientName || auth.clientId}. Destino: ${auth.redirectUri}. Permissões: ${auth.scope.join(", ")}`,
        envelope,
        hash,
        nonce,
        action: "/authorize",
      });
    }
    if (request.method !== "POST")
      return new Response("Método não permitido.", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    const owner = await requireOwner(request, env);
    const nonce = await postNonce(request, env);
    const row = await env.DB.prepare(
      "SELECT resource_id,envelope_hash,payload_json FROM auth_nonces WHERE nonce_hash=? AND purpose=?",
    )
      .bind(await digest(nonce), "oauth")
      .first<{
        resource_id: string;
        envelope_hash: string;
        payload_json: string;
      }>();
    if (!row) throw new AuthError();
    const auth = JSON.parse(row.payload_json) as AuthRequest;
    validateAuthRequest(auth, env);
    if (
      (await digest(canonical(auth))) !== row.envelope_hash ||
      auth.clientId !== row.resource_id
    )
      throw new AuthError();
    await consumeNonce(
      env,
      nonce,
      owner,
      "oauth",
      row.resource_id,
      row.envelope_hash,
    );
    const { redirectTo } = await oauth.completeAuthorization({
      request: auth,
      userId: encodeURIComponent(owner.sub),
      metadata: {},
      scope: auth.scope,
      props: owner,
    });
    // Redirect sent as an HTTP response, not form navigation. No wildcard CSP for clients.
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectTo,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return denied();
  }
}

/** One Worker: library owns protocol endpoints and bearer validation; Access owns human pages. */
export function createOAuthProvider<E extends AuthEnv>(
  apiHandler: { fetch: NonNullable<ExportedHandler<E>["fetch"]> },
  defaultHandler?: { fetch: NonNullable<ExportedHandler<E>["fetch"]> },
): {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      try {
        const origin = publicOrigin(env);
        if (
          new URL(request.url).origin !== origin ||
          request.url.length > 16384
        )
          return denied();
        const path = new URL(request.url).pathname;
        if (
          (path === "/oauth/register" || path === "/oauth/token") &&
          request.body
        ) {
          const reader = request.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.length;
            if (length > 16384) {
              await reader.cancel();
              return new Response("Requisição grande demais.", { status: 413 });
            }
            chunks.push(next.value);
          }
          const body = new Uint8Array(length);
          let at = 0;
          for (const chunk of chunks) {
            body.set(chunk, at);
            at += chunk.length;
          }
          request = new Request(request, { body });
        }
        const provider = new OAuthProvider<E>({
          apiRoute: "/mcp",
          apiHandler: {
            async fetch(req, bindings, context) {
              requireMcpOwner(context.props, bindings);
              if (
                !(context as OAuthResourceContext<unknown>).auth.scope.includes(
                  "mcp",
                )
              )
                return denied();
              return apiHandler.fetch(req, bindings, context);
            },
          },
          defaultHandler: {
            async fetch(req, bindings, context) {
              if (new URL(req.url).pathname === "/authorize")
                return authorize(req, bindings);
              return defaultHandler
                ? defaultHandler.fetch(req, bindings, context)
                : new Response("Não encontrado.", { status: 404 });
            },
          },
          authorizeEndpoint: `${origin}/authorize`,
          tokenEndpoint: `${origin}/oauth/token`,
          clientRegistrationEndpoint: `${origin}/oauth/register`,
          resourceMetadata: {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
          },
          accessTokenTTL: 300,
          refreshTokenTTL: 86400,
          clientRegistrationTTL: 86400,
          scopesSupported: ["mcp", "offline_access"],
          requiredScopes: ["mcp"],
          allowTokenExchangeGrant: false,
          clientIdMetadataDocumentEnabled: false,
          allowPrivateUseRedirectUris: false,
          clientRegistrationCallback({ clientMetadata }) {
            const redirects = clientMetadata.redirect_uris;
            if (
              !Array.isArray(redirects) ||
              !redirects.length ||
              redirects.length > 10 ||
              redirects.some(
                (uri) => typeof uri !== "string" || !safeRedirect(uri, env),
              ) ||
              clientMetadata.jwks_uri ||
              clientMetadata.sector_identifier_uri ||
              clientMetadata.request_uris ||
              clientMetadata.software_statement
            )
              return {
                code: "invalid_client_metadata",
                description:
                  "Use callbacks HTTPS explícitos; loopback HTTP somente em desenvolvimento.",
              };
          },
          tokenExchangeCallback({ props, env: bindings }) {
            try {
              requireMcpOwner(props, bindings);
            } catch {
              throw new OAuthError("invalid_grant", {
                description: "Autorização expirada ou revogada.",
              });
            }
            return { accessTokenTTL: 300 };
          },
        });
        return await provider.fetch(request, env, ctx);
      } catch {
        return denied();
      }
    },
  };
}
