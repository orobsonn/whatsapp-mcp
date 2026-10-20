import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { upsertDirectoryPage, setCapture } from "../src/directory";
import { getChatExternal } from "../src/store";
import { ingestEvent, normalizeZapiEvent, queryMessages } from "../src/capture";
import { processMediaJobs } from "../src/media";
import { captureDiagnostics } from "../src/capture-policy";
const e = {
  ...env,
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "optout-e",
  CONNECTION_GENERATION: "optout-g",
  MAINTENANCE: "false",
} as Env;
const f = { epoch: e.INSTALLATION_EPOCH, generation: e.CONNECTION_GENERATION };
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM media_jobs;DELETE FROM media_derivatives;DELETE FROM media;DELETE FROM message_versions;DELETE FROM messages;DELETE FROM actions;DELETE FROM participants;DELETE FROM chats;DELETE FROM policies;DELETE FROM capture_metrics;",
  );
});
const event = (phone: string, isGroup: boolean, fromMe = false) =>
  normalizeZapiEvent({
    phone,
    isGroup,
    fromMe,
    messageId: "event-1",
    momment: 123,
    senderName: "Pessoa",
    participantLid: isGroup ? "author-lid" : undefined,
    text: { message: "conteúdo de teste" },
  });
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "webhook descobre chat novo, captura e deduplica (grupo=%s, próprio=%s)",
  async (isGroup, fromMe) => {
    const phone = isGroup ? "42-group" : "5511999999999";
    const first = await ingestEvent(e, f, event(phone, isGroup, fromMe));
    expect(first.captured).toBe(true);
    await ingestEvent(e, f, event(phone, isGroup, fromMe));
    const chat = await getChatExternal(e, phone, f);
    expect(chat?.capture_enabled).toBe(1);
    const data = await queryMessages(e, { chatId: chat!.id });
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.timestamp).toBe(123);
    expect(data.items[0]?.fromMe).toBe(fromMe);
  },
);
it.each(["individual", "group"] as const)(
  "diretório cria %s com padrão ativo e não sobrescreve opt-out",
  async (kind) => {
    const p = {
      items: [{ externalId: "entry", kind, name: "Equipe" }],
      complete: true,
    };
    const c = (await upsertDirectoryPage(e, f, p)).items[0]!;
    expect(c.captureEnabled).toBe(true);
    await setCapture(e, c.id, false, f);
    await upsertDirectoryPage({ ...e }, f, p);
    expect(
      (await ingestEvent({ ...e }, f, event("entry", kind === "group", true)))
        .captured,
    ).toBe(false);
    expect((await getChatExternal(e, "entry", f))?.capture_enabled).toBe(0);
    await setCapture({ ...e }, c.id, true, f);
    expect(
      (await ingestEvent({ ...e }, f, event("entry", kind === "group", true)))
        .captured,
    ).toBe(true);
    const d = await captureDiagnostics(e);
    expect(d.captureDefaultEnabled).toBe(true);
  },
);
it("não inventa tipo de chat desconhecido e preserva escolha global após reinício", async () => {
  const x = event("unknown", false);
  delete x.chatKind;
  expect((await ingestEvent(e, f, x)).captured).toBe(false);
  expect(await getChatExternal(e, "unknown", f)).toBeNull();
  await env.DB.prepare(
    "INSERT INTO policies(key,value_json,epoch,updated_at) VALUES(?,?,?,?)",
  )
    .bind(
      `capture_default_enabled:${f.generation}`,
      "false",
      f.epoch,
      Date.now(),
    )
    .run();
  const p = {
    items: [{ externalId: "x", kind: "individual" as const, name: "X" }],
    complete: true,
  };
  const c = (await upsertDirectoryPage({ ...e }, f, p)).items[0]!;
  expect(c.captureEnabled).toBe(false);
  await setCapture(e, c.id, false, f);
  await env.DB.prepare("DELETE FROM policies WHERE key=?")
    .bind(`capture_default_enabled:${f.generation}`)
    .run();
  expect((await getChatExternal({ ...e }, "x", f))?.capture_enabled).toBe(0);
});

