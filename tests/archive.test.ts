import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { upsertDirectoryPage, listChats, setCapture } from "../src/directory";
import {
  ingestEvent,
  ingestStatus,
  queryMessages,
  normalizeZapiEvent,
} from "../src/capture";
import type { Env } from "../src/env";
const e: Env = {
  ...env,
  OWNER_SUB: "synthetic-owner",
  INSTALLATION_EPOCH: "e1",
  CONNECTION_GENERATION: "g1",
  MAINTENANCE: "false",
};
const fence = { epoch: "e1", generation: "g1" };
async function chat(externalId: string, name = "Homônimo") {
  const page = await upsertDirectoryPage(e, fence, {
    items: [{ externalId, kind: "group", name }],
    complete: true,
  });
  return page.items[0]!;
}
async function event(chatExternalId: string, externalId = "same", extra = {}) {
  return ingestEvent(e, fence, {
    chatExternalId,
    externalId,
    authorExternalId: "participant-lid",
    authorName: "Pessoa Sintética",
    fromMe: false,
    kind: "text",
    text: "combinado",
    timestamp: 100,
    ...extra,
  });
}
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM participants; DELETE FROM directory_syncs; DELETE FROM chats",
  );
});
describe("arquivo D1 com isolamento e fences", () => {
  it("preserva homônimos, participantes e namespace por conversa, com replay concorrente", async () => {
    const a = await chat("group-a");
    const b = await chat("group-b");
    await setCapture(e, a.id, true, fence);
    await setCapture(e, b.id, true, fence);
    await Promise.all([event("group-a"), event("group-a"), event("group-b")]);
    const qa = await queryMessages(e, { chatId: a.id });
    const qb = await queryMessages(e, { chatId: b.id });
    expect(qa.items).toHaveLength(1);
    expect(qb.items).toHaveLength(1);
    expect(qa.items[0]!.id).not.toBe(qb.items[0]!.id);
    expect(qa.items[0]!.authorId).toBe(qb.items[0]!.authorId);
    expect(qa.items[0]!.authorName).toBe("Pessoa Sintética");
    expect((await listChats(e, { term: "Homônimo" })).items).toHaveLength(2);
  });
  it("respeita opt-out e recusa trabalho de geração/epoch antigo", async () => {
    const a = await chat("group-a");
    await setCapture(e, a.id, false, fence);
    expect((await event("group-a")).captured).toBe(false);
    await setCapture(e, a.id, true, fence);
    await expect(
      ingestEvent(
        e,
        { ...fence, epoch: "old" },
        {
          chatExternalId: "group-a",
          externalId: "x",
          kind: "text",
          text: "a",
          timestamp: 1,
          fromMe: false,
        },
      ),
    ).rejects.toMatchObject({ code: "stale_fence" });
    expect((await queryMessages(e, { chatId: a.id })).items).toHaveLength(0);
  });
  it("concilia status anterior ao corpo e não regride read", async () => {
    const a = await chat("group-a");
    await setCapture(e, a.id, true, fence);
    await ingestStatus(e, fence, {
      chatExternalId: "group-a",
      externalId: "same",
      status: "read",
    });
    await event("group-a");
    await ingestStatus(e, fence, {
      chatExternalId: "group-a",
      externalId: "same",
      status: "sent",
    });
    expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe(
      "read",
    );
  });
  it("arquiva texto com prazo de desaparecimento recebido do provedor", async () => {
    const a = await chat("expiring-text");
    await setCapture(e, a.id, true, fence);
    await ingestEvent(e, fence, normalizeZapiEvent({
      phone: "expiring-text", messageId: "expiring", isGroup: true,
      fromMe: false, momment: 100, messageExpirationSeconds: 86400,
      text: { message: "correção sintética" },
    }));
    expect((await queryMessages(e, { chatId: a.id, term: "correção" })).items[0])
      .toMatchObject({ kind: "text", text: "correção sintética", unavailableReason: null });
  });
  it("arquiva anexo temporário e enfileira download", async () => {
    const a = await chat("expiring-media");
    await setCapture(e, a.id, true, fence);
    await event("expiring-media", "image", {
      temporary: true, kind: "image", text: "legenda",
      media: { url: "https://media.example/file", mime: "image/jpeg" },
    });
    expect((await queryMessages(e, { chatId: a.id })).items[0])
      .toMatchObject({ kind: "image", text: "legenda", unavailableReason: null });
    expect((await e.DB.prepare("SELECT id FROM media_jobs WHERE status='pending'").all()).results)
      .toHaveLength(1);
  });
  it("status sem conversa anterior ao corpo concilia só com candidato único", async () => {
    const a = await chat("group-a");
    await setCapture(e, a.id, true, fence);
    await ingestStatus(e, fence, { externalId: "same", status: "read" });
    await event("group-a");
    expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe(
      "read",
    );
  });
  it("normaliza wire sem confundir autor próprio com destinatário e bloqueia mídia temporária", () => {
    const n = normalizeZapiEvent({
      phone: "group-a",
      messageId: "x",
      isGroup: true,
      fromMe: true,
      connectedPhone: "owner-address",
      participantLid: "peer-lid",
      momment: 100,
      image: { imageUrl: "https://media.example/img", viewOnce: true },
    });
    expect(n.authorExternalId).toBe("owner-address");
    expect(n.viewOnce).toBe(true);
  });
  it("status sem conversa permanece pendente se o ID aparece em dois chats", async () => {
    const a = await chat("group-a");
    const b = await chat("group-b");
    await setCapture(e, a.id, true, fence);
    await setCapture(e, b.id, true, fence);
    await event("group-a");
    await event("group-b");
    expect(
      (
        await ingestStatus(e, fence, {
          externalId: "same",
          status: "delivered",
        })
      ).pending,
    ).toBe(true);
    expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe(
      "received",
    );
  });
  it("edição ordenada e tombstone nunca ressuscitam em replay", async () => {
    const a = await chat("group-a");
    await setCapture(e, a.id, true, fence);
    await event("group-a");
    await event("group-a", "same", { revision: 2, text: "novo" });
    await event("group-a", "same", { revision: 1, text: "velho" });
    expect((await queryMessages(e, { chatId: a.id })).items[0]!.text).toBe(
      "novo",
    );
    await event("group-a", "same", { deleted: true, revision: 3 });
    await event("group-a", "same", { revision: 4, text: "ressuscitar" });
    expect((await queryMessages(e, { chatId: a.id })).items[0]).toMatchObject({
      text: null,
      deleted: true,
    });
  });
  it("persiste mídia e job antes de retornar; temporária só registra indisponível", async () => {
    const a = await chat("group-a");
    await setCapture(e, a.id, true, fence);
    await event("group-a", "img", {
      kind: "image",
      text: undefined,
      media: {
        url: "https://media.example/file",
        mime: "image/jpeg",
        filename: "foto.jpg",
      },
    });
    expect(
      (await env.DB.prepare("SELECT * FROM media_jobs").all()).results,
    ).toHaveLength(1);
    await event("group-a", "once", {
      kind: "image",
      viewOnce: true,
      media: { url: "https://media.example/private" },
    });
    const items = (await queryMessages(e, { chatId: a.id })).items;
    expect(items.find((x) => x.kind === "unavailable")).toBeDefined();
    expect(JSON.stringify(items)).not.toContain("https://");
    expect(
      (await env.DB.prepare("SELECT * FROM media_jobs").all()).results,
    ).toHaveLength(1);
  });
  it("viewOnce é irrevogável mesmo quando replay remove o marcador", async () => {
    const a = await chat("privacy-replay");
    await setCapture(e, a.id, true, fence);
    await event("privacy-replay", "one", {
      kind: "image",
      text: undefined,
      viewOnce: true,
      media: { url: "https://media.example/private" },
    });
    await event("privacy-replay", "one", {
      kind: "image",
      text: undefined,
      media: { url: "https://media.example/private" },
    });
    const message = (await queryMessages(e, { chatId: a.id })).items[0]!;
    expect(message).toMatchObject({
      kind: "unavailable",
      unavailableReason: "view_once",
      mediaId: null,
    });
    expect(
      (
        await e.DB.prepare("SELECT id FROM media WHERE message_id=?")
          .bind(message.id)
          .all()
      ).results,
    ).toHaveLength(0);
    await event("privacy-replay", "one", {
      revision: 2,
      text: "não restaurar",
      kind: "text",
    });
    expect(
      (await queryMessages(e, { chatId: a.id })).items[0]!.text,
    ).toBeNull();
  });
  it("visualização única tardia invalida mídia pronta, trabalhos e derivados da mesma versão", async () => {
    const a = await chat("privacy-late");
    await setCapture(e, a.id, true, fence);
    await event("privacy-late", "one", {
      kind: "image",
      text: undefined,
      media: { url: "https://media.example/private" },
    });
    const m = await e.DB.prepare("SELECT id FROM media").first<{
      id: string;
    }>();
    await e.DB.prepare(
      "UPDATE media SET state='ready',object_key='synthetic-key'",
    ).run();
    await e.DB.prepare(
      "INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at) VALUES('d',?,1,'e1','g1','transcript','segredo','ready',1)",
    )
      .bind(m!.id)
      .run();
    await event("privacy-late", "one", {
      kind: "image",
      text: undefined,
      viewOnce: true,
      media: { url: "https://media.example/private" },
    });
    expect((await queryMessages(e, { chatId: a.id })).items[0]).toMatchObject({
      kind: "unavailable",
      mediaId: null,
    });
    expect(
      await e.DB.prepare("SELECT state,source_url FROM media WHERE id=?")
        .bind(m!.id)
        .first(),
    ).toMatchObject({ state: "deleted", source_url: null });
    expect(
      await e.DB.prepare("SELECT status FROM media_jobs WHERE media_id=?")
        .bind(m!.id)
        .first(),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await e.DB.prepare(
        "SELECT text,state FROM media_derivatives WHERE media_id=?",
      )
        .bind(m!.id)
        .first(),
    ).toMatchObject({ text: null, state: "deleted" });
    await e.DB.prepare("DELETE FROM media_derivatives").run();
  });
  it("projeção JSON UTF8 nunca bloqueia paginação em texto escapado ou multibyte", async () => {
    const a = await chat("large-text");
    await setCapture(e, a.id, true, fence);
    await event("large-text", "first", {
      timestamp: 1,
      text: "\u0001".repeat(8000),
    });
    await event("large-text", "second", {
      timestamp: 2,
      text: "😀".repeat(4000),
    });
    const first = await queryMessages(e, { chatId: a.id, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ textTruncated: true });
    expect(first.nextCursor).toBeTruthy();
    expect(
      new TextEncoder().encode(JSON.stringify(first)).byteLength,
    ).toBeLessThanOrEqual(32000);
    const second = await queryMessages(e, {
      chatId: a.id,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(
      new TextEncoder().encode(JSON.stringify(second)).byteLength,
    ).toBeLessThanOrEqual(32000);
  });
  it("status e corpo concorrentes não deixam status órfão após snapshot vazio", async () => {
    const a = await chat("status-race");
    await setCapture(e, a.id, true, fence);
    const db = new Proxy(e.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.startsWith("SELECT m.id FROM messages")) return stmt;
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement =>
              new Proxy(statement, {
                get(st, p) {
                  if (p === "bind")
                    return (...args: unknown[]) => wrap(st.bind(...args));
                  if (p === "all")
                    return async () => {
                      const snapshot = await st.all();
                      await event("status-race");
                      return snapshot;
                    };
                  const value = Reflect.get(st, p);
                  return typeof value === "function" ? value.bind(st) : value;
                },
              });
            return wrap(stmt);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await Promise.all([
      ingestStatus({ ...e, DB: db }, fence, {
        chatExternalId: "status-race",
        externalId: "same",
        status: "read",
      }),
      event("status-race"),
    ]);
    expect((await queryMessages(e, { chatId: a.id })).items[0]!.status).toBe(
      "read",
    );
    expect(
      (
        await e.DB.prepare(
          "SELECT id FROM pending_statuses WHERE external_id='same'",
        ).all()
      ).results,
    ).toHaveLength(0);
  });
  it("cobertura sinaliza intervalo sem captura após desativação e retomada", async () => {
    const a = await chat("gaps");
    await setCapture(e, a.id, true, fence);
    expect((await queryMessages(e, { chatId: a.id })).coverage).toMatchObject({
      discontinuous: false,
    });
    await setCapture(e, a.id, false, fence);
    await setCapture(e, a.id, true, fence);
    expect((await queryMessages(e, { chatId: a.id })).coverage).toMatchObject({
      discontinuous: true,
    });
  });
  it("callback posterior preenche mídia e autoria ausentes mesmo sem legenda", async () => {
    const a = await chat("partial");
    await setCapture(e, a.id, true, fence);
    await event("partial", "one", {
      kind: "image",
      text: "legenda anterior",
      authorExternalId: undefined,
      authorName: undefined,
    });
    await event("partial", "one", {
      kind: "image",
      text: undefined,
      authorExternalId: "new-lid",
      authorName: "Nome",
      media: { url: "https://media.example/file" },
    });
    expect((await queryMessages(e, { chatId: a.id })).items[0]).toMatchObject({
      kind: "image",
      text: "legenda anterior",
      unavailableReason: null,
      authorName: "Nome",
    });
    expect(
      (await e.DB.prepare("SELECT * FROM media_jobs").all()).results,
    ).toHaveLength(1);
  });
  it("paginação do diretório preserva ausentes; filtro literal e cursor não cruzam conversa", async () => {
    const a = await chat("group-a");
    await chat("group-b");
    await upsertDirectoryPage(e, fence, {
      items: [{ externalId: "group-c", kind: "group", name: "C" }],
      complete: false,
      cursor: "page2",
    });
    expect((await listChats(e, {})).items).toHaveLength(3);
    await setCapture(e, a.id, true, fence);
    await event("group-a", "1", { timestamp: 1, text: "100% sim" });
    await event("group-a", "2", { timestamp: 2, text: "outro" });
    expect(
      (await queryMessages(e, { chatId: a.id, term: "%" })).items,
    ).toHaveLength(1);
    const first = await queryMessages(e, { chatId: a.id, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await queryMessages(e, {
      chatId: a.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    await expect(
      queryMessages(e, {
        chatId: (await listChats(e, {})).items.find((x) => x.id !== a.id)!.id,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});
