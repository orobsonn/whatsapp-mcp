import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  connectConnection,
  retryConnection,
  getConnectionStatus,
  resolveRuntimeEnv,
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
    nullCallbacks?: boolean;
    timeout?: boolean;
    badReadback?: boolean;
    phoneChanged?: boolean;
  } = {},
) {
  let me: Record<string, unknown> = Object.fromEntries(
    callbacks.map((k) => [k, options.nullCallbacks ? null : ""]),
  );
  me.receiveCallbackSentByMe = false;
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
        options.badReadback && writes
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
  it.each([{ foreign: true }, { missing: true }])(
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
it("identifies a missing field without including its value", async () => {
  const p = provider({ missing: true });
  await expect(
    connectConnection(settings(), credentials, p.fetcher),
  ).rejects.toThrow("callback_contract_deliveryCallbackUrl_missing");
  expect(p.puts()).toHaveLength(0);
});
