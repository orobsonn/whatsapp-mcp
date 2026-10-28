import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TelegramOwnerInbox, type TelegramOwnerTurn } from "../assistant/telegram-owner-inbox";
import { TelegramOwnerReplies, type ReplyDependency, type OwnerReplySender } from "../assistant/telegram-owner-replies";
import { TelegramLink } from "../assistant/telegram-auth";
import { TelegramBotApi } from "../assistant/telegram";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { RetentionPurge } from "../assistant/retention-purge";
import { AssistantExport } from "../assistant/retention";
import { OriginGuard } from "../assistant/origin-guard";
import { bridgeHash } from "../assistant/ingress";
const bot = "synthetic_bot", secret = "synthetic-owner-replies-secret-for-tests", owner = { kind: "owner" } as const;
const retirement = { allow: async () => {}, withdraw: async () => {} };
let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
let inbox: TelegramOwnerInbox, turn: TelegramOwnerTurn, link: TelegramLink, sources: SourceController, replies: TelegramOwnerReplies;
let sends: { chat: string; thread: number | null; text: string }[], beforeSend: () => Promise<void>, duringSend: () => Promise<void>;
let sender: OwnerReplySender;
const query = (sql: string, ...args: (string | number | null)[]) => env.DB.prepare(sql).bind(scope.installationId, scope.generation, bot, ...args);
async function note(key = "support", text = "Synthetic private source") {
  const source = await sources.create({ originKey: key, text, occurredAt: 1 });
  return { ref: source, dep: { source: (await new SourceAccess(env.DB, scope).read(owner, source.id))!.fence } as ReplyDependency };
}
async function prepare(text = "Resposta em sombra", deps: ReplyDependency[] = []) {
  expect(await replies.prepare(turn, text, deps)).toMatchObject({ updateId: 3, state: "prepared" });
}
const revoke = () => link.execute({ kind: "telegram_link.revoke", operationId: "revoke", expectedRevision: 1 });
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "epoch", sourceGeneration: "capture" };
  await env.DB.prepare("INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',?)")
    .bind(scope.installationId, scope.generation, bot, scope.sourceEpoch, scope.sourceGeneration, Math.floor(Date.now() / 1000) - 10).run();
  link = new TelegramLink(env.DB, scope, bot, secret); inbox = new TelegramOwnerInbox(env.DB, scope, bot);
  const activation = await inbox.activate();
  await new Promise(resolve => setTimeout(resolve, Math.max(1, (activation.cutoffSecond + 1) * 1000 - Date.now() + 15)));
  expect(await link.receive({ update_id: 3, message: { message_id: 103, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false },
    chat: { id: 101, type: "private" }, text: "Pergunta sintética com citação privada", message_thread_id: 10 } })).toBe("pending");
  turn = (await inbox.claim(3))!; sends = []; beforeSend = async () => {}; duringSend = async () => {};
  sender = check => ({ send: async (chat, thread, text) => { await beforeSend(); await check(); sends.push({ chat, thread, text }); await duringSend(); return 201; } });
  sources = new SourceController(env.DB, scope, owner, Date.now, retirement);
  replies = new TelegramOwnerReplies(env.DB, scope, bot, inbox, sender);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("publishes one reply with inbox completion and sends once in the exact original thread", async () => {
  const { dep } = await note(); await prepare("Resposta com fonte", [dep]);
  expect(await inbox.inspect(3)).toMatchObject({ state: "complete" });
  expect(await replies.prepare(turn, "Resposta com fonte", [dep])).toMatchObject({ state: "prepared" });
  await expect(replies.prepare(turn, "outra resposta", [dep])).rejects.toThrow("telegram_owner_reply_conflict");
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1, messageId: 201 });
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1 });
  expect(sends).toEqual([{ chat: "101", thread: 10, text: "Resposta com fonte" }]);
});

