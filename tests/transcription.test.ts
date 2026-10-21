import { beforeEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { currentFence } from "../src/core";
import { upsertDirectoryPage, setCapture } from "../src/directory";
import { ingestEvent, queryMessages } from "../src/capture";
import { processMediaJobs } from "../src/media";
import { processTranscriptions } from "../src/transcription";

const run = vi.fn(async () => ({ text: "Prazo sintético: sexta-feira." }));
const e = {
  ...env,
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "e1",
  CONNECTION_GENERATION: "g1",
  MAINTENANCE: "false",
  MEDIA_HOSTS: "media.example",
  TRANSCRIPTION_ENABLED: "true",
  AUTO_TRANSCRIPTION_ENABLED: "true",
  AI: { run } as unknown as Ai,
} as Env;
const ogg = Uint8Array.from(
  atob(
    "T2dnUwACAAAAAAAAAAADHYPEAAAAANg89KYBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAAMdg8QBAAAA1InspQE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAAQYAwAAAAAAAAMdg8QCAAAAe+E0QAEDmP/+",
  ),
  (c) => c.charCodeAt(0),
);
let chatId: string;
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM actions; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM directory_syncs; DELETE FROM participants; DELETE FROM chats; DELETE FROM transcription_usage; UPDATE transcription_state SET enabled_since=0,lease_token=NULL,lease_until=0",
  );
  run.mockClear();
  await upsertDirectoryPage(e, currentFence(e), {
    items: [{ externalId: "group-a", kind: "group", name: "Grupo sintético" }],
    complete: true,
  });
  const chat = await env.DB.prepare("SELECT id FROM chats").first<{
    id: string;
  }>();
  chatId = chat!.id;
  await setCapture(e, chatId, true, currentFence(e));
});
async function audio(fromMe = false) {
  const result = await ingestEvent(e, currentFence(e), {
    chatExternalId: "group-a",
    externalId: crypto.randomUUID(),
    fromMe,
    kind: "audio",
    timestamp: 1,
    media: {
      url: "https://media.example/a",
      mime: "audio/ogg; codecs=opus",
      durationSeconds: 87,
    },
  });
  await processMediaJobs(
    e,
    async () => new Response(ogg, { headers: { "content-type": "audio/ogg" } }),
  );
  return result.messageId!;
}
it("transcreve áudio novo, reusa cache e expõe derivado na consulta e busca", async () => {
  const id = await audio();
  expect((await processTranscriptions(e)).ready).toBe(1);
  await processTranscriptions(e);
  expect(run).toHaveBeenCalledTimes(1);
  const page = await queryMessages(e, { chatId, term: "sexta-feira" });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    id,
    text: null,
    transcription: {
      status: "ready",
      text: "Prazo sintético: sexta-feira.",
      untrusted: true,
    },
  });
});
it("não processa passado, uploads ou mensagens enviadas pelo dono", async () => {
  await audio();
  await env.DB.prepare("UPDATE transcription_state SET enabled_since=?")
    .bind(Date.now() + 1)
    .run();
  await processTranscriptions(e);
  expect(run).not.toHaveBeenCalled();
  await env.DB.exec("UPDATE transcription_state SET enabled_since=0");
  await env.DB.exec(
    "DELETE FROM media_jobs; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages",
  );
  await audio(true);
  await processTranscriptions(e);
  expect(run).not.toHaveBeenCalled();
});
it("quota esgotada mantém trabalho pendente sem consumir tentativas", async () => {
  await audio();
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO transcription_usage(epoch,generation,day,used) VALUES('e1','g1',?,500)",
  )
    .bind(day)
    .run();
  await processTranscriptions(e);
  expect(run).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT status,attempts,error FROM media_jobs WHERE kind='transcribe'",
    ).first(),
  ).toMatchObject({
    status: "retry",
    attempts: 0,
    error: "transcription_quota",
  });
});
it("dois crons concorrentes não duplicam inferência", async () => {
  await audio();
  await Promise.all([processTranscriptions(e), processTranscriptions(e)]);
  expect(run).toHaveBeenCalledTimes(1);
});
it("exclusão impede consulta/busca e processamento do derivado", async () => {
  await audio();
  await processTranscriptions(e);
  await env.DB.exec("UPDATE messages SET deleted_at=1,privacy_locked=1");
  expect(
    (await queryMessages(e, { chatId, term: "sexta-feira" })).items,
  ).toHaveLength(0);
  const page = await queryMessages(e, { chatId });
  expect(page.items[0]?.transcription).toBeNull();
});

