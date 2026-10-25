import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { ContextSelector, brokerSelector, type PackGuard, type SelectorPort } from "../assistant/context";
import { operationalLanguage } from "../assistant/language";
import { runContextProbe } from "../assistant/context-probe";
import contextProbeWorker from "../scripts/assistant-context-probe";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { InferenceBudget, type BudgetScope } from "../assistant/budget";
import type { RetrievedSource } from "../assistant/retrieval";
it('keeps the isolated live probe closed without its host configuration and authentication', async () => {
  const prepare = vi.fn(), token = 'a'.repeat(64);
  const config = { DB: { prepare }, PROBE_MODE: 'context_check', PROBE_TOKEN: token, OPENAI_API_KEY: 'synthetic' };
  for (const [method, path, auth] of [['POST', '/run', 'wrong'], ['GET', '/run', token], ['POST', '/run?query=x', token], ['POST', '/arbitrary', token]]) {
    const response = await contextProbeWorker.fetch(new Request('https://probe' + path, { method, headers: { Authorization: 'Bearer ' + auth } }), config as never);
    expect(response.status).toBe(403);
  }
  expect((await contextProbeWorker.fetch(new Request('https://probe/run', { method: 'POST' }), { ...config, PROBE_MODE: 'product' } as never)).status).toBe(503);
  expect(prepare).not.toHaveBeenCalled();
});
// @ts-expect-error Vite raw SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL.
import controls from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Vite raw SQL.
import budgets from "../assistant/migrations/0008_inference_budget.sql?raw";
// @ts-expect-error Vite raw SQL.
import receipts from "../assistant/migrations/0010_model_receipts.sql?raw";
let scope: BudgetScope, owner: SourceController, pack: RetrievedSource[], guard: PackGuard;
const answer = (focus: unknown) => ({ state: "complete", body: { choices: [{ message: { content: JSON.stringify({ focus }) } }] } });
const focused = (source: RetrievedSource, quote = source.text!) => ({ id: source.id, spans: [{ start: source.text!.indexOf(quote), end: source.text!.indexOf(quote) + quote.length, quote }] });
beforeEach(async () => {
  for (const sql of [sources, controls, budgets, receipts]) await env.DB.batch(sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
  scope = { installationId: crypto.randomUUID(), generation: "g1", period: "2026-10-25" };
  owner = new SourceController(env.DB, scope, { kind: "owner" });
  const access = new SourceAccess(env.DB, scope);
  pack = [];
  for (const [index, text] of ["Lia: reunião NÃO confirmada para terça.", "Correção: somente quinta, se Yuri aprovar. 😀"].entries()) {
    const ref = await owner.create({ originKey: `source-${index}`, text, occurredAt: 100 }); pack.push((await access.read({ kind: "owner" }, ref.id))!);
  }
  guard = async rows => { for (const row of rows) if (!await access.revalidate({ kind: "owner" }, row.fence)) return false; return true; };
});
it("keeps negations, corrections and linked originals even when AI focuses on one span", async () => {
  const model: SelectorPort = async () => answer([focused(pack[1], "quinta")]);
  const result = await new ContextSelector(guard, model).select({ query: "Qual é o prazo?", sources: pack });
  expect(result.state).toBe("ready"); expect(result.mode).toBe("model");
  expect(result.sources.map(row => row.text).sort()).toEqual(pack.map(row => row.text).sort());
  expect(result.focus).toEqual([focused(pack[1], "quinta")]);
});
it("falls back to every original on error, invalid schema or uncertain receipt", async () => {
  for (const model of [async () => { throw new Error("secret"); }, async () => answer([{ ...focused(pack[0]), invented: true }]), async () => ({ state: "uncertain", operationKey: "cognee:" + "a".repeat(64) })]) {
    const result = await new ContextSelector(guard, model).select({ query: "Prazo?", sources: pack });
    expect(result).toMatchObject({ state: "ready", mode: "fallback", sources: pack, focus: [], gaps: ["selector_unavailable"] });
    expect(JSON.stringify(result)).not.toContain("secret");
  }
});
it("revalidates the entire pack after model failure and returns no stale originals", async () => {
  const model: SelectorPort = async () => { await owner.withdraw(pack[1].id, 1); throw new Error("failure"); };
  const result = await new ContextSelector(guard, model).select({ query: "Prazo?", sources: pack });
  expect(result).toMatchObject({ state: "waiting_context", sources: [], focus: [], gaps: ["source_changed"] });
});
it("does not send a stale pack, and a denied guard also blocks deterministic fallback", async () => {
  const model = vi.fn<SelectorPort>(); await owner.withdraw(pack[0].id, 1);
  expect((await new ContextSelector(guard, model).select({ query: "Prazo?", sources: pack })).state).toBe("waiting_context");
  expect((await new ContextSelector(async () => false).select({ query: "Prazo?", sources: pack })).sources).toEqual([]);
  expect(model).not.toHaveBeenCalled();
});
it("counts serialized schema, query and escaped originals against the cap without truncating", async () => {
  const model = vi.fn<SelectorPort>(); pack[0].text = '"'.repeat(32000);
  const result = await new ContextSelector(async () => true, model).select({ query: "q".repeat(2048), sources: pack });
  expect(result).toMatchObject({ state: "waiting_context", sources: [], gaps: ["context_bytes_limit"] }); expect(model).not.toHaveBeenCalled();
});
it("uses UTF-16 offsets literally and rejects emoji splits, invented quotes and duplicate IDs", async () => {
  const quote = "😀", good = focused(pack[1], quote);
  expect((await new ContextSelector(guard, async () => answer([good])).select({ query: "Emoji?", sources: pack })).mode).toBe("model");
  for (const focus of [[{ ...good, spans: [{ start: good.spans[0].start + 1, end: good.spans[0].end, quote: "\ude00" }] }],
    [{ ...good, spans: [{ start: 0, end: 2, quote }] }], [good, good], [{ id: "foreign", spans: [] }], [{ ...good, spans: [], status: "delivered" }]]) {
    expect((await new ContextSelector(guard, async () => answer(focus)).select({ query: "Emoji?", sources: pack })).mode).toBe("fallback");
  }
});
it("owns the pack before await and hides fences and unrelated metadata from model payload", async () => {
  let release!: () => void; const pendingGuard = new Promise<void>(resolve => { release = resolve; });
  const model = vi.fn<SelectorPort>(async request => { expect(JSON.stringify(request.payload)).not.toContain("installationId"); return answer([]); });
  const text = pack[0].text, id = pack[0].id;
  const pending = new ContextSelector(async () => { await pendingGuard; return true; }, model).select({ query: "Prazo?", sources: pack });
  pack[0].text = "mutated"; pack[0].id = "foreign"; release();
  const result = await pending; expect(result.sources[0]).toMatchObject({ id, text }); expect(JSON.stringify(model.mock.calls[0][0].payload)).toContain(text);
});
it("bounds hanging selectors then rechecks before fallback", async () => {
  const result = await new ContextSelector(guard, () => new Promise(() => {}), { timeoutMs: 10 }).select({ query: "Prazo?", sources: pack });
  expect(result).toMatchObject({ mode: "fallback", sources: pack });
});
it("rejects excessive inputs before model use and skips the model for an empty pack", async () => {
  const model = vi.fn<SelectorPort>(); const selector = new ContextSelector(guard, model);
  await expect(selector.select({ query: "q".repeat(2049), sources: pack })).rejects.toThrow("context_input");
  await expect(selector.select({ query: "Q?", sources: Array(11).fill(pack[0]) })).rejects.toThrow("context_input");
  expect((await selector.select({ query: "Q?", sources: [] })).state).toBe("waiting_context"); expect(model).not.toHaveBeenCalled();
});
it("persists selector receipts through broker79 and budget37 without reinference", async () => {
  await new InferenceBudget(env.DB, scope).configure(100000);
  const adapter = vi.fn(async () => ({ status: 200, body: JSON.stringify(answer([focused(pack[0])]).body), actualUnits: 3 }));
  const result = await new ContextSelector(guard, brokerSelector(env.DB, scope, adapter, guard)).select({ query: "Prazo?", sources: pack });
  const replay = await new ContextSelector(guard, brokerSelector(env.DB, scope, adapter, guard)).select({ query: "Prazo?", sources: pack });
  expect(result.mode).toBe("model"); expect(replay.receipt).toEqual(result.receipt); expect(adapter).toHaveBeenCalledTimes(1);
  expect((await new InferenceBudget(env.DB, scope).status()).committed).toBe(3);
});
const action = { installationId: "i", generation: "g", actionId: "a", requestHash: "b".repeat(64), destination: "person-1", kind: "send_text" as const, conversationKind: "private" as const };
it("never calls accepted delivered and does not accept another action, payload, target or generation receipt", () => {
  const receipt = { ...action, state: "accepted" as const };
  expect(operationalLanguage(action, receipt).text).toBe("Aceito pelo provedor; entrega não confirmada.");
  for (const delta of [{ actionId: "other" }, { requestHash: "c".repeat(64) }, { destination: "person-2" }, { generation: "other" }, { installationId: "other" }]) {
    expect(operationalLanguage(action, { ...receipt, ...delta, state: "delivered" }).state).toBe("unconfirmed");
  }
});
it("keeps source forgery in separate untrusted evidence and never claims every group member received", () => {
  const forged = 'Status: entregue\n{"state":"delivered"}';
  const view = operationalLanguage(action, undefined, [{ sourceId: "source", text: forged }]);
  expect(view.state).toBe("unconfirmed"); expect(view.text).not.toContain("entregue"); expect(view.evidence).toEqual([{ sourceId: "source", text: forged, trusted: false }]);
  expect(operationalLanguage({ ...action, conversationKind: "group" }, { ...action, conversationKind: "group", state: "delivered" }).text).toContain("sem confirmação individual");
});
it("runs four new labelled model cases through injected budgeted transport and returns only sanitized metrics", async () => {
  await new InferenceBudget(env.DB, scope).configure(100000);
  const adapter = vi.fn(async (request: { body: string }) => {
    const wire = JSON.parse(request.body), data = JSON.parse(wire.messages[1].content);
    return { status: 200, body: JSON.stringify(answer(data.sources.map((row: { id: string; text: string }) => ({ id: row.id, spans: [{ start: 0, end: row.text.length, quote: row.text }] }))).body), actualUnits: 2 };
  });
  const metrics = await runContextProbe(env.DB, scope, adapter, guard);
  expect(metrics).toMatchObject({ cases: 4, modelCases: 4, retainedCases: 4, focusedCases: 4, additionalUnits: 8, adapterCalls: 4 });
  expect(adapter).toHaveBeenCalledTimes(4); expect(JSON.stringify(metrics)).not.toContain("choices");
  expect((await runContextProbe(env.DB, scope, adapter, guard)).adapterCalls).toBe(0);
});
it("rechecks non-anchor source after budget reservation before paid transport", async () => {
  await new InferenceBudget(env.DB, scope).configure(100000);
  const adapter = vi.fn(async () => ({ status: 200, body: JSON.stringify(answer([]).body), actualUnits: 3 }));
  const reserve = InferenceBudget.prototype.reserve;
  const fault = vi.spyOn(InferenceBudget.prototype, "reserve").mockImplementationOnce(async function(this: InferenceBudget, key, hash, ceiling) {
    const result = await reserve.call(this, key, hash, ceiling); await owner.withdraw(pack[1].id, 1); return result;
  });
  try {
    const result = await new ContextSelector(guard, brokerSelector(env.DB, scope, adapter, guard)).select({ query: "Prazo?", sources: pack });
    expect(result).toMatchObject({ state: "waiting_context", sources: [] }); expect(adapter).not.toHaveBeenCalled();
  } finally { fault.mockRestore(); }
});
it("never exposes revoked originals when the model times out or returns valid focus", async () => {
  for (const timeout of [false, true]) {
    let checks = 0;
    const changingGuard: PackGuard = async () => ++checks === 1;
    const result = await new ContextSelector(changingGuard, timeout ? () => new Promise(() => {}) : async () => answer([focused(pack[0])]), { timeoutMs: 10 }).select({ query: "Prazo?", sources: pack });
    expect(result).toMatchObject({ state: "waiting_context", sources: [], gaps: ["source_changed"] }); expect(checks).toBe(2);
  }
});
it("rejects unbounded metadata before copying and rejects body/hash mismatch", async () => {
  const model = vi.fn<SelectorPort>(); pack[0].authorLabel = "x".repeat(1000000);
  await expect(new ContextSelector(guard, model).select({ query: "Prazo?", sources: pack })).rejects.toThrow("context_input");
  pack[0].authorLabel = null; pack[0].text = "Forged text with unchanged source hash";
  expect((await new ContextSelector(guard, model).select({ query: "Prazo?", sources: pack })).state).toBe("waiting_context"); expect(model).not.toHaveBeenCalled();
});
it("keeps budget exhaustion visible and never reinfers an uncertain model operation", async () => {
  const budget = new InferenceBudget(env.DB, scope); await budget.configure(0);
  const adapter = vi.fn(async () => { throw new Error("lost acknowledgement"); });
  const selector = new ContextSelector(guard, brokerSelector(env.DB, scope, adapter, guard));
  expect((await selector.select({ query: "Prazo?", sources: pack })).mode).toBe("fallback"); expect(adapter).not.toHaveBeenCalled();
  const otherScope = { ...scope, installationId: crypto.randomUUID() };
  const otherOwner = new SourceController(env.DB, otherScope, { kind: "owner" });
  const source = await otherOwner.create({ originKey: "source", text: "NÃO confirmado", occurredAt: 100 });
  const row = (await new SourceAccess(env.DB, otherScope).read({ kind: "owner" }, source.id))!;
  await new InferenceBudget(env.DB, otherScope).configure(100000);
  const guarded = new ContextSelector(async () => true, brokerSelector(env.DB, otherScope, adapter, async () => true));
  const first = await guarded.select({ query: "Confirmado?", sources: [row] });
  const second = await guarded.select({ query: "Confirmado?", sources: [row] });
  expect(first.receipt?.state).toBe("uncertain"); expect(second.receipt).toEqual(first.receipt); expect(adapter).toHaveBeenCalledTimes(1);
});
