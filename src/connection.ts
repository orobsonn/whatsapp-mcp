import type { Env } from "./env";
import { publicOrigin } from "./auth";
import { AppError, readBounded } from "./core";

export interface ConnectionStatus {
  state: "unconfigured" | "pending" | "active" | "unavailable";
  revision: string;
  attemptId?: string;
  error?: string;
}
export interface ConnectionCredentials {
  instanceId: string;
  instanceToken: string;
  clientToken: string;
}
interface ConnectionPayload extends ConnectionCredentials {
  phone: string;
  generation: string;
  webhookSecret: string;
}
interface ConnectionRow {
  epoch: string;
  cipher: string;
  state: "pending" | "active";
  attempt_id: string;
  version: number;
  attempts: number;
  error: string | null;
}
const CALLBACKS = [
  "receivedCallbackUrl",
  "messageStatusCallbackUrl",
  "connectedCallbackUrl",
  "deliveryCallbackUrl",
  "disconnectedCallbackUrl",
  "presenceChatCallbackUrl",
  "initialDataCallbackUrl",
] as const;
const LEASE_MS = 120_000;
const fail = (code: string, status = 409): never => {
  throw new AppError(code, status);
};
const random = (size: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(size)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
function configured(env: Env): void {
  if (
    !env.OWNER_SUB ||
    !env.INSTALLATION_EPOCH ||
    env.INSTALLATION_EPOCH === "unconfigured" ||
    !env.DB
  )
    fail("setup_unavailable", 503);
  publicOrigin(env);
}
function credentialsValid(c: ConnectionCredentials): void {
  for (const field of ["instanceId", "instanceToken", "clientToken"] as const) {
    const value = c[field];
    const valid =
      field === "clientToken" ? /^[\x21-\x7e]+$/ : /^[A-Za-z0-9_-]+$/;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 512 ||
      !valid.test(value)
    )
      fail(`invalid_credentials_${field}`, 400);
  }
}

async function key(env: Env): Promise<CryptoKey> {
  try {
    if (!env.ENCRYPTION_KEY || !/^[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEY))
      throw Error();
    const bytes = Uint8Array.from(atob(env.ENCRYPTION_KEY), (x) =>
      x.charCodeAt(0),
    );
    if (bytes.length !== 32) throw Error();
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    return fail("setup_unavailable", 503);
  }
}
const aad = (env: Env) =>
  new TextEncoder().encode(
    JSON.stringify([
      "whatsapp-mcp/connection/v1",
      publicOrigin(env),
      env.INSTALLATION_EPOCH,
    ]),
  );
async function encrypt(env: Env, payload: ConnectionPayload): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(env) },
    await key(env),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}
