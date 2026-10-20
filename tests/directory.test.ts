import { beforeEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  listChats,
  upsertDirectoryPage,
  searchDirectory,
  syncDirectory,
} from "../src/directory";
import { ZapiGroupsClient } from "../src/zapi-groups";
import { ZapiClient } from "../src/zapi";
const e = {
  ...env,
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "e",
  CONNECTION_GENERATION: "g",
  MAINTENANCE: "false",
  ZAPI_INSTANCE_ID: "test",
  ZAPI_TOKEN: "test",
  ZAPI_CLIENT_TOKEN: "test",
  CONNECTED_PHONE: "5511999999999",
} as Env;
const fence = { epoch: "e", generation: "g" };
beforeEach(async () => {
  await env.DB.exec("DELETE FROM directory_syncs; DELETE FROM chats");
});
it("combines name and phone suffix without matching LIDs or groups or exposing numbers", async () => {
  await upsertDirectoryPage(e, fence, {
    items: [
      { externalId: "5511988888985", name: "Renata Copy", kind: "individual" },
      { externalId: "5511977778985", name: "Renata Outra", kind: "individual" },
      { externalId: "5511966661234", name: "Renata", kind: "individual" },
      { externalId: "1238985@lid", name: "Renata", kind: "individual" },
      { externalId: "1238985", name: "Renata Grupo", kind: "group" },
      { externalId: "5511955558985", name: "Outra", kind: "individual" },
    ],
    complete: true,
  });
  const result = await listChats(e, { term: "Renata", phoneSuffix: "8985" });
  expect(result.items.map((x) => x.name).sort()).toEqual([
    "Renata Copy",
    "Renata Outra",
  ]);
  expect(JSON.stringify(result)).not.toContain("5511988888985");
  await expect(listChats(e, { phoneSuffix: "%985" })).rejects.toThrow(
    "invalid_phone_suffix",
  );
});
it("search synchronizes missing contacts, caches complete agenda separately from groups and uses opt-out defaults", async () => {
  const transport = vi.fn<typeof fetch>(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    return Response.json([{ phone: "5511988888985", vname: "Renata Copy" }]);
  });
  const p = new ZapiClient(e, transport);
  await upsertDirectoryPage(e, fence, {
    items: [],
    complete: true,
    kind: "group",
  });
  const result = await searchDirectory(
    e,
    { term: "Renata", phoneSuffix: "8985" },
    p,
  );
  expect(result.items).toHaveLength(1);
  expect(result.directory.complete).toBe(true);
  expect(result.items[0]?.captureEnabled).toBe(true);
  const cached = await searchDirectory(
    e,
    { term: "Renata" },
    new ZapiClient(e, async () => {
      throw Error("should use cache");
    }),
  );
  expect(cached.items).toHaveLength(1);
});
it("keeps bounded sync incomplete and resumes before claiming no match", async () => {
  const p = new ZapiClient(e, async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    const page = Number(u.searchParams.get("page"));
    return Response.json(
      page <= 3
        ? Array.from({ length: 100 }, (_, i) => ({
            phone: `5511${page}${String(i).padStart(7, "0")}`,
            name: "Outro",
          }))
        : [{ phone: "5511988888985", name: "Renata" }],
    );
  });
  const partial = await searchDirectory(e, { term: "Renata" }, p);
  expect(partial.items).toEqual([]);
  expect(partial.directory.complete).toBe(false);
  const final = await searchDirectory(e, { term: "Renata" }, p);
  expect(final.directory.complete).toBe(true);
  expect(final.items).toHaveLength(1);
});
it("does not persist contacts if device changes during the provider read", async () => {
  let devices = 0;
  const p = new ZapiClient(e, async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({
        phone: ++devices === 1 ? e.CONNECTED_PHONE : "5511000000000",
      });
    return Response.json([{ phone: "5511988888985", name: "Renata" }]);
  });
  await expect(searchDirectory(e, { term: "Renata" }, p)).rejects.toThrow(
    "device_changed",
  );
  expect((await listChats(e)).items).toEqual([]);
});
it("binds result cursors to suffix and preserves multiple matches", async () => {
  await upsertDirectoryPage(e, fence, {
    items: [
      { externalId: "5511988888985", name: "Renata", kind: "individual" },
      { externalId: "5511977778985", name: "Renata", kind: "individual" },
    ],
    complete: true,
  });
  const first = await listChats(e, {
    term: "Renata",
    phoneSuffix: "8985",
    limit: 1,
  });
  expect(first.nextCursor).toBeDefined();
  await expect(
    listChats(e, {
      term: "Renata",
      phoneSuffix: "1234",
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow("invalid_cursor");
  expect(
    (
      await listChats(e, {
        term: "Renata",
        phoneSuffix: "8985",
        cursor: first.nextCursor,
      })
    ).items,
  ).toHaveLength(1);
});

it("manual later page does not mark automatic agenda complete", async () => {
  const p = new ZapiClient(e, async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    return Response.json(
      u.searchParams.get("page") === "1"
        ? [{ phone: "5511988888985", name: "Renata" }]
        : [],
    );
  });
  await syncDirectory(e, { kind: "individual", page: 2, pageSize: 10 }, p);
  expect((await searchDirectory(e, { term: "Renata" }, p)).items).toHaveLength(
    1,
  );
});
it("does not persist a partly fetched batch when a later provider page fails", async () => {
  const p = new ZapiClient(e, async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    if (u.searchParams.get("page") === "1")
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          phone: `5511${String(i).padStart(9, "0")}`,
          name: "Renata",
        })),
      );
    throw Error("synthetic provider failure");
  });
  await expect(searchDirectory(e, { term: "Renata" }, p)).rejects.toThrow();
  expect((await listChats(e)).items).toEqual([]);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM directory_syncs").first(
      "n",
    ),
  ).toBe(0);
});

