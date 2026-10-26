import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { RetentionAuthorityCore, configuredRetirementGuard, retirementBootstrapPlan, retirementKeys, sourceRetirementGuard, type RetirementStore } from "../assistant/retention-authority";
import { SourceController } from "../assistant/sources";
import { OwnerAssistant } from "../assistant/mcp";
import { SourceAccess } from "../assistant/access";
import { bridgeHash } from "../assistant/ingress";
// @ts-expect-error Vite SQL assets.
const migrations = import.meta.glob("../assistant/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
class Store implements RetirementStore {
  values = new Map<string, unknown>(); failure?: "ack" | "rollback"; private tail = Promise.resolve();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async transaction<T>(action: (store: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>) {
    const previous = this.tail; let release!: () => void; this.tail = new Promise(resolve => { release = resolve; }); await previous;
    const next = new Map(structuredClone([...this.values]));
    try { const result = await action({ get: async <T>(key: string) => structuredClone(next.get(key)) as T | undefined, put: async (key, value) => { next.set(key, structuredClone(value)); } });
      const failure = this.failure; this.failure = undefined; if (failure === "rollback") throw new Error("synthetic rollback"); this.values = next;
      if (failure === "ack") throw new Error("synthetic ACK lost"); return result;
    } finally { release(); }
  }
}
const owner = { kind: "owner" } as const;
let store: Store, scope: { installationId: string; generation: string };
beforeEach(async () => {
  for (const [, sql] of Object.entries(migrations).sort()) await env.DB.batch(sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(part => part.trim()).map(part => env.DB.prepare(part)));
  store = new Store(); scope = { installationId: crypto.randomUUID(), generation: "retention-test" };
});
async function initialized() {
  const plan = await retirementBootstrapPlan(env.DB, scope), core = new RetentionAuthorityCore(store, scope.installationId, plan.seal);
  await core.begin(plan.manifest); for (let page = 0; page < plan.pages.length; page++) await core.append(plan.seal, page, plan.pages[page]); await core.seal(plan.seal);
  return { core, plan };
}
test("unavailable, unsealed or malformed authority never means an empty retired list", async () => {
  const key = "a".repeat(64), core = new RetentionAuthorityCore(store, scope.installationId);
  expect(await core.lookup(scope.installationId, [key])).toEqual({ state: "unavailable" });
  const plan = await retirementBootstrapPlan(env.DB, scope);
  await expect(core.begin(plan.manifest)).rejects.toThrow("retention_bootstrap_seal");
  const pending = new RetentionAuthorityCore(store, scope.installationId, plan.seal); await pending.begin(plan.manifest);
  expect(await pending.lookup(scope.installationId, [key])).toEqual({ state: "unavailable" });
  store.values.set("state", { phase: "sealed" }); await expect(pending.lookup(scope.installationId, [key])).rejects.toThrow();
});
test("paged sealed bootstrap covers every tombstone and exact lost ACK recovery never changes a page", async () => {
  const keys = (await Promise.all(Array.from({ length: 260 }, (_, index) => bridgeHash(["retired", index])))).sort();
  let chain = await bridgeHash(["retention-tombstones-v1"]); const pages = [];
  for (let offset = 0; offset < keys.length; offset += 128) { const page = keys.slice(offset, offset + 128); pages.push(page); chain = await bridgeHash([chain, page]); }
  const manifest = { installationId: scope.installationId, generation: scope.generation, sourceCount: 130, sourceInventoryHash: "b".repeat(64), tombstoneCount: keys.length, tombstoneDigest: chain }, seal = await bridgeHash(manifest), core = new RetentionAuthorityCore(store, scope.installationId, seal);
  store.failure = "ack"; await core.begin(manifest);
  for (let page = 0; page < pages.length; page++) { store.failure = "ack"; const receipt = await core.append(seal, page, pages[page]); expect(await core.append(seal, page, pages[page])).toEqual(receipt); }
  await expect(core.append(seal, 0, ["f".repeat(64)])).rejects.toThrow("retention_bootstrap_conflict");
  store.failure = "ack"; await core.seal(seal);
  expect(await core.lookup(scope.installationId, [keys[259]])).toMatchObject({ state: "sealed", blocked: [keys[259]] });
  await expect(core.lookup("other-installation", [keys[259]])).rejects.toThrow("retention_authority_affinity");
});
test("partial or wrong-digest bootstrap cannot be sealed and a new empty manifest cannot erase authority", async () => {
  const empty = await retirementBootstrapPlan(env.DB, scope), manifest = { ...empty.manifest, tombstoneCount: 1 }, seal = await bridgeHash(manifest), core = new RetentionAuthorityCore(store, scope.installationId, seal);
  await core.begin(manifest); await expect(core.seal(seal)).rejects.toThrow("retention_bootstrap_uncertain");
  expect(await core.lookup(scope.installationId, ["a".repeat(64)])).toEqual({ state: "unavailable" });
  await expect(new RetentionAuthorityCore(store, scope.installationId, empty.seal).begin(empty.manifest)).rejects.toThrow("retention_bootstrap_uncertain");
});
test("monotone retirements survive restart, concurrent aliases and a lost record ACK", async () => {
  const { core } = await initialized(), keys = await retirementKeys(scope.installationId, "owner_note", "private-origin", "source");
  store.failure = "ack"; expect(await core.record(scope.installationId, keys)).toMatchObject({ state: "sealed", blocked: keys });
  const restart = new RetentionAuthorityCore(store, scope.installationId);
  const outcomes = await Promise.all([restart.record(scope.installationId, keys), core.record(scope.installationId, keys)]);
  expect(outcomes[0]).toEqual(outcomes[1]); expect(await restart.lookup(scope.installationId, keys)).toMatchObject({ blocked: keys });
  expect(JSON.stringify([...store.values])).not.toContain("private-origin");
});
test.each([null,false,0])("corrupt retirement marker %s never authorizes a restored origin or gets overwritten",async value=>{
  const {core}=await initialized(),keys=await retirementKeys(scope.installationId,"owner_note","retired-origin","source");
  const key="retired:"+keys[0];store.values.set(key,value);
  await expect(core.lookup(scope.installationId,keys)).rejects.toThrow("retention_authority_corrupt");
  await expect(core.record(scope.installationId,keys)).rejects.toThrow("retention_authority_corrupt");
  await expect(sourceRetirementGuard(scope.installationId,core).allow("owner_note","retired-origin","source")).rejects.toThrow("retention_authority_corrupt");
  expect(store.values.get(key)).toBe(value);
});
test("bootstrap discovers withdrawn sources in every generation without reading their bodies", async () => {
  const oldScope = { ...scope, generation: "older" }, old = new SourceController(env.DB, oldScope, owner), source = await old.create({ originKey: "old-private", text: "BODY MUST NOT ENTER AUTHORITY", occurredAt: 1 }); await old.withdraw(source.id, 1);
  const { core, plan } = await initialized(); expect(plan.manifest.sourceCount).toBe(1); expect(plan.manifest.tombstoneCount).toBe(2);
  expect(await core.lookup(scope.installationId, await retirementKeys(scope.installationId, "owner_note", "old-private"))).toMatchObject({ state: "sealed", blocked: [expect.any(String)] });
  expect(JSON.stringify(plan)).not.toContain("BODY MUST NOT ENTER AUTHORITY");
});
test("withdraw records external authority first, blocks reads and prevents a new generation recreating the same origin", async () => {
  const { core } = await initialized(), guard = sourceRetirementGuard(scope.installationId, { lookup: core.lookup.bind(core), record: async (installationId, keys) => {
    expect(await env.DB.prepare("SELECT status FROM assistant_sources WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("status")).toBe("withdrawn"); return core.record(installationId, keys);
  } });
  const controller = new SourceController(env.DB, scope, owner, () => 100, guard), source = await controller.create({ originKey: "retire", text: "Synthetic original", occurredAt: 1 });
  await controller.withdraw(source.id, 1);
  expect(await new SourceAccess(env.DB, scope).read(owner, source.id)).toBeNull();
  await expect(new SourceController(env.DB, { ...scope, generation: "new-generation" }, owner, () => 100, guard).create({ originKey: "retire", text: "Synthetic old snapshot", occurredAt: 1 })).rejects.toThrow("source_retired");
});
test("stale revision and missing authority cannot silently claim withdrawal or admit new notes", async () => {
  const { core } = await initialized(), guard = sourceRetirementGuard(scope.installationId, core), controller = new SourceController(env.DB, scope, owner, () => 100, guard);
  const source = await controller.create({ originKey: "still-active", text: "Synthetic current", occurredAt: 1 });
  await expect(controller.withdraw(source.id, 2)).rejects.toThrow("source_revision_conflict"); expect(await core.lookup(scope.installationId, await retirementKeys(scope.installationId, "owner_note", "still-active", source.id))).toMatchObject({ blocked: [] });
  const unavailable = sourceRetirementGuard(scope.installationId, { lookup: async () => ({ state: "unavailable" }), record: async () => ({ state: "unavailable" }) });
  await expect(new SourceController(env.DB, scope, owner, () => 100, unavailable).withdraw(source.id, 1)).rejects.toThrow("retention_authority_unavailable");
  expect(await new SourceAccess(env.DB, scope).read(owner, source.id)).toBeNull();
  expect(() => configuredRetirementGuard({ INSTALLATION_ID: scope.installationId, RETENTION_AUTHORITY_REQUIRED: "true" })).toThrow("retention_authority_unconfigured");
  expect(() => configuredRetirementGuard({ INSTALLATION_ID: scope.installationId, RETENTION_AUTHORITY_REQUIRED: "tru" })).toThrow("retention_authority_configuration");
  const affinity = { ...scope, sourceEpoch: "e", sourceGeneration: "g" }, rpc = new OwnerAssistant(createExecutionContext(), { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: "e", BRIDGE_SOURCE_GENERATION: "g", RETENTION_AUTHORITY_REQUIRED: "true" });
  await expect(rpc.source(affinity, { kind: "source.withdraw", operationId: "withdraw", id: source.id, expectedRevision: 1 })).rejects.toThrow("retention_authority_unconfigured");
});
test("public command replay after D1 ACK loss keeps the original receipt and durable retirement", async () => {
  const { core } = await initialized(), guard = sourceRetirementGuard(scope.installationId, core), legacy = new SourceController(env.DB, scope, owner, () => 100, guard), source = await legacy.create({ originKey: "lost-ack", text: "Synthetic original", occurredAt: 1 });
  const batch = env.DB.batch.bind(env.DB); let count = 0;
  const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { const result = await batch(statements); if (++count === 2) throw new Error("synthetic ACK lost"); return result; } } as D1Database;
  const controller = new SourceController(db, scope, owner, () => 100, guard), command = { kind: "source.withdraw", operationId: "retire-ack", id: source.id, expectedRevision: 1 };
  await expect(controller.execute(command)).rejects.toThrow("synthetic ACK lost");
  expect(await controller.execute(command)).toMatchObject({ id: source.id, revision: 2, operationId: "retire-ack" });
  expect((await core.lookup(scope.installationId, await retirementKeys(scope.installationId, "owner_note", "lost-ack", source.id)))).toMatchObject({ state: "sealed", blocked: expect.any(Array) });
});
test("export receiver enforces exact owner binding affinity before returning records", async () => {
  const source = await new SourceController(env.DB, scope, owner).create({ originKey: "export-owner", text: "Synthetic export through owner receiver", occurredAt: 1 });
  const affinity = { ...scope, sourceEpoch: "e", sourceGeneration: "g" }, rpc = new OwnerAssistant(createExecutionContext(), { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: "e", BRIDGE_SOURCE_GENERATION: "g" });
  await expect(rpc.query({ ...affinity, generation: "other" }, { kind: "assistant.export" })).rejects.toThrow("owner_binding_affinity");
  const page = await rpc.query(affinity, { kind: "assistant.export", limit: 50 });
  expect(page).toMatchObject({ namespace: affinity, financialScope: "installation_all_generations_all_periods" });
  expect(JSON.stringify(page)).not.toContain("Synthetic export through owner receiver"); // Bodies are base64 parts, not extra diagnostic copies.
  const exported = page as { parts: { table: string; data: string }[] };
  const sources = exported.parts.filter(part => part.table === "assistant_sources").map(part => JSON.parse(atob(part.data)));
  expect(sources).toEqual([expect.objectContaining({ id: source.id, installation_id: scope.installationId, generation: scope.generation })]);
});
