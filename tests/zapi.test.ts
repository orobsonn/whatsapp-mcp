import { describe, expect, it, vi } from "vitest";
import { ProviderUncertainError, ZapiClient, ZapiError } from "../src/zapi";

const env = {
  ZAPI_INSTANCE_ID: "inst/1",
  ZAPI_TOKEN: "secret/token",
  ZAPI_CLIENT_TOKEN: "client-secret",
  CONNECTED_PHONE: "5511999999999",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const client = (fetcher: typeof fetch) => new ZapiClient(env, fetcher);

describe("Z-API transport", () => {
  it("fetches status and device identity separately", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ connected: true, smartphoneConnected: true }),
      )
      .mockResolvedValueOnce(json({ phone: "5511999999999" }));
    expect(await client(fetcher).status()).toEqual({
      connected: true,
      phone: "5511999999999",
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.z-api.io/instances/inst%2F1/token/secret%2Ftoken/status",
      "https://api.z-api.io/instances/inst%2F1/token/secret%2Ftoken/device",
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "manual",
      method: "GET",
    });
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("Client-Token"),
    ).toBe("client-secret");
  });
  it("never treats connected without device phone as confirmed identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ connected: false }));
    expect(await client(fetcher).status()).toEqual({ connected: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      client(
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(json({ connected: true }))
          .mockResolvedValueOnce(json({ name: "x" })),
      ).status(),
    ).rejects.toBeInstanceOf(ZapiError);
  });
  it("lists bounded pages preserving exact contact and group addresses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ phone: "123@lid", name: "A" }]))
      .mockResolvedValueOnce(
        json([{ phone: "123@g.us", name: "A", isGroup: true }]),
      );
    expect(await client(fetcher).listContacts(2, 100)).toEqual([
      { phone: "123@lid", name: "A" },
    ]);
    expect(await client(fetcher).listGroups(3, 50)).toEqual([
      { phone: "123@g.us", name: "A", isGroup: true },
    ]);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/contacts?page=2&pageSize=100",
    );
    expect(String(fetcher.mock.calls[1][0])).toContain(
      "/groups?page=3&pageSize=50",
    );
    await expect(client(fetcher).listContacts(1, 101)).rejects.toBeInstanceOf(
      ZapiError,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("posts text reply using documented messageId and returns distinct ids", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ messageId: "wa", zaapId: "zaap", id: "other" }),
      );
    expect(
      await client(fetcher).send({
        destination: "123@g.us",
        kind: "text",
        text: "Olá",
        replyTo: "prior",
      }),
    ).toEqual({ messageId: "wa", zaapId: "zaap", id: "other" });
    expect(String(fetcher.mock.calls[0][0])).toContain("/send-text");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      phone: "123@g.us",
      message: "Olá",
      messageId: "prior",
    });
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
  });
  it("sends media as private Base64 with documented fields and paths", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ messageId: "wa" }));
    const z = client(fetcher);
    await z.send({
      destination: "123@lid",
      kind: "image",
      bytes: new Uint8Array([1, 2]),
      mime: "image/png",
      caption: "foto",
      replyTo: "prior",
    });
    await z.send({
      destination: "123@g.us",
      kind: "pdf",
      bytes: new TextEncoder().encode("%PDF-1"),
      mime: "application/pdf",
      fileName: "a.pdf",
      caption: "doc",
      replyTo: "prior",
    });
    await z.send({
      destination: "123@g.us",
      kind: "audio",
      bytes: new Uint8Array([1, 2]),
      mime: "audio/mpeg",
    });
    expect(
      fetcher.mock.calls.map(([url]) => String(url).split("/").pop()),
    ).toEqual(["send-image", "pdf", "send-audio"]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      phone: "123@lid",
      image: "data:image/png;base64,AQI=",
      caption: "foto",
      messageId: "prior",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      phone: "123@g.us",
      document: "data:application/pdf;base64,JVBERi0x",
      fileName: "a.pdf",
      caption: "doc",
      messageId: "prior",
    });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      phone: "123@g.us",
      audio: "data:audio/mpeg;base64,AQI=",
    });
  });
  it("rejects missing config and unsupported envelopes before network", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ZapiClient({}, fetcher).status()).rejects.toBeInstanceOf(
      ZapiError,
    );
    await expect(
      client(fetcher).send({
        destination: "x",
        kind: "audio",
        bytes: new Uint8Array([1]),
        mime: "audio/mpeg",
        replyTo: "y",
      }),
    ).rejects.toBeInstanceOf(ZapiError);
    await expect(
      client(fetcher).send({
        destination: "x",
        kind: "pdf",
        bytes: new Uint8Array([1]),
        mime: "application/pdf",
        fileName: "../x.pdf",
      }),
    ).rejects.toBeInstanceOf(ZapiError);
    await expect(
      client(fetcher).send({
        destination: "x",
        kind: "image",
        bytes: new Uint8Array(2 * 1024 * 1024 + 1),
        mime: "image/png",
      }),
    ).rejects.toBeInstanceOf(ZapiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects redirects, malformed and oversized replies without leaking secrets or remote body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.invalid" },
        }),
      )
      .mockResolvedValueOnce(json({ bad: "client-secret" }))
      .mockResolvedValueOnce(json({ error: "client-secret" }, 401))
      .mockResolvedValueOnce(new Response("x".repeat(256 * 1024 + 1)));
    const z = client(fetcher);
    for (let i = 0; i < 4; i++) {
      try {
        await z.listContacts(1, 10);
        throw Error("expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(ZapiError);
        expect(String(error)).not.toMatch(
          /client-secret|secret\/token|evil\.invalid/,
        );
      }
    }
  });
  it("marks network timeout and malformed send acceptance uncertain, without retry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("secret/token"));
    await expect(
      client(fetcher).send({ destination: "123", kind: "text", text: "Oi" }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "unknown" }));
    await expect(
      client(malformed).send({ destination: "123", kind: "text", text: "Oi" }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
  });
  it("aborts a timed out POST and keeps its outcome uncertain", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("timed out")),
            );
          }),
      );
      const result = client(fetcher).send({
        destination: "123",
        kind: "text",
        text: "Oi",
      });
      const assertion = expect(result).rejects.toBeInstanceOf(
        ProviderUncertainError,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("does not bind the platform transport to ZapiClient", async () => {
  const transport: typeof fetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    return Promise.resolve(json({ connected: false }));
  };
  await expect(client(transport).status()).resolves.toEqual({
    connected: false,
  });
});
it("classifies provider errors without exposing arbitrary messages", () => {
  expect(new ZapiError("Falha Z-API HTTP 429.").code).toBe("provider_http_429");
  expect(new ZapiError("Contrato de grupo inválido.").code).toBe(
    "provider_contract",
  );
  expect(new ZapiError("synthetic-secret").code).toBe("provider_failed");
});