it("aceita áudio declarado de dez minutos e arquivo acima de 2 MiB", async () => {
  const result = await ingestEvent(e, currentFence(e), {
    chatExternalId: "group-a",
    externalId: "long",
    fromMe: false,
    kind: "audio",
    timestamp: 1,
    media: {
      url: "https://media.example/long",
      mime: "audio/ogg",
      durationSeconds: 600,
    },
  });
  const bytes = new Uint8Array(3 * 1024 * 1024);
  bytes.set(ogg);
  const download = await processMediaJobs(
    e,
    async () =>
      new Response(bytes, { headers: { "content-type": "audio/ogg" } }),
  );
  expect(download.ready).toBe(1);
  await processTranscriptions(e);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await queryMessages(e, { chatId })).items[0]).toMatchObject({
    id: result.messageId,
    transcription: { status: "ready" },
  });
});
it("expõe pausa e falha de download sem anunciar uma fila impossível", async () => {
  await audio();
  const paused = await queryMessages(
    { ...e, AUTO_TRANSCRIPTION_ENABLED: "false" },
    { chatId },
  );
  expect(paused.items[0]?.transcription?.status).toBe("paused");
  await env.DB.exec(
    "UPDATE media SET state='failed'; UPDATE media_jobs SET status='failed',error='media_source_forbidden' WHERE kind='download'",
  );
  const failed = await queryMessages(e, { chatId });
  expect(failed.items[0]?.transcription).toMatchObject({
    status: "download_failed",
    error: "media_source_forbidden",
  });
});
it("derivado grande respeita orçamento UTF8 e paginação continua", async () => {
  await audio();
  await processTranscriptions(e);
  await env.DB.prepare("UPDATE media_derivatives SET text=?")
    .bind("á🙂".repeat(7000))
    .run();
  const page = await queryMessages(e, { chatId });
  expect(
    new TextEncoder().encode(JSON.stringify(page)).length,
  ).toBeLessThanOrEqual(32000);
  expect(page.items[0]?.transcription).toMatchObject({
    status: "ready",
    truncated: true,
  });
  expect(page.items[0]?.transcription?.text).not.toContain("�");
  expect(page.items[0]?.text).toBeNull();
  expect(page.items[0]?.textTruncated).toBe(false);
});
it("limite de 20 MiB usa base64 completo sem vetor numérico", async () => {
  await ingestEvent(e, currentFence(e), {
    chatExternalId: "group-a",
    externalId: "max",
    fromMe: false,
    kind: "audio",
    timestamp: 1,
    media: {
      url: "https://media.example/max",
      mime: "audio/ogg",
      durationSeconds: 600,
    },
  });
  const bytes = new Uint8Array(20 * 1024 * 1024);
  bytes.set(ogg);
  bytes[bytes.length - 1] = 47;
  expect(
    (
      await processMediaJobs(
        e,
        async () =>
          new Response(bytes, { headers: { "content-type": "audio/ogg" } }),
      )
    ).ready,
  ).toBe(1);
  await processTranscriptions(e);
  expect(run).toHaveBeenCalledTimes(1);
  const input = (
    run.mock.calls as unknown as [string, { audio: string }][]
  )[0]![1];
  expect(atob(input.audio).length).toBe(bytes.length);
  expect(atob(input.audio).charCodeAt(bytes.length - 1)).toBe(47);
}, 20000);
