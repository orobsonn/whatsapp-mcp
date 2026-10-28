import { beforeEach, expect, test, vi } from "vitest";
import { CalendarOAuthBroker, calendarOAuthName, type OAuthAffinity, type OAuthStore, type OAuthStored } from "../assistant/connectors/calendar-oauth";

class Store implements OAuthStore {
  value: unknown;
  writes: OAuthStored[] = [];
  failure?: { phase: string; mode: "ack" | "rollback" };
  private tail = Promise.resolve();
  async get() { return structuredClone(this.value); }
  async transaction<T>(action: (store: { get(): Promise<unknown>; put(value: OAuthStored): Promise<void> }) => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void; this.tail = new Promise(resolve => { release = resolve; }); await previous;
    let staged = structuredClone(this.value), written: OAuthStored | undefined;
    try {
      const result = await action({ get: async () => structuredClone(staged), put: async value => { staged = structuredClone(value); written = value; } });
      const failure = written && this.failure?.phase === written.phase && written.revision > 1 ? this.failure : undefined;
      if (failure) this.failure = undefined;
      if (failure?.mode === "rollback") throw new Error("synthetic-storage-rollback");
      this.value = staged; if (written) this.writes.push(structuredClone(written));
      if (failure?.mode === "ack") throw new Error("synthetic-ack-lost");
      return result;
    } finally { release(); }
  }
}
const affinity: OAuthAffinity = { installationId: "synthetic-install", generation: "synthetic-g", configurationVersion: 1, secretEpoch: "secret-one" };
const scope = "https://www.googleapis.com/auth/calendar.events.readonly";
const configuration = () => ({ clientId: "synthetic-client", clientSecret: "synthetic-client-secret", refreshToken: "synthetic-refresh-secret", encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) });
const response = (extra: Record<string, unknown> = {}) => Response.json({ access_token: "synthetic-access-secret", expires_in: 3600, token_type: "Bearer", scope, ...extra });
let store: Store, now: number;
beforeEach(() => { store = new Store(); now = 1000; });
test("refresh uses only the fixed OAuth POST and commits encrypted credentials before returning host-only access", async () => {
  const requests: Request[] = [];
  const broker = new CalendarOAuthBroker(store, affinity, configuration(), async request => { requests.push(request); expect(await store.get()).toMatchObject({ phase: "attempting" }); return response(); }, () => now);
  expect(await broker.token()).toEqual({ state: "ready", accessToken: "synthetic-access-secret", expiresAt: 3601000 });
  expect(await store.get()).toMatchObject({ phase: "ready", revision: 3 }); expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://oauth2.googleapis.com/token"); expect(requests[0].method).toBe("POST"); expect(requests[0].redirect).toBe("manual");
  const form = new URLSearchParams(await requests[0].text()); expect([...form.keys()].sort()).toEqual(["client_id", "client_secret", "grant_type", "refresh_token"]);
  expect(form.get("grant_type")).toBe("refresh_token"); expect(form.get("refresh_token")).toBe("synthetic-refresh-secret");
  for (const secret of ["synthetic-access-secret", "synthetic-refresh-secret", "synthetic-client-secret", configuration().encryptionKey]) expect(JSON.stringify(store.writes)).not.toContain(secret);
});
test("cache survives broker restart and expiry refresh preserves the rotated durable token", async () => {
  const requests: Request[] = [], request = async (request: Request) => { requests.push(request); return response(requests.length === 1 ? { refresh_token: "synthetic-rotated-secret" } : { access_token: "synthetic-second-access" }); };
  expect((await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).state).toBe("ready");
  expect((await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).state).toBe("ready"); expect(requests).toHaveLength(1);
  now = 3601000;
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toMatchObject({ state: "ready", accessToken: "synthetic-second-access" });
  expect(requests).toHaveLength(2); expect(new URLSearchParams(await requests[1].text()).get("refresh_token")).toBe("synthetic-rotated-secret");
});
test("one durable claim wins concurrent brokers and an attempting restart never repeats POST", async () => {
  let finish!: (response: Response) => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), request = vi.fn(() => { began(); return new Promise<Response>(resolve => { finish = resolve; }); });
  const broker = new CalendarOAuthBroker(store, affinity, configuration(), request, () => now), pending = broker.token(); await started;
  expect(await broker.token()).toEqual({ state: "unavailable" });
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "uncertain" });
  expect(request).toHaveBeenCalledTimes(1); finish(response()); expect((await pending).state).toBe("ready");
});
test.each(["attempting", "ready"])("lost %s commit ACK reconciles the exact durable state with zero duplicate refresh", async phase => {
  store.failure = { phase, mode: "ack" }; const request = vi.fn(async () => response({ refresh_token: "synthetic-rotated-secret" }));
  expect((await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).state).toBe("ready");
  expect((await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).state).toBe("ready"); expect(request).toHaveBeenCalledTimes(1);
});
test("a failed durable rotated-token commit exposes no access token and cannot retry on restart", async () => {
  store.failure = { phase: "ready", mode: "rollback" }; const request = vi.fn(async () => response({ refresh_token: "synthetic-rotated-secret" }));
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "uncertain" });
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "uncertain" }); expect(request).toHaveBeenCalledTimes(1);
});
test("a failed attempt admission performs zero OAuth requests", async () => {
  store.failure = { phase: "attempting", mode: "rollback" }; const request = vi.fn(async () => response());
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "unavailable" }); expect(request).not.toHaveBeenCalled();
});
test.each(["write_scope", "missing_scope", "other_scope", "wrong_type", "short_expiry", "malformed", "redirect", "network", "wrong_http_invalid_grant"])("%s remains uncertain and never retries the token endpoint", async kind => {
  const request = vi.fn(async () => {
    if (kind === "network") throw new Error("synthetic-private-network");
    if (kind === "redirect") return new Response(null, { status: 302, headers: { Location: "https://private.invalid" } });
    if (kind === "malformed") return new Response("synthetic-private-malformed");
    if (kind === "wrong_http_invalid_grant") return Response.json({ error: "invalid_grant" }, { status: 401 });
    return response(kind === "write_scope" ? { scope: "https://www.googleapis.com/auth/calendar" } : kind === "missing_scope" ? { scope: undefined } : kind === "other_scope" ? { scope: scope + " https://www.googleapis.com/auth/drive.readonly" } : kind === "wrong_type" ? { token_type: "DPoP" } : { expires_in: 10 });
  });
  const result = await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token();
  expect(result).toEqual({ state: "uncertain" }); expect(JSON.stringify(result)).not.toContain("private");
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "uncertain" }); expect(request).toHaveBeenCalledTimes(1);
});
test("only a valid invalid_grant response becomes needs_consent without leaking provider descriptions", async () => {
  const request = vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "synthetic-private-description" }, { status: 400 }));
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "needs_consent" });
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "needs_consent" }); expect(request).toHaveBeenCalledTimes(1);
});
test("ciphertext is bound to installation/generation/configuration/client/secret epoch and key", async () => {
  const request = vi.fn(async () => response()); await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token();
  for (const changed of [{ ...affinity, installationId: "other" }, { ...affinity, generation: "other" }, { ...affinity, configurationVersion: 2 }, { ...affinity, secretEpoch: "other" }]) expect(await new CalendarOAuthBroker(store, changed, configuration(), request, () => now).token()).toEqual({ state: "unavailable" });
  expect(await new CalendarOAuthBroker(store, affinity, { ...configuration(), clientId: "other" }, request, () => now).token()).toEqual({ state: "unavailable" });
  expect(await new CalendarOAuthBroker(store, affinity, { ...configuration(), encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(8))) }, request, () => now).token()).toEqual({ state: "unavailable" });
  expect(request).toHaveBeenCalledTimes(1); expect(calendarOAuthName(affinity)).not.toContain("secret-client");
});
test("malformed credential state cannot bootstrap over or disclose the old state", async () => {
  store.value = { phase: "ready", cipher: { data: "synthetic-private-invalid" } }; const request = vi.fn(async () => response());
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "unavailable" }); expect(request).not.toHaveBeenCalled(); expect(store.writes).toHaveLength(0);
});