async function decrypt(env: Env, cipher: string): Promise<ConnectionPayload> {
  try {
    const parts = cipher.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw Error();
    const iv = Uint8Array.from(atob(parts[1]!), (x) => x.charCodeAt(0));
    if (iv.length !== 12) throw Error();
    const bytes = Uint8Array.from(atob(parts[2]!), (x) => x.charCodeAt(0));
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad(env) },
      await key(env),
      bytes,
    );
    const p = JSON.parse(new TextDecoder().decode(clear)) as ConnectionPayload;
    credentialsValid(p);
    if (
      !/^\d{8,16}$/.test(p.phone) ||
      !/^[a-f0-9]{32}$/.test(p.generation) ||
      !/^[a-f0-9]{64}$/.test(p.webhookSecret)
    )
      throw Error();
    return p;
  } catch {
    return fail("setup_unavailable", 503);
  }
}
async function row(env: Env): Promise<ConnectionRow | null> {
  return env.DB.prepare(
    "SELECT epoch,cipher,state,attempt_id,version,attempts,error FROM connection_state WHERE id=1",
  ).first<ConnectionRow>();
}
function statusOf(env: Env, r: ConnectionRow | null): ConnectionStatus {
  if (!r)
    return {
      state: "unconfigured",
      revision: `${env.INSTALLATION_EPOCH}:empty`,
    };
  if (r.epoch !== env.INSTALLATION_EPOCH)
    return { state: "unavailable", revision: "unavailable" };
  return {
    state: r.state,
    revision: `${r.epoch}:${r.attempt_id}:${r.version}:${r.state}`,
    attemptId: r.attempt_id,
    ...(r.error ? { error: r.error } : {}),
  };
}
export async function getConnectionStatus(env: Env): Promise<ConnectionStatus> {
  try {
    configured(env);
    await key(env);
    const r = await row(env);
    if (r) await decrypt(env, r.cipher);
    return statusOf(env, r);
  } catch {
    return {
      state: "unavailable",
      revision: "unavailable",
      error: "setup_unavailable",
    };
  }
}
/** Production uses database mode. Missing/corrupt connection always removes provider secrets. */
export async function resolveRuntimeEnv(env: Env): Promise<Env> {
  if (env.RUNTIME_CONFIG === "static" && env.DEVELOPMENT === "true")
    return { ...env };
  const closed = {
    ...env,
    MAINTENANCE: "true",
    ZAPI_INSTANCE_ID: undefined,
    ZAPI_INSTANCE_TOKEN: undefined,
    ZAPI_TOKEN: undefined,
    ZAPI_CLIENT_TOKEN: undefined,
    WEBHOOK_SECRET: undefined,
    CONNECTION_GENERATION: "unconfigured",
    CONNECTED_PHONE: "",
  };
  try {
    configured(env);
    const r = await row(env);
    if (!r || r.state !== "active" || r.epoch !== env.INSTALLATION_EPOCH)
      return closed;
    const p = await decrypt(env, r.cipher);
    return {
      ...closed,
      MAINTENANCE: env.MAINTENANCE,
      ZAPI_INSTANCE_ID: p.instanceId,
      ZAPI_INSTANCE_TOKEN: p.instanceToken,
      ZAPI_TOKEN: p.instanceToken,
      ZAPI_CLIENT_TOKEN: p.clientToken,
      WEBHOOK_SECRET: p.webhookSecret,
      CONNECTION_GENERATION: p.generation,
      CONNECTED_PHONE: p.phone,
    };
  } catch {
    return closed;
  }
}
/** Host-only mutation fence. The provider Env may have been decrypted before
 * an await; recheck it against the current cipher and pin that exact DB row.
 * No credential or cipher leaves the host through a tool result. */
