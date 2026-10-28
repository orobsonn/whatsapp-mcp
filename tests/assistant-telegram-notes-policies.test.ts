import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { OwnerControl } from "../assistant/control";
import { JobQueue } from "../assistant/queue";
import { Episodes } from "../assistant/agent/episodes";
import { changeTelegramNote } from "../assistant/telegram-note-command";
import { readTelegramNotes } from "../assistant/telegram-note-reader";
import { changeTelegramPolicy } from "../assistant/telegram-policy-command";
import type { AssistantEnv } from "../assistant/env";

const retirement = { allow: async () => {}, withdraw: async () => {} };
async function fixture(text: string) {
  const scope = { installationId: crypto.randomUUID(), generation: "notes-policy", sourceEpoch: "epoch", sourceGeneration: "capture" };
  const sources = new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  const note = await sources.create({ originKey: "note", title: "Preferência piloto", text: "O piloto usa mensagens curtas em português.", occurredAt: 1 });
  const request = await sources.create({ originKey: "current-request", text: "Synthetic current request", occurredAt: 2 });
  const queue = new JobQueue(env.DB, scope, { kind: "owner" });
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "test", sourceId: request.id, sourceRevision: 1, request: "synthetic", maxAttempts: 1 }, Date.now());
  const lease = (await queue.claimId(job.id, Date.now(), 60000))!, ledger = (await queue.ledger(job.id))!;
  const episode = await new Episodes(env.DB, scope).prepare({ lease, requestHash: ledger.request_hash, profile: "owner", checkpoint: "a".repeat(64), binding: { kind: "telegram_owner_dialogue" }, deadline: Date.now() + 50000, maxCalls: 1 });
  let allowed = true;
  const input = { episodeId: episode.id, bindingHash: episode.binding_hash, updateId: 50, operationId: "test-command", text, occurredAt: Date.now(), guard: () => ({ sql: allowed ? "1" : "0", values: [] }) };
  const read = () => new SourceAccess(env.DB, scope).read({ kind: "owner" }, note.id);
  const boundary = { deadlineAt: Date.now() + 50000, check: async () => { if (!allowed) throw Error("revoked"); } };
  return { scope, sources, note, input, read, boundary, revoke: () => { allowed = false; } };
}

it("corrects a unique literal note through the controller and recovers its exact receipt", async () => {
  const f = await fixture('Corrija a nota “Preferência piloto” para: O piloto usa explicações diretas.');
  const original = SourceController.prototype.execute; let lose = true;
  const spy = vi.spyOn(SourceController.prototype, "execute").mockImplementation(async function(this: SourceController, command) {
    const result = await original.call(this, command); if ((command as { kind: string }).kind === "source.correct" && lose) { lose = false; throw Error("lost ack"); } return result;
  });
  try {
    await expect(changeTelegramNote(env.DB, f.scope, f.input, retirement)).rejects.toThrow("lost ack");
    expect((await f.read())?.text).toBe("O piloto usa explicações diretas.");
    const result = await changeTelegramNote(env.DB, f.scope, f.input, retirement);
    expect(result).toMatchObject({ state: "applied", witness: { kind: "owner_command" } });
    expect((await f.read())?.fence.source.revision).toBe(2);
  } finally { spy.mockRestore(); }
});
it("withdraws a note from use without claiming physical erasure", async () => {
  const f = await fixture('Esqueça a nota “Preferência piloto”');
  const result = await changeTelegramNote(env.DB, f.scope, f.input, retirement);
  expect(result).toMatchObject({ state: "applied", witness: { kind: "owner_command" } });
  expect(result.text).toContain("retirada do uso"); expect(result.text).not.toMatch(/apagada|eliminada/iu);
  expect(await f.read()).toBeNull();
});
it("rejects questions, conditions, a namesake and revoked authority before note mutation", async () => {
  const f = await fixture('Corrija a nota “Preferência piloto” para: Texto novo.');
  for (const text of ['Não ' + f.input.text, 'Pode corrigir a nota “Preferência piloto” para: Texto novo?', 'Se estiver pronta, ' + f.input.text, 'Ele disse: ' + f.input.text])
    expect(await changeTelegramNote(env.DB, f.scope, { ...f.input, text }, retirement)).toMatchObject({ state: "clarify" });
  const original = SourceController.prototype.execute;
  const spy = vi.spyOn(SourceController.prototype, "execute").mockImplementation(async function(this: SourceController, command) { f.revoke(); return original.call(this, command); });
  try { await expect(changeTelegramNote(env.DB, f.scope, f.input, retirement)).rejects.toThrow(); } finally { spy.mockRestore(); }
  expect((await f.read())?.text).toBe("O piloto usa mensagens curtas em português.");
  const other = await fixture('Esqueça a nota “Preferência piloto”');
  await other.sources.create({ originKey: "namesake", title: "Preferência piloto", text: "Outra nota", occurredAt: 3 });
  expect(await changeTelegramNote(env.DB, other.scope, other.input, retirement)).toMatchObject({ state: "clarify" });
});
it("reads at most three current owner notes with exact bodies and fences", async () => {
  const f = await fixture("query");
  for (let n = 0; n < 4; n++) await f.sources.create({ originKey: "extra:" + n, title: "Piloto " + n, text: "Preferência piloto sintética " + n, occurredAt: 3 + n });
  const read = await readTelegramNotes(env.DB, f.scope, "Qual preferência do piloto?", f.boundary);
  expect(read.state).toBe("available"); if (read.state !== "available") return;
  expect(read.documents).toHaveLength(3); expect(read.dependencies).toHaveLength(3); expect(read.coverage.complete).toBe(false);
  for (const doc of read.documents) expect((await new SourceAccess(env.DB, f.scope).read({ kind: "owner" }, doc.id))?.text).toBe(doc.text);
});
it("does not return withdrawn notes or read after channel revocation", async () => {
  const f = await fixture("query"); await f.sources.withdraw(f.note.id, 1);
  const read = await readTelegramNotes(env.DB, f.scope, "Preferência piloto", f.boundary);
  expect(read.state).toBe("available"); if (read.state === "available") expect(read.documents.some(d => d.id === f.note.id)).toBe(false);
  f.revoke(); expect(await readTelegramNotes(env.DB, f.scope, "Preferência piloto", f.boundary)).toMatchObject({ state: "unavailable" });
});