it("finds an unsaved person in chat metadata when the contacts agenda has no match", async () => {
  const transport: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    if (u.pathname.endsWith("/contacts")) return Response.json([]);
    return Response.json([
      { phone: "5511988888985", name: "Renata Copy", isGroup: false },
      { phone: "1234568985@g.us", name: "Renata Grupo", isGroup: true },
    ]);
  };
  const result = await searchDirectory(
    e,
    { term: "Renata", phoneSuffix: "8985" },
    new ZapiClient(e, transport),
    new ZapiGroupsClient(e, transport),
  );
  expect(result.items.map((x) => x.name)).toEqual(["Renata Copy"]);
  expect(result.directory.complete).toBe(true);
  expect(result.directory.source).toBe("contacts_and_chats");
  expect(result.items[0]?.captureEnabled).toBe(true);
});
it("continues raw chat pages full of groups and excludes LIDs and numeric groups", async () => {
  const transport: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    if (u.pathname.endsWith("/contacts")) return Response.json([]);
    if (Number(u.searchParams.get("page")) <= 3)
      return Response.json(
        Array.from({ length: 50 }, (_, i) => ({
          phone: `12345678${i}@g.us`,
          name: "Grupo",
          isGroup: true,
        })),
      );
    return Response.json([
      { phone: "5511988888985", name: "Renata", isGroup: false },
      { phone: "1234567898985", name: "Grupo", isGroup: true },
      { phone: "1234567898985@lid", name: "LID", isGroup: false },
    ]);
  };
  const provider = new ZapiClient(e, transport),
    chats = new ZapiGroupsClient(e, transport);
  const partial = await searchDirectory(
    e,
    { phoneSuffix: "8985" },
    provider,
    chats,
  );
  expect(partial.directory.complete).toBe(false);
  expect(partial.items).toEqual([]);
  const final = await searchDirectory(
    e,
    { phoneSuffix: "8985" },
    provider,
    chats,
  );
  expect(final.directory.complete).toBe(true);
  expect(final.items.map((x) => x.name)).toEqual(["Renata"]);
});

it("preserves the saved contact name when chat metadata has no name", async () => {
  await upsertDirectoryPage(e, fence, {
    items: [
      { externalId: "5511988888985", kind: "individual", name: "Renata Copy" },
    ],
    complete: true,
  });
  await upsertDirectoryPage(e, fence, {
    items: [
      { externalId: "5511988888985", kind: "individual", name: "Sem nome" },
    ],
    complete: true,
    chatSource: true,
  });
  expect(
    (await listChats(e, { phoneSuffix: "8985" })).items.map((x) => x.name),
  ).toEqual(["Renata Copy"]);
});

it("continua páginas de grupos com entradas não-grupo sem classificá-las como grupos", async () => {
  const pages: number[] = [];
  const transport: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/status"))
      return Response.json({ connected: true });
    if (u.pathname.endsWith("/device"))
      return Response.json({ phone: e.CONNECTED_PHONE });
    const p = Number(u.searchParams.get("page"));
    pages.push(p);
    return Response.json(
      p === 1
        ? [
            { phone: "5511999999999", name: "Pessoa", isGroup: false },
            { phone: "100-group", name: "Equipe", isGroup: true },
          ]
        : [{ phone: "200-group", name: "Equipe 2", isGroup: true }],
    );
  };
  const result = await syncDirectory(
    e,
    { kind: "group", pageSize: 2 },
    new ZapiClient(e, transport),
    3,
  );
  expect(pages).toEqual([1, 2]);
  expect(result.complete).toBe(true);
  expect(result.unsupportedEntriesInBatch).toBe(1);
  expect(
    (await listChats(e, { kind: "group" })).items.map((x) => x.name).sort(),
  ).toEqual(["Equipe", "Equipe 2"]);
});
