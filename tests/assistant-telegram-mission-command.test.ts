import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { SourceController } from "../assistant/sources";
import { OwnerControl } from "../assistant/control";
import { JobQueue } from "../assistant/queue";
import { Episodes } from "../assistant/agent/episodes";
import { RetentionPurge } from "../assistant/retention-purge";
import { setTelegramMissionState } from "../assistant/telegram-mission-command";

const retirement = { allow: async () => {}, withdraw: async () => {} };
async function fixture() {
  const scope = { installationId: crypto.randomUUID(), generation: "mission-command" }, sources = new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  const source = await sources.create({ originKey: "mission-support", text: "Synthetic mission support", occurredAt: Date.now() });
  const currentRequest = await sources.create({ originKey: "current-owner-request", text: "Synthetic current request", occurredAt: Date.now() });
  const control = new OwnerControl(env.DB, scope, { kind: "owner" });
  const objective = "Verificar o recibo técnico sem enviar mensagens.";
  const create = async (id: string, text = objective, support = source) => control.execute({ kind: "mission.put", operationId: "create:" + id, id, expectedRevision: 0, objective: text, source: { id: support.id, revision: 1 }, state: "active" });
  await create("mission-target");
  const queue = new JobQueue(env.DB, scope, { kind: "owner" });
  const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "mission-test", sourceId: currentRequest.id, sourceRevision: 1, request: "synthetic", maxAttempts: 1 }, Date.now());
  const lease = (await queue.claimId(job.id, Date.now(), 60000))!, ledger = (await queue.ledger(job.id))!, episodes = new Episodes(env.DB, scope);
  const episode = await episodes.prepare({ lease, requestHash: ledger.request_hash, profile: "owner", checkpoint: "a".repeat(64), binding: { kind: "telegram_owner_dialogue" }, deadline: Date.now() + 50000, maxCalls: 1 });
  let allowed = true;
  const input = { episodeId: episode.id, bindingHash: episode.binding_hash, updateId: 50, operationId: "synthetic-state-command", text: "Conclua a missão: " + objective, guard: () => ({ sql: allowed ? "1" : "0", values: [] }) };
  const read = () => env.DB.prepare("SELECT revision,state FROM assistant_missions WHERE installation_id=? AND id='mission-target'").bind(scope.installationId).first();
  return { scope, sources, source, control, objective, create, input, read, revoke: () => { allowed = false; } };
}
it("changes one exact mission through the controller and reuses the original command after a lost acknowledgement", async () => {
  const f = await fixture(), original = OwnerControl.prototype.execute; let lost = true;
  const spy = vi.spyOn(OwnerControl.prototype, "execute").mockImplementation(async function (this: OwnerControl, command) {
    const result = await original.call(this, command); if ((command as { kind: string }).kind === "mission.set_state" && lost) { lost = false; throw Error("synthetic lost command acknowledgement"); } return result;
  });
  try {
    await expect(setTelegramMissionState(env.DB, f.scope, f.input)).rejects.toThrow("lost command acknowledgement");
    expect(await f.read()).toEqual({ revision: 2, state: "resolved" });
    expect(await setTelegramMissionState(env.DB, f.scope, f.input)).toMatchObject({ state: "applied", witness: { kind: "owner_command" } });
    expect(await f.read()).toEqual({ revision: 2, state: "resolved" });
  } finally { spy.mockRestore(); }
});
it("never retargets a frozen command when the original mission and receipt disappear and a new namesake is added", async () => {
  const f = await fixture(); await setTelegramMissionState(env.DB, f.scope, f.input);
  await f.sources.withdraw(f.source.id, 1);
  const purge = new RetentionPurge(env.DB, f.scope, { kind: "owner" }, Date.now, retirement);
  let state = "pending"; for (let i = 0; i < 25 && state === "pending"; i++) state = (await purge.advance({ kind: "source.purge", operationId: "purge-old-support", sourceId: f.source.id })).state;
  expect(state).toBe("complete");
  expect(await f.read()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND operation_id=?").bind(f.scope.installationId, f.input.operationId).first()).toBeNull();
  const newSupport = await f.sources.create({ originKey: "new-support", text: "Synthetic new mission support", occurredAt: Date.now() });
  await f.create("mission-new", f.objective, newSupport);
  await expect(setTelegramMissionState(env.DB, f.scope, f.input)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT revision,state FROM assistant_missions WHERE installation_id=? AND id='mission-new'").bind(f.scope.installationId).first()).toEqual({ revision: 1, state: "active" });
});
it("rejects a new namesake or revoked authority between selection and admission", async () => {
  for (const change of ["namesake", "revoke"] as const) {
    const f = await fixture(), original = OwnerControl.prototype.execute;
    const spy = vi.spyOn(OwnerControl.prototype, "execute").mockImplementation(async function (this: OwnerControl, command) {
      if ((command as { kind: string }).kind === "mission.set_state") { if (change === "namesake") await f.create("mission-other"); else f.revoke(); }
      return original.call(this, command);
    });
    try { await expect(setTelegramMissionState(env.DB, f.scope, f.input)).rejects.toThrow(); expect(await f.read()).toEqual({ revision: 1, state: "active" }); }
    finally { spy.mockRestore(); }
  }
});
it("requires an entire explicit instruction and refuses ambiguous targets", async () => {
  const f = await fixture();
  for (const text of ["Não conclua a missão: " + f.objective, "Conclua a primeira missão", 'Ele disse "Conclua a missão: ' + f.objective + '"', "Se estiver pronta, conclua a missão: " + f.objective, "Conclua a missão: " + f.objective + "?"])
    expect(await setTelegramMissionState(env.DB, f.scope, { ...f.input, text })).toMatchObject({ state: "clarify" });
  await f.create("mission-namesake"); expect(await setTelegramMissionState(env.DB, f.scope, f.input)).toMatchObject({ state: "clarify" });
  expect(await f.read()).toEqual({ revision: 1, state: "active" });
});
it("clarifies a conditional suffix unless the owner explicitly delimits the literal mission title", async () => {
  const f = await fixture(), title = "Enviar proposta se o cliente aprovar";
  await f.create("conditional-title", title);
  expect(await setTelegramMissionState(env.DB, f.scope, { ...f.input, text: "Conclua a missão: " + title })).toMatchObject({ state: "clarify" });
  expect(await setTelegramMissionState(env.DB, f.scope, { ...f.input, text: 'Conclua a missão: "' + title + '"' })).toMatchObject({ state: "applied" });
});