async function unorderedDependencies() {
  const deps = await Promise.all([note("hash-a"), note("hash-b"), note("hash-c")]);
  return deps.map(item => item.dep).sort((a, b) => b.source.source.id.localeCompare(a.source.source.id)).map(dep => ({
    source: { ...dep.source, source: Object.fromEntries(Object.entries(dep.source.source).reverse()) as typeof dep.source.source },
  }));
}

it("uses the same hash for a three-source Plan and outbox despite dependency and property order", async () => {
  const deps = await unorderedDependencies(), text = "Resposta com três fontes", frame = inbox.replyFence(turn);
  await prepare(text, deps);
  const row = await query("SELECT request_hash FROM assistant_telegram_owner_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first<{ request_hash: string }>();
  const legacy = await bridgeHash([frame, text, deps, []]);
  expect(legacy).not.toBe(row!.request_hash);
  expect(await replies.requestHash(Object.fromEntries(Object.entries(frame).reverse()), text, deps)).toBe(row!.request_hash);
  expect(await replies.requestHash(frame, text, [...deps].reverse())).toBe(row!.request_hash);
});

it("matches a sent legacy Plan historically without sending again, and rejects altered text, sources and witnesses", async () => {
  const dependencies = await unorderedDependencies(), text = "Resposta histórica com três fontes";
  const legacyPlan = { text, dependencies, witnesses: [], outboxRequestHash: await bridgeHash([inbox.replyFence(turn), text, dependencies, []]) };
  await prepare(text, dependencies); await replies.dispatch(3); await revoke();
  const row = await query("SELECT request_hash FROM assistant_telegram_owner_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first<{ request_hash: string }>();
  expect(legacyPlan.outboxRequestHash).not.toBe(row!.request_hash);
  const expected = { text: legacyPlan.text, dependencies: legacyPlan.dependencies, witnesses: legacyPlan.witnesses };
  expect(await replies.inspect(3, expected)).toMatchObject({ state: "sent", attempts: 1, messageId: 201, purged: false, requestHash: row!.request_hash });
  for (const tampered of [
    { ...expected, text: "Texto alterado" },
    { ...expected, dependencies: dependencies.slice(1) },
    { ...expected, witnesses: [{ kind: "owner_listing" as const, entity: "notes" as const, rowsJSON: "[]" }] },
  ]) await expect(replies.inspect(3, tampered)).rejects.toThrow("telegram_owner_reply_conflict");
  expect(legacyPlan.outboxRequestHash).not.toBe(row!.request_hash);
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1 }); expect(sends).toHaveLength(1);
});

it("refuses a self-consistent sent envelope copied onto a different update", async () => {
  await prepare("Resposta do turno original"); await replies.dispatch(3);
  await query(`INSERT INTO assistant_telegram_owner_replies
    SELECT installation_id,generation,bot_instance,4,request_hash,body_hash,fence_json,text,deps_json,expires_at,published_at,state,attempts,attempt_token,message_id,purged,witnesses_json
    FROM assistant_telegram_owner_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3`).run();
  await expect(replies.inspect(4, { text: "Resposta do turno original", dependencies: [] })).rejects.toThrow("telegram_owner_reply_corrupt");
  expect(sends).toHaveLength(1);
});

it("concurrent dispatchers observe one real attempt instead of reporting a duplicate as blocked", async () => {
  await prepare();
  const results = await Promise.all([replies.dispatch(3), replies.dispatch(3)]);
  expect(sends).toHaveLength(1);
  expect(results.every(result => result?.attempts === 1 && ["attempting", "sent"].includes(result.state))).toBe(true);
  expect(await replies.inspect(3)).toMatchObject({ state: "sent", attempts: 1 });
});

it("concurrent exact publication recovers one outbox and one completion", async () => {
  const result = await Promise.all([replies.prepare(turn, "Reply", []), replies.prepare(turn, "Reply", [])]);
  expect(result.map(row => row.state)).toEqual(["prepared", "prepared"]);
  expect(await query("SELECT COUNT(*) n FROM assistant_telegram_owner_replies WHERE installation_id=? AND generation=? AND bot_instance=?").first("n")).toBe(1);
});

