import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi, afterEach } from "vitest";
import { TelegramLink } from "../assistant/telegram-auth";
import { TelegramOwnerInbox } from "../assistant/telegram-owner-inbox";
import { AssistantExport } from "../assistant/retention";
import { RetentionPurge } from "../assistant/retention-purge";
import { SourceController } from "../assistant/sources";

let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
let inbox: TelegramOwnerInbox, link: TelegramLink;
const bot = "synthetic_bot", secret = "synthetic-owner-inbox-secret-for-tests";
const q = (sql: string, ...args: (string | number | null)[]) => env.DB.prepare(sql).bind(scope.installationId, scope.generation, bot, ...args);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (update_id: number, text = "O que está pendente?", thread: number | undefined = 10) => ({ update_id, message: {
  message_id: update_id + 100, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false },
  chat: { id: 101, type: "private" }, text, ...(thread === undefined ? {} : { message_thread_id: thread }),
} });
async function open() {
  const activation = await inbox.activate();
  expect(activation).toMatchObject({ linkRevision: 1 });
  await wait(Math.max(1, (activation.cutoffSecond + 1) * 1000 - Date.now() + 15));
  return activation;
}
async function receive(id = 3, text?: string, thread: number | undefined = 10) {
  expect(await link.receive(message(id, text, thread))).toBe("pending");
}
async function admitted(guard: { sql: string; values: (string | number | null)[] }) {
  return !!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first();
}
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "epoch", sourceGeneration: "capture" };
  await env.DB.prepare("INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',?)")
    .bind(scope.installationId, scope.generation, bot, scope.sourceEpoch, scope.sourceGeneration, Math.floor(Date.now() / 1000) - 10).run();
  link = new TelegramLink(env.DB, scope, bot, secret);
  inbox = new TelegramOwnerInbox(env.DB, scope, bot);
});
afterEach(() => vi.restoreAllMocks());

it("claims a new message once and never drains pre-activation or delayed old messages", async () => {
  await receive(3, "mensagem anterior à ativação");
  const activation = await open();
  expect(await inbox.claim(3)).toBeNull();
  const delayed = message(4, "mensagem antiga entregue depois"); delayed.message.date = activation.cutoffSecond;
  expect(await link.receive(delayed)).toBe("pending");
  expect(await inbox.claim(4)).toBeNull();
  await receive(5);
  const turn = await inbox.claim(5);
  expect(turn).toMatchObject({ updateId: 5, text: "O que está pendente?", threadId: 10 });
  expect(await admitted(inbox.guard(turn!))).toBe(true);
  expect(await inbox.claim(5)).toBeNull();
  expect(await inbox.activate()).toEqual(activation);
});