test("owned write grant requires positive owned scope and cannot reuse readonly ciphertext", async () => {
  const owned = "https://www.googleapis.com/auth/calendar.events.owned";
  const request = vi.fn(async () => response({ scope: owned }));
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now, "write_owned").token()).toMatchObject({ state: "ready" });
  expect(await new CalendarOAuthBroker(store, affinity, configuration(), request, () => now).token()).toEqual({ state: "unavailable" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(calendarOAuthName(affinity, "write_owned")).not.toBe(calendarOAuthName(affinity));
  const readonlyStore = new Store(), readonlyRequest = vi.fn(async () => response());
  await new CalendarOAuthBroker(readonlyStore, affinity, configuration(), readonlyRequest, () => now).token();
  expect(await new CalendarOAuthBroker(readonlyStore, affinity, configuration(), request, () => now, "write_owned").token()).toEqual({ state: "unavailable" });
  expect(request).toHaveBeenCalledTimes(1);
});
test("write profile rejects readonly-only and unrelated expanded grants without retry", async () => {
  for (const invalidScope of [scope, "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/drive.readonly"]) {
    const isolated = new Store(), request = vi.fn(async () => response({ scope: invalidScope }));
    expect(await new CalendarOAuthBroker(isolated, affinity, configuration(), request, () => now, "write_owned").token()).toEqual({ state: "uncertain" });
    expect(await new CalendarOAuthBroker(isolated, affinity, configuration(), request, () => now, "write_owned").token()).toEqual({ state: "uncertain" });
    expect(request).toHaveBeenCalledTimes(1);
  }
});