it("migração é idempotente, segura para legados ambíguos e não usa propostas applied como prova", async () => {
  await env.DB.exec(
    "DROP TRIGGER capture_chat_insert;DELETE FROM capture_migrations;",
  );
  for (const [id, kind, on] of [
    ["old-person", "individual", 0],
    ["old-group", "group", 0],
    ["old-on", "group", 1],
  ] as const)
    await env.DB.prepare(
      "INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)",
    )
      .bind(id, f.epoch, f.generation, id, kind, id, on)
      .run();
  await env.DB.prepare(
    "INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at) VALUES('old-message','old-on',?,?,'old-msg',0,'text','histórico intacto',1,1)",
  )
    .bind(f.epoch, f.generation)
    .run();
  const sql = env.TEST_MIGRATIONS.find(
    (m) => m.name === "0009_capture_optout.sql",
  )!.queries;
  for (const q of sql) await env.DB.prepare(q).run();
  expect(
    await env.DB.prepare(
      "SELECT mode FROM capture_settings WHERE chat_id='old-person'",
    ).first("mode"),
  ).toBe("legacy_hold");
  expect(
    await env.DB.prepare(
      "SELECT capture_enabled FROM chats WHERE id='old-group'",
    ).first("capture_enabled"),
  ).toBe(0);
  await setCapture(e, "old-on", false, f);
  for (const q of sql) await env.DB.prepare(q).run();
  expect(
    await env.DB.prepare(
      "SELECT mode FROM capture_settings WHERE chat_id='old-on'",
    ).first("mode"),
  ).toBe("disabled");
  expect(
    await env.DB.prepare(
      "SELECT text FROM messages WHERE id='old-message'",
    ).first("text"),
  ).toBe("histórico intacto");
  expect((await captureDiagnostics(e)).counts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "group", legacyHold: 1, explicitOff: 1 }),
    ]),
  );
});
it("webhook e sincronização concorrentes mantêm a mesma identidade e exceção", async () => {
  await Promise.all([
    ingestEvent(e, f, event("race", true)),
    upsertDirectoryPage(e, f, {
      items: [{ externalId: "race", kind: "group", name: "Equipe" }],
      complete: true,
    }),
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM chats WHERE external_id='race'",
    ).first("n"),
  ).toBe(1);
  const c = await getChatExternal(e, "race", f);
  await setCapture(e, c!.id, false, f);
  await Promise.all([
    ingestEvent(e, f, event("race", true)),
    upsertDirectoryPage(e, f, {
      items: [{ externalId: "race", kind: "group", name: "Equipe" }],
      complete: true,
    }),
  ]);
  expect((await getChatExternal(e, "race", f))?.capture_enabled).toBe(0);
});
it("opt-out antes do batch impede autor e mídia, incluindo mensagem já existente", async () => {
  const first = await ingestEvent(e, f, event("concurrent", true));
  const c = await getChatExternal(e, "concurrent", f);
  let intercepted = false;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true;
        await setCapture(e, c!.id, false, f);
      }
      return env.DB.batch(statements);
    },
  } as D1Database;
  const wire = {
    ...event("concurrent", true),
    kind: "image" as const,
    revision: 2,
    authorExternalId: "must-not-store",
    media: { url: "https://media.example/new.png" },
  };
  expect((await ingestEvent({ ...e, DB: db }, f, wire, true)).captured).toBe(
    false,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM participants WHERE external_id='must-not-store'",
    ).first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM media WHERE message_id=?")
      .bind(first.messageId)
      .first("n"),
  ).toBe(0);
  const m = await env.DB.prepare("SELECT kind,version FROM messages WHERE id=?")
    .bind(first.messageId)
    .first();
  expect(m).toEqual({ kind: "text", version: 1 });
});
it("métricas de callback não contam replay como mensagem nova e não expõem conteúdo", async () => {
  const x = event("metric", false);
  await ingestEvent(e, f, x, true);
  await ingestEvent(e, f, x, true);
  const c = await getChatExternal(e, "metric", f);
  await setCapture(e, c!.id, false, f);
  await ingestEvent(e, f, x, true);
  const d = await captureDiagnostics(e);
  expect(d.metrics[0]).toMatchObject({
    received: 3,
    stored: 1,
    duplicates: 1,
    skipped: 1,
  });
  expect(JSON.stringify(d)).not.toMatch(
    /conteúdo de teste|5511999999999|Pessoa/,
  );
  expect(d.gaps).toMatchObject({ openPeriods: 1 });
});
it("alteração global só afeta defaults da instalação/geração certa", async () => {
  const items = (
    await upsertDirectoryPage(e, f, {
      items: [
        { externalId: "default", kind: "group", name: "Default" },
        { externalId: "off", kind: "group", name: "Off" },
      ],
      complete: true,
    })
  ).items;
  const off = items.find((x) => x.name === "Off")!;
  await setCapture(e, off.id, false, f);
  await env.DB.prepare(
    "INSERT INTO policies(key,value_json,epoch,updated_at) VALUES(?,?,?,?)",
  )
    .bind(
      `capture_default_enabled:${f.generation}`,
      "false",
      "other-epoch",
      Date.now(),
    )
    .run();
  expect((await getChatExternal(e, "default", f))?.capture_enabled).toBe(1);
  await env.DB.prepare("UPDATE policies SET epoch=?").bind(f.epoch).run();
  expect((await getChatExternal(e, "default", f))?.capture_enabled).toBe(0);
  await env.DB.prepare("DELETE FROM policies").run();
  expect((await getChatExternal(e, "default", f))?.capture_enabled).toBe(1);
  expect((await getChatExternal(e, "off", f))?.capture_enabled).toBe(0);
});

it("opt-out cancela download em andamento e não publica bytes recebidos depois", async () => {
  const x = {
    ...event("download-stop", true),
    kind: "image" as const,
    media: { url: "https://media.example/file.png", mime: "image/png" },
  };
  await ingestEvent(e, f, x);
  const c = await getChatExternal(e, "download-stop", f);
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6xkAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  const r = await processMediaJobs(
    { ...e, MEDIA_HOSTS: "media.example" },
    async () => {
      await setCapture(e, c!.id, false, f);
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    },
  );
  expect(r.ready).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT status FROM media_jobs WHERE media_id IN(SELECT id FROM media WHERE chat_id=?)",
    )
      .bind(c!.id)
      .first("status"),
  ).toBe("cancelled");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM media WHERE chat_id=? AND state='ready'",
    )
      .bind(c!.id)
      .first("n"),
  ).toBe(0);
  expect((await e.MEDIA.list()).objects).toHaveLength(0);
});