export async function runtimeConnectionGuard(env:Env):Promise<{sql:string;values:(string|number|null)[]}> {
  if(env.RUNTIME_CONFIG==='static'&&env.DEVELOPMENT==='true')return {sql:'NOT EXISTS(SELECT 1 FROM connection_state WHERE id=1)',values:[]};
  configured(env);const saved=await row(env);
  if(!saved||saved.state!=='active'||saved.epoch!==env.INSTALLATION_EPOCH||!Number.isSafeInteger(saved.version)||saved.version<1)throw new AppError('connection_changed',409);
  const current=await decrypt(env,saved.cipher);
  if(current.generation!==env.CONNECTION_GENERATION||current.phone!==env.CONNECTED_PHONE||current.instanceId!==env.ZAPI_INSTANCE_ID||current.instanceToken!==env.ZAPI_TOKEN||current.clientToken!==env.ZAPI_CLIENT_TOKEN)throw new AppError('connection_changed',409);
  return {sql:"EXISTS(SELECT 1 FROM connection_state WHERE id=1 AND epoch=? AND state='active' AND attempt_id=? AND version=? AND cipher=?)",values:[saved.epoch,saved.attempt_id,saved.version,saved.cipher]};
}
class SetupProvider {
  constructor(
    private c: ConnectionCredentials,
    private fetcher: typeof fetch,
  ) {}
  async request(
    path:
      | "status"
      | "device"
      | "me"
      | "update-webhook-received"
      | "update-webhook-received-delivery"
      | "update-webhook-message-status"
      | "update-notify-sent-by-me",
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(
        `https://api.z-api.io/instances/${encodeURIComponent(this.c.instanceId)}/token/${encodeURIComponent(this.c.instanceToken)}/${path}`,
        {
          method: body ? "PUT" : "GET",
          headers: {
            "Client-Token": this.c.clientToken,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          redirect: "manual",
          signal: controller.signal,
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!response.ok) {
        const reason = [401, 403].includes(response.status)
          ? "auth"
          : response.status === 404
            ? "instance"
            : response.status === 429
              ? "rate"
              : "http";
        return fail(`provider_${reason}_${path}`, 502);
      }
      const bytes = await readBounded(response, 65536);
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error();
      return data;
    } catch (error) {
      if (error instanceof AppError && error.code.startsWith("provider_"))
        throw error;
      return fail(`provider_network_${path}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }
  async phone(): Promise<string> {
    if ((await this.request("status")).connected !== true)
      return fail("device_not_connected");
    const p = (await this.request("device")).phone;
    if (typeof p !== "string" || !/^\d{8,16}$/.test(p))
      return fail("device_not_connected");
    return p;
  }
}
function webhook(env: Env, p: ConnectionPayload): string {
  return `${publicOrigin(env)}/webhook/${p.generation}/${p.webhookSecret}`;
}
function validateCallbacks(
  me: Record<string, unknown>,
  url: string,
  instanceId: string,
): void {
  if (me.id !== instanceId) fail("provider_instance_mismatch");
  for (const field of CALLBACKS) {
    const value = me[field];
    // Z-API omits unconfigured optional callbacks in its live representation.
    if (!Object.hasOwn(me, field) || value === null) continue;
    if (typeof value !== "string" || value.length > 2048) {
      const type = !Object.hasOwn(me, field)
        ? "missing"
        : typeof value === "string"
          ? "long_string"
          : "invalid_type";
      fail(`callback_contract_${field}_${type}`);
    }
    if (value !== "" && value !== url) fail("instance_in_use");
  }
  if (
    Object.hasOwn(me, "receiveCallbackSentByMe") &&
    typeof me.receiveCallbackSentByMe !== "boolean"
  )
    fail(
      `callback_contract_receiveCallbackSentByMe_${Object.hasOwn(me, "receiveCallbackSentByMe") ? "invalid_type" : "missing"}`,
    );
}
async function runAttempt(
  env: Env,
  r: ConnectionRow,
  p: ConnectionPayload,
  fetcher: typeof fetch,
): Promise<ConnectionStatus> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE connection_state SET lease_until=?,attempts=attempts+1,version=version+1,error=NULL,updated_at=? WHERE id=1 AND epoch=? AND state='pending' AND attempt_id=? AND cipher=? AND version=? AND lease_until<=? RETURNING version",
  )
    .bind(
      now + LEASE_MS,
      now,
      env.INSTALLATION_EPOCH,
      r.attempt_id,
      r.cipher,
      r.version,
      now,
    )
    .first<{ version: number }>();
  if (!claim) return fail("connection_busy");
  const version = claim.version,
    provider = new SetupProvider(p, fetcher),
    url = webhook(env, p);
  async function checkpoint(step: string): Promise<void> {
    const checked = await env.DB.prepare(
      "UPDATE connection_state SET step=?,updated_at=? WHERE id=1 AND epoch=? AND state='pending' AND attempt_id=? AND cipher=? AND version=? AND lease_until>? RETURNING id",
    )
      .bind(
        step,
        Date.now(),
        env.INSTALLATION_EPOCH,
        r.attempt_id,
        r.cipher,
        version,
        Date.now(),
      )
      .first();
    if (!checked) fail("connection_busy");
  }
  try {
    await checkpoint("preflight");
    if ((await provider.phone()) !== p.phone) fail("device_changed");
    validateCallbacks(await provider.request("me"), url, p.instanceId);
    const updates = [
      ["update-webhook-received", { value: url }],
      ["update-webhook-received-delivery", { value: url }],
      ["update-webhook-message-status", { value: url }],
      ["update-notify-sent-by-me", { notifySentByMe: true }],
    ] as const;
    for (const [path, body] of updates) {
      await checkpoint(path);
      await provider.request(path, body);
    }
    await checkpoint("readback");
    const me = await provider.request("me");
    validateCallbacks(me, url, p.instanceId);
    if (
      me.receivedCallbackUrl !== url ||
      me.messageStatusCallbackUrl !== url ||
      me.receiveCallbackSentByMe !== true
    )
      fail("callback_verification_pending");
    if ((await provider.phone()) !== p.phone) fail("device_changed");
    await checkpoint("activating");
    const activated = await env.DB.prepare(
      "UPDATE connection_state SET state='active',step='complete',lease_until=0,error=NULL,updated_at=?,version=version+1 WHERE id=1 AND epoch=? AND state='pending' AND attempt_id=? AND cipher=? AND version=? AND lease_until>? RETURNING id",
    )
      .bind(
        Date.now(),
        env.INSTALLATION_EPOCH,
        r.attempt_id,
        r.cipher,
        version,
        Date.now(),
      )
      .first();
    if (!activated) fail("connection_busy");
  } catch (error) {
    const code = error instanceof AppError ? error.code : "setup_unavailable";
    await env.DB.prepare(
      "UPDATE connection_state SET error=?,lease_until=?,updated_at=? WHERE id=1 AND epoch=? AND state='pending' AND attempt_id=? AND version=?",
    )
      .bind(
        code,
        Date.now() + 30_000,
        Date.now(),
        env.INSTALLATION_EPOCH,
        r.attempt_id,
        version,
      )
      .run();
  }
  return getConnectionStatus(env);
}
export async function connectConnection(
  env: Env,
  c: ConnectionCredentials,
  fetcher: typeof fetch = fetch,
): Promise<ConnectionStatus> {
  configured(env);
  c = {
    instanceId: c.instanceId.trim(),
    instanceToken: c.instanceToken.trim(),
    clientToken: c.clientToken.trim(),
  };
  credentialsValid(c);
  await key(env);
  if (await row(env)) return fail("connection_exists");
  const provider = new SetupProvider(c, fetcher);
  const p: ConnectionPayload = {
    ...c,
    phone: await provider.phone(),
    generation: random(16),
    webhookSecret: random(32),
  };
  validateCallbacks(
    await provider.request("me"),
    webhook(env, p),
    p.instanceId,
  );
  const cipher = await encrypt(env, p),
    attemptId = random(16),
    now = Date.now();
  const inserted = await env.DB.prepare(
    "INSERT INTO connection_state (id,epoch,cipher,state,attempt_id,step,created_at,updated_at) VALUES (1,?,?,'pending',?,'saved',?,?) ON CONFLICT(id) DO NOTHING RETURNING id",
  )
    .bind(env.INSTALLATION_EPOCH, cipher, attemptId, now, now)
    .first();
  if (!inserted) return fail("connection_exists");
  return runAttempt(env, (await row(env))!, p, fetcher);
}
export async function retryConnection(
  env: Env,
  attemptId: string,
  fetcher: typeof fetch = fetch,
): Promise<ConnectionStatus> {
  configured(env);
  const r = await row(env);
  if (
    !r ||
    r.state !== "pending" ||
    r.epoch !== env.INSTALLATION_EPOCH ||
    r.attempt_id !== attemptId
  )
    return fail("connection_not_pending");
  return runAttempt(env, r, await decrypt(env, r.cipher), fetcher);
}

/** Renew only the account header token; never reprovision the installation. */
export async function updateConnectionClientToken(
  env: Env,
  clientToken: string,
  expectedRevision: string,
  fetcher: typeof fetch = fetch,
): Promise<ConnectionStatus> {
  configured(env);
  const saved = await row(env);
  if (
    !saved ||
    saved.state !== "active" ||
    saved.epoch !== env.INSTALLATION_EPOCH ||
    statusOf(env, saved).revision !== expectedRevision
  )
    return fail("connection_changed");
  const previous = await decrypt(env, saved.cipher);
  const next = { ...previous, clientToken: clientToken.trim() };
  credentialsValid(next);
  const provider = new SetupProvider(next, fetcher);
  if ((await provider.phone()) !== previous.phone)
    return fail("provider_device_mismatch");
  const cipher = await encrypt(env, next);
  const updated = await env.DB.prepare(
    "UPDATE connection_state SET cipher=?,version=version+1,updated_at=? WHERE id=1 AND epoch=? AND state='active' AND attempt_id=? AND version=? AND cipher=? RETURNING id",
  )
    .bind(
      cipher,
      Date.now(),
      saved.epoch,
      saved.attempt_id,
      saved.version,
      saved.cipher,
    )
    .first();
  if (!updated) return fail("connection_changed");
  return getConnectionStatus(env);
}
