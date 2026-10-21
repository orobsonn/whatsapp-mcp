import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { currentFence, LIMITS } from "../src/core";
import { upsertDirectoryPage } from "../src/directory";
import {
  generateAudio,
  getGeneratedAudio,
  audioGenerationSchema,
  cleanupAudioGenerations,
} from "../src/tts";
import { getMedia, readMedia, listUploadedMedia } from "../src/media";
import {
  prepareAction,
  executeAction,
  type SendProvider,
} from "../src/actions";

import { mp3 } from "./fixtures/audio";
const e: Env = {
  ...env,
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "tts-e",
  CONNECTION_GENERATION: "tts-g",
  CONNECTED_PHONE: "test-device",
  MAINTENANCE: "false",
  TTS_ENABLED: "true",
  FISH_API_KEY: "synthetic-key",
  FISH_VOICE_ID: "synthetic-voice",
  FISH_VOICE_NAME: "Minha voz",
  FISH_TTS_MODEL: "s2.1-pro",
};
let chatId: string;
const input = () => ({ chatId, text: "Texto privado sintético" });
const ok = () =>
  new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
const provider = () => vi.fn(async () => ok());
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM tts_generations; DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM actions; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM directory_syncs; DELETE FROM chats",
  );
  for (const o of (await env.MEDIA.list()).objects)
    await env.MEDIA.delete(o.key);
  chatId = (
    await upsertDirectoryPage(e, currentFence(e), {
      items: [
        { externalId: "tts-target", kind: "individual", name: "Sintético" },
      ],
      complete: true,
    })
  ).items[0]!.id;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("gera MP3 privado, exige contrato controlado e nunca envia", async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer synthetic-key",
      model: "s2.1-pro",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      text: input().text,
      reference_id: e.FISH_VOICE_ID,
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal",
    });
    return ok();
  });
  const result = await generateAudio(e, input(), fetcher);
  expect(result).toMatchObject({
    status: "ready",
    text: input().text,
    voice: "Minha voz",
    media: { kind: "audio", mime: "audio/mpeg", size: mp3.length },
    mayHaveConsumedCredit: true,
  });
  expect(result.previewUrl).toBe(`${e.PUBLIC_ORIGIN}/audio/${result.id}`);
  expect((await readMedia(e, result.media!.id)).bytes).toEqual(mp3);
  expect(JSON.stringify(result)).not.toMatch(
    /synthetic-key|object_key|source_url/,
  );
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM actions").first<{
      n: number;
    }>())!.n,
  ).toBe(0);
  expect(() =>
    audioGenerationSchema.parse({
      ...input(),
      url: "https://evil.example",
      key: "x",
    }),
  ).toThrow();
});
it("deduplica inclusive concorrência e chamadas com a mesma entrada", async () => {
  const fetcher = provider();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => generateAudio(e, input(), fetcher)),
  );
  expect(new Set(results.map((x) => x.id)).size).toBe(1);
  const result = await generateAudio(e, input(), fetcher);
  expect(result.status).toBe("ready");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await env.MEDIA.list()).objects).toHaveLength(1);
  const next = await generateAudio(
    e,
    { ...input(), text: "Outro texto" },
    fetcher,
  );
  expect(next.id).not.toBe(result.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([401, 402, 422, 429, 500, 503, 302])(
  "sanitiza erro HTTP %s e não repete",
  async (status) => {
    const fetcher = vi.fn(
      async () =>
        new Response("PRIVATE PROVIDER BODY", {
          status,
          headers: { location: "https://evil.example" },
        }),
    );
    const first = await generateAudio(e, input(), fetcher);
    expect(first.status).toBe(
      status >= 500 || status === 302 ? "uncertain" : "failed",
    );
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE PROVIDER|evil/);
    expect(await generateAudio(e, input(), fetcher)).toMatchObject({
      id: first.id,
      status: first.status,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each(["network", "headers-timeout", "body-timeout"])(
  "resultado incerto em %s sem ressubmissão",
  async (kind) => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => {
      if (kind === "network") throw new Error("secret-text");
      if (kind === "headers-timeout") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    if (kind !== "network") vi.useFakeTimers();
    const pending = generateAudio(e, input(), fetcher);
    if (kind !== "network") {
      // Let real D1 I/O reach fetch before advancing only the deadline timer.
      while (!fetcher.mock.calls.length)
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalled(), {
          timeout: 5000,
        });
      await vi.advanceTimersByTimeAsync(45_001);
    }
    const result = await pending;
    expect(result.status).toBe("uncertain");
    if (kind === "body-timeout") expect(cancelled).toHaveBeenCalled();
    expect((await generateAudio(e, input(), fetcher)).status).toBe("uncertain");
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each(["mime", "signature", "size", "empty"])(
  "recusa %s inválido sem criar mídia",
  async (kind) => {
    const bytes =
      kind === "size"
        ? new Uint8Array(LIMITS.mediaBytes + 1)
        : kind === "signature"
          ? new TextEncoder().encode("not mp3")
          : kind === "empty"
            ? new Uint8Array()
            : mp3;
    const fetcher = vi.fn(
      async () =>
        new Response(bytes, {
          headers: {
            "content-type": kind === "mime" ? "audio/wav" : "audio/mpeg",
          },
        }),
    );
    const result = await generateAudio(e, input(), fetcher);
    expect(result.status).toBe("failed");
    expect(result.mayHaveConsumedCredit).toBe(true);
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
    await generateAudio(e, input(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("bloqueia configuração ausente/inválida, manutenção e chat de outra instalação antes da rede", async () => {
  const fetcher = provider();
  for (const overrides of [
    { TTS_ENABLED: "false" },
    { FISH_API_KEY: undefined },
    { FISH_VOICE_ID: undefined },
    { FISH_TTS_MODEL: "unknown" },
    { MAINTENANCE: "true" },
    { INSTALLATION_EPOCH: "other" },
    { CONNECTION_GENERATION: "other" },
  ]) {
    await expect(
      generateAudio({ ...e, ...overrides }, input(), fetcher),
    ).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
  const result = await generateAudio(e, input(), fetcher);
  await expect(
    getGeneratedAudio({ ...e, INSTALLATION_EPOCH: "other" }, result.id),
  ).rejects.toThrow("tts_not_found");
});
it("orphan expirado torna-se incerto, sem novo claim", async () => {
  const fetcher = provider();
  const result = await generateAudio(e, input(), fetcher);
  await env.DB.prepare(
    "UPDATE tts_generations SET status='attempting',deadline_at=0,media_id=NULL WHERE id=?",
  )
    .bind(result.id)
    .run();
  expect((await generateAudio(e, input(), fetcher)).status).toBe("uncertain");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("não publica após exclusão durante Fish e não permite reutilizar o texto apagado", async () => {
  const fetcher = vi.fn(async () => {
    await env.DB.prepare(
      "UPDATE tts_generations SET status='unavailable',text=NULL,voice_name=NULL WHERE chat_id=?",
    )
      .bind(chatId)
      .run();
    return ok();
  });
  const result = await generateAudio(e, input(), fetcher);
  expect(result.status).toBe("unavailable");
  expect(result.text).toBeNull();
  expect(await listUploadedMedia(e, chatId)).toHaveLength(0);
  expect((await env.MEDIA.list()).objects).toHaveLength(0);
  await generateAudio(e, input(), fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("áudio final e destinatário participam da aprovação; envio não repete", async () => {
  const result = await generateAudio(e, input(), provider());
  const proposal = await prepareAction(e, {
    chatId,
    kind: "audio",
    mediaId: result.media!.id,
    mediaHash: result.media!.sha256,
  });
  expect(proposal.authorization).toContain("NOVA autorização posterior");
  expect(proposal.previewUrl).toBe(result.previewUrl);
  const other = (
    await upsertDirectoryPage(e, currentFence(e), {
      items: [{ externalId: "other", kind: "individual", name: "Outro" }],
      complete: true,
    })
  ).items[0]!;
  const changed = await prepareAction(e, {
    chatId: other.id,
    kind: "audio",
    mediaId: result.media!.id,
    mediaHash: result.media!.sha256,
  });
  expect(changed.hash).not.toBe(proposal.hash);
  const send = vi.fn(async () => ({ messageId: "synthetic-send" }));
  const transport: SendProvider = {
    status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
    send,
  };
  await expect(
    executeAction(e, changed.id, transport, {
      confirmed: true,
      hash: proposal.hash,
    }),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  await expect(executeAction(e, proposal.id, transport)).rejects.toThrow(
    "action_not_approved",
  );
  expect(send).not.toHaveBeenCalled();
  const sent = await executeAction(e, proposal.id, transport, {
    confirmed: true,
    hash: proposal.hash,
  });
  expect(sent.status).toBe("accepted");
  await executeAction(e, proposal.id, transport, {
    confirmed: true,
    hash: proposal.hash,
  });
  expect(send).toHaveBeenCalledTimes(1);
  await env.DB.prepare("UPDATE media SET sha256=? WHERE id=?")
    .bind("0".repeat(64), result.media!.id)
    .run();
  await expect(
    executeAction(e, changed.id, transport, {
      confirmed: true,
      hash: changed.hash,
    }),
  ).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});
it("exclusão durante R2 impede publicação e remove o objeto", async () => {
  const bucket = new Proxy(e.MEDIA, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const stored = await target.put(...args);
          await env.DB.prepare(
            "UPDATE tts_generations SET status='unavailable',text=NULL,voice_name=NULL WHERE chat_id=?",
          )
            .bind(chatId)
            .run();
          return stored;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await generateAudio(
    { ...e, MEDIA: bucket },
    input(),
    provider(),
  );
  expect(result.status).toBe("unavailable");
  expect(await listUploadedMedia(e, chatId)).toHaveLength(0);
  expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
it("arquivo em staging não aparece nem pode ser proposto; perder CAS limpa o upload", async () => {
  let stagedId = "";
  const db = new Proxy(e.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("UPDATE tts_generations SET status='ready'"))
            return statement;
          return new Proxy(statement, {
            get(s, p) {
              if (p === "bind")
                return (...bindings: unknown[]) => {
                  const bound = s.bind(...bindings);
                  return new Proxy(bound, {
                    get(b, k) {
                      if (k === "run")
                        return async () => {
                          stagedId = String(bindings[0]);
                          expect(
                            await listUploadedMedia(e, chatId),
                          ).toHaveLength(0);
                          await expect(getMedia(e, stagedId)).rejects.toThrow(
                            "media_not_found",
                          );
                          const m = await env.DB.prepare(
                            "SELECT sha256 FROM media WHERE id=?",
                          )
                            .bind(stagedId)
                            .first<{ sha256: string }>();
                          await expect(
                            prepareAction(e, {
                              chatId,
                              kind: "audio",
                              mediaId: stagedId,
                              mediaHash: m!.sha256,
                            }),
                          ).rejects.toThrow("media_unavailable");
                          await env.DB.prepare(
                            "UPDATE tts_generations SET status='uncertain',text=NULL,voice_name=NULL WHERE chat_id=?",
                          )
                            .bind(chatId)
                            .run();
                          return { meta: { changes: 0 } };
                        };
                      const value = Reflect.get(b, k);
                      return typeof value === "function"
                        ? value.bind(b)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await generateAudio({ ...e, DB: db }, input(), provider());
  expect(stagedId).not.toBe("");
  expect(result.status).toBe("uncertain");
  expect(await listUploadedMedia(e, chatId)).toHaveLength(0);
  expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
it("limpeza redige orphan incerto sem retomar geração", async () => {
  const result = await generateAudio(e, input(), provider());
  await env.DB.prepare(
    "UPDATE tts_generations SET status='attempting',deadline_at=0,media_id=NULL WHERE id=?",
  )
    .bind(result.id)
    .run();
  await cleanupAudioGenerations(e);
  expect(
    await env.DB.prepare(
      "SELECT status,text,voice_name FROM tts_generations WHERE id=?",
    )
      .bind(result.id)
      .first(),
  ).toEqual({ status: "uncertain", text: null, voice_name: null });
  await expect(getMedia(e, result.media!.id)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT deleted_at FROM media WHERE id=?")
      .bind(result.media!.id)
      .first(),
  ).toMatchObject({ deleted_at: expect.any(Number) });
});
it("deadline termina mesmo quando o cancelamento do provedor não responde", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const fetcher = vi.fn(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "audio/mpeg" },
      }),
  );
  const pending = generateAudio(e, input(), fetcher);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled(), { timeout: 5000 });
  await vi.advanceTimersByTimeAsync(45_001);
  expect((await pending).status).toBe("uncertain");
  expect(cancel).toHaveBeenCalled();
});
it("não submete ao Fish quando o claim já venceu antes da rede", async () => {
  const base = Date.now();
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(base)
    .mockReturnValue(base + 45_001);
  const fetcher = provider();
  try {
    await generateAudio(e, input(), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
it("resposta tardia depois do timeout não publica arquivo", async () => {
  vi.useFakeTimers();
  let release!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const pending = generateAudio(e, input(), fetcher);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled(), { timeout: 5000 });
  await vi.advanceTimersByTimeAsync(45_001);
  const result = await pending;
  expect(result.status).toBe("uncertain");
  release(ok());
  await vi.advanceTimersByTimeAsync(1);
  expect((await getGeneratedAudio(e, result.id)).status).toBe("uncertain");
  expect((await env.MEDIA.list()).objects).toHaveLength(0);
});

it("aceita modelo gratuito só por configuração explícita, sem fallback", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("model")).toBe("s2.1-pro-free");
    return ok();
  });
  expect(
    (
      await generateAudio(
        { ...e, FISH_TTS_MODEL: "s2.1-pro-free" },
        input(),
        fetcher,
      )
    ).status,
  ).toBe("ready");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("revalida conexão em produção e mudança de instalação durante a geração", async () => {
  const fetcher = provider();
  await expect(
    generateAudio(
      { ...e, RUNTIME_CONFIG: "database", DEVELOPMENT: "false", PUBLIC_ORIGIN: "https://production.example" },
      input(),
      fetcher,
    ),
  ).rejects.toThrow("not_active");
  expect(fetcher).not.toHaveBeenCalled();
  const changing = { ...e };
  const flight = vi.fn(async () => {
    changing.CONNECTION_GENERATION = "changed";
    return ok();
  });
  await expect(generateAudio(changing, input(), flight)).rejects.toThrow();
  expect((await env.MEDIA.list()).objects).toHaveLength(0);
  const state = await generateAudio(e, input(), fetcher);
  expect(state.status).toBe("uncertain");
  expect(fetcher).not.toHaveBeenCalled();
});