async function policyFixture(text: string, kind: "private" | "group" = "group") {
  const f = await fixture(text), chatId = "synthetic-chat";
  await env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,7,?,'available')").bind(f.scope.installationId, f.scope.generation, f.scope.sourceEpoch, f.scope.sourceGeneration, chatId, kind).run();
  const reader = { searchConversations: async () => ({ observation: "capture_conversation_search", requestId: "", sourceEpoch: f.scope.sourceEpoch, sourceGeneration: f.scope.sourceGeneration, state: "available", refs: [{ chatId, kind }], complete: true, nextCursor: null }),
    readSnapshot: async () => ({ observation: "capture_snapshot", state: "available", sourceEpoch: f.scope.sourceEpoch, sourceGeneration: f.scope.sourceGeneration, sourceKind: "conversation", sourceId: chatId, chatId, sourceVersion: 1, watermark: 7, conversationKind: kind, access: { captureEnabled: true, captureSince: 1, discontinuous: false }, content: { kind, name: "Projeto Piloto" } }) };
  const originalSearch = reader.searchConversations;
  reader.searchConversations = async (input?: any) => ({ ...await originalSearch(), requestId: input.requestId });
  const own = { DB: env.DB, CAPTURE_READER: reader, BRIDGE_SECRET: "synthetic-read-secret-at-least-32-characters" } as unknown as AssistantEnv;
  const read = () => env.DB.prepare("SELECT revision,excluded,group_mode FROM assistant_conversation_policies WHERE installation_id=? AND generation=? AND conversation_id=?").bind(f.scope.installationId, f.scope.generation, chatId).first();
  return { ...f, own, chatId, reader, readPolicy: read };
}
it("admits an explicit shadow group policy once through existing controller", async () => {
  const f = await policyFixture('Acompanhe em sombra o grupo “Projeto Piloto”');
  expect(await changeTelegramPolicy(f.own, f.scope, f.input)).toMatchObject({ state: "applied", witness: { kind: "owner_command" } });
  expect(await f.readPolicy()).toEqual({ revision: 1, excluded: 0, group_mode: "observe" });
  expect(await changeTelegramPolicy(f.own, f.scope, f.input)).toMatchObject({ state: "applied" });
  expect(await f.readPolicy()).toEqual({ revision: 1, excluded: 0, group_mode: "observe" });
});
it("requires a full current name and never enables a response policy", async () => {
  const f = await policyFixture('Acompanhe em sombra o grupo “Piloto”');
  expect(await changeTelegramPolicy(f.own, f.scope, f.input)).toMatchObject({ state: "clarify" });
  expect(await changeTelegramPolicy(f.own, f.scope, { ...f.input, text: 'Responda no grupo “Projeto Piloto”' })).toMatchObject({ state: "clarify" });
  expect(await f.readPolicy()).toBeNull();
});
it("preserves exclusion and refuses observing an excluded group", async () => {
  const f = await policyFixture('Acompanhe em sombra o grupo “Projeto Piloto”');
  await new OwnerControl(env.DB, f.scope, { kind: "owner" }).execute({ kind: "policy.put", operationId: "exclude-first", id: f.chatId, expectedRevision: 0, conversationKind: "group", excluded: true, groupMode: "ignore" });
  expect(await changeTelegramPolicy(f.own, f.scope, f.input)).toMatchObject({ state: "clarify" });
  expect(await f.readPolicy()).toEqual({ revision: 1, excluded: 1, group_mode: "ignore" });
});
it("checks chat kind and current origin in the same policy admission", async () => {
  const f = await policyFixture('Acompanhe em sombra o grupo “Projeto Piloto”'), original = OwnerControl.prototype.execute;
  const spy = vi.spyOn(OwnerControl.prototype, "execute").mockImplementation(async function(this: OwnerControl, command) {
    await env.DB.prepare("UPDATE assistant_origin_conversations SET kind='private' WHERE installation_id=? AND generation=? AND chat_id=?").bind(f.scope.installationId, f.scope.generation, f.chatId).run();
    return original.call(this, command);
  });
  try { await expect(changeTelegramPolicy(f.own, f.scope, f.input)).rejects.toThrow(); } finally { spy.mockRestore(); }
  expect(await f.readPolicy()).toBeNull();
});
it("excludes a private conversation without enabling group response or unpausing anything", async () => {
  const f = await policyFixture('Exclua a conversa “Projeto Piloto” do assistente', "private");
  expect(await changeTelegramPolicy(f.own, f.scope, f.input)).toMatchObject({ state: "applied" });
  expect(await f.readPolicy()).toEqual({ revision: 1, excluded: 1, group_mode: "ignore" });
});
it("stores a question inside a correction as literal note data", async () => {
  const f = await fixture('Corrija a nota “Preferência piloto” para: Quem decide? O dono, sem executar comandos citados.');
  expect(await changeTelegramNote(env.DB, f.scope, f.input, retirement)).toMatchObject({ state: "applied" });
  expect((await f.read())?.text).toBe("Quem decide? O dono, sem executar comandos citados.");
});
it("does not apply a frozen correction after a concurrent source revision", async () => {
  const f = await fixture('Corrija a nota “Preferência piloto” para: Texto que perdeu a revisão.'), original = SourceController.prototype.execute;
  const spy = vi.spyOn(SourceController.prototype, "execute").mockImplementation(async function(this: SourceController, command) {
    if ((command as { kind: string }).kind === "source.correct") await f.sources.correct(f.note.id, 1, { text: "Correção concorrente atual.", occurredAt: 3 });
    return original.call(this, command);
  });
  try { await expect(changeTelegramNote(env.DB, f.scope, f.input, retirement)).rejects.toThrow(); } finally { spy.mockRestore(); }
  expect((await f.read())?.text).toBe("Correção concorrente atual.");
});
it("does not apply a policy if the remote conversation changes after freezing", async () => {
  const f = await policyFixture('Acompanhe em sombra o grupo “Projeto Piloto”'), snapshot = f.reader.readSnapshot; let calls = 0;
  f.reader.readSnapshot = async () => { const value = await snapshot(); return ++calls === 1 ? value : { ...value, watermark: 8, content: { ...value.content, name: "Outro projeto" } }; };
  await expect(changeTelegramPolicy(f.own, f.scope, f.input)).rejects.toThrow("policy_origin_changed");
  expect(await f.readPolicy()).toBeNull();
});
it.each(["observe", "respond"] as const)("preserves existing %s mode while explicitly excluding a group", async mode => {
  const f = await policyFixture('Exclua a conversa “Projeto Piloto” do assistente');
  await new OwnerControl(env.DB, f.scope, { kind: "owner" }).execute({ kind: "policy.put", operationId: "existing-mode", id: f.chatId, expectedRevision: 0, conversationKind: "group", groupMode: mode });
  expect(await changeTelegramPolicy(f.own, f.scope, f.input)).toMatchObject({ state: "applied" });
  expect(await f.readPolicy()).toEqual({ revision: 2, excluded: 1, group_mode: mode });
  expect(await env.DB.prepare("SELECT effective_mode FROM assistant_conversation_modes WHERE installation_id=? AND generation=? AND conversation_id=?").bind(f.scope.installationId, f.scope.generation, f.chatId).first("effective_mode")).toBe("ignore");
});
