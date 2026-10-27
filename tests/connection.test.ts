import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  connectConnection,
  retryConnection,
  getConnectionStatus,
  resolveRuntimeEnv,
  updateConnectionClientToken,
} from "../src/connection";
const settings = () =>
  ({
    ...env,
    PUBLIC_ORIGIN: "https://personal.example",
    OWNER_SUB: "owner",
    INSTALLATION_EPOCH: "epoch-setup",
    MAINTENANCE: "false",
    RUNTIME_CONFIG: "database",
    ENCRYPTION_KEY: btoa("k".repeat(32)),
    ZAPI_INSTANCE_ID: "unsafe-fallback",
    ZAPI_TOKEN: "unsafe-fallback",
    WEBHOOK_SECRET: "unsafe-fallback",
  }) as Env;
const credentials = {
  instanceId: "synthetic-instance",
  instanceToken: "synthetic-token",
  clientToken: "synthetic-client",
};
const callbacks = [
  "receivedCallbackUrl",
  "messageStatusCallbackUrl",
  "connectedCallbackUrl",
  "deliveryCallbackUrl",
  "disconnectedCallbackUrl",
  "presenceChatCallbackUrl",
  "initialDataCallbackUrl",
];
function provider(
  options: {
    foreign?: boolean;
    missing?: boolean;
    omitEmpty?: boolean;
    wrongInstance?: boolean;
    omittedReadback?: boolean;
    invalidCallback?: boolean;
    nullCallbacks?: boolean;
    timeout?: boolean;
    badReadback?: boolean;
    phoneChanged?: boolean;
  } = {},
) {
  let me: Record<string, unknown> = Object.fromEntries(
    callbacks.map((k) => [k, options.nullCallbacks ? null : ""]),
  );
  me.id = options.wrongInstance ? "different-instance" : credentials.instanceId;
  me.receiveCallbackSentByMe = false;
  if (options.omitEmpty) {
    for (const k of callbacks) delete me[k];
    delete me.receiveCallbackSentByMe;
  }
  if (options.invalidCallback) me.connectedCallbackUrl = false;
  if (options.foreign) me.connectedCallbackUrl = "https://elo.example/webhook";
  if (options.missing) delete me.deliveryCallbackUrl;
  let writes = 0,
    devices = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).split("/").at(-1)!;
    if (init?.method === "PUT") {
      writes++;
      if (options.timeout && writes === 2) throw new Error("synthetic-token");
      const body = JSON.parse(String(init.body));
      if (
        path === "update-webhook-received" ||
        path === "update-webhook-received-delivery"
      )
        me.receivedCallbackUrl = body.value;
      if (path === "update-webhook-message-status")
        me.messageStatusCallbackUrl = body.value;
      if (path === "update-notify-sent-by-me")
        me.receiveCallbackSentByMe = body.notifySentByMe;
      return Response.json({ value: true });
    }
    if (path === "status") return Response.json({ connected: true });
    if (path === "device")
      return Response.json({
        phone:
          options.phoneChanged && ++devices > 1
            ? "5599999999999"
            : "5511999999999",
      });
    if (path === "me")
      return Response.json(
        options.omittedReadback && writes
          ? { id: credentials.instanceId }
          : options.badReadback && writes
            ? { ...me, receiveCallbackSentByMe: false }
            : me,
      );
    throw Error("unexpected endpoint");
  });
  return {
    fetcher,
    puts: () => fetcher.mock.calls.filter(([, i]) => i?.method === "PUT"),
  };
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM connection_state").run();
});
describe("first connection transaction", () => {
  it("keeps runtime closed until readback, stores only ciphertext, and refuses a second save", async () => {
    expect((await resolveRuntimeEnv(settings())).MAINTENANCE).toBe("true");
    const p = provider();
    const status = await connectConnection(settings(), credentials, p.fetcher);
    expect(status.state).toBe("active");
    const runtime = await resolveRuntimeEnv(settings());
    expect(runtime.ZAPI_TOKEN).toBe(credentials.instanceToken);
    expect(runtime.CONNECTED_PHONE).toBe("5511999999999");
    const row = await env.DB.prepare("SELECT * FROM connection_state").first();
    expect(JSON.stringify(row)).not.toMatch(
      /synthetic-token|synthetic-client|5511999999999|\/webhook\//,
    );
    await expect(
      connectConnection(settings(), credentials, p.fetcher),
    ).rejects.toThrow("connection_exists");
    expect(p.puts()).toHaveLength(4);
  });
  it.each([
    { foreign: true },
    { wrongInstance: true },
    { invalidCallback: true },
  ])(
    "refuses foreign or incomplete callbacks before any PUT %o",
    async (options) => {
      const p = provider(options);
      await expect(
        connectConnection(settings(), credentials, p.fetcher),
      ).rejects.toThrow();
      expect(p.puts()).toHaveLength(0);
      expect((await getConnectionStatus(settings())).state).toBe(
        "unconfigured",
      );
    },
  );
  it("makes concurrent first saves one immutable attempt", async () => {
    const p = provider();
    const results = await Promise.allSettled([
      connectConnection(settings(), credentials, p.fetcher),
      connectConnection(
        settings(),
        { ...credentials, instanceToken: "other-token" },
        p.fetcher,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(p.puts()).toHaveLength(4);
  });
  it("retains uncertain writes as pending; retry reuses exact payload and credentials", async () => {
    const p = provider({ timeout: true });
    const status = await connectConnection(settings(), credentials, p.fetcher);
    expect(status.state).toBe("pending");
    expect((await resolveRuntimeEnv(settings())).MAINTENANCE).toBe("true");
    const before = await env.DB.prepare(
      "SELECT cipher FROM connection_state",
    ).first<{ cipher: string }>();
    await env.DB.prepare("UPDATE connection_state SET lease_until=0").run();
    expect(
      (await retryConnection(settings(), status.attemptId!, p.fetcher)).state,
    ).toBe("active");
    const after = await env.DB.prepare(
      "SELECT cipher FROM connection_state",
    ).first<{ cipher: string }>();
    expect(after).toEqual(before);
    const received = p
      .puts()
      .filter(([u]) => String(u).endsWith("update-webhook-received"));
    expect(received[0][1]?.body).toBe(received[1][1]?.body);
  });
  it.each([{ badReadback: true }, { phoneChanged: true }])(
    "does not activate without matching readback and unchanged phone %o",
    async (options) => {
      const p = provider(options);
      expect(
        (await connectConnection(settings(), credentials, p.fetcher)).state,
      ).toBe("pending");
      expect((await resolveRuntimeEnv(settings())).MAINTENANCE).toBe("true");
    },
  );
  it("permits a human recovery after three transient failures using the same encrypted attempt", async () => {
    const options = { badReadback: true };
    const p = provider(options);
    let status = await connectConnection(settings(), credentials, p.fetcher);
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("UPDATE connection_state SET lease_until=0").run();
      status = await retryConnection(settings(), status.attemptId!, p.fetcher);
      expect(status.state).toBe("pending");
    }
    options.badReadback = false;
    await env.DB.prepare("UPDATE connection_state SET lease_until=0").run();
    expect(
      (await retryConnection(settings(), status.attemptId!, p.fetcher)).state,
    ).toBe("active");
  });
  it("fails closed on ciphertext, epoch or database failure, never returning static secrets", async () => {
    const p = provider();
    await connectConnection(settings(), credentials, p.fetcher);
    for (const altered of [
      { ...settings(), INSTALLATION_EPOCH: "different" },
      { ...settings(), ENCRYPTION_KEY: undefined },
      {
        ...settings(),
        DB: {
          prepare() {
            throw Error("unavailable");
          },
        } as unknown as D1Database,
      },
    ]) {
      const resolved = await resolveRuntimeEnv(altered);
      expect(resolved.MAINTENANCE).toBe("true");
      expect(resolved.ZAPI_TOKEN).toBeUndefined();
    }
    await env.DB.prepare(
      "UPDATE connection_state SET cipher='corrupted'",
    ).run();
    expect((await resolveRuntimeEnv(settings())).MAINTENANCE).toBe("true");
  });
  it("distinguishes temporary runtime failure from inactive configuration for HTTP without changing background consumers", async () => {
    const strict = { failOnUnavailable: true };
    expect((await resolveRuntimeEnv(settings(), strict)).MAINTENANCE).toBe("true");
    await connectConnection(settings(), credentials, provider().fetcher);
    expect((await resolveRuntimeEnv({ ...settings(), INSTALLATION_EPOCH: "revoked" }, strict)).MAINTENANCE).toBe("true");
    const broken = { ...settings(), DB: { prepare() { throw Error("synthetic private DB error"); } } as unknown as D1Database };
    await expect(resolveRuntimeEnv(broken, strict)).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    expect((await resolveRuntimeEnv(broken)).ZAPI_TOKEN).toBeUndefined();
    await env.DB.prepare("UPDATE connection_state SET cipher='corrupted'").run();
    await expect(resolveRuntimeEnv(settings(), strict)).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    expect((await resolveRuntimeEnv(settings())).ZAPI_TOKEN).toBeUndefined();
  });
});

describe("safe provider diagnostics", () => {
  it.each([
    [401, "provider_auth_status"],
    [403, "provider_auth_status"],
    [404, "provider_instance_status"],
    [429, "provider_rate_status"],
    [503, "provider_http_status"],
  ])(
    "identifies HTTP %s without exposing provider content",
    async (status, code) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response("synthetic-secret", { status }),
      );
      await expect(
        connectConnection(settings(), credentials, fetcher),
      ).rejects.toMatchObject({ code });
      expect((await getConnectionStatus(settings())).state).toBe(
        "unconfigured",
      );
    },
  );
  it("identifies the failing read endpoint on network errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/status"))
        return Response.json({ connected: true });
      throw Error("synthetic-secret");
    });
    await expect(
      connectConnection(settings(), credentials, fetcher),
    ).rejects.toMatchObject({ code: "provider_network_device" });
  });
});

