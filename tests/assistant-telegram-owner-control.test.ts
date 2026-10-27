import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { TelegramLink } from "../assistant/telegram-auth";
import { TelegramOwnerInbox, type TelegramOwnerTurn } from "../assistant/telegram-owner-inbox";
import { SourceController } from "../assistant/sources";
import { OwnerControl } from "../assistant/control";

const owner = { kind: "owner" } as const, bot = "synthetic_bot", secret = "synthetic-owner-control-secret-for-tests";
const retirement = { allow: async () => {}, withdraw: async () => {} };
let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
let link: TelegramLink, inbox: TelegramOwnerInbox, turn: TelegramOwnerTurn, sources: SourceController;
const count = (table: string) => env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE installation_id=? AND generation=?`).bind(scope.installationId, scope.generation).first("n");
const revoke = () => link.execute({ kind: "telegram_link.revoke", operationId: "revoke-in-await", expectedRevision: 1 });
const beforeBatch = (action: () => Promise<unknown>) => ({ prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
  await action(); return env.DB.batch(statements);
} }) as D1Database;
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g", sourceEpoch: "epoch", sourceGeneration: "capture" };
  await env.DB.prepare("INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',?)")
    .bind(scope.installationId, scope.generation, bot, scope.sourceEpoch, scope.sourceGeneration, Math.floor(Date.now() / 1000) - 10).run();
  link = new TelegramLink(env.DB, scope, bot, secret); inbox = new TelegramOwnerInbox(env.DB, scope, bot);
  const activation = await inbox.activate();
  await new Promise(resolve => setTimeout(resolve, Math.max(1, (activation.cutoffSecond + 1) * 1000 - Date.now() + 15)));
  expect(await link.receive({ update_id: 3, message: { message_id: 103, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false },
    chat: { id: 101, type: "private" }, text: "Ensine minha preferência e acompanhe essa missão", message_thread_id: 10 } })).toBe("pending");
  turn = (await inbox.claim(3))!;
  sources = new SourceController(env.DB, scope, owner, Date.now, retirement);
});

it("reuses the existing mission controller with a current Telegram guard and one durable receipt", async () => {
  const source = await sources.create({ originKey: "support", text: "Synthetic owner-authorized mission", occurredAt: 1 });
  const command = { kind: "mission.put", operationId: "tg-mission", id: "mission", expectedRevision: 0,
    objective: "Acompanhar em sombra", source: { id: source.id, revision: 1 } };
  const control = new OwnerControl(env.DB, scope, owner, Date.now, undefined, () => inbox.guard(turn));
  const receipt = await control.execute(command);
  expect(receipt).toMatchObject({ operationId: "tg-mission", revision: 1, shadow: true });
  await revoke();
  expect(await control.execute(command)).toEqual(receipt); // historical receipt grants no new mutation
  expect(await count("assistant_missions")).toBe(1);
  expect(await count("assistant_mission_versions")).toBe(1);
});

it("admits explicit teaching and policy changes once, while completed turns can only recover old receipts", async () => {
  const bound = new SourceController(env.DB, scope, owner, Date.now, retirement, () => inbox.guard(turn));
  const command = { kind: "source.create", operationId: "tg-teach", input: { originKey: "tg-teach", text: "Synthetic explicitly taught preference", occurredAt: 1 } };
  const receipt = await bound.execute(command);
  expect(receipt).toMatchObject({ kind: "source.create", revision: 1, version: 1 });
  const control = new OwnerControl(env.DB, scope, owner, Date.now, undefined, () => inbox.guard(turn));
  const policy = { kind: "policy.put", operationId: "tg-policy", id: "synthetic-chat", expectedRevision: 0, conversationKind: "private" };
  const policyReceipt = await control.execute(policy);
  expect(policyReceipt).toMatchObject({ kind: "policy.put", revision: 1, shadow: true });
  expect(await inbox.complete(turn)).toBe(true);
  expect(await bound.execute(command)).toEqual(receipt);
  expect(await control.execute(policy)).toEqual(policyReceipt);
  await expect(bound.execute({ ...command, operationId: "tg-new-teach", input: { ...command.input, originKey: "new-note" } })).rejects.toThrow("source_revision_conflict");
  await expect(control.execute({ ...policy, operationId: "tg-new-policy", id: "other-chat" })).rejects.toThrow("control_precondition");
  expect(await count("assistant_sources")).toBe(1);
  expect(await count("assistant_source_versions")).toBe(1);
  expect(await count("assistant_policy_versions")).toBe(1);
});

it("revocation immediately before mission admission denies the mutation and its receipt together", async () => {
  const source = await sources.create({ originKey: "support", text: "Synthetic owner mission", occurredAt: 1 });
  const control = new OwnerControl(beforeBatch(revoke), scope, owner, Date.now, undefined, () => inbox.guard(turn));
  await expect(control.execute({ kind: "mission.put", operationId: "tg-mission", id: "mission", expectedRevision: 0,
    objective: "Should never be admitted", source: { id: source.id, revision: 1 } })).rejects.toThrow("control_precondition");
  expect(await count("assistant_missions")).toBe(0);
  expect(await count("assistant_mission_versions")).toBe(0);
  expect(await env.DB.prepare("SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='tg-mission'").bind(scope.installationId, scope.generation).first()).toBeNull();
});

it("revocation during source creation's external-read await leaves no source or command receipt", async () => {
  const bound = new SourceController(env.DB, scope, owner, Date.now, { allow: async () => { await revoke(); }, withdraw: retirement.withdraw }, () => inbox.guard(turn));
  await expect(bound.execute({ kind: "source.create", operationId: "tg-teach", input: { originKey: "telegram-teach", text: "Preferência ensinada", occurredAt: 1 } })).rejects.toThrow("source_revision_conflict");
  expect(await count("assistant_sources")).toBe(0);
  expect(await count("assistant_source_versions")).toBe(0);
  expect(await env.DB.prepare("SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='tg-teach'").bind(scope.installationId, scope.generation).first()).toBeNull();
});

it.each(["source.correct", "source.change_audience"])("revocation in the pre-write await prevents %s", async kind => {
  const source = await sources.create({ originKey: "support", text: "Original synthetic source", occurredAt: 1 });
  const bound = new SourceController(env.DB, scope, owner, Date.now, { allow: async () => { await revoke(); }, withdraw: retirement.withdraw }, () => inbox.guard(turn));
  const command = kind === "source.correct" ? { kind, operationId: "tg-edit", id: source.id, expectedRevision: 1, text: "No new body", occurredAt: 1 }
    : { kind, operationId: "tg-edit", id: source.id, expectedRevision: 1, audience: "public" };
  await expect(bound.execute(command)).rejects.toThrow("source_revision_conflict");
  expect(await env.DB.prepare("SELECT revision,audience,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?")
    .bind(scope.installationId, scope.generation, source.id).first()).toEqual({ revision: 1, audience: "owner", status: "active" });
  expect(await count("assistant_source_versions")).toBe(1);
});

it("revocation before the withdrawal batch does not create a barrier or withdraw a source", async () => {
  const source = await sources.create({ originKey: "support", text: "Original synthetic source", occurredAt: 1 });
  const bound = new SourceController(beforeBatch(revoke), scope, owner, Date.now, retirement, () => inbox.guard(turn));
  await expect(bound.execute({ kind: "source.withdraw", operationId: "tg-withdraw", id: source.id, expectedRevision: 1 })).rejects.toThrow("source_revision_conflict");
  expect(await count("assistant_retention_barriers")).toBe(0);
  expect(await env.DB.prepare("SELECT revision,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?")
    .bind(scope.installationId, scope.generation, source.id).first()).toEqual({ revision: 1, status: "active" });
});

it("settles an exactly admitted withdrawal after revocation and lost final ACK without another revision", async () => {
  const source = await sources.create({ originKey: "support", text: "Original synthetic source", occurredAt: 1 });
  let calls = 0, batches = 0;
  const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
    const result = await env.DB.batch(statements); if (++batches === 2) throw Error("lost final ACK"); return result;
  } } as D1Database;
  const bound = new SourceController(db, scope, owner, Date.now, { allow: retirement.allow, withdraw: async () => { calls++; await revoke(); } }, () => inbox.guard(turn));
  const command = { kind: "source.withdraw", operationId: "tg-withdraw", id: source.id, expectedRevision: 1 };
  await expect(bound.execute(command)).rejects.toThrow("lost final ACK");
  const receipt = await bound.execute(command);
  expect(receipt).toMatchObject({ kind: "source.withdraw", id: source.id, revision: 2, version: 1 });
  expect(calls).toBe(1);
  expect(await count("assistant_retention_barriers")).toBe(1);
  expect(await env.DB.prepare("SELECT base_revision,state,operation_id FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=?")
    .bind(scope.installationId, scope.generation, source.id).first()).toEqual({ base_revision: 1, state: "retired", operation_id: "tg-withdraw" });
  expect(await env.DB.prepare("SELECT revision,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?")
    .bind(scope.installationId, scope.generation, source.id).first()).toEqual({ revision: 2, status: "withdrawn" });
  expect(await count("assistant_source_changes")).toBe(2);
});

it.each(["create", "correct", "changeAudience", "withdraw"])("a restricted controller refuses the direct %s API without a command ledger", async method => {
  const source = await sources.create({ originKey: "support", text: "Original synthetic source", occurredAt: 1 });
  const bound = new SourceController(env.DB, scope, owner, Date.now, retirement, () => inbox.guard(turn));
  const operation = method === "create" ? bound.create({ originKey: "new", text: "new", occurredAt: 1 })
    : method === "correct" ? bound.correct(source.id, 1, { text: "new", occurredAt: 1 })
      : method === "changeAudience" ? bound.changeAudience(source.id, 1, "public") : bound.withdraw(source.id, 1);
  await expect(operation).rejects.toThrow("source_command_required");
  expect(await env.DB.prepare("SELECT revision,audience,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?")
    .bind(scope.installationId, scope.generation, source.id).first()).toEqual({ revision: 1, audience: "owner", status: "active" });
  expect(await count("assistant_sources")).toBe(1);
});
