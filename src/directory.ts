import { ZapiGroupsClient } from "./zapi-groups";
import { ZapiClient, type ZapiContact } from "./zapi";
import type { Env } from "./env";
import {
  AppError,
  assertActive,
  assertFence,
  boundedInt,
  currentFence,
  decodeCursor,
  encodeCursor,
  escapeLike,
  type Fence,
} from "./core";
import { chatView, getChat, type ChatRow, type ChatView } from "./store";
export interface DirectoryItem {
  externalId: string;
  kind: "individual" | "group";
  name: string;
}
export async function upsertDirectoryPage(
  env: Env,
  fence: Fence,
  page: {
    items: DirectoryItem[];
    cursor?: string;
    complete: boolean;
    kind?: "individual" | "group";
    projectItems?: boolean;
    manualSync?: boolean;
    chatSource?: boolean;
  },
): Promise<{
  items: ChatView[];
  nextCursor?: string;
  complete: boolean;
}> {
  assertFence(env, fence);
  if (page.items.length > 100 || (page.cursor?.length ?? 0) > 1024)
    throw new AppError("directory_page_too_large");
  const now = Date.now();
  const statements = [];
  for (const item of page.items) {
    if (
      !item.externalId ||
      item.externalId.length > 256 ||
      !["group", "individual"].includes(item.kind) ||
      typeof item.name !== "string" ||
      item.name.length > 256
    )
      throw new AppError("invalid_directory_item");
    statements.push(
      env.DB.prepare(
        "INSERT INTO chats(id,epoch,generation,external_id,kind,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(epoch,generation,external_id) DO UPDATE SET name=CASE WHEN ?=1 AND chats.name<>'Sem nome' THEN chats.name ELSE excluded.name END,updated_at=excluded.updated_at WHERE chats.kind=excluded.kind",
      ).bind(
        crypto.randomUUID(),
        fence.epoch,
        fence.generation,
        item.externalId,
        item.kind,
        item.name,
        now,
        now,
        page.chatSource ? 1 : 0,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO directory_syncs(id,epoch,generation,cursor,complete,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at",
    ).bind(
      `${fence.epoch}:${fence.generation}${page.kind ? `:${page.kind}` : ""}${page.manualSync ? ":manual" : ""}${page.chatSource ? ":chats" : ""}`,
      fence.epoch,
      fence.generation,
      page.cursor ?? null,
      page.complete ? 1 : 0,
      now,
    ),
  );
  await env.DB.batch(statements);
  assertFence(env, fence);
  const items: ChatView[] = [];
  for (const item of page.projectItems === false ? [] : page.items) {
    const r = await env.DB.prepare(
      "SELECT * FROM chats WHERE external_id=? AND epoch=? AND generation=?",
    )
      .bind(item.externalId, fence.epoch, fence.generation)
      .first<ChatRow>();
    if (r) items.push(chatView(r));
  }
  return {
    items,
    nextCursor: page.complete ? undefined : page.cursor,
    complete: page.complete,
  };
}
export async function setCapture(
  env: Env,
  chatId: string,
  enabled: boolean,
  fence: Fence,
): Promise<void> {
  assertActive(env);
  assertFence(env, fence);
  await getChat(env, chatId, fence);
  await env.DB.prepare(
    "UPDATE chats SET capture_discontinuous=CASE WHEN capture_enabled=1 AND ?=0 THEN 1 ELSE capture_discontinuous END,capture_enabled=?,capture_since=CASE WHEN capture_since IS NULL AND ?=1 THEN ? ELSE capture_since END,updated_at=? WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(
      enabled ? 1 : 0,
      enabled ? 1 : 0,
      enabled ? 1 : 0,
      Date.now(),
      Date.now(),
      chatId,
      fence.epoch,
      fence.generation,
    )
    .run();
}
export async function listChats(
  env: Env,
  input: {
    term?: string;
    phoneSuffix?: string;
    kind?: "individual" | "group";
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{
  items: ChatView[];
  nextCursor?: string;
}> {
  const fence = currentFence(env);
  assertFence(env, fence);
  const limit = boundedInt(input.limit, 50, 100);
  if ((input.term?.length ?? 0) > 256) throw new AppError("invalid_term");
  if (input.phoneSuffix !== undefined && !/^\d{4,15}$/.test(input.phoneSuffix))
    throw new AppError("invalid_phone_suffix");
  const scope = JSON.stringify([
    fence,
    input.term ?? "",
    input.kind ?? "",
    input.phoneSuffix ?? "",
  ]);
  let last = "";
  if (input.cursor) {
    const c = decodeCursor<{
      scope: string;
      id: string;
    }>(input.cursor);
    if (c.scope !== scope || typeof c.id !== "string")
      throw new AppError("invalid_cursor");
    last = c.id;
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM chats WHERE epoch=? AND generation=? AND id>? AND name LIKE ? ESCAPE '\\' AND (? IS NULL OR kind=?) AND (? IS NULL OR (kind='individual' AND length(external_id) BETWEEN 8 AND 15 AND external_id NOT GLOB '*[^0-9]*' AND substr(external_id,-length(?))=?)) ORDER BY id LIMIT ?",
  )
    .bind(
      fence.epoch,
      fence.generation,
      last,
      `%${escapeLike(input.term ?? "")}%`,
      input.kind ?? null,
      input.kind ?? null,
      input.phoneSuffix ?? null,
      input.phoneSuffix ?? null,
      input.phoneSuffix ?? null,
      limit + 1,
    )
    .all<ChatRow>();
  const items = rows.results.slice(0, limit).map(chatView);
  return {
    items,
    nextCursor:
      rows.results.length > limit
        ? encodeCursor({ scope, id: items.at(-1)!.id })
        : undefined,
  };
}

// Provider reads are bounded. Repeating the same search resumes incomplete sync;
// the result cursor is independent and never used as a provider page number.
export async function syncDirectory(
  env: Env,
  input: {
    kind: "individual" | "group";
    page?: number;
    pageSize?: number;
    source?: "chats";
  },
  provider: ZapiClient = new ZapiGroupsClient(env),
  maxPages = 1,
) {
  assertActive(env);
  const fence = currentFence(env);
  const pageSize = boundedInt(input.pageSize, 100, 100);
  let page = boundedInt(input.page, 1, 10000);
  const before = await provider.status();
  if (
    !before.connected ||
    !env.CONNECTED_PHONE ||
    before.phone !== env.CONNECTED_PHONE
  )
    throw new AppError("device_changed", 409);
  const pages: {
    items: DirectoryItem[];
    complete: boolean;
    cursor?: string;
    unsupportedEntries?: number;
  }[] = [];
  for (let i = 0; i < maxPages; i++) {
    if (page > 10000) throw new AppError("directory_page_limit", 409);
    const raw =
      input.source === "chats"
        ? await (provider as ZapiGroupsClient).listDirectoryChats(
            page,
            pageSize,
          )
        : input.kind === "group"
          ? await provider.listGroups(page, pageSize)
          : await provider.listContacts(page, pageSize);
    const rows = raw.filter(
      (item): item is ZapiContact =>
        "phone" in item &&
        typeof item.phone === "string" &&
        (input.source !== "chats" ||
          (!("isGroup" in item && item.isGroup === true) &&
            /^\d{8,15}$/.test(item.phone))),
    );
    const complete = raw.length < pageSize;
    pages.push({
      items: rows.map((item) => ({
        externalId: item.phone,
        kind: input.kind,
        name:
          item.name ||
          ("short" in item ? item.short : undefined) ||
          ("vname" in item ? item.vname : undefined) ||
          ("notify" in item ? item.notify : undefined) ||
          "Sem nome",
      })),
      complete,
      unsupportedEntries: raw.filter((item) => "unavailable" in item).length,
      cursor: complete ? undefined : String(page + 1),
    });
    page++;
    if (complete) break;
  }
  const after = await provider.status();
  assertFence(env, fence);
  if (!after.connected || after.phone !== before.phone)
    throw new AppError("device_changed", 409);
  let projected: ChatView[] = [];
  for (const batch of pages) {
    const saved = await upsertDirectoryPage(env, fence, {
      ...batch,
      kind: input.kind,
      projectItems: maxPages === 1,
      manualSync: maxPages === 1,
      chatSource: input.source === "chats",
    });
    projected = saved.items;
  }
  const last = pages.at(-1)!;
  return {
    items: projected,
    nextCursor: last.cursor,
    kind: input.kind,
    complete: last.complete,
    nextPage: last.complete ? undefined : Number(last.cursor),
    syncedItems: pages.reduce((n, p) => n + p.items.length, 0),
    unsupportedEntriesInBatch: pages.reduce(
      (n, p) => n + (p.unsupportedEntries ?? 0),
      0,
    ),
    coverage: "available_identifiers_only",
  };
}
export async function searchDirectory(
  env: Env,
  input: Parameters<typeof listChats>[1] = {},
  provider = new ZapiClient(env),
  chatProvider = new ZapiGroupsClient(env),
) {
  input = { ...input, kind: input.kind ?? "individual" };
  // Validate filters/cursor before any provider operation.
  await listChats(env, input);
  const fence = currentFence(env),
    kind = input.kind ?? "individual";
  const state = await env.DB.prepare(
    "SELECT complete,cursor,updated_at FROM directory_syncs WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(
      `${fence.epoch}:${fence.generation}:${kind}`,
      fence.epoch,
      fence.generation,
    )
    .first<{ complete: number; cursor: string | null; updated_at: number }>();
  const fresh = state && Date.now() - state.updated_at < 15 * 60 * 1000;
  let directory: {
    kind: string;
    complete: boolean;
    nextPage?: number;
    syncedItems: number;
    source?: string;
    unsupportedEntries?: number;
    coverage?: string;
  } =
    fresh && state.complete
      ? { kind, complete: true, nextPage: undefined, syncedItems: 0 }
      : await syncDirectory(
          env,
          { kind, page: fresh && state.cursor ? Number(state.cursor) : 1 },
          provider,
          3,
        );
  let found = await listChats(env, input);
  if (kind === "individual" && directory.complete) {
    const chatState = await env.DB.prepare(
      "SELECT complete,cursor,updated_at FROM directory_syncs WHERE id=? AND epoch=? AND generation=?",
    )
      .bind(
        `${fence.epoch}:${fence.generation}:individual:chats`,
        fence.epoch,
        fence.generation,
      )
      .first<{ complete: number; cursor: string | null; updated_at: number }>();
    if (found.items.length === 0 || chatState) {
      const freshChats =
        chatState && Date.now() - chatState.updated_at < 15 * 60 * 1000;
      const chatDirectory =
        freshChats && chatState.complete
          ? { kind, complete: true, syncedItems: 0 }
          : await syncDirectory(
              env,
              {
                kind: "individual",
                source: "chats",
                page:
                  freshChats && chatState.cursor ? Number(chatState.cursor) : 1,
                pageSize: 50,
              },
              chatProvider,
              3,
            );
      directory = { ...chatDirectory, source: "contacts_and_chats" };
      found = await listChats(env, input);
    }
  }
  return {
    ...found,
    directory: {
      ...directory,
      coverage: "available_identifiers_only",
      completeMeaning: "available_pages_scanned_not_all_account_identities",
    },
    instruction: directory.complete
      ? "Preserve homônimos; confirme identidade se houver ambiguidade. Páginas disponíveis percorridas não provam todos os grupos/contatos: entradas sem identificação confiável podem ter sido omitidas. Cadastro não libera captura."
      : "Agenda parcial: repita a mesma busca até directory.complete=true antes de concluir ausência ou identidade única.",
  };
}
