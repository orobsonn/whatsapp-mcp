import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { CogneeModelBroker, type BrokerConfig, type ModelAdapter, type ModelAdmission } from "../assistant/model-broker";
import { SourceController } from "../assistant/sources";
import { InferenceBudget, type BudgetScope } from "../assistant/budget";
// @ts-expect-error Vite raw SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL.
import controls from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Vite raw SQL.
import budgets from "../assistant/migrations/0008_inference_budget.sql?raw";
// @ts-expect-error Vite raw SQL.
import receipts from "../assistant/migrations/0010_model_receipts.sql?raw";
let scope: BudgetScope, budget: InferenceBudget, owner: SourceController, broker: CogneeModelBroker, sourceId: string, now: number;
let adapter: ReturnType<typeof vi.fn<ModelAdapter>>;
const config: BrokerConfig = { extractionConfig: "cognee-1.6.5-extract-v1", priceVersion: "synthetic-v1",
  chatModel: "gpt-6-luna", embeddingModel: "text-embedding-3-small", maxOutputTokens: 2000, chatCeiling: 5, embeddingCeiling: 2 };
const path = "/v1/chat/completions";
const payload = () => ({ model: config.chatModel, messages: [{ role: "user", content: "Synthetic source" }], max_tokens: 100 });
beforeEach(async () => {
  for (const sql of [sources, controls, budgets, receipts]) {
    const statements = sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim());
    await env.DB.batch(statements.map((part: string) => env.DB.prepare(part)));
  }
  scope = { installationId: crypto.randomUUID(), generation: "g1", period: "2026-10-25" }; now = 100;
  budget = new InferenceBudget(env.DB, scope); await budget.configure(30);
  owner = new SourceController(env.DB, scope, { kind: "owner" }, () => now);
  sourceId = (await owner.create({ originKey: "source", text: "Synthetic source", occurredAt: 100 })).id;
  adapter = vi.fn<ModelAdapter>(async () => ({ status: 200, body: '{"choices":[{"message":{"content":"synthetic answer"}}]}', actualUnits: 3 }));
  broker = new CogneeModelBroker(env.DB, scope, config, adapter, () => now);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const permit = () => broker.issuePermit(sourceId, 1, 200);
it("deduplicates different job aliases and equivalent payload ordering with persistent receipts", async () => {
  const first = await broker.invoke(await permit(), path, payload(), "job-one");
  const restarted = new CogneeModelBroker(env.DB, scope, config, adapter, () => now);
  expect(await restarted.invoke(await permit(), path, Object.fromEntries(Object.entries(payload()).reverse()), "job-two")).toEqual(first);
  expect(first).toMatchObject({ state: "complete", body: { choices: [{ message: { content: "synthetic answer" } }] } });
  expect(adapter).toHaveBeenCalledTimes(1); expect((await budget.status()).committed).toBe(3);
});
it("admits only one external call under concurrent aliases", async () => {
  const token = await permit();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => broker.invoke(token, path, payload(), `job-${i}`)));
  expect(results.some(result => result.state === "complete")).toBe(true); expect(adapter).toHaveBeenCalledTimes(1);
  expect((await budget.status()).committed).toBe(3);
});
it("blocks invalid permit, expiry, namespace, source correction and withdrawal", async () => {
  const token = await permit();
  await expect(broker.invoke("0".repeat(64), path, payload())).rejects.toThrow("broker_denied");
  const outside = new CogneeModelBroker(env.DB, { ...scope, generation: "g2" }, config, adapter, () => now);
  await expect(outside.invoke(token, path, payload())).rejects.toThrow("broker_denied");
  now = 200; await expect(broker.invoke(token, path, payload())).rejects.toThrow("broker_denied"); now = 100;
  await owner.correct(sourceId, 1, { text: "Corrected", occurredAt: 100 });
  await expect(broker.invoke(token, path, payload())).rejects.toThrow("broker_denied");
  await expect(permit()).rejects.toThrow("broker_denied");
  await owner.withdraw(sourceId, 2);
  await expect(broker.issuePermit(sourceId, 3, 200)).rejects.toThrow("broker_denied"); expect(adapter).not.toHaveBeenCalled();
});
it("requires budget before the adapter and preserves uncertain reservations without reinference", async () => {
  const zeroScope = { ...scope, installationId: crypto.randomUUID() };
  const zeroOwner = new SourceController(env.DB, zeroScope, { kind: "owner" }, () => now);
  const zeroSource = await zeroOwner.create({ originKey: "source", text: "Synthetic", occurredAt: 100 });
  await new InferenceBudget(env.DB, zeroScope).configure(0);
  const zero = new CogneeModelBroker(env.DB, zeroScope, config, adapter, () => now);
  await expect(zero.invoke(await zero.issuePermit(zeroSource.id, 1, 200), path, payload())).rejects.toThrow("broker_budget_exhausted");
  expect(adapter).not.toHaveBeenCalled();
  adapter.mockRejectedValue(new Error("secret-provider-token-do-not-return"));
  const token = await permit(); const failed = await broker.invoke(token, path, payload(), "one");
  expect(failed.state).toBe("uncertain"); expect(JSON.stringify(failed)).not.toContain("secret-provider");
  expect((await broker.invoke(token, path, payload(), "two")).state).toBe("uncertain");
  expect(adapter).toHaveBeenCalledTimes(1); expect((await budget.status()).committed).toBe(5);
});
it("rejects arbitrary routes, models, fields and excessive bodies without spending", async () => {
  const token = await permit();
  for (const [route, body] of [["https://evil.example", payload()], [path, { ...payload(), model: "unknown" }],
    [path, { ...payload(), api_key: "forbidden" }], [path, { ...payload(), max_tokens: 2001 }],
    [path, { ...payload(), messages: [{ role: "user", content: "x".repeat(66000) }] }]]) {
    await expect(broker.invoke(token, route as string, body)).rejects.toThrow("broker_invalid_request");
  }
  expect(adapter).not.toHaveBeenCalled(); expect((await budget.status()).committed).toBe(0);
});
it("preserves structured output and scopes changed payload or extraction configuration", async () => {
  const token = await permit(); const body = { ...payload(), response_format: { type: "json_schema", json_schema: { name: "claims", schema: { type: "object" }, strict: true } } };
  await broker.invoke(token, path, body);
  expect(JSON.parse(adapter.mock.calls[0][0].body).response_format).toEqual(body.response_format);
  await broker.invoke(token, path, { ...body, temperature: 0 }); expect(adapter).toHaveBeenCalledTimes(2);
  const configured = new CogneeModelBroker(env.DB, scope, { ...config, extractionConfig: "v2" }, adapter, () => now);
  await expect(configured.invoke(token, path, body)).rejects.toThrow("broker_denied");
  await configured.invoke(await configured.issuePermit(sourceId, 1, 200), path, body); expect(adapter).toHaveBeenCalledTimes(3);
});
it("accepts only bounded embedding calls and retains the source guard when returning cached content", async () => {
  const token = await permit(); adapter.mockResolvedValue({ status: 200, body: JSON.stringify({ data: [{ index: 0, embedding: Array(1536).fill(0.1) }] }), actualUnits: 1 });
  const body = { model: config.embeddingModel, input: ["Synthetic"], dimensions: 1536, encoding_format: "float" };
  await broker.invoke(token, "/v1/embeddings", body);
  await expect(broker.invoke(token, "/v1/embeddings", { ...body, input: Array(5).fill("x") })).rejects.toThrow("broker_invalid_request");
  await owner.withdraw(sourceId, 1); await expect(broker.invoke(token, "/v1/embeddings", body)).rejects.toThrow("broker_denied");
  expect(adapter).toHaveBeenCalledTimes(1);
});
it("recovers a stored response after settlement acknowledgement is lost", async () => {
  const token = await permit(), batch = env.DB.batch.bind(env.DB); let lost = false;
  const fault = vi.spyOn(env.DB, "batch").mockImplementation(async statements => {
    const result = await batch(statements);
    if (!lost) { lost = true; throw new Error("synthetic settlement acknowledgement lost"); }
    return result;
  });
  expect((await broker.invoke(token, path, payload())).state).toBe("uncertain"); fault.mockRestore();
  expect((await broker.invoke(token, path, payload(), "another-job")).state).toBe("complete");
  expect(adapter).toHaveBeenCalledTimes(1); expect((await budget.status()).committed).toBe(3);
});
it("never executes after the admission acknowledgement is lost", async () => {
  const token = await permit(), prepare = env.DB.prepare.bind(env.DB);
  const fault = vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("INSERT INTO assistant_model_receipts")) return statement;
    return new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => {
        const bound = target.bind(...values);
        return new Proxy(bound, { get(value, key) {
          if (key === "all") return async () => { await value.all(); throw new Error("synthetic admission acknowledgement lost"); };
          const method = Reflect.get(value, key); return typeof method === "function" ? method.bind(value) : method;
        } });
      };
      const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
    } });
  });
  expect((await broker.invoke(token, path, payload())).state).toBe("uncertain"); fault.mockRestore();
  expect((await broker.invoke(token, path, payload(), "another-job")).state).toBe("uncertain");
  expect(adapter).not.toHaveBeenCalled(); expect((await budget.status()).committed).toBe(5);
});
it("stores late provider truth but does not return content after withdrawal", async () => {
  const token = await permit(); adapter.mockImplementation(async () => {
    await owner.withdraw(sourceId, 1); return { status: 200, body: '{"choices":[{"message":{"content":"late private answer"}}]}', actualUnits: 3 };
  });
  await expect(broker.invoke(token, path, payload())).rejects.toThrow("broker_denied");
  expect((await budget.status()).committed).toBe(3);
  expect(await env.DB.prepare("SELECT state FROM assistant_model_receipts WHERE installation_id=?").bind(scope.installationId).first()).toEqual({ state: "complete" });
});
it("keeps a lost reservation acknowledgement uncertain without submitting", async () => {
  const token = await permit(), reserve = InferenceBudget.prototype.reserve;
  const fault = vi.spyOn(InferenceBudget.prototype, "reserve").mockImplementationOnce(async function (this: InferenceBudget, key, hash, ceiling) {
    await reserve.call(this, key, hash, ceiling); throw new Error("synthetic reserve acknowledgement lost");
  });
  expect((await broker.invoke(token, path, payload())).state).toBe("uncertain"); fault.mockRestore();
  expect((await broker.invoke(token, path, payload(), "retry-job")).state).toBe("uncertain");
  expect(adapter).not.toHaveBeenCalled(); expect((await budget.status()).committed).toBe(5);
});
it("preserves a response whose persistence acknowledgement was lost", async () => {
  const token = await permit(), prepare = env.DB.prepare.bind(env.DB);
  const fault = vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql); if (!sql.startsWith("UPDATE assistant_model_receipts SET state='response_ready'")) return statement;
    return new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => {
        const bound = target.bind(...values);
        return new Proxy(bound, { get(value, key) {
          if (key === "run") return async () => { await value.run(); throw new Error("synthetic response acknowledgement lost"); };
          const method = Reflect.get(value, key); return typeof method === "function" ? method.bind(value) : method;
        } });
      };
      const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
    } });
  });
  expect((await broker.invoke(token, path, payload())).state).toBe("uncertain"); fault.mockRestore();
  expect((await broker.invoke(token, path, payload())).state).toBe("complete");
  expect(adapter).toHaveBeenCalledTimes(1); expect((await budget.status()).committed).toBe(3);
});
it("checks source withdrawal in the admission mutation after budget reservation", async () => {
  const token = await permit(), reserve = InferenceBudget.prototype.reserve;
  const fault = vi.spyOn(InferenceBudget.prototype, "reserve").mockImplementationOnce(async function (this: InferenceBudget, key, hash, ceiling) {
    const reservation = await reserve.call(this, key, hash, ceiling); await owner.withdraw(sourceId, 1); return reservation;
  });
  await expect(broker.invoke(token, path, payload())).rejects.toThrow("broker_denied"); fault.mockRestore();
  expect(adapter).not.toHaveBeenCalled(); expect((await budget.status()).committed).toBe(5);
});
it("bounds a stalled adapter and conserves its reservation", async () => {
  const token = await permit(); vi.useFakeTimers(); adapter.mockImplementation(() => new Promise(() => {}));
  let outcome: { state: string } | undefined;
  const pending = broker.invoke(token, path, payload()).then(result => { outcome = result; });
  await vi.waitFor(() => expect(adapter).toHaveBeenCalled(), { timeout: 5000 });
  await vi.advanceTimersByTimeAsync(45001);
  expect(outcome).toMatchObject({ state: "uncertain" }); await pending;
  expect((await budget.status()).committed).toBe(5);
});
it("redacts unusable HTTP200 responses and records known overage without reinference", async () => {
  const token = await permit(); adapter.mockResolvedValue({ status: 200, body: '{"error":"secret-provider-token"}', actualUnits: 40 });
  const result = await broker.invoke(token, path, payload());
  expect(result.state).toBe("uncertain"); expect(JSON.stringify(result)).not.toContain("secret-provider");
  expect((await broker.invoke(token, path, payload(), "alias")).state).toBe("uncertain");
  expect(adapter).toHaveBeenCalledTimes(1); expect(await budget.status()).toMatchObject({ committed: 40, blocked: true });
});
it("validates embedding indexes and finite dimensions and accepts four complete vectors", async () => {
  const token = await permit(), body = { model: config.embeddingModel, input: ["one", "two", "three", "four"] };
  adapter.mockResolvedValue({ status: 200, body: JSON.stringify({ data: Array.from({ length: 4 }, (_, index) => ({ index, embedding: Array(1536).fill(1.2345678912345678e-200) })) }), actualUnits: 1 });
  expect((await broker.invoke(token, "/v1/embeddings", body)).state).toBe("complete");
  for (const data of [[{ index: 0, embedding: [1] }], [{ index: 1, embedding: Array(1536).fill(1) }],
    [{ index: 0, embedding: Array(1536).fill(null) }]]) {
    adapter.mockResolvedValue({ status: 200, body: JSON.stringify({ data }), actualUnits: 1 });
    expect((await broker.invoke(token, "/v1/embeddings", { ...body, input: [JSON.stringify(data)] })).state).toBe("uncertain");
  }
});
it("owns payload and config before hashing yields and supplies the host token bound", async () => {
  const settings = { ...config }, configured = new CogneeModelBroker(env.DB, scope, settings, adapter, () => now);
  const token = await configured.issuePermit(sourceId, 1, 200), body = { model: config.chatModel, messages: [{ role: "user", content: "original" }] };
  const pending = configured.invoke(token, path, body); body.messages[0].content = "mutated"; settings.maxOutputTokens = 1;
  await pending; expect(JSON.parse(adapter.mock.calls[0][0].body)).toMatchObject({ max_completion_tokens: 2000, messages: [{ content: "original" }] });
});
it("replays complete exact receipts on a new budget day without reservation, settlement or transport", async () => {
  const token = await permit(), first = await broker.invoke(token, path, payload());
  const tomorrow = { ...scope, period: "2026-10-26" }; await new InferenceBudget(env.DB, tomorrow).configure(0);
  const replay = new CogneeModelBroker(env.DB, tomorrow, config, adapter, () => now);
  const reserve = vi.spyOn(InferenceBudget.prototype, "reserve"), settle = vi.spyOn(InferenceBudget.prototype, "settle");
  expect(await replay.replay(token, path, Object.fromEntries(Object.entries(payload()).reverse()))).toEqual(first);
  expect(reserve).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); expect(adapter).toHaveBeenCalledTimes(1);
  expect((await new InferenceBudget(env.DB, tomorrow).status()).committed).toBe(0); expect((await budget.status()).committed).toBe(3);
});
it("blocks replay cache misses, changed payload/config and another source without creating receipts", async () => {
  const token = await permit(); await broker.invoke(token, path, payload());
  const reserve = vi.spyOn(InferenceBudget.prototype, "reserve"), settle = vi.spyOn(InferenceBudget.prototype, "settle");
  expect(await broker.replay(token, path, { ...payload(), temperature: 0 })).toMatchObject({ state: "blocked" });
  const other = await owner.create({ originKey: "another", text: "Synthetic source", occurredAt: 100 });
  expect(await broker.replay(await broker.issuePermit(other.id, 1, 200), path, payload())).toMatchObject({ state: "blocked" });
  const changed = new CogneeModelBroker(env.DB, scope, { ...config, extractionConfig: "different" }, adapter, () => now);
  expect(await changed.replay(await changed.issuePermit(sourceId, 1, 200), path, payload())).toMatchObject({ state: "blocked" });
  expect(reserve).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); expect(adapter).toHaveBeenCalledTimes(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_model_receipts WHERE installation_id=?").bind(scope.installationId).first<{ n: number }>())?.n).toBe(1);
});
it.each(["attempting", "uncertain", "response_ready"])("never reconciles or submits a non-complete replay receipt: %s", async state => {
  const token = await permit(), first = await broker.invoke(token, path, payload());
  await env.DB.prepare(`UPDATE assistant_model_receipts SET state=?,response_json=?,actual_units=? WHERE installation_id=? AND operation_key=?`)
    .bind(state, state === "response_ready" ? JSON.stringify(first.body) : null, state === "attempting" ? null : 3, scope.installationId, first.operationKey!).run();
  const reserve = vi.spyOn(InferenceBudget.prototype, "reserve"), settle = vi.spyOn(InferenceBudget.prototype, "settle");
  expect(await broker.replay(token, path, payload())).toMatchObject({ state: "blocked" });
  expect(reserve).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); expect(adapter).toHaveBeenCalledTimes(1);
});
it("rechecks source withdrawal after reading the persistent replay response", async () => {
  const token = await permit(); await broker.invoke(token, path, payload());
  const prepare = env.DB.prepare.bind(env.DB); let withdrawn = false;
  vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql); if (!sql.startsWith("SELECT state,response_json,actual_units FROM assistant_model_receipts")) return statement;
    return new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => {
        const bound = target.bind(...values);
        return new Proxy(bound, { get(value, key) {
          if (key === "first") return async () => { const row = await value.first(); if (!withdrawn) { withdrawn = true; await owner.withdraw(sourceId, 1); } return row; };
          const method = Reflect.get(value, key); return typeof method === "function" ? method.bind(value) : method;
        } });
      };
      const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
    } });
  });
  await expect(broker.replay(token, path, payload())).rejects.toThrow("broker_denied"); expect(adapter).toHaveBeenCalledTimes(1);
});
it("reserves the exact request before atomically admitting the host slot and model receipt", async () => {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS synthetic_admission(id TEXT PRIMARY KEY)").run();
  const admission: ModelAdmission = { async prepare({ key }) {
    expect((await budget.status()).committed).toBe(5);
    return { statements: [env.DB.prepare("INSERT INTO synthetic_admission VALUES(?)").bind(key)],
      guard: { sql: "EXISTS(SELECT 1 FROM synthetic_admission WHERE id=?)", values: [key] } };
  }, async uncertain() { throw new Error("unexpected_uncertainty"); } };
  broker = new CogneeModelBroker(env.DB, scope, config, adapter, () => now, admission);
  adapter.mockImplementation(async () => {
    expect(await env.DB.prepare("SELECT id FROM synthetic_admission").first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT operation_key FROM assistant_model_receipts WHERE installation_id=? AND state='attempting'").bind(scope.installationId).first()).not.toBeNull();
    return { status: 200, body: '{"choices":[{"message":{"content":"synthetic answer"}}]}', actualUnits: 3 };
  });
  expect((await broker.invoke(await permit(), path, payload())).state).toBe("complete");
  expect(adapter).toHaveBeenCalledTimes(1);
});
it.each(["null", "throw", "false"])("host admission %s preserves the reservation, latches and calls no adapter", async mode => {
  const latch = vi.fn(async () => {});
  const admission: ModelAdmission = { async prepare() {
    if (mode === "throw") throw new Error("synthetic_lost_ack");
    return mode === "null" ? null : { statements: [], guard: { sql: "0=1", values: [] } };
  }, uncertain: latch };
  broker = new CogneeModelBroker(env.DB, scope, config, adapter, () => now, admission);
  expect((await broker.invoke(await permit(), path, payload())).state).toBe("uncertain");
  expect(latch).toHaveBeenCalledTimes(1); expect(adapter).not.toHaveBeenCalled();
  expect((await budget.status()).committed).toBe(5);
});
it("a recovered complete receipt still requires host admission without reserve/settle; replay never invokes host admission", async () => {
  const token = await permit(); await broker.invoke(token, path, payload());
  const latch = vi.fn(async () => {}), hook = vi.fn(async () => ({ statements: [], guard: { sql: "0=1", values: [] } }));
  broker = new CogneeModelBroker(env.DB, scope, config, adapter, () => now, { prepare: hook, uncertain: latch });
  const reserve = vi.spyOn(InferenceBudget.prototype, "reserve"), settle = vi.spyOn(InferenceBudget.prototype, "settle");
  expect(await broker.invoke(token, path, payload())).toMatchObject({ state: "uncertain" });
  expect(hook).toHaveBeenCalledTimes(1); expect(latch).toHaveBeenCalledTimes(1);
  expect(reserve).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
  expect((await broker.replay(token, path, payload())).state).toBe("complete");
  expect(hook).toHaveBeenCalledTimes(1); expect(adapter).toHaveBeenCalledTimes(1);
});
it("a lost atomic admission ACK preserves attempting truth, latches and performs zero adapter calls", async () => {
  const latch = vi.fn(async () => {}), batch = env.DB.batch.bind(env.DB);
  const token = await permit();
  broker = new CogneeModelBroker(env.DB, scope, config, adapter, () => now,
    { async prepare() { return { statements: [], guard: { sql: "1=1", values: [] } }; }, uncertain: latch });
  vi.spyOn(env.DB, "batch").mockImplementation(async statements => { await batch(statements); throw new Error("synthetic_ack_lost"); });
  expect((await broker.invoke(token, path, payload())).state).toBe("uncertain");
  expect(adapter).not.toHaveBeenCalled(); expect(latch).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare("SELECT state FROM assistant_model_receipts WHERE installation_id=?").bind(scope.installationId).first("state")).toBe("attempting");
});
it("a lost settlement ACK also latches the episode despite preserving the paid receipt", async () => {
  const latch = vi.fn(async () => {}), settle = InferenceBudget.prototype.settle;
  broker = new CogneeModelBroker(env.DB, scope, config, adapter, () => now,
    { async prepare() { return { statements: [], guard: { sql: "1=1", values: [] } }; }, uncertain: latch });
  vi.spyOn(InferenceBudget.prototype, "settle").mockImplementation(async function(this: InferenceBudget, ...args) { await settle.apply(this, args); throw new Error("synthetic_settlement_ack"); });
  expect((await broker.invoke(await permit(), path, payload())).state).toBe("uncertain");
  expect(adapter).toHaveBeenCalledTimes(1); expect(latch).toHaveBeenCalledTimes(1);
  expect((await budget.status()).committed).toBe(3);
});
