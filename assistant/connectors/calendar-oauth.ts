import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { bridgeHash } from "../ingress";
import type { AssistantEnv } from "../env";

const label = z.string().min(1).max(256), secret = z.string().min(1).max(8192).refine(value => !/[\u0000-\u0020\u007f]/.test(value));
export const oauthAffinity = z.object({ installationId: label, generation: label, configurationVersion: z.number().int().positive(), secretEpoch: label }).strict();
export type OAuthAffinity = z.infer<typeof oauthAffinity>;
const cipher = z.object({ iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/), data: z.string().min(24).max(50000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const tokenState = z.object({ refreshToken: secret, accessToken: secret.optional(), expiresAt: z.number().int().nonnegative().safe().optional(), scope: z.string().max(512).optional() }).strict();
const stored = z.object({ schema: z.literal(1), affinity: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), phase: z.enum(["ready", "attempting", "uncertain", "needs_consent"]),
  attemptId: z.string().uuid().optional(), cipher }).strict();
export type OAuthStored = z.infer<typeof stored>;
type Stored = OAuthStored;
export interface OAuthStore { get(): Promise<unknown>; transaction<T>(action: (store: { get(): Promise<unknown>; put(value: Stored): Promise<void> }) => Promise<T>): Promise<T> }
export type CalendarTokenResult = { state: "ready"; accessToken: string; expiresAt: number } | { state: "pending_configuration" | "needs_consent" | "uncertain" | "unavailable" };
export type CalendarTokenSource = () => Promise<CalendarTokenResult>;
const scopes = new Set(["https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.readonly"]);
export function readonlyCalendarScope(value: string) { const items = value.trim().split(/\s+/); return items.length > 0 && items.every(item => scopes.has(item)); }
export type CalendarPermission = "read_only" | "write_owned";
export const OWNED_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
export function calendarPermissionScope(value: string, permission: CalendarPermission) {
  if (permission === "read_only") return readonlyCalendarScope(value);
  const items = value.trim().split(/\s+/);
  return items.includes(OWNED_CALENDAR_SCOPE) && items.every(item => item === OWNED_CALENDAR_SCOPE || scopes.has(item));
}
const oauthProfile = (permission: CalendarPermission) => permission === "write_owned" ? "calendar-oauth-write-owned-v1" : "calendar-oauth-v1";
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

/** Private credential controller; never exposed as a model tool or public route. */
export class CalendarOAuthBroker {
  private busy = false;
  private readonly affinity: OAuthAffinity;
  private readonly configuration: { clientId: string; clientSecret: string; refreshToken: string; encryptionKey: string };
  constructor(private readonly store: OAuthStore, affinity: OAuthAffinity, configuration: {
    clientId: string; clientSecret: string; refreshToken: string; encryptionKey: string;
  }, private readonly request: (request: Request) => Promise<Response> = request => fetch(request), private readonly clock = Date.now, private readonly permission: CalendarPermission = "read_only") {
    this.affinity = oauthAffinity.parse(affinity);
    this.configuration = z.object({ clientId: secret, clientSecret: secret, refreshToken: secret, encryptionKey: z.string().min(1).max(128) }).strict().parse(configuration);
  }
  private async identity() { return bridgeHash([oauthProfile(this.permission), this.affinity, this.configuration.clientId]); }
  private async cryptography() {
    const bytes = decode(this.configuration.encryptionKey); if (bytes.length !== 32) throw new Error("oauth_key");
    return { key: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]), additionalData: new TextEncoder().encode(await this.identity()) };
  }
  private async seal(value: z.infer<typeof tokenState>) {
    const { key, additionalData } = await this.cryptography(), iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv: encode(iv), data: encode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, new TextEncoder().encode(JSON.stringify(tokenState.parse(value)))))) };
  }
  private async open(value: z.infer<typeof cipher>) {
    const parsed = cipher.parse(value), { key, additionalData } = await this.cryptography();
    return tokenState.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(parsed.iv), additionalData }, key, decode(parsed.data)))));
  }
  private same(left: unknown, right: Stored) { try { return JSON.stringify(stored.parse(left)) === JSON.stringify(stored.parse(right)); } catch { return false; } }
  private async exact(value: Stored) { try { return this.same(await this.store.get(), value); } catch { return false; } }
  private async commit(before: Stored, next: Stored) {
    try { return await this.store.transaction(async store => { if (!this.same(await store.get(), before)) return false; await store.put(next); return true; }); }
    catch { return this.exact(next); }
  }
  async token(): Promise<CalendarTokenResult> {
    if (this.busy) return { state: "unavailable" }; this.busy = true;
    let attempt: Stored | undefined;
    try {
      oauthAffinity.parse(this.affinity); secret.parse(this.configuration.clientId); secret.parse(this.configuration.clientSecret); secret.parse(this.configuration.refreshToken);
      const affinity = await this.identity(); let raw = await this.store.get();
      if (raw === undefined || raw === null) {
        const initial: Stored = { schema: 1, affinity, revision: 1, phase: "ready", cipher: await this.seal({ refreshToken: this.configuration.refreshToken }) };
        try { await this.store.transaction(async store => { if (await store.get() == null) await store.put(initial); }); }
        catch { if (!await this.exact(initial)) return { state: "unavailable" }; }
        raw = await this.store.get();
      }
      const current = stored.parse(raw); if (current.affinity !== affinity) return { state: "unavailable" };
      if (current.phase !== "ready") return { state: current.phase === "needs_consent" ? "needs_consent" : "uncertain" };
      const tokens = await this.open(current.cipher), now = this.clock();
      if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt > now + 60000 && tokens.scope && calendarPermissionScope(tokens.scope, this.permission)) return { state: "ready", accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
      attempt = { ...current, revision: current.revision + 1, phase: "attempting", attemptId: crypto.randomUUID() };
      if (!await this.commit(current, attempt)) return { state: "unavailable" };
      const response = await this.refresh(tokens.refreshToken);
      if (response.status === 400 && z.object({ error: z.literal("invalid_grant") }).safeParse(response.body).success) {
        return await this.commit(attempt, { ...attempt, phase: "needs_consent" }) ? { state: "needs_consent" } : { state: "uncertain" };
      }
      if (response.status !== 200) throw new Error("oauth_response");
      const value = z.object({ access_token: secret, expires_in: z.number().int().min(120).max(86400), token_type: z.literal("Bearer"), scope: z.string().min(1).max(512), refresh_token: secret.optional() }).parse(response.body);
      if (!calendarPermissionScope(value.scope, this.permission)) throw new Error("oauth_scope");
      const expiresAt = now + value.expires_in * 1000;
      if (expiresAt <= this.clock() + 60000) throw new Error("oauth_expired");
      const next: Stored = { ...attempt, revision: attempt.revision + 1, phase: "ready", cipher: await this.seal({ refreshToken: value.refresh_token ?? tokens.refreshToken, accessToken: value.access_token, expiresAt, scope: value.scope }) };
      if (!await this.commit(attempt, next)) return { state: "uncertain" };
      return { state: "ready", accessToken: value.access_token, expiresAt };
    } catch {
      if (attempt) { await this.commit(attempt, { ...attempt, phase: "uncertain" }); return { state: "uncertain" }; }
      return { state: "unavailable" };
    } finally { this.busy = false; }
  }
  private async refresh(refreshToken: string): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("oauth_timeout")); }, 8000); });
    try {
      const response = await Promise.race([this.request(new Request("https://oauth2.googleapis.com/token", { method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: this.configuration.clientId, client_secret: this.configuration.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }) })), deadline]);
      if (![200, 400].includes(response.status) || !response.body) throw new Error("oauth_response");
      reader = response.body.getReader(); let size = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      while (true) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; size += part.value.length; if (size > 16384) throw new Error("oauth_response_limit"); text += decoder.decode(part.value, { stream: true }); }
      return { status: response.status, body: JSON.parse(text + decoder.decode()) };
    } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
}