it("calls the transport without binding it to the provider instance", async () => {
  const mock = provider();
  const transport: typeof fetch = function (
    this: unknown,
    ...args: Parameters<typeof fetch>
  ) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    return mock.fetcher(...args);
  };
  await expect(
    connectConnection(settings(), credentials, transport),
  ).resolves.toMatchObject({ state: "active" });
});

it("accepts explicit null callbacks but requires configured URLs in readback", async () => {
  const p = provider({ nullCallbacks: true });
  await expect(
    connectConnection(settings(), credentials, p.fetcher),
  ).resolves.toMatchObject({ state: "active" });
});
it("still protects foreign callbacks among explicit nulls", async () => {
  const p = provider({ nullCallbacks: true, foreign: true });
  await expect(
    connectConnection(settings(), credentials, p.fetcher),
  ).rejects.toThrow("instance_in_use");
  expect(p.puts()).toHaveLength(0);
});
it("accepts empty callbacks omitted by the real provider representation", async () => {
  const p = provider({ omitEmpty: true });
  await expect(
    connectConnection(settings(), credentials, p.fetcher),
  ).resolves.toMatchObject({ state: "active" });
});
it("does not activate when the readback omits required configured callbacks", async () => {
  const p = provider({ omittedReadback: true });
  await expect(
    connectConnection(settings(), credentials, p.fetcher),
  ).resolves.toMatchObject({ state: "pending" });
  expect((await resolveRuntimeEnv(settings())).MAINTENANCE).toBe("true");
});

