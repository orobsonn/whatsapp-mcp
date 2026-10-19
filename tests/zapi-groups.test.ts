import { describe, expect, it, vi } from "vitest";
import { ProviderUncertainError, ZapiError } from "../src/zapi";
import {
  ZapiGroupsClient,
  parseGroupInvite,
  validateGroupMutation,
  type ZapiGroupMutation,
} from "../src/zapi-groups";

const env = {
  ZAPI_INSTANCE_ID: "instance",
  ZAPI_TOKEN: "secret",
  ZAPI_CLIENT_TOKEN: "client-secret",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const client = (fetcher: typeof fetch) => new ZapiGroupsClient(env, fetcher);

describe("group provider contract", () => {
  it("maps every documented mutation to a closed provider route and JSON shape", async () => {
    const groupId = "g@g.us";
    const phones = ["1"];
    const cases: [
      ZapiGroupMutation,
      string,
      string,
      Record<string, unknown> | undefined,
    ][] = [
      [
        { operation: "create", groupName: "G", phones, autoInvite: false },
        "POST",
        "create-group",
        { autoInvite: false, groupName: "G", phones },
      ],
      [
        { operation: "name", groupId, groupName: "G" },
        "POST",
        "update-group-name",
        { groupId, groupName: "G" },
      ],
      [
        {
          operation: "photo",
          groupId,
          bytes: new Uint8Array([1]),
          mime: "image/png",
        },
        "POST",
        "update-group-photo",
        { groupId, groupPhoto: "data:image/png;base64,AQ==" },
      ],
      [
        { operation: "add_participants", groupId, phones, autoInvite: true },
        "POST",
        "add-participant",
        { groupId, phones, autoInvite: true },
      ],
      ...(
        [
          ["remove_participants", "remove-participant"],
          ["approve_participants", "approve-participant"],
          ["reject_participants", "reject-participant"],
          ["promote_admins", "add-admin"],
          ["demote_admins", "remove-admin"],
        ] as const
      ).map(
        ([operation, endpoint]) =>
          [
            { operation, groupId, phones },
            "POST",
            endpoint,
            { groupId, phones },
          ] as [ZapiGroupMutation, string, string, Record<string, unknown>],
      ),
      [{ operation: "leave", groupId }, "POST", "leave-group", { groupId }],
      [
        {
          operation: "settings",
          groupId,
          adminOnlyMessage: false,
          adminOnlySettings: true,
          requireAdminApproval: false,
          adminOnlyAddMember: true,
        },
        "POST",
        "update-group-settings",
        {
          phone: groupId,
          adminOnlyMessage: false,
          adminOnlySettings: true,
          requireAdminApproval: false,
          adminOnlyAddMember: true,
        },
      ],
      [
        { operation: "description", groupId, groupDescription: "D" },
        "POST",
        "update-group-description",
        { groupId, groupDescription: "D" },
      ],
      [
        { operation: "reset_invite", groupId },
        "POST",
        "redefine-invitation-link/g%40g.us",
        undefined,
      ],
      [
        { operation: "accept_invite", url: "https://chat.whatsapp.com/ABC" },
        "GET",
        "accept-invite-group?url=https%3A%2F%2Fchat.whatsapp.com%2FABC",
        undefined,
      ],
      [
        {
          operation: "mention_members",
          groupId,
          message: "Hi @1",
          mentioned: phones,
          delayMessage: 5,
        },
        "POST",
        "send-text",
        {
          phone: groupId,
          message: "Hi @1",
          mentioned: phones,
          delayMessage: 5,
        },
      ],
      [
        {
          operation: "mention_groups",
          groupId,
          message: "Hi @g@g.us",
          groupMentioned: [{ phone: groupId, subject: "G" }],
        },
        "POST",
        "send-text",
        {
          phone: groupId,
          message: "Hi @g@g.us",
          groupMentioned: [{ phone: groupId, subject: "G" }],
        },
      ],
      [
        { operation: "mention_all", groupId, message: "Hi @all" },
        "POST",
        "send-text",
        { phone: groupId, message: "Hi @all", mentionAll: true },
      ],
      ...(
        [
          ["chat_read", "read"],
          ["chat_archive", "archive"],
          ["chat_pin", "pin"],
          ["chat_mute", "mute"],
        ] as const
      ).map(
        ([operation, action]) =>
          [
            { operation, groupId, enabled: true },
            "POST",
            "modify-chat",
            { phone: groupId, action },
          ] as [ZapiGroupMutation, string, string, Record<string, unknown>],
      ),
      [
        { operation: "chat_clear", groupId },
        "POST",
        "modify-chat",
        { phone: groupId, action: "clear" },
      ],
      [
        { operation: "chat_delete", groupId },
        "POST",
        "modify-chat",
        { phone: groupId, action: "delete" },
      ],
      [
        { operation: "chat_expiration", groupId, chatExpiration: "7_DAYS" },
        "POST",
        "send-chat-expiration",
        { phone: groupId, chatExpiration: "7_DAYS" },
      ],
      [
        { operation: "link_groups", communityId: "c", groupsPhones: [groupId] },
        "POST",
        "communities/link",
        { communityId: "c", groupsPhones: [groupId] },
      ],
      [
        {
          operation: "unlink_groups",
          communityId: "c",
          groupsPhones: [groupId],
        },
        "POST",
        "communities/unlink",
        { communityId: "c", groupsPhones: [groupId] },
      ],
    ];
    for (const [input, method, endpoint, body] of cases) {
      validateGroupMutation(input);
      const response =
        input.operation === "create"
          ? { phone: groupId, phonesNotAdded: [] }
          : input.operation === "reset_invite"
            ? { invitationLink: "https://chat.whatsapp.com/ABC" }
            : input.operation.startsWith("mention_")
              ? { messageId: "m" }
              : ["accept_invite", "link_groups", "unlink_groups"].includes(
                    input.operation,
                  )
                ? { success: true }
                : { value: true };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response));
      expect((await client(fetcher).mutate(input)).outcome).toBe("accepted");
      expect(String(fetcher.mock.calls[0][0]).split("/token/secret/")[1]).toBe(
        endpoint,
      );
      expect(fetcher.mock.calls[0][1]?.method).toBe(method);
      expect(
        fetcher.mock.calls[0][1]?.body === undefined
          ? undefined
          : JSON.parse(String(fetcher.mock.calls[0][1]?.body)),
      ).toEqual(body);
    }
    expect(cases).toHaveLength(26);
  });
  it("plans fixed group mutation paths, methods and exact body fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ value: true }));
    const z = client(fetcher);
    await z.mutate({
      operation: "add_participants",
      groupId: "g@g.us",
      phones: ["1"],
      autoInvite: false,
    });
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/add-participant$/);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      groupId: "g@g.us",
      phones: ["1"],
      autoInvite: false,
    });
    await z.mutate({
      operation: "settings",
      groupId: "g@g.us",
      adminOnlyMessage: false,
      adminOnlySettings: true,
      requireAdminApproval: false,
      adminOnlyAddMember: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      phone: "g@g.us",
      adminOnlyMessage: false,
      adminOnlySettings: true,
      requireAdminApproval: false,
      adminOnlyAddMember: true,
    });
    await z.mutate({
      operation: "chat_archive",
      groupId: "g@g.us",
      enabled: false,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      phone: "g@g.us",
      action: "unarchive",
    });
  });

  it("treats effectful GET invite as uncertain after network failure; no retry or URL fetch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(Error("secret"));
    await expect(
      client(fetcher).mutate({
        operation: "accept_invite",
        url: "https://chat.whatsapp.com/AbC123",
      }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/accept-invite-group?url=https%3A%2F%2Fchat.whatsapp.com%2FAbC123",
    );
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("parses exact WhatsApp invite and rejects unsafe variants before network", () => {
    expect(parseGroupInvite("https://chat.whatsapp.com/AbC123")).toBe(
      "https://chat.whatsapp.com/AbC123",
    );
    for (const url of [
      "http://chat.whatsapp.com/x",
      "https://evil.example/x",
      "https://chat.whatsapp.com/x?z=1",
      "https://chat.whatsapp.com/x/y",
    ])
      expect(() => parseGroupInvite(url)).toThrow(ZapiError);
    expect(() =>
      validateGroupMutation({
        operation: "add_participants",
        groupId: "g@g.us",
        phones: ["1"],
      } as never),
    ).toThrow(ZapiError);
  });

  it("normalizes create partial and rejects explicit false; malformed acceptance is uncertain", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          phone: "g@g.us",
          phonesNotAdded: ["2"],
          invitationLink: "https://chat.whatsapp.com/ABC",
        }),
      )
      .mockResolvedValueOnce(json({ value: false }))
      .mockResolvedValueOnce(json({ irrelevant: true }));
    const z = client(fetcher);
    expect(
      await z.mutate({
        operation: "create",
        groupName: "G",
        phones: ["1", "2"],
        autoInvite: false,
      }),
    ).toEqual({
      outcome: "accepted",
      evidence: "provider_ack",
      groupId: "g@g.us",
      invitationLink: "https://chat.whatsapp.com/ABC",
      notAdded: ["2"],
      partial: true,
    });
    expect(await z.mutate({ operation: "leave", groupId: "g@g.us" })).toEqual({
      outcome: "rejected",
      evidence: "provider_ack",
    });
    await expect(
      z.mutate({ operation: "leave", groupId: "g@g.us" }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
  });

  it("bounds and normalizes metadata without fabricating permissions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({
          phone: "g@g.us",
          subject: "G",
          participants: [{ phone: "1", isAdmin: true }],
          invitationLink: null,
          communityId: null,
        }),
      );
    expect(await client(fetcher).metadata("g@g.us")).toEqual({
      phone: "g@g.us",
      subject: "G",
      participants: [{ phone: "1", isAdmin: true }],
    });
    expect(String(fetcher.mock.calls[0][0])).toMatch(
      /\/light-group-metadata\/g%40g\.us$/,
    );
  });

  it("uses the seven documented read routes and keeps chat pagination raw", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ phone: "g@g.us", participants: [] }))
      .mockResolvedValueOnce(json({ phone: "g@g.us", participants: [] }))
      .mockResolvedValueOnce(
        json({
          phone: "g@g.us",
          invitationLink: "https://chat.whatsapp.com/ABC",
        }),
      )
      .mockResolvedValueOnce(
        json([
          { phone: "1", isGroup: false },
          {
            phone: "g@g.us",
            isGroup: true,
            archived: "false",
            lastMessageTime: "123",
          },
        ]),
      )
      .mockResolvedValueOnce(json({ phone: "g@g.us", isGroup: true }))
      .mockResolvedValueOnce(json([{ id: "c", name: "C" }]))
      .mockResolvedValueOnce(
        json({
          id: "c",
          name: "C",
          subGroups: [{ phone: "g@g.us", name: "G" }],
        }),
      );
    const z = client(fetcher);
    await z.metadata("g@g.us", "full");
    await z.invitationMetadata("https://chat.whatsapp.com/ABC");
    expect(await z.invitationLink("g@g.us")).toBe(
      "https://chat.whatsapp.com/ABC",
    );
    expect(await z.listChats(2, 10)).toHaveLength(2);
    expect(await z.chatMetadata("g@g.us")).toEqual({
      phone: "g@g.us",
      isGroup: true,
    });
    expect(await z.listCommunities(1, 10)).toEqual([{ id: "c", name: "C" }]);
    expect((await z.communityMetadata("c")).subGroups).toEqual([
      { phone: "g@g.us", name: "G" },
    ]);
    expect(
      fetcher.mock.calls.map(([url]) => String(url).split("/token/secret/")[1]),
    ).toEqual([
      "group-metadata/g%40g.us",
      "group-invitation-metadata?url=https%3A%2F%2Fchat.whatsapp.com%2FABC",
      "group-invitation-link/g%40g.us",
      "chats?page=2&pageSize=10",
      "chats/g%40g.us",
      "communities?page=1&pageSize=10",
      "communities-metadata/c",
    ]);
  });

  it("marks redirects and oversized effects uncertain without leaking provider details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.invalid" },
        }),
      )
      .mockResolvedValueOnce(new Response("x".repeat(256 * 1024 + 1)));
    const z = client(fetcher);
    for (let i = 0; i < 2; i++) {
      try {
        await z.mutate({ operation: "leave", groupId: "g@g.us" });
        throw Error("expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderUncertainError);
        expect(String(error)).not.toMatch(/secret|evil/);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves documented -group IDs through metadata, creation, mutation and community", async () => {
    const groupId = "120363019502650977-group";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ phone: groupId, subject: "Grupo Z-API", participants: [] }),
      )
      .mockResolvedValueOnce(json({ phone: groupId, phonesNotAdded: [] }))
      .mockResolvedValueOnce(json({ value: true }))
      .mockResolvedValueOnce(
        json({
          id: "98372465382764532938",
          subGroups: [{ phone: groupId, isGroupAnnouncement: true }],
        }),
      );
    const z = client(fetcher);
    expect((await z.metadata(groupId)).phone).toBe(groupId);
    expect(
      (
        await z.mutate({
          operation: "create",
          groupName: "G",
          phones: ["5511999999999"],
          autoInvite: false,
        })
      ).groupId,
    ).toBe(groupId);
    expect(
      (await z.mutate({ operation: "name", groupId, groupName: "Novo" }))
        .outcome,
    ).toBe("accepted");
    expect(
      (await z.communityMetadata("98372465382764532938")).subGroups[0].phone,
    ).toBe(groupId);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      `/light-group-metadata/${groupId}`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      groupId,
      groupName: "Novo",
    });
    expect(() =>
      validateGroupMutation({
        operation: "link_groups",
        communityId: "c",
        groupsPhones: [groupId],
      }),
    ).not.toThrow();
  });

  it("requires documented mention target syntax and delay range", () => {
    const groupId = "120363019502650977-group";
    expect(() =>
      validateGroupMutation({
        operation: "mention_groups",
        groupId,
        message: `Olá @${groupId}`,
        groupMentioned: [{ phone: groupId, subject: "G" }],
        delayMessage: 5,
      }),
    ).not.toThrow();
    expect(() =>
      validateGroupMutation({
        operation: "mention_groups",
        groupId,
        message: "Olá @outro",
        groupMentioned: [{ phone: groupId, subject: "G" }],
      }),
    ).toThrow(ZapiError);
    for (const delayMessage of [0, 16])
      expect(() =>
        validateGroupMutation({
          operation: "mention_all",
          groupId,
          message: "Olá @all",
          delayMessage,
        }),
      ).toThrow(ZapiError);
  });
});