it.each(["", " ", "x".repeat(4001), "😀".repeat(2001)])("rejects unsupported reply length before completing or calling the provider", async text => {
  await expect(replies.prepare(turn, text, [])).rejects.toThrow("telegram_owner_reply_input");
  expect(await inbox.inspect(3)).toMatchObject({ state: "claimed" }); expect(await replies.inspect(3)).toBeNull(); expect(sends).toEqual([]);
});

it("rejects a stale source without completing the inbox or preparing a reply", async () => {
  const { ref, dep } = await note(); await sources.correct(ref.id, 1, { text: "Changed private body", occurredAt: 2 });
  expect(await replies.prepare(turn, "Old answer", [dep])).toMatchObject({ state: "blocked" });
  expect(await inbox.inspect(3)).toMatchObject({ state: "claimed" });
  expect(await replies.inspect(3)).toBeNull(); expect(sends).toEqual([]);
});

it("rolls back completion when reply publication fails", async () => {
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => batch([...statements, env.DB.prepare("INSERT INTO nonexistent_owner_reply_fixture VALUES(1)")]));
  await expect(replies.prepare(turn, "Reply", [])).rejects.toThrow();
  expect(await inbox.inspect(3)).toMatchObject({ state: "claimed" }); expect(await replies.inspect(3)).toBeNull();
});

it("lost publication ACK recovers the same reply without another completion or body", async () => {
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw Error("lost publication ACK"); });
  await expect(replies.prepare(turn, "Reply", [])).rejects.toThrow("lost publication ACK");
  expect(await replies.prepare(turn, "Reply", [])).toMatchObject({ state: "prepared" });
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1 }); expect(sends).toHaveLength(1);
});

it("copies dependencies before an await and refuses conflicting fences for the same source", async () => {
  const { dep } = await note();
  await expect(replies.prepare(turn, "Reply", [dep, { source: { ...dep.source, source: { ...dep.source.source, revision: 99 } } }])).rejects.toThrow("telegram_owner_reply_input");
  const pending = replies.prepare(turn, "Reply", [dep]); dep.source.source.revision = 999;
  expect(await pending).toMatchObject({ state: "prepared" });
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent" });
});

it("checks source changes and current linking before every new provider attempt", async () => {
  const { ref, dep } = await note(); await prepare("Old answer", [dep]);
  await sources.withdraw(ref.id, 1);
  expect(await replies.dispatch(3)).toMatchObject({ state: "blocked", attempts: 0 }); expect(sends).toEqual([]);
});

it("revocation between latch and provider check leaves one uncertain attempt without sending", async () => {
  await prepare(); beforeSend = async () => { await revoke(); };
  expect(await replies.dispatch(3)).toMatchObject({ state: "uncertain", attempts: 1 });
  expect(await replies.dispatch(3)).toMatchObject({ state: "uncertain", attempts: 1 }); expect(sends).toEqual([]);
});

it("a lost provider ACK never triggers a blind second send", async () => {
  await prepare(); duringSend = async () => { throw Error("accepted, ACK lost"); };
  expect(await replies.dispatch(3)).toMatchObject({ state: "uncertain", attempts: 1 });
  expect(await replies.dispatch(3)).toMatchObject({ state: "uncertain", attempts: 1 }); expect(sends).toHaveLength(1);
});