it("admits exactly one concurrent claimant and completes original plus sidecar together", async () => {
  await open(); await receive();
  const turns = await Promise.all([inbox.claim(3), inbox.claim(3)]);
  expect(turns.filter(Boolean)).toHaveLength(1);
  const turn = turns.find(Boolean)!;
  const guard = inbox.guard(turn);
  expect((await Promise.all([inbox.complete(turn), inbox.complete(turn)])).filter(Boolean)).toHaveLength(1);
  expect(await inbox.inspect(3)).toMatchObject({ state: "complete" });
  expect(await q("SELECT state FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("state")).toBe("completed");
  expect(await admitted(guard)).toBe(false);
  expect(await inbox.claim(3)).toBeNull();
});

it("pins the text in the admission snapshot rather than adopting a later edit", async () => {
  await open(); await receive(3, "texto original admitido");
  const prepare = env.DB.prepare.bind(env.DB);
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (key === "first" && sql.includes("INSERT INTO assistant_telegram_owner_turns")) return async () => {
        const result = await target.first();
        if (result) await prepare("UPDATE assistant_telegram_updates SET text='texto alterado depois' WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3")
          .bind(scope.installationId, scope.generation, bot).run();
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = { prepare: (sql: string) => wrap(prepare(sql), sql), batch: env.DB.batch.bind(env.DB) } as D1Database;
  const subject = new TelegramOwnerInbox(db, scope, bot), turn = (await subject.claim(3))!;
  expect(turn.text).toBe("texto original admitido");
  expect(await admitted(subject.guard(turn))).toBe(false);
});

it("revocation during an await denies the stored guard and leaves completion unadmitted", async () => {
  await open(); await receive(); const turn = (await inbox.claim(3))!, guard = inbox.guard(turn);
  await link.execute({ kind: "telegram_link.revoke", operationId: "revoke", expectedRevision: 1 });
  expect(await admitted(guard)).toBe(false);
  expect(await inbox.complete(turn)).toBe(false);
  expect(await inbox.inspect(3)).toMatchObject({ state: "claimed" });
  expect(await q("SELECT state FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("state")).toBe("cancelled");
  await env.DB.prepare("UPDATE assistant_telegram_links SET revision=3,state='active',user_id='101',chat_id='101',activation_cut=? WHERE installation_id=? AND generation=? AND bot_instance=?")
    .bind(Math.floor(Date.now() / 1000), scope.installationId, scope.generation, bot).run();
  // A later active revision never revives the old turn.
  expect(await admitted(guard)).toBe(false);
});

it.each(["thread_id", "payload_hash", "token", "text", "source_epoch", "source_generation", "message_id", "user_id", "chat_id"])("pins the original message %s across an await", async field => {
  await open(); await receive(); const turn = (await inbox.claim(3))!, guard = inbox.guard(turn);
  const value = field === "thread_id" || field === "message_id" ? 999 : field === "payload_hash" ? "f".repeat(64) : "changed";
  await env.DB.prepare(`UPDATE assistant_telegram_updates SET ${field}=? WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3`)
    .bind(value, scope.installationId, scope.generation, bot).run();
  expect(await admitted(guard)).toBe(false);
  expect(await inbox.complete(turn)).toBe(false);
});

it("keeps an absent thread distinct from a numbered thread and refuses serialized authority", async () => {
  await open();
  const input = message(3); delete (input.message as { message_thread_id?: number }).message_thread_id;
  expect(await link.receive(input)).toBe("pending");
  const turn = (await inbox.claim(3))!;
  expect(turn.threadId).toBeNull();
  expect(await admitted(inbox.guard(turn))).toBe(true);
  expect(() => inbox.guard(JSON.parse(JSON.stringify(turn)))).toThrow("telegram_owner_turn_invalid");
});

it.each(["hold", "generation", "quiescing"])("refuses a claimed turn under retention %s", async kind => {
  await open(); await receive(); const turn = (await inbox.claim(3))!, guard = inbox.guard(turn);
  if (kind === "hold") await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,100)").bind(scope.installationId).run();
  if (kind === "generation") await env.DB.prepare("INSERT INTO assistant_retention_active_generation VALUES(?,'next',?,?,'activate',1)").bind(scope.installationId, "a".repeat(64), "b".repeat(64)).run();
  if (kind === "quiescing") await env.DB.prepare("INSERT INTO assistant_retention_installation_gate(installation_id,generation,operation_id,request_hash,token,state,started_at) VALUES(?,?,?,?,?,'quiescing',?)")
    .bind(scope.installationId, scope.generation, "snapshot", "a".repeat(64), "snapshot-token", Date.now()).run();
  expect(await admitted(guard)).toBe(false);
  expect(await inbox.complete(turn)).toBe(false);
});

it("expires the SAME previously built guard by SQL time before any cleanup runs", async () => {
  await open(); await receive();
  const turn = (await inbox.claim(3, Date.now() + 1200))!, guard = inbox.guard(turn);
  expect(await admitted(guard)).toBe(true);
  await wait(Math.max(1, turn.deadlineAt - Date.now() + 60));
  expect(await admitted(guard)).toBe(false);
  expect(await inbox.complete(turn)).toBe(false);
  expect(await inbox.expire(3)).toBe(true);
  expect(await inbox.inspect(3)).toMatchObject({ state: "uncertain" });
  expect(await inbox.claim(3)).toBeNull();
});

it("rolls back both completion writes when the second statement fails", async () => {
  await open(); await receive(); const turn = (await inbox.claim(3))!;
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => batch([...statements, env.DB.prepare("INSERT INTO nonexistent_owner_inbox_test_table VALUES(1)")]));
  await expect(inbox.complete(turn)).rejects.toThrow();
  expect(await inbox.inspect(3)).toMatchObject({ state: "claimed" });
  expect(await q("SELECT state FROM assistant_telegram_updates WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first("state")).toBe("pending");
  expect(await admitted(inbox.guard(turn))).toBe(true);
});

it("lost completion ACK preserves the receipt without reopening execution", async () => {
  await open(); await receive(); const turn = (await inbox.claim(3))!;
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => { await batch(statements); throw Error("lost ACK"); });
  await expect(inbox.complete(turn)).rejects.toThrow("lost ACK");
  expect(await inbox.inspect(3)).toMatchObject({ state: "complete" });
  expect(await inbox.complete(turn)).toBe(false);
  expect(await inbox.claim(3)).toBeNull();
});

it("does not export bearer tokens or restore inbox execution and leaves source purges supported", async () => {
  await open(); await receive(); const turn = (await inbox.claim(3))!; await inbox.complete(turn);
  const tokens = await q("SELECT token,update_token,finish_token FROM assistant_telegram_owner_turns WHERE installation_id=? AND generation=? AND bot_instance=? AND update_id=3").first();
  const reader = new AssistantExport(env.DB, scope, { kind: "owner" });
  const records: { table: string; body: Record<string, unknown> }[] = []; let cursor: string | undefined;
  do {
    const page = await reader.page({ cursor, limit: 50 }); cursor = page.nextCursor;
    for (const part of page.parts) if (part.table.startsWith("assistant_telegram_")) {
      expect(part.offset).toBe(0);
      records.push({ table: part.table, body: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.data), char => char.charCodeAt(0)))) });
    }
  } while (cursor);
  const exported = records.find(row => row.table === "assistant_telegram_owner_turns")!.body;
  expect(exported).toMatchObject({ token: null, update_token: null, finish_token: null, state: "complete" });
  for (const token of Object.values(tokens!)) if (token) expect(JSON.stringify(records)).not.toContain(token);
  const snapshot = await new AssistantExport(env.DB, scope, { kind: "owner" }, "canonical_snapshot_candidate").snapshotMetadata();
  expect(snapshot.tables).not.toContain("assistant_telegram_owner_turns");
  expect(snapshot.tables).not.toContain("assistant_telegram_owner_activations");
  const retirement = { allow: async () => {}, withdraw: async () => {} };
  const sources = new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  const source = await sources.create({ originKey: "unrelated-note", text: "Synthetic source body for purge", occurredAt: 1 });
  await sources.withdraw(source.id, 1);
  const purge = await new RetentionPurge(env.DB, scope, { kind: "owner" }, Date.now, retirement)
    .advance({ kind: "source.purge", operationId: "purge-unrelated", sourceId: source.id });
  expect(purge).toMatchObject({ state: "complete" });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_source_versions WHERE installation_id=? AND generation=? AND source_id=?")
    .bind(scope.installationId, scope.generation, source.id).first("n")).toBe(0);
  expect(await inbox.inspect(3)).toMatchObject({ state: "complete" });
});
