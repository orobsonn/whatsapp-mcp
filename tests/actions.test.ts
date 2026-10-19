import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  canonicalEnvelope,
  actionDigest,
  prepareAction,
  approveAction,
  executeAction,
  getAction,
  cancelAction,
  reconcileActions,
} from "../src/actions";
import { upsertDirectoryPage, setCapture } from "../src/directory";
import { queryMessages, ingestStatus } from "../src/capture";
import { uploadMedia, readMedia } from "../src/media";
import type { Env } from "../src/env";

describe("envelope de envio", () => {
  const text = {
    chatId: "chat-1",
    kind: "text" as const,
    text: "Olá",
    replyTo: "msg-1",
  };
  it("vincula destino, texto, citação e bytes imutáveis ao digest", async () => {
    const original = await actionDigest(text);
    expect(await actionDigest({ ...text, chatId: "chat-2" })).not.toBe(
      original,
    );
    expect(await actionDigest({ ...text, text: "Outro" })).not.toBe(original);
    expect(await actionDigest({ ...text, replyTo: "msg-2" })).not.toBe(
      original,
    );
    const file = {
      chatId: "chat-1",
      kind: "pdf" as const,
      mediaId: "file-1",
      mediaHash: "a".repeat(64),
      caption: "Contrato",
      fileName: "contrato.pdf",
    };
    expect(await actionDigest({ ...file, mediaHash: "b".repeat(64) })).not.toBe(
      await actionDigest(file),
    );
    expect(await actionDigest({ ...file, caption: "Alterada" })).not.toBe(
      await actionDigest(file),
    );
    expect(await actionDigest({ ...file, fileName: "outro.pdf" })).not.toBe(
      await actionDigest(file),
    );
    expect(
      canonicalEnvelope({
        replyTo: "msg-1",
        text: "Olá",
        kind: "text",
        chatId: "chat-1",
      }),
    ).toBe(canonicalEnvelope(text));
  });
  it("recusa endpoint/URL arbitrários, campos desconhecidos, texto vazio e mídia sem hash", () => {
    for (const invalid of [
      { ...text, url: "https://attacker.invalid" },
      { ...text, text: " " },
      { chatId: "chat-1", kind: "pdf", mediaId: "file-1" },
      { chatId: "chat-1", kind: "execute", text: "Olá" },
      { ...text, text: "x".repeat(8001) },
    ])
      expect(() => canonicalEnvelope(invalid)).toThrow();
  });
});