it("late success after revoke and source purge settles the same attempt without restoring private bodies", async () => {
  const { ref, dep } = await note("support-b", "Private support B"); await prepare("Private derived answer A", [dep]);
  duringSend = async () => {
    await revoke(); await sources.withdraw(ref.id, 1);
    const purge = new RetentionPurge(env.DB, scope, owner, Date.now, retirement);
    for (let i = 0; i < 10; i++) { const result = await purge.advance({ kind: "source.purge", operationId: "purge-b", sourceId: ref.id }); if (result.state === "complete") break; }
    expect(await replies.inspect(3)).toMatchObject({ state: "uncertain", purged: true, attempts: 1 });
  };
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1, messageId: 201, purged: true });
  const row = await query("SELECT text,deps_json FROM assistant_telegram_owner_replies WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first();
  expect(row).toEqual({ text: null, deps_json: "[]" });
  expect(await replies.inspect(3, { text: "Private derived answer A", dependencies: [dep] })).toBeNull();
  expect(await query("SELECT text FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("text")).toBeNull();
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1 }); expect(sends).toHaveLength(1);
});

it("retention hold after latch prevents a send, and clearing it never retries the attempt", async () => {
  await prepare(); beforeSend = async () => { await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,100)").bind(scope.installationId).run(); };
  expect(await replies.dispatch(3)).toMatchObject({ state: "uncertain", attempts: 1 });
  await env.DB.prepare("DELETE FROM assistant_retention_runtime_hold WHERE installation_id=?").bind(scope.installationId).run();
  expect(await replies.dispatch(3)).toMatchObject({ state: "uncertain", attempts: 1 }); expect(sends).toEqual([]);
});

it("expiry cleanup removes both bodies and preserves a cancelled latch", async () => {
  expect(await link.receive({ update_id: 4, message: { message_id: 104, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false },
    chat: { id: 101, type: "private" }, text: "Outra pergunta privada" } })).toBe("pending");
  const short = (await inbox.claim(4, Date.now() + 1800))!;
  expect(await replies.prepare(short, "Resposta curta", [])).toMatchObject({ state: "prepared" });
  await new Promise(resolve => setTimeout(resolve, Math.max(1, short.deadlineAt - Date.now() + 60)));
  expect(await replies.dispatch(4)).toMatchObject({ state: "blocked", attempts: 0 });
  expect(await replies.cleanup()).toBe(1);
  expect(await replies.inspect(4)).toMatchObject({ state: "cancelled", purged: true, attempts: 0 });
  expect(await query("SELECT text FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=4").first("text")).toBeNull();
  expect(await replies.dispatch(4)).toMatchObject({ state: "cancelled", attempts: 0 }); expect(sends).toEqual([]);
});

it("exports the private body only as Owner data and redacts attempt authority", async () => {
  await prepare(); await replies.dispatch(3);
  const reader = new AssistantExport(env.DB, scope, owner); let cursor: string | undefined, found: Record<string, unknown> | undefined;
  do { const page = await reader.page({ cursor, limit: 50 }); cursor = page.nextCursor;
    for (const part of page.parts) if (part.table === "assistant_telegram_owner_replies") found = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.data), c => c.charCodeAt(0))));
  } while (cursor);
  expect(found).toMatchObject({ text: "Resposta em sombra", state: "sent", attempt_token: null });
  const snapshot = await new AssistantExport(env.DB, scope, owner, "canonical_snapshot_candidate").snapshotMetadata();
  expect(snapshot.tables).not.toContain("assistant_telegram_owner_replies");
});

it("sends an absent thread without inventing a topic, with protected plain text", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); expect(body).toEqual({ chat_id: "101", text: "<b>literal</b>", protect_content: true });
    return Response.json({ ok: true, result: { message_id: 201, chat: { id: 101, type: "private" } } });
  });
  const api = new TelegramBotApi("123456789:synthetic_token_12345678901234567890", bot, fetcher);
  expect(await api.send("101", null, "<b>literal</b>", [])).toBe(201);
});

it("refuses sources without their required WhatsApp origin proof", async () => {
  const { ref } = await note();
  await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId, scope.generation, ref.id).run();
  const source = (await new SourceAccess(env.DB, scope).read(owner, ref.id))!.fence;
  await expect(replies.prepare(turn, "No unproved transfer", [{ source }])).rejects.toThrow("telegram_owner_reply_input");
  expect(await replies.inspect(3)).toBeNull();
});

