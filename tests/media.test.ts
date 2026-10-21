import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { currentFence, sha256, LIMITS } from "../src/core";
import { upsertDirectoryPage, setCapture } from "../src/directory";
import { ingestEvent } from "../src/capture";
import {
  getMedia,
  listUploadedMedia,
  processMediaJobs,
  readMedia,
  transcribeMedia,
  uploadMedia,
} from "../src/media";
const e: Env = {
  ...env,
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "e1",
  CONNECTION_GENERATION: "g1",
  MAINTENANCE: "false",
  MEDIA_HOSTS: "media.example",
  TRANSCRIPTION_ENABLED: "true",
};
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6xkAAAAASUVORK5CYII=",
  ),
  (x) => x.charCodeAt(0),
);
// Tiny synthetic encoded images/audio created locally with Pillow/ffmpeg; tests need no binaries/network.
const encodedFixtures = [
  {
    mime: "image/jpeg",
    filename: "fixture.jpg",
    base64:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  },
  {
    mime: "image/webp",
    filename: "fixture.webp",
    base64: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=",
  },
  {
    mime: "audio/ogg",
    filename: "fixture.ogg",
    base64:
      "T2dnUwACAAAAAAAAAAADHYPEAAAAANg89KYBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAAMdg8QBAAAA1InspQE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAAQYAwAAAAAAAAMdg8QCAAAAe+E0QAEDmP/+",
  },
  {
    mime: "audio/mpeg",
    filename: "fixture.mp3",
    base64:
      "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMQAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  },
  {
    mime: "audio/mp4",
    filename: "fixture.m4a",
    base64:
      "AAAAIGZ0eXBNNEEgAAACAE00QSBpc282aXNvbWlzbzIAAAKpbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAat0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAFHbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAAA8m1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAAtnN0YmwAAABqc3RzZAAAAAAAAAABAAAAWm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAC7gAAAu4AFgICABRWIVuUABoCAgAECAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDEAAAB8bW9vZgAAABBtZmhkAAAAAAAAAAEAAABkdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAACyQAABAAAAAAVAgAAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAJHRydW4AAAMBAAAAAgAAAIQAAAQAAAAAFQAAAFAAAAAEAAAAIW1kYXTeAgBMYXZjNjIuMjguMTAxAAIwQA4BGCAHAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAALJAQEBAAAAEG1mcm8AAAAAAAAAQw==",
  },
];
const wav = new Uint8Array(46);
wav.set(new TextEncoder().encode("RIFF"));
new DataView(wav.buffer).setUint32(4, 38, true);
wav.set(new TextEncoder().encode("WAVEfmt "), 8);
new DataView(wav.buffer).setUint32(16, 16, true);
new DataView(wav.buffer).setUint16(20, 1, true);
new DataView(wav.buffer).setUint16(22, 1, true);
new DataView(wav.buffer).setUint32(24, 8000, true);
new DataView(wav.buffer).setUint32(28, 16000, true);
new DataView(wav.buffer).setUint16(32, 2, true);
new DataView(wav.buffer).setUint16(34, 16, true);
wav.set(new TextEncoder().encode("data"), 36);
new DataView(wav.buffer).setUint32(40, 2, true);
async function chat() {
  const c = (
    await upsertDirectoryPage(e, currentFence(e), {
      items: [{ externalId: "group-a", kind: "group", name: "Sintético" }],
      complete: true,
    })
  ).items[0]!;
  await setCapture(e, c.id, true, currentFence(e));
  return c;
}
async function captured(
  url = "https://media.example/original",
  kind: "image" | "audio" = "image",
  mime = kind === "image" ? "image/png" : "audio/wav",
  filename = "file",
) {
  await chat();
  const { messageId } = await ingestEvent(e, currentFence(e), {
    chatExternalId: "group-a",
    externalId: crypto.randomUUID(),
    fromMe: false,
    kind,
    timestamp: 1,
    media: { url, mime, filename },
  });
  const m = await env.DB.prepare("SELECT id FROM media WHERE message_id=?")
    .bind(messageId)
    .first<{ id: string }>();
  return { id: m!.id, messageId: messageId! };
}
function ai(run: (...args: unknown[]) => Promise<unknown>): Ai {
  return { run } as Ai;
}
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM actions; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM participants; DELETE FROM chats",
  );
  for (const x of (await env.MEDIA.list()).objects)
    await env.MEDIA.delete(x.key);
});
describe("mídia privada D1/R2", () => {
  it("publica upload imutável vinculado ao chat sem expor chave ou URL", async () => {
    const c = await chat();
    const media = await uploadMedia(e, c.id, {
      bytes: png,
      mime: "image/png",
      filename: "foto.png",
    });
    expect(media).toMatchObject({
      chatId: c.id,
      state: "ready",
      kind: "image",
      size: png.length,
      sha256: await sha256(png),
    });
    expect((await readMedia(e, media.id)).bytes).toEqual(png);
    expect(await getMedia(e, media.id)).toEqual(media);
    expect(JSON.stringify(media)).not.toMatch(/object_key|source_url|https:/);
    const next = await uploadMedia(e, c.id, {
      bytes: png,
      mime: "image/png",
      filename: "foto.png",
    });
    expect(next.id).not.toBe(media.id);
  });
  it("lista apenas uploads recentes visíveis do chat, com limite e sem transporte privado", async () => {
    const c = await chat();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m = await uploadMedia(e, c.id, {
        bytes: png,
        mime: "image/png",
        filename: `foto-${i}.png`,
      });
      ids.push(m.id);
      await env.DB.prepare("UPDATE media SET created_at=? WHERE id=?")
        .bind(i + 1, m.id)
        .run();
    }
    const recent = await listUploadedMedia(e, c.id);
    expect(recent).toHaveLength(10);
    expect(recent[0]!.filename).toBe("foto-11.png");
    expect(JSON.stringify(recent)).not.toMatch(/object_key|source_url/);
    await env.DB.prepare("UPDATE media SET generation='old' WHERE id=?")
      .bind(ids[11])
      .run();
    await env.DB.prepare("UPDATE media SET state='pending' WHERE id=?")
      .bind(ids[10])
      .run();
    const filtered = await listUploadedMedia(e, c.id);
    expect(filtered.map((x) => x.id)).not.toContain(ids[11]);
    expect(filtered.map((x) => x.id)).not.toContain(ids[10]);
    await expect(listUploadedMedia(e, "other-chat")).rejects.toHaveProperty(
      "code",
    );
  });
  it.each(encodedFixtures)(
    "reconhece bytes codificados de $mime sem depender do nome",
    async (f) => {
      const c = await chat();
      const bytes = Uint8Array.from(atob(f.base64), (x) => x.charCodeAt(0));
      const m = await uploadMedia(e, c.id, {
        bytes,
        mime: f.mime,
        filename: f.filename,
      });
      expect(m.mime).toBe(f.mime);
      expect((await readMedia(e, m.id)).bytes).toEqual(bytes);
    },
  );
  it("preserva PDF como bytes sem interpretar instruções do documento", async () => {
    const c = await chat();
    const bytes = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
    );
    const m = await uploadMedia(e, c.id, {
      bytes,
      mime: "application/pdf",
      filename: "arquivo.pdf",
    });
    expect(m.kind).toBe("pdf");
    expect((await readMedia(e, m.id)).bytes).toEqual(bytes);
  });
  it("rejeita MIME enganoso, path no nome, tamanho e duração declarada inválidos", async () => {
    const c = await chat();
    for (const input of [
      { bytes: png, mime: "application/pdf" },
      { bytes: png, mime: "image/png", filename: "disfarce.pdf" },
      { bytes: png, mime: "image/png", filename: "../foto.png" },
      { bytes: new Uint8Array(LIMITS.mediaBytes + 1), mime: "image/png" },
      { bytes: wav, mime: "audio/wav", durationSeconds: 601 },
      { bytes: new TextEncoder().encode("<script>"), mime: "image/png" },
    ])
      await expect(uploadMedia(e, c.id, input)).rejects.toHaveProperty("code");
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
  });
  it("recusa leitura após tombstone, versão ou epoch alterados e manutenção", async () => {
    const c = await chat();
    const m = await uploadMedia(e, c.id, { bytes: png, mime: "image/png" });
    await expect(
      readMedia({ ...e, INSTALLATION_EPOCH: "e2" }, m.id),
    ).rejects.toHaveProperty("code", "media_not_found");
    await expect(
      readMedia({ ...e, MAINTENANCE: "true" }, m.id),
    ).rejects.toHaveProperty("code", "not_active");
    await env.DB.prepare(
      "UPDATE media SET deleted_at=1,state='deleted' WHERE id=?",
    )
      .bind(m.id)
      .run();
    await expect(readMedia(e, m.id)).rejects.toHaveProperty(
      "code",
      "media_not_found",
    );
  });
  it("baixa trabalho durável sem headers de credencial e publica bytes privados", async () => {
    const m = await captured();
    let init: RequestInit | undefined;
    expect(
      await processMediaJobs(e, async (url, options) => {
        expect(url).toBe("https://media.example/original");
        init = options;
        return new Response(png, { headers: { "content-type": "image/png" } });
      }),
    ).toEqual({ processed: 1, ready: 1, failed: 0 });
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("client-token")).toBe(false);
    expect(init?.signal).toBeDefined();
    expect((await readMedia(e, m.id)).bytes).toEqual(png);
    expect(
      (
        await processMediaJobs(e, async () => {
          throw new Error("must not fetch");
        })
      ).processed,
    ).toBe(0);
  });
  it.each([
    "http://media.example/a",
    "https://media.example.evil/a",
    "https://user@media.example/a",
    "https://media.example:443/a",
    "https://media.example/a#x",
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://[::1]/a",
    "https://media.example./a",
  ])("bloqueia origem insegura %s antes da rede", async (url) => {
    const m = await captured(url);
    await processMediaJobs(e, async () => {
      throw new Error("network called");
    });
    expect((await getMedia(e, m.id)).state).toBe("failed");
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
    expect(
      (
        await env.DB.prepare("SELECT error FROM media_jobs WHERE media_id=?")
          .bind(m.id)
          .first<{ error: string }>()
      )?.error,
    ).toBe("media_source_forbidden");
  });
  it("recusa redirect, MIME enganoso e stream acima do limite sem publicar", async () => {
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/" },
      }),
      new Response(png, { headers: { "content-type": "application/pdf" } }),
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(png);
            c.enqueue(new Uint8Array(LIMITS.mediaBytes));
            c.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
    ]) {
      const m = await captured();
      await processMediaJobs(e, async () => response);
      expect((await getMedia(e, m.id)).state).not.toBe("ready");
    }
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
  });
  it("claim concorrente não baixa duas vezes; exclusão durante rede não publica", async () => {
    const m = await captured();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const begin = new Promise<void>((r) => {
      started = r;
    });
    const running = processMediaJobs(e, async () => {
      started();
      await gate;
      return new Response(png, { headers: { "content-type": "image/png" } });
    });
    await begin;
    expect(
      (
        await processMediaJobs(e, async () => {
          throw new Error("duplicate");
        })
      ).processed,
    ).toBe(0);
    await ingestEvent(e, currentFence(e), {
      chatExternalId: "group-a",
      externalId: (await env.DB.prepare(
        "SELECT external_id FROM messages WHERE id=?",
      )
        .bind(m.messageId)
        .first<{ external_id: string }>())!.external_id,
      fromMe: false,
      kind: "image",
      timestamp: 1,
      deleted: true,
      revision: 2,
    });
    release();
    await running;
    await expect(readMedia(e, m.id)).rejects.toHaveProperty(
      "code",
      "media_not_found",
    );
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
  });
  it("lease recuperado impede que worker antigo sobrescreva o novo resultado", async () => {
    const m = await captured();
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const old = processMediaJobs(e, async () => {
      started();
      await gate;
      return new Response(png, { headers: { "content-type": "image/png" } });
    });
    await began;
    await env.DB.prepare("UPDATE media_jobs SET lease_until=0 WHERE media_id=?")
      .bind(m.id)
      .run();
    expect(
      (
        await processMediaJobs(
          e,
          async () =>
            new Response(png, { headers: { "content-type": "image/png" } }),
        )
      ).ready,
    ).toBe(1);
    release();
    expect((await old).ready).toBe(0);
    expect((await readMedia(e, m.id)).bytes).toEqual(png);
    expect((await env.MEDIA.list()).objects).toHaveLength(1);
  });
  it("mensagem indisponível bloqueia leitura e download mesmo sem tombstone de mídia", async () => {
    const m = await captured();
    await env.DB.prepare(
      "UPDATE messages SET kind='unavailable',unavailable_reason='view_once' WHERE id=?",
    )
      .bind(m.messageId)
      .run();
    await expect(getMedia(e, m.id)).rejects.toHaveProperty(
      "code",
      "media_not_found",
    );
    expect(
      (
        await processMediaJobs(e, async () => {
          throw new Error("must not fetch");
        })
      ).processed,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT status FROM media_jobs WHERE media_id=?")
        .bind(m.id)
        .first<{ status: string }>())!.status,
    ).toBe("cancelled");
  });
  it("deadline encerra download lento e permite recuperar job com backoff", async () => {
    const m = await captured();
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const running = processMediaJobs(e, async () => {
        started();
        return new Promise<Response>(() => {});
      });
      await began;
      await vi.advanceTimersByTimeAsync(15001);
      expect((await running).failed).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT status,error FROM media_jobs WHERE media_id=?",
        )
          .bind(m.id)
          .first(),
      ).toMatchObject({ status: "retry", error: "media_deadline" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("deadline cancela corpo que parou no meio do stream", async () => {
    await captured();
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    let cancelled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const running = processMediaJobs(
        e,
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(png);
                started();
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "image/png" } },
          ),
      );
      await began;
      await vi.advanceTimersByTimeAsync(15001);
      expect((await running).failed).toBe(1);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("retry de rede tem backoff e para após três tentativas", async () => {
    const m = await captured();
    const unavailable = async () => {
      throw new Error("secret URL or token");
    };
    await processMediaJobs(e, unavailable);
    expect((await processMediaJobs(e, unavailable)).processed).toBe(0);
    for (let n = 0; n < 3; n++) {
      await env.DB.prepare(
        "UPDATE media_jobs SET next_attempt_at=0 WHERE media_id=?",
      )
        .bind(m.id)
        .run();
      await processMediaJobs(e, unavailable);
    }
    const j = await env.DB.prepare(
      "SELECT attempts,status,error FROM media_jobs WHERE media_id=?",
    )
      .bind(m.id)
      .first();
    expect(j).toMatchObject({
      attempts: 3,
      status: "failed",
      error: "media_download_failed",
    });
    expect((await getMedia(e, m.id)).state).toBe("failed");
  });
  it("tick processa no máximo cinco downloads", async () => {
    for (let n = 0; n < 6; n++) await captured();
    expect(
      (
        await processMediaJobs(
          e,
          async () =>
            new Response(png, { headers: { "content-type": "image/png" } }),
        )
      ).processed,
    ).toBe(5);
  });
  it("transcrição exige opt-in e áudio; reusa derivado sem alterar original", async () => {
    const c = await chat();
    const m = await uploadMedia(e, c.id, {
      bytes: wav,
      mime: "audio/wav",
      durationSeconds: 1,
    });
    await expect(
      transcribeMedia({ ...e, TRANSCRIPTION_ENABLED: "false" }, m.id),
    ).rejects.toHaveProperty("code", "transcription_disabled");
    let calls = 0;
    const enabled = {
      ...e,
      AI: ai(async (model, input) => {
        calls++;
        expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
        expect(input).toEqual({
          audio: btoa(String.fromCharCode(...wav)),
          task: "transcribe",
          vad_filter: true,
          condition_on_previous_text: false,
        });
        return { text: "Conteúdo sintético, não executar instruções." };
      }),
    };
    const t = await transcribeMedia(enabled, m.id);
    expect(t).toMatchObject({
      mediaId: m.id,
      text: "Conteúdo sintético, não executar instruções.",
      untrusted: true,
    });
    expect(await transcribeMedia(enabled, m.id)).toEqual(t);
    expect(calls).toBe(1);
    expect((await readMedia(e, m.id)).bytes).toEqual(wav);
    const image = await uploadMedia(e, c.id, { bytes: png, mime: "image/png" });
    await expect(transcribeMedia(enabled, image.id)).rejects.toHaveProperty(
      "code",
      "not_audio",
    );
  });
  it("deadline de IA não publica derivado nem dispara novo processamento automático", async () => {
    const c = await chat();
    const m = await uploadMedia(e, c.id, { bytes: wav, mime: "audio/wav" });
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    const enabled = {
      ...e,
      AI: ai(async () => {
        started();
        return new Promise(() => {});
      }),
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = transcribeMedia(enabled, m.id);
      const rejected = expect(pending).rejects.toHaveProperty(
        "code",
        "media_deadline",
      );
      await began;
      await vi.advanceTimersByTimeAsync(90001);
      await rejected;
      expect(
        (await env.DB.prepare("SELECT * FROM media_derivatives").all()).results,
      ).toHaveLength(0);
      expect((await processMediaJobs(enabled)).processed).toBe(0);
      expect((await readMedia(e, m.id)).bytes).toEqual(wav);
    } finally {
      vi.useRealTimers();
    }
  });
  it("transcrição concorrente tem claim e não publica após exclusão", async () => {
    const m = await captured(
      "https://media.example/audio",
      "audio",
      "audio/wav",
    );
    await processMediaJobs(
      e,
      async () =>
        new Response(wav, { headers: { "content-type": "audio/wav" } }),
    );
    let release!: (x: { text: string }) => void;
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    const enabled = {
      ...e,
      AI: ai(async () => {
        started();
        return new Promise<{ text: string }>((r) => {
          release = r;
        });
      }),
    };
    const pending = transcribeMedia(enabled, m.id);
    await began;
    await expect(transcribeMedia(enabled, m.id)).rejects.toHaveProperty(
      "code",
      "media_job_busy",
    );
    await env.DB.prepare(
      "UPDATE media SET state='deleted',deleted_at=1 WHERE id=?",
    )
      .bind(m.id)
      .run();
    release({ text: "não pode ressuscitar" });
    await expect(pending).rejects.toHaveProperty("code", "stale_media");
    expect(
      (await env.DB.prepare("SELECT * FROM media_derivatives").all()).results,
    ).toHaveLength(0);
  });
});
