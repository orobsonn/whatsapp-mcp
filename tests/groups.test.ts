import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { upsertDirectoryPage } from "../src/directory";
import {
  prepareGroupAction,
  approveGroupAction,
  executeGroupAction,
  getGroupAction,
  cancelGroupAction,
  readGroup,
  readGroupInviteMetadata,
  listGroupChats,
  groupActionSchema,
  invalidateGroupActionsStatements,
  cleanupGroupActions,
} from "../src/groups";
import type { GroupProvider } from "../src/group-types";
import { uploadMedia } from "../src/media";
const e: Env = {
  ...env,
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "e",
  CONNECTION_GENERATION: "g",
  CONNECTED_PHONE: "5511000000000",
  MAINTENANCE: "false",
  PUBLIC_ORIGIN: "https://example.test",
};
let group: string, other: string, contact: string, calls: number;
const metadata = (phone = "123@g.us") => ({
  phone,
  subject: "Equipe",
  communityId: "community-external",
  participants: [{ phone: "5511999999999", name: "Ana", isAdmin: true }],
});
const provider: GroupProvider = {
  status: async () => ({ connected: true, phone: e.CONNECTED_PHONE }),
  metadata: async (id) => metadata(id),
  invitationMetadata: async () => metadata(),
  invitationLink: async () => "https://chat.whatsapp.com/SECRETinvite",
  listChats: async () => [],
  chatMetadata: async (id) => ({ phone: id, isGroup: true }),
  listCommunities: async () => [],
  communityMetadata: async (id) => ({ id, name: "Comunidade", subGroups: [] }),
  mutate: async () => {
    calls++;
    return { outcome: "accepted", evidence: "provider_ack" };
  },
};
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM group_action_targets; DELETE FROM group_actions; DELETE FROM group_member_refs; DELETE FROM group_community_refs; DELETE FROM actions; DELETE FROM media_jobs; DELETE FROM media_derivatives; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM participants; DELETE FROM directory_syncs; DELETE FROM chats;",
  );
  calls = 0;
  const p = await upsertDirectoryPage(
    e,
    { epoch: "e", generation: "g" },
    {
      items: [
        { externalId: "123@g.us", kind: "group", name: "Equipe" },
        { externalId: "456@g.us", kind: "group", name: "Outro" },
        { externalId: "5511999999999", kind: "individual", name: "Ana" },
      ],
      complete: true,
    },
  );
  [group, other, contact] = p.items.map((i) => i.id) as [
    string,
    string,
    string,
  ];
});
async function approve(input: unknown) {
  const a = await prepareGroupAction(e, input, provider);
  await approveGroupAction(e, a.id, {
    sub: "owner",
    epoch: "e",
    purpose: "group",
    resourceId: a.id,
    envelopeHash: a.hash,
  });
  return a;
}
describe("gestão de grupos com confirmação e uma tentativa", () => {
  it("recusa campos desconhecidos, tipos de referência e confirmação sem propósito group", async () => {
    expect(() =>
      groupActionSchema.parse({
        operation: "leave",
        chatId: "x",
        endpoint: "x",
      }),
    ).toThrow();
    await expect(
      prepareGroupAction(e, { operation: "leave", chatId: contact }, provider),
    ).rejects.toMatchObject({ code: "group_required" });
    const a = await prepareGroupAction(
      e,
      { operation: "leave", chatId: group },
      provider,
    );
    await expect(
      approveGroupAction(e, a.id, {
        sub: "owner",
        epoch: "e",
        purpose: "send",
        resourceId: a.id,
        envelopeHash: a.hash,
      }),
    ).rejects.toMatchObject({ code: "approval_mismatch" });
    await expect(executeGroupAction(e, a.id, provider)).rejects.toMatchObject({
      code: "action_not_approved",
    });
    expect(calls).toBe(0);
  });
  it("concorrência e timeout nunca repetem uma mutação", async () => {
    const a = await approve({ operation: "name", chatId: group, name: "Novo" });
    await Promise.all([
      executeGroupAction(e, a.id, provider),
      executeGroupAction(e, a.id, provider),
    ]);
    expect(calls).toBe(1);
    expect((await getGroupAction(e, a.id)).status).toBe("accepted");
    const b = await approve({ operation: "leave", chatId: group });
    const timeout = {
      ...provider,
      mutate: async () => {
        calls++;
        throw new Error("SECRET");
      },
    };
    expect((await executeGroupAction(e, b.id, timeout)).status).toBe(
      "uncertain",
    );
    await executeGroupAction(e, b.id, timeout);
    expect(calls).toBe(2);
    expect(JSON.stringify(await getGroupAction(e, b.id))).not.toContain(
      "SECRET",
    );
  });
  it("vincula membro ao grupo e rejeita LID em contratos de telefone", async () => {
    const r = await readGroup(e, { chatId: group }, provider);
    const member = r.items[0]!.id;
    await expect(
      prepareGroupAction(
        e,
        {
          operation: "remove_participants",
          chatId: other,
          memberIds: [member],
        },
        provider,
      ),
    ).rejects.toMatchObject({ code: "member_not_found" });
    await env.DB.prepare(
      "UPDATE group_member_refs SET external_id=? WHERE id=?",
    )
      .bind("123@lid", member)
      .run();
    await expect(
      prepareGroupAction(
        e,
        {
          operation: "remove_participants",
          chatId: group,
          memberIds: [member],
        },
        provider,
      ),
    ).rejects.toMatchObject({ code: "unsupported_lid" });
  });
  it("alteração aninhada pública ou privada invalida a aprovação", async () => {
    for (const field of ["envelope_json", "private_json"]) {
      const a = await approve({
        operation: "settings",
        chatId: group,
        adminOnlyMessage: true,
        adminOnlySettings: false,
        requireAdminApproval: true,
        adminOnlyAddMember: false,
      });
      const row = await env.DB.prepare(
        `SELECT ${field} value FROM group_actions WHERE id=?`,
      )
        .bind(a.id)
        .first<{ value: string }>();
      const data = JSON.parse(row!.value);
      if (field === "envelope_json") data.operation.adminOnlySettings = true;
      else data.bindings[0].externalId = "999@g.us";
      await env.DB.prepare(`UPDATE group_actions SET ${field}=? WHERE id=?`)
        .bind(JSON.stringify(data), a.id)
        .run();
      await expect(executeGroupAction(e, a.id, provider)).rejects.toMatchObject(
        { code: "action_changed" },
      );
    }
    expect(calls).toBe(0);
  });
  it("claim recusa mudança de alvo e mídia revogada durante preflight", async () => {
    const a = await approve({ operation: "leave", chatId: group });
    await expect(
      executeGroupAction(e, a.id, {
        ...provider,
        status: async () => {
          await env.DB.prepare("UPDATE chats SET external_id=? WHERE id=?")
            .bind("999@g.us", group)
            .run();
          return { connected: true, phone: e.CONNECTED_PHONE };
        },
      }),
    ).rejects.toMatchObject({ code: "group_binding_changed" });
    expect(calls).toBe(0);
  });
  it("convite fica privado; criação parcial materializa referência com captura padrão", async () => {
    const a = await approve({
      operation: "accept_invite",
      inviteURL: "https://chat.whatsapp.com/SECRETinvite",
    });
    expect(JSON.stringify(a)).not.toContain("SECRETinvite");
    const meta = await readGroupInviteMetadata(
      e,
      { invite: "https://chat.whatsapp.com/SECRETinvite" },
      provider,
    );
    expect(JSON.stringify(meta)).not.toContain("SECRETinvite");
    const b = await approve({
      operation: "create",
      name: "Novo",
      contactIds: [contact],
      autoInvite: true,
    });
    const out = await executeGroupAction(e, b.id, {
      ...provider,
      mutate: async () => {
        calls++;
        return {
          outcome: "accepted",
          evidence: "provider_ack",
          groupId: "789@g.us",
          notAdded: ["5511999999999"],
          invitationLink: "https://chat.whatsapp.com/SECRETinvite",
          partial: true,
        };
      },
    });
    expect(out.result).toMatchObject({ partial: true, notAddedCount: 1 });
    expect(out.result?.chat).toMatchObject({
      name: "Novo",
      captureEnabled: true,
    });
    expect(JSON.stringify(out)).not.toContain("5511999999999");
    expect(JSON.stringify(out)).not.toContain("SECRETinvite");
    await executeGroupAction(e, b.id, provider);
    expect(calls).toBe(1);
  });
  it("cursor é vinculado a escopo/snapshot e página filtrada vazia não encerra", async () => {
    const p = {
      ...provider,
      metadata: async (id: string) => ({
        ...metadata(id),
        participants: [
          ...metadata().participants,
          { phone: "5511888888888", name: "Bia" },
        ],
      }),
    };
    const first = await readGroup(e, { chatId: group, limit: 1 }, p);
    expect(first.nextCursor).toBeTruthy();
    await expect(
      readGroup(e, { chatId: other, limit: 1, cursor: first.nextCursor }, p),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    const page = await listGroupChats(
      e,
      { page: 1, pageSize: 1 },
      {
        ...provider,
        listChats: async () => [{ phone: "5511888888888", isGroup: false }],
      },
    );
    expect(page).toMatchObject({ items: [], complete: false, nextPage: 2 });
  });
  it("exclusão de alvo secundário cancela e cleanup redige snapshots", async () => {
    const a = await approve({
      operation: "mention_groups",
      chatId: group,
      groupIds: [other],
      text: `@{${other}} olá`,
    });
    await env.DB.batch(invalidateGroupActionsStatements(e, other));
    expect((await getGroupAction(e, a.id)).status).toBe("cancelled");
    await cleanupGroupActions(e);
    expect(await getGroupAction(e, a.id)).toMatchObject({
      status: "cancelled",
      redacted: true,
      envelope: null,
    });
    expect(calls).toBe(0);
  });
});
describe("fences de privacidade e recuperação local", () => {
  it("recusa foto revogada durante status e snapshot/hash/version alterado", async () => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const media = await uploadMedia(e, group, {
      bytes: png,
      mime: "image/png",
      filename: "foto.png",
    });
    const a = await approve({
      operation: "photo",
      chatId: group,
      mediaId: media.id,
      mediaHash: media.sha256,
    });
    await expect(
      executeGroupAction(e, a.id, {
        ...provider,
        status: async () => {
          await env.DB.prepare("UPDATE media SET deleted_at=? WHERE id=?")
            .bind(Date.now(), media.id)
            .run();
          return { connected: true, phone: e.CONNECTED_PHONE };
        },
      }),
    ).rejects.toMatchObject({ code: "group_binding_changed" });
    expect(calls).toBe(0);
  });
  it("aging redige resultados tentados sem perder o estado mínimo", async () => {
    const a = await approve({
      operation: "accept_invite",
      inviteURL: "https://chat.whatsapp.com/SECRETinvite",
    });
    await executeGroupAction(e, a.id, provider);
    await env.DB.prepare("UPDATE group_actions SET expires_at=0 WHERE id=?")
      .bind(a.id)
      .run();
    expect(await cleanupGroupActions(e)).toBe(1);
    const row = await env.DB.prepare(
      "SELECT private_json,envelope_json,ack_json FROM group_actions WHERE id=?",
    )
      .bind(a.id)
      .first();
    expect(row).toEqual({
      private_json: "{}",
      envelope_json: "{}",
      ack_json: null,
    });
    expect(await getGroupAction(e, a.id)).toMatchObject({
      status: "accepted",
      redacted: true,
    });
    await executeGroupAction(e, a.id, provider);
    expect(calls).toBe(1);
  });
  it("guard falso não cancela e exclusão verdadeira redige inclusive ações aceitas", async () => {
    const a = await approve({ operation: "name", chatId: group, name: "Novo" });
    await env.DB.batch(
      invalidateGroupActionsStatements(e, group, { sql: "?=1", binds: [0] }),
    );
    expect((await getGroupAction(e, a.id)).status).toBe("approved");
    await executeGroupAction(e, a.id, provider);
    await readGroup(e, { chatId: group }, provider);
    await env.DB.batch(
      invalidateGroupActionsStatements(e, group, { sql: "?=1", binds: [1] }),
    );
    expect(await getGroupAction(e, a.id)).toMatchObject({
      status: "accepted",
      redacted: true,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM group_member_refs WHERE chat_id=?",
        )
          .bind(group)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("grupo grande materializa só a página limitada e mantém referências/cursor estáveis", async () => {
    const large = {
      ...provider,
      metadata: async (id: string) => ({
        ...metadata(id),
        participants: Array.from({ length: 250 }, (_, i) => ({
          phone: `5511${String(i).padStart(9, "0")}`,
          name: `Participante ${i}`,
        })),
      }),
    };
    const first = await readGroup(e, { chatId: group, limit: 2 }, large);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM group_member_refs").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(2);
    const repeated = await readGroup(e, { chatId: group, limit: 2 }, large);
    expect(repeated.items).toEqual(first.items);
    const second = await readGroup(
      e,
      { chatId: group, limit: 2, cursor: first.nextCursor },
      large,
    );
    expect(second.items.map((i) => i.id)).not.toEqual(
      first.items.map((i) => i.id),
    );
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM group_member_refs").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(4);
  });
  it("retoma materialização após ack conhecido sem repetir criação", async () => {
    const a = await approve({
      operation: "create",
      name: "Novo",
      contactIds: [contact],
      autoInvite: false,
    });
    let fail = true;
    const db = new Proxy(e.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (fail) {
              fail = false;
              throw new Error("local failure");
            }
            return target.batch(statements);
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const p = {
      ...provider,
      mutate: async () => {
        calls++;
        return {
          outcome: "accepted" as const,
          evidence: "provider_ack" as const,
          groupId: "999@g.us",
        };
      },
    };
    expect(
      (await executeGroupAction({ ...e, DB: db }, a.id, p)).result,
    ).toMatchObject({ localReferencePending: true });
    expect((await executeGroupAction(e, a.id, p)).result?.chat).toMatchObject({
      name: "Novo",
      captureEnabled: true,
    });
    expect(calls).toBe(1);
  });
});
describe("contratos de identidade e apresentação", () => {
  it("aceita endereço oficial -group sem converter e resolve menção por referência interna", async () => {
    await env.DB.prepare("UPDATE chats SET external_id=? WHERE id=?")
      .bind("120363019502650977-group", other)
      .run();
    const a = await approve({
      operation: "mention_groups",
      chatId: group,
      groupIds: [other],
      text: `Confira @{${other}}`,
    });
    let actual: unknown;
    await executeGroupAction(e, a.id, {
      ...provider,
      mutate: async (input) => {
        calls++;
        actual = input;
        return { outcome: "accepted", evidence: "provider_ack" };
      },
    });
    expect(actual).toMatchObject({
      operation: "mention_groups",
      message: "Confira @120363019502650977-group",
      groupMentioned: [{ phone: "120363019502650977-group", subject: "Outro" }],
    });
    expect(JSON.stringify(await getGroupAction(e, a.id))).not.toContain(
      "120363019502650977-group",
    );
  });
  it("convite mostra grupo legível e bloqueia mudança do alvo remoto", async () => {
    const a = await approve({
      operation: "accept_invite",
      inviteURL: "https://chat.whatsapp.com/SECRETinvite",
    });
    expect(a.envelope?.operation).toMatchObject({
      inviteTarget: { name: "Equipe", participantsCount: 1 },
    });
    await expect(
      executeGroupAction(e, a.id, {
        ...provider,
        invitationMetadata: async () => ({ ...metadata(), subject: "Outro" }),
      }),
    ).rejects.toMatchObject({ code: "group_binding_changed" });
    expect(calls).toBe(0);
  });
  it("papel ausente continua desconhecido; mudança de nome invalida ação anterior", async () => {
    const p = {
      ...provider,
      metadata: async (id: string) => ({
        ...metadata(id),
        participants: [{ phone: "5511999999999", name: "Nome inicial" }],
      }),
    };
    const first = await readGroup(e, { chatId: group }, p);
    expect(first.items[0]).toMatchObject({
      name: "Nome inicial",
      isAdmin: null,
      isSuperAdmin: null,
    });
    const a = await approve({
      operation: "remove_participants",
      chatId: group,
      memberIds: [first.items[0]!.id],
    });
    const renamed = await readGroup(
      e,
      { chatId: group },
      {
        ...p,
        metadata: async (id: string) => ({
          ...metadata(id),
          participants: [{ phone: "5511999999999", name: "Nome atual" }],
        }),
      },
    );
    expect(renamed.items[0]!.name).toBe("Nome atual");
    await expect(executeGroupAction(e, a.id, provider)).rejects.toMatchObject({
      code: "group_binding_changed",
    });
    expect(calls).toBe(0);
  });
  it("cleanup nunca importa ack de geração antiga para a instalação atual", async () => {
    const a = await approve({
      operation: "create",
      name: "Antigo",
      contactIds: [contact],
      autoInvite: false,
    });
    await env.DB.prepare(
      "UPDATE group_actions SET status='accepted',expires_at=0,ack_json=?,result_json=? WHERE id=?",
    )
      .bind(
        JSON.stringify({
          groupId: "876@g.us",
          partial: false,
          notAddedCount: 0,
        }),
        JSON.stringify({ localReferencePending: true }),
        a.id,
      )
      .run();
    await cleanupGroupActions({ ...e, CONNECTION_GENERATION: "g2" });
    expect(
      await env.DB.prepare("SELECT id FROM chats WHERE external_id=?")
        .bind("876@g.us")
        .first(),
    ).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT private_json FROM group_actions WHERE id=?",
        )
          .bind(a.id)
          .first<{ private_json: string }>()
      )?.private_json,
    ).toBe("{}");
  });
});
it("chat resultante de criação participa da exclusão local da mesma ação", async () => {
  const a = await approve({
    operation: "create",
    name: "Novo",
    contactIds: [contact],
    autoInvite: false,
  });
  const out = await executeGroupAction(e, a.id, {
    ...provider,
    mutate: async () => {
      calls++;
      return {
        outcome: "accepted",
        evidence: "provider_ack",
        groupId: "432@g.us",
      };
    },
  });
  expect(out.result?.chat?.id).toBeTruthy();
  await env.DB.batch(invalidateGroupActionsStatements(e, out.result!.chat!.id));
  expect(await getGroupAction(e, a.id)).toMatchObject({
    status: "accepted",
    redacted: true,
    result: null,
  });
  expect(
    (
      await env.DB.prepare("SELECT private_json FROM group_actions WHERE id=?")
        .bind(a.id)
        .first<{ private_json: string }>()
    )?.private_json,
  ).toBe("{}");
  expect(calls).toBe(1);
});

it("cleanup remove ack já redigido de geração antiga e libera o próximo lote", async () => {
  const a = await approve({
    operation: "create",
    name: "Recuperação antiga",
    contactIds: [contact],
    autoInvite: false,
  });
  await env.DB.prepare(
    "UPDATE group_actions SET status='accepted',expires_at=0,envelope_json='{}',private_json='{}',ack_json=?,result_json=? WHERE id=?",
  )
    .bind(
      JSON.stringify({
        groupId: "998-group",
        name: "Recuperação antiga",
        needsReference: true,
        partial: false,
        notAddedCount: 0,
      }),
      JSON.stringify({ localReferencePending: true }),
      a.id,
    )
    .run();
  const rotated = { ...e, CONNECTION_GENERATION: "g2" };
  expect(await cleanupGroupActions(rotated, 1)).toBe(1);
  expect(
    (
      await env.DB.prepare("SELECT ack_json FROM group_actions WHERE id=?")
        .bind(a.id)
        .first<{ ack_json: string | null }>()
    )?.ack_json,
  ).toBeNull();
  expect(await cleanupGroupActions(rotated, 1)).toBe(0);
});
it("uses chat for creating a group but never for clearing a chat", async () => {
  const create = await prepareGroupAction(
    e,
    {
      operation: "create",
      name: "Equipe sintética",
      contactIds: [contact],
      autoInvite: false,
    },
    provider,
  );
  expect(create.confirmationMode).toBe("chat");
  expect(create.confirmationUrl).toBeUndefined();
  await executeGroupAction(e, create.id, provider, {
    confirmed: true,
    hash: create.hash,
  });
  expect(calls).toBe(1);
  const clear = await prepareGroupAction(
    e,
    { operation: "chat_clear", chatId: group },
    provider,
  );
  expect(clear.confirmationMode).toBe("page");
  expect(clear.confirmationUrl).toContain("/confirm/group/");
  await expect(
    executeGroupAction(e, clear.id, provider, {
      confirmed: true,
      hash: clear.hash,
    }),
  ).rejects.toThrow("browser_confirmation_required");
  expect(calls).toBe(1);
});