it.each([false, true])("keeps the complete ten-source WhatsApp proof within D1's bind limit with varied counters=%s", async varied => {
  const snapshots = new Map<string, unknown>(); const deps: ReplyDependency[] = [];
  for (let i = 0; i < 10; i++) {
    const { ref } = await note(`wa-${i}`, `Synthetic WhatsApp source ${i}`), suffix = varied ? "x".repeat(200) : "", chat = `chat-${i}${suffix}`, providerId = `provider-${i}${suffix}`;
    const revision = varied ? 501 + i : 1, version = varied ? 201 + i : 1, watermark = varied ? 401 + i : i + 1;
    if (varied) {
      await env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
        SELECT installation_id,generation,source_id,?,original_text,content_hash,occurred_at FROM assistant_source_versions WHERE installation_id=? AND generation=? AND source_id=? AND version=1`)
        .bind(version, scope.installationId, scope.generation, ref.id).run();
      await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,?,'private',0,'ignore',?)")
        .bind(scope.installationId, scope.generation, chat, 301 + i).run();
    }
    await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id=?,project_id=?,revision=?,current_version=? WHERE installation_id=? AND generation=? AND id=?")
      .bind(chat, `project-${i}${suffix}`, revision, version, scope.installationId, scope.generation, ref.id).run();
    const access = { captureEnabled: true, captureSince: i + 1, discontinuous: false }, content = { kind: "text", text: `Synthetic WhatsApp source ${i}`, messageId: providerId, messageVersion: version };
    const hash = await bridgeHash([version, access, content]);
    await env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,?,'private','available')").bind(scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration, chat, watermark).run();
    await env.DB.prepare("INSERT INTO assistant_source_origins VALUES(?,?,?,?,'message',?,?,?,?,?,0)").bind(scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration, providerId, chat, ref.id, watermark, hash).run();
    snapshots.set(providerId, { observation: "capture_snapshot", state: "available", sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration, sourceKind: "message", sourceId: providerId, chatId: chat, sourceVersion: version, watermark, conversationKind: "private", access, content });
  }
  const origin = new OriginGuard(env.DB, () => scope, { readSnapshot: async input => snapshots.get(input.sourceId) }, secret);
  for (const [i, snapshot] of [...snapshots.values()].entries()) {
    const chat = (snapshot as { chatId: string }).chatId;
    const row = await env.DB.prepare("SELECT id FROM assistant_sources WHERE installation_id=? AND generation=? AND conversation_id=?").bind(scope.installationId, scope.generation, chat).first<{ id: string }>();
    const source = (await new SourceAccess(env.DB, scope).read(owner, row!.id))!.fence;
    deps.push({ source, origin: (await origin.fence(source.source.id))! }); expect(source.source.conversationId).toBe(`chat-${i}${varied ? "x".repeat(200) : ""}`);
  }
  const prepareStatement = env.DB.prepare.bind(env.DB), db = { prepare: (sql: string) => new Proxy(prepareStatement(sql), { get(target, key) {
    if (key === "bind") return (...args: unknown[]) => { if (args.length > 100) throw Error("cloud_d1_parameter_limit"); return target.bind(...args); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }), batch: env.DB.batch.bind(env.DB) } as D1Database;
  // Both inbox completion and reply SQL cross the constrained D1 boundary.
  // Inbox completion also uses compactStatement, which enforces the same limit.
  replies = new TelegramOwnerReplies(db, scope, bot, inbox, sender, origin);
  const text = varied ? "備".repeat(4000) : "Resposta com dez fontes";
  await prepare(text, deps);
  expect(await replies.dispatch(3)).toMatchObject({ state: "sent", attempts: 1 }); expect(sends).toHaveLength(1);
  expect(sends[0].text).toBe(text);
});