const e: Env = {
  ...env,
  OWNER_SUB: "synthetic-owner",
  INSTALLATION_EPOCH: "e1",
  CONNECTION_GENERATION: "g1",
  CONNECTED_PHONE: "synthetic-device",
  MAINTENANCE: "false",
  PUBLIC_ORIGIN: "https://mcp.example.test",
};
const f = { epoch: "e1", generation: "g1" };
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM actions; DELETE FROM media_jobs; DELETE FROM media_derivatives; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM participants; DELETE FROM directory_syncs; DELETE FROM chats;",
  );
});
async function prepared() {
  const { items } = await upsertDirectoryPage(e, f, {
    items: [{ externalId: "group-actions", kind: "group", name: "Equipe" }],
    complete: true,
  });
  return prepareAction(e, {
    chatId: items[0]!.id,
    kind: "text",
    text: "Ensaio sintético",
  });
}
async function approved() {
  const a = await prepared();
  await approveAction(e, a.id, {
    sub: e.OWNER_SUB,
    epoch: f.epoch,
    purpose: "send",
    resourceId: a.id,
    envelopeHash: a.hash,
  });
  return a;
}
describe("ações D1 com uma tentativa e autorização vinculada", () => {
  it("sem confirmação não envia; confirmação de hash/dono diferente é recusada", async () => {
    const a = await prepared();
    let sends = 0;
    const p = {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => {
        sends++;
        return { messageId: "out-1" };
      },
    };
    await expect(executeAction(e, a.id, p)).rejects.toMatchObject({
      code: "action_not_approved",
    });
    await expect(
      approveAction(e, a.id, {
        sub: "attacker",
        epoch: f.epoch,
        purpose: "send",
        resourceId: a.id,
        envelopeHash: a.hash,
      }),
    ).rejects.toThrow();
    await expect(
      approveAction(e, a.id, {
        sub: e.OWNER_SUB,
        epoch: f.epoch,
        purpose: "send",
        resourceId: a.id,
        envelopeHash: "bad",
      }),
    ).rejects.toThrow();
    expect(sends).toBe(0);
  });
  it("duas execuções concorrentes fazem no máximo uma tentativa", async () => {
    const a = await approved();
    let sends = 0;
    const p = {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => {
        sends++;
        return { messageId: "out-unique", zaapId: "zaap-distinct" };
      },
    };
    await Promise.allSettled([
      executeAction(e, a.id, p),
      executeAction(e, a.id, p),
    ]);
    expect(sends).toBe(1);
    const result = await getAction(e, a.id);
    expect(result.status).toBe("accepted");
    expect(JSON.stringify(result)).not.toContain("group-actions");
    expect(JSON.stringify(result)).not.toContain("zaap-distinct");
  });
  it("timeout após claim fica incerto; a mesma ação nunca repete", async () => {
    const a = await approved();
    let sends = 0;
    const p = {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => {
        sends++;
        throw new Error("remote failure with SECRET");
      },
    };
    expect((await executeAction(e, a.id, p)).status).toBe("uncertain");
    await executeAction(e, a.id, p);
    expect(sends).toBe(1);
    expect(JSON.stringify(await getAction(e, a.id))).not.toContain("SECRET");
  });
  it("expiração, cancelamento, aparelho trocado e epoch antigo impedem efeito", async () => {
    const a = await approved();
    let sends = 0;
    const p = {
      status: async () => ({ connected: true, phone: "other-device" }),
      send: async () => {
        sends++;
        return { messageId: "x" };
      },
    };
    await expect(executeAction(e, a.id, p)).rejects.toMatchObject({
      code: "device_changed",
    });
    await cancelAction(e, a.id);
    expect((await getAction(e, a.id)).status).toBe("cancelled");
    await executeAction(e, a.id, p);
    const b = await approved();
    await env.DB.prepare("UPDATE actions SET expires_at=0 WHERE id=?")
      .bind(b.id)
      .run();
    await expect(executeAction(e, b.id, p)).rejects.toMatchObject({
      code: "action_expired",
    });
    await expect(
      getAction({ ...e, INSTALLATION_EPOCH: "e2" }, b.id),
    ).rejects.toMatchObject({ code: "action_not_found" });
    expect(sends).toBe(0);
  });
  it("arquiva saída própria com estado aceito e concilia callback anterior à resposta", async () => {
    const a = await approved();
    await setCapture(e, a.chat.id, true, f);
    await executeAction(e, a.id, {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => ({ messageId: "own-accepted" }),
    });
    let messages = await queryMessages(e, { chatId: a.chat.id });
    expect(
      messages.items.find((m) => m.text === "Ensaio sintético"),
    ).toMatchObject({ fromMe: true, status: "accepted" });
    const b = await approved();
    const result = await executeAction(e, b.id, {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => {
        await ingestStatus(e, f, {
          externalId: "own-read",
          chatExternalId: "group-actions",
          status: "read",
        });
        return { messageId: "own-read" };
      },
    });
    expect(result.status).toBe("read");
    messages = await queryMessages(e, { chatId: a.chat.id });
    expect(messages.items).toHaveLength(2);
  });
  it("envia bytes imutáveis e preserva o PDF de saída no arquivo sem depender do callback", async () => {
    const a = await prepared();
    await setCapture(e, a.chat.id, true, f);
    const bytes = new TextEncoder().encode("%PDF-1.4\nEnsaio sintético\n%%EOF");
    const media = await uploadMedia(e, a.chat.id, {
      bytes,
      mime: "application/pdf",
      filename: "ensaio.pdf",
    });
    const action = await prepareAction(e, {
      chatId: a.chat.id,
      kind: "pdf",
      mediaId: media.id,
      mediaHash: media.sha256,
      caption: "Confira",
    });
    await approveAction(e, action.id, {
      sub: e.OWNER_SUB,
      epoch: f.epoch,
      purpose: "send",
      resourceId: action.id,
      envelopeHash: action.hash,
    });
    let sent: Uint8Array | undefined;
    await executeAction(e, action.id, {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async (input) => {
        sent = input.bytes;
        return { messageId: "pdf-own" };
      },
    });
    expect(sent).toEqual(bytes);
    const messages = await queryMessages(e, { chatId: a.chat.id });
    const output = messages.items.find((m) => m.kind === "pdf");
    expect(output).toMatchObject({
      fromMe: true,
      text: "Confira",
      status: "accepted",
    });
    expect(output?.mediaId).toBeTruthy();
    expect((await readMedia(e, output!.mediaId!)).bytes).toEqual(bytes);
  });
  it("conteúdo alterado ou apagado após aprovação não pode enviar; consulta redigida continua recuperável", async () => {
    const a = await approved();
    let sends = 0;
    const provider = {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => {
        sends++;
        return { messageId: "changed" };
      },
    };
    await env.DB.prepare("UPDATE actions SET envelope_json=? WHERE id=?")
      .bind(JSON.stringify({ ...a.envelope, text: "alterado" }), a.id)
      .run();
    await expect(executeAction(e, a.id, provider)).rejects.toMatchObject({
      code: "action_changed",
    });
    await env.DB.prepare(
      "UPDATE actions SET envelope_json='{}',status='cancelled' WHERE id=?",
    )
      .bind(a.id)
      .run();
    expect(await getAction(e, a.id)).toMatchObject({
      status: "cancelled",
      redacted: true,
    });
    await executeAction(e, a.id, provider);
    expect(sends).toBe(0);
  });
  it.each([
    ["delivered", "read"],
    ["read", "delivered"],
  ] as const)(
    "preserva READ com callbacks concorrentes %s/%s",
    async (firstStatus, secondStatus) => {
      const a = await approved();
      await executeAction(e, a.id, {
        status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
        send: async () => ({ messageId: "concurrent-status" }),
      });
      let arrived = 0;
      let release: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wrap = (
        statement: D1PreparedStatement,
        sql: string,
      ): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind")
              return (...values: unknown[]) =>
                wrap(target.bind(...values), sql);
            if (key === "all" && sql.startsWith("SELECT a.id,a.status"))
              return async () => {
                const found = await target.all();
                if (++arrived === 2) release();
                await barrier;
                return found;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      const db = new Proxy(e.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => wrap(target.prepare(sql), sql);
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await Promise.all([
        reconcileActions(
          { ...e, DB: db },
          {
            externalId: "concurrent-status",
            chatExternalId: "group-actions",
            status: firstStatus,
          },
        ),
        reconcileActions(
          { ...e, DB: db },
          {
            externalId: "concurrent-status",
            chatExternalId: "group-actions",
            status: secondStatus,
          },
        ),
      ]);
      expect((await getAction(e, a.id)).status).toBe("read");
    },
  );
  it.each([true, false])(
    "concilia callback anterior ao retorno sem captura, com conversa=%s",
    async (withChat) => {
      const a = await approved();
      await setCapture(e, a.chat.id, false, f);
      const result = await executeAction(e, a.id, {
        status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
        send: async () => {
          await ingestStatus(e, f, {
            externalId: "early-without-capture",
            chatExternalId: withChat ? "group-actions" : undefined,
            status: "read",
          });
          await reconcileActions(e, {
            externalId: "early-without-capture",
            chatExternalId: withChat ? "group-actions" : undefined,
            status: "read",
          });
          return { messageId: "early-without-capture" };
        },
      });
      expect(result.status).toBe("read");
      expect(
        (await queryMessages(e, { chatId: a.chat.id })).items,
      ).toHaveLength(0);
    },
  );
  it("status sem conversa permanece pendente quando o mesmo ID pertence a dois chats", async () => {
    const a = await approved();
    await executeAction(e, a.id, {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => ({ messageId: "ambiguous" }),
    });
    const chat = (
      await upsertDirectoryPage(e, f, {
        items: [
          {
            externalId: "other-action-chat",
            kind: "individual",
            name: "Outro destino",
          },
        ],
        complete: true,
      })
    ).items[0]!;
    const b = await prepareAction(e, {
      chatId: chat.id,
      kind: "text",
      text: "Outro",
    });
    await approveAction(e, b.id, {
      sub: e.OWNER_SUB,
      epoch: f.epoch,
      purpose: "send",
      resourceId: b.id,
      envelopeHash: b.hash,
    });
    await executeAction(e, b.id, {
      status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
      send: async () => ({ messageId: "ambiguous" }),
    });
    await ingestStatus(e, f, { externalId: "ambiguous", status: "read" });
    await reconcileActions(e, { externalId: "ambiguous", status: "read" });
    await reconcileActions(e, {
      externalId: "ambiguous",
      chatExternalId: "group-actions",
      status: "accepted",
    });
    expect((await getAction(e, a.id)).status).toBe("accepted");
    expect((await getAction(e, b.id)).status).toBe("accepted");
    expect(
      await env.DB.prepare(
        "SELECT status_rank FROM pending_statuses WHERE external_id='ambiguous' AND chat_external_id=''",
      ).first(),
    ).toMatchObject({ status_rank: 4 });
  });
  it("WAV permanece arquivável mas não cria proposta enviável nem consome tentativa", async () => {
    const a = await prepared();
    const bytes = new Uint8Array(46),
      d = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    d.setUint32(4, 38, true);
    bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
    d.setUint32(16, 16, true);
    const media = await uploadMedia(e, a.chat.id, {
      bytes,
      mime: "audio/wav",
      filename: "ensaio.wav",
    });
    const before = await env.DB.prepare(
      "SELECT COUNT(*) n FROM actions",
    ).first<{ n: number }>();
    await expect(
      prepareAction(e, {
        chatId: a.chat.id,
        kind: "audio",
        mediaId: media.id,
        mediaHash: media.sha256,
      }),
    ).rejects.toMatchObject({ code: "unsupported_send_media" });
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM actions").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(before?.n);
    expect((await readMedia(e, media.id)).bytes).toEqual(bytes);
  });
});