it("accepts surrounding clipboard whitespace without changing credential contents", async () => {
  const p = provider();
  await expect(
    connectConnection(
      settings(),
      {
        instanceId: "  synthetic-instance\n",
        instanceToken: "\tsynthetic-token ",
        clientToken: " synthetic-client\n",
      },
      p.fetcher,
    ),
  ).resolves.toMatchObject({ state: "active" });
  expect(String(p.fetcher.mock.calls[0][0])).toContain(
    "/synthetic-instance/token/synthetic-token/status",
  );
  expect(
    new Headers(p.fetcher.mock.calls[0][1]?.headers).get("Client-Token"),
  ).toBe("synthetic-client");
});
it("accepts visible header-token punctuation but blocks embedded whitespace", async () => {
  const p = provider();
  await expect(
    connectConnection(
      settings(),
      { ...credentials, clientToken: "synthetic.client+token/=" },
      p.fetcher,
    ),
  ).resolves.toMatchObject({ state: "active" });
  await env.DB.prepare("DELETE FROM connection_state").run();
  await expect(
    connectConnection(
      settings(),
      { ...credentials, clientToken: "synthetic\nclient" },
      p.fetcher,
    ),
  ).rejects.toThrow("invalid_credentials_clientToken");
});

describe("active Client-Token renewal", () => {
  async function active() {
    await connectConnection(settings(), credentials, provider().fetcher);
    return getConnectionStatus(settings());
  }
  const snapshot = () =>
    env.DB.prepare(
      "SELECT cipher,version,state,attempt_id FROM connection_state WHERE id=1",
    ).first();
  it("validates read-only and changes only the encrypted Client-Token", async () => {
    const before = await active(),
      old = await resolveRuntimeEnv(settings()),
      saved = await snapshot();
    const p = provider();
    const result = await updateConnectionClientToken(
      settings(),
      " new-client-token ",
      before.revision,
      p.fetcher,
    );
    expect(result.state).toBe("active");
    expect(result.revision).not.toBe(before.revision);
    expect(await resolveRuntimeEnv(settings())).toEqual({
      ...old,
      ZAPI_CLIENT_TOKEN: "new-client-token",
    });
    expect(
      p.fetcher.mock.calls.map(([u]) => String(u).split("/").at(-1)),
    ).toEqual(["status", "device"]);
    expect(p.puts()).toHaveLength(0);
    for (const [, init] of p.fetcher.mock.calls)
      expect(new Headers(init?.headers).get("Client-Token")).toBe(
        "new-client-token",
      );
    const updated = await snapshot();
    expect(updated).not.toEqual(saved);
    expect(JSON.stringify(updated)).not.toMatch(
      /new-client-token|synthetic-client/,
    );
  });
  it.each(["auth", "phone", "network", "redirect", "invalid"])(
    "preserves saved connection on %s failure",
    async (failure) => {
      const status = await active(),
        before = await snapshot();
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        if (failure === "auth")
          return new Response("private-provider-body", { status: 401 });
        if (failure === "network") throw Error("new-client-token");
        if (failure === "redirect")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://other.example" },
          });
        if (failure === "invalid") return Response.json([]);
        return Response.json(
          String(input).endsWith("/status")
            ? { connected: true }
            : { phone: "5599999999999" },
        );
      });
      await expect(
        updateConnectionClientToken(
          settings(),
          "new-client-token",
          status.revision,
          fetcher,
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect((await resolveRuntimeEnv(settings())).ZAPI_CLIENT_TOKEN).toBe(
        credentials.clientToken,
      );
    },
  );
  it("rejects a stale form and malformed token before contacting the provider", async () => {
    const status = await active(),
      p = provider();
    await expect(
      updateConnectionClientToken(
        settings(),
        "new-client-token",
        "old-revision",
        p.fetcher,
      ),
    ).rejects.toMatchObject({ code: "connection_changed" });
    await expect(
      updateConnectionClientToken(
        settings(),
        "bad\ntoken",
        status.revision,
        p.fetcher,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials_clientToken" });
    expect(p.fetcher).not.toHaveBeenCalled();
  });
  it("allows only one concurrent renewal to replace the same revision", async () => {
    const status = await active();
    let started = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/status")) {
        if (++started === 2) release();
        await barrier;
        return Response.json({ connected: true });
      }
      return Response.json({ phone: "5511999999999" });
    });
    const results = await Promise.allSettled([
      updateConnectionClientToken(
        settings(),
        "new-token-one",
        status.revision,
        fetcher,
      ),
      updateConnectionClientToken(
        settings(),
        "new-token-two",
        status.revision,
        fetcher,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "connection_changed" });
  });
});