export function calendarOAuthName(affinity: OAuthAffinity, permission: CalendarPermission = "read_only") { return JSON.stringify([oauthProfile(permission), affinity.installationId, affinity.generation, affinity.configurationVersion, affinity.secretEpoch]); }
export class CalendarOAuth extends DurableObject<AssistantEnv> {
  async token(expected: OAuthAffinity, permission: CalendarPermission = "read_only"): Promise<CalendarTokenResult> {
    if (permission !== (this.env.CALENDAR_OAUTH_PERMISSION ?? "read_only") || !["read_only", "write_owned"].includes(permission)) throw new Error("calendar_oauth_permission");
    const actual = oauthAffinity.parse({ installationId: this.env.INSTALLATION_ID, generation: this.env.OPERATIONAL_GENERATION,
      configurationVersion: Number(this.env.CALENDAR_OAUTH_CONFIGURATION_VERSION), secretEpoch: this.env.CALENDAR_OAUTH_SECRET_EPOCH });
    if (JSON.stringify(oauthAffinity.parse(expected)) !== JSON.stringify(actual)) throw new Error("calendar_oauth_affinity");
    if (!this.env.CALENDAR_OAUTH || this.ctx.id.toString() !== this.env.CALENDAR_OAUTH.idFromName(calendarOAuthName(actual, permission)).toString()) throw new Error("calendar_oauth_instance");
    if (this.env.CALENDAR_OAUTH_CREDENTIAL_GENERATION !== actual.generation) return { state: "pending_configuration" };
    if (!this.env.CALENDAR_OAUTH_CLIENT_ID || !this.env.CALENDAR_OAUTH_CLIENT_SECRET || !this.env.CALENDAR_OAUTH_REFRESH_TOKEN || !this.env.CALENDAR_OAUTH_ENCRYPTION_KEY) return { state: "pending_configuration" };
    return this.ctx.blockConcurrencyWhile(() => new CalendarOAuthBroker({
      get: () => this.ctx.storage.get("credentials"), transaction: action => this.ctx.storage.transaction(store => action({ get: () => store.get("credentials"), put: value => store.put("credentials", value) })),
    }, actual, { clientId: this.env.CALENDAR_OAUTH_CLIENT_ID!, clientSecret: this.env.CALENDAR_OAUTH_CLIENT_SECRET!, refreshToken: this.env.CALENDAR_OAUTH_REFRESH_TOKEN!, encryptionKey: this.env.CALENDAR_OAUTH_ENCRYPTION_KEY! }, undefined, Date.now, permission).token());
  }
  async fetch() { return new Response("forbidden", { status: 403 }); }
}
