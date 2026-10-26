import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { SourceController, sourceTextHash } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { InferenceBudget } from "../assistant/budget";
import { RetentionAuthorityCore, retirementBootstrapPlan, sourceRetirementGuard, type RetirementStore } from "../assistant/retention-authority";
import { SnapshotAuthorityCore } from "../assistant/retention-snapshot-authority";
import { SnapshotProducer } from "../assistant/retention-snapshot";
import { SnapshotVerifier, canonicalSnapshotTables, type SnapshotPacket, type SnapshotManifest } from "../assistant/retention-snapshot-contract";
import { bridgeHash } from "../assistant/ingress";
class Store implements RetirementStore {
  values = new Map<string, unknown>(); failure?: "ack"; private tail = Promise.resolve();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async transaction<T>(action: (store: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>) {
    const previous = this.tail; let release!: () => void; this.tail = new Promise(resolve => { release = resolve; }); await previous;
    const next = new Map(structuredClone([...this.values]));
    try { const result = await action({ get: async <T>(key: string) => structuredClone(next.get(key)) as T | undefined, put: async (key, value) => { next.set(key, structuredClone(value)); } });
      this.values = next; const failure = this.failure; this.failure = undefined; if (failure === "ack") throw new Error("synthetic DO ACK lost"); return result;
    } finally { release(); }
  }
}
const owner = { kind: "owner" } as const;
let scope: { installationId: string; generation: string }, store: Store, retirement: RetentionAuthorityCore, authority: SnapshotAuthorityCore, producer: SnapshotProducer;
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1" }; store = new Store();
  const plan = await retirementBootstrapPlan(env.DB, scope); retirement = new RetentionAuthorityCore(store, scope.installationId, plan.seal); await retirement.begin(plan.manifest); await retirement.seal(plan.seal);
  authority = new SnapshotAuthorityCore(store, scope.installationId, view => retirement.status(view)); producer = new SnapshotProducer(env.DB, scope, owner, authority, () => 100);
});
afterEach(async () => { await env.DB.prepare("UPDATE assistant_retention_installation_gate SET state='idle' WHERE installation_id=?").bind(scope.installationId).run(); });
const note = () => new SourceController(env.DB, scope, owner).create({ originKey: "source", text: "Synthetic canonical body", occurredAt: 1 });
async function pages(operationId = "snapshot", service = producer) {
  let begin = await service.execute({ kind: "snapshot.begin", operationId }); for(let i=0;begin.state === "preparing" && i<1000;i++)begin=await service.execute({kind:"snapshot.advance",operationId}); if (!("index" in begin)) throw new Error("test_begin");
  const packets: SnapshotPacket[] = []; let index = 0, cursor: string | null = null;
  for (;;) { const result = await service.execute({ kind: "snapshot.page", operationId, index, cursor }); if (!("packet" in result)) throw new Error("test_page"); packets.push(result.packet); index++; cursor = result.packet.page.nextCursor ?? null; if (!cursor) break; if (index > 30) throw new Error("test_page_capacity"); }
  return packets;
}
async function sealed(operationId = "snapshot") {
  const packets = await pages(operationId), result = await producer.execute({ kind: "snapshot.seal", operationId });
  if (!("manifest" in result)) throw new Error("test_seal"); return { packets, manifest: result.manifest };
}
test("real producer creates a sealed canonical artifact accepted offline, excluding operational latches and preserving all financial generations", async () => {
  await note(); const old = new InferenceBudget(env.DB, { ...scope, generation: "old", period: "old-period" }); await old.configure(100); await old.reserve("uncertain-old", "a".repeat(64), 40); await old.uncertain("uncertain-old");
  const { packets, manifest } = await sealed(), verifier = new SnapshotVerifier(manifest), records = [];
  for (const packet of packets) records.push(...await verifier.accept(packet));
  expect(await verifier.finish()).toMatchObject({ state: "integrity_verified", authority: "unchecked" });
  expect(await authority.snapshotReceipt("snapshot")).toMatchObject({ state: "sealed_snapshot", seal: manifest.seal });
  expect(records.some(row => row.table === "assistant_budget_reservations" && row.value.generation === "old" && row.value.state === "uncertain")).toBe(true);
  expect(records.some(row => row.table === "assistant_source_versions" && row.value.original_text === "Synthetic canonical body")).toBe(true);
  expect(manifest.tables.some(table => /episodes|job_|model_receipts|telegram|oauth/.test(table))).toBe(false);
  expect(await env.DB.prepare("SELECT state FROM assistant_retention_installation_gate WHERE installation_id=?").bind(scope.installationId).first("state")).toBe("idle");
});
test("every canonical table has INSERT/UPDATE/DELETE freeze triggers, while owner withdrawal stays admissible", async () => {
  const source = await note(), before = (await new SourceAccess(env.DB, scope).read(owner, source.id))!;
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,'project','Synthetic project')").bind(scope.installationId, scope.generation).run();
  await producer.execute({ kind: "snapshot.begin", operationId: "freeze" });
  const triggers = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'retention_freeze_*'").all<{ name: string }>()).results.map(row => row.name);
  for (const table of canonicalSnapshotTables) for (const action of ["insert", "update", "delete"]) expect(triggers).toContain(`retention_freeze_${table}_${action}`);
  expect(await new SourceAccess(env.DB, scope).read(owner, source.id)).toBeNull();
  const guard = new SourceAccess(env.DB, scope).guard(owner, before.fence, 100); expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
  await expect(new SourceController(env.DB, scope, owner).correct(source.id, 1, { text: "Changed", occurredAt: 1 })).rejects.toThrow("canonical_writers_quiesced");
  await expect(env.DB.prepare("UPDATE assistant_projects SET name='changed' WHERE installation_id=?").bind(scope.installationId).run()).rejects.toThrow("canonical_writers_quiesced");
  await expect(env.DB.prepare("DELETE FROM assistant_projects WHERE installation_id=?").bind(scope.installationId).run()).rejects.toThrow("canonical_writers_quiesced");
  await new SourceController(env.DB, scope, owner, () => 100, sourceRetirementGuard(scope.installationId, retirement)).withdraw(source.id, 1);
  await expect(producer.execute({ kind: "snapshot.page", operationId: "freeze", index: 0, cursor: null })).rejects.toThrow("snapshot_changed_live_not_sealed");
  expect(await authority.snapshotReceipt("freeze")).toBeNull();
});
test("financial settlement remains writable and invalidates the candidate instead of sealing or releasing its reservation", async () => {
  await note(); const budget = new InferenceBudget(env.DB, { ...scope, period: "period" }); await budget.configure(100); await budget.reserve("paid", "a".repeat(64), 8);
  await pages("moving-finance"); await budget.settle("paid", "a".repeat(64), 3);
  await expect(producer.execute({ kind: "snapshot.seal", operationId: "moving-finance" })).rejects.toThrow("snapshot_changed_live_not_sealed");
  expect((await budget.status()).committed).toBe(3); expect(await authority.snapshotReceipt("moving-finance")).toBeNull();
  await producer.execute({ kind: "snapshot.cancel", operationId: "moving-finance" });
  expect(await new SourceAccess(env.DB, scope).read(owner, (await env.DB.prepare("SELECT id FROM assistant_sources WHERE installation_id=?").bind(scope.installationId).first<string>("id"))!)).not.toBeNull();
});
test("pagination emits every canonical row with exact page replay and no body cache in D1 metadata", async () => {
  const body = "Synthetic canonical bulk", hash = await sourceTextHash(body), rows = Array.from({ length: 80 }, (_, index) => ({ id: "bulk-" + index }));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key) SELECT ?,?,json_extract(value,'$.id'),'owner_note',json_extract(value,'$.id') FROM json_each(?)").bind(scope.installationId, scope.generation, JSON.stringify(rows)),
    env.DB.prepare("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) SELECT ?,?,json_extract(value,'$.id'),1,?,?,1 FROM json_each(?)").bind(scope.installationId, scope.generation, body, hash, JSON.stringify(rows)),
  ]);
  const packets = await pages("paged"); expect(packets.length).toBeGreaterThan(3);
  const replay = await producer.execute({ kind: "snapshot.page", operationId: "paged", index: 0, cursor: null }); expect(replay).toMatchObject({ packet: packets[0] });
  const result = await producer.execute({ kind: "snapshot.seal", operationId: "paged" }); if (!("manifest" in result)) throw new Error("test_seal");
  const verifier = new SnapshotVerifier(result.manifest); let sources = 0;
  for (const packet of packets) sources += (await verifier.accept(packet)).filter(row => row.table === "assistant_sources").length;
  await verifier.finish(); expect(sources).toBe(80);
  const metadata = await env.DB.prepare("SELECT * FROM assistant_retention_snapshot_sessions WHERE installation_id=?").bind(scope.installationId).all(); expect(JSON.stringify(metadata)).not.toContain(body);
});
test("page transaction ACK loss and external seal ACK loss reconcile the original operation", async () => {
  await note(); await producer.execute({ kind: "snapshot.begin", operationId: "ack" });
  const batch = env.DB.batch.bind(env.DB); let fail = true;
  // Catalog PRAGMAs are a separate read-only batch. Lose the ACK only after
  // the page receipt plus head CAS transaction has actually committed.
  const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { const result = await batch(statements); if (fail && statements.length === 2) { fail = false; throw new Error("synthetic page ACK lost"); } return result; } } as D1Database;
  const service = new SnapshotProducer(db, scope, owner, authority, () => 100); const packets = await pages("ack", service); expect(packets).toHaveLength(1); expect(fail).toBe(false);
  expect(await env.DB.prepare("SELECT page_index FROM assistant_retention_snapshot_sessions WHERE installation_id=? AND operation_id='ack'").bind(scope.installationId).first("page_index")).toBe(1);
  store.failure = "ack"; const result = await service.execute({ kind: "snapshot.seal", operationId: "ack" }); expect(result).toMatchObject({ state: "sealed" });
  expect(await service.execute({ kind: "snapshot.seal", operationId: "ack" })).toEqual(result);
});
test("only a fresh generation can be reserved outside D1 and lost ACK never allocates another ticket", async () => {
  await note(); const { manifest } = await sealed();
  const input = { operationId: "restore", sourceOperationId: "snapshot", snapshotSeal: manifest.seal, targetGeneration: "externally-new", currentGeneration: scope.generation, quiescenceToken: "private-restore-fence" };
  await expect(authority.reserveRestore({ ...input, targetGeneration: scope.generation })).rejects.toThrow("restore_new_external_generation_required");
  store.failure = "ack"; const ticket = await authority.reserveRestore(input); expect(ticket).toMatchObject({ state: "reserved_inactive", targetGeneration: "externally-new" });
  expect(await authority.reserveRestore(input)).toEqual(ticket);
  await expect(authority.reserveRestore({ ...input, operationId: "rekey" })).rejects.toThrow();
});
test("financial inventory resumes past one bounded page and detects movement without resetting an uncertain reservation", async () => {
  await note();
  const budget = new InferenceBudget(env.DB, { ...scope, generation: "historical", period: "old" }); await budget.configure(1000);
  const rows=Array.from({length:300},(_,index)=>({key:"old-"+index}));
  await env.DB.prepare(`INSERT INTO assistant_budget_reservations(installation_id,generation,operation_key,period,request_hash,ceiling_units,state)
    SELECT ?,?,json_extract(value,'$.key'),'old',?,1,'uncertain' FROM json_each(?)`).bind(scope.installationId,"historical","a".repeat(64),JSON.stringify(rows)).run();
  const first=await producer.execute({kind:"snapshot.begin",operationId:"financial-pages"});expect(first.state).toBe("preparing");
  const cursor=JSON.parse((await env.DB.prepare("SELECT financial_cursor FROM assistant_retention_snapshot_sessions WHERE installation_id=? AND operation_id='financial-pages'").bind(scope.installationId).first<string>("financial_cursor"))!);
  expect(cursor.counts.assistant_budget_reservations).toBe(128);
  const restarted=new SnapshotProducer(env.DB,scope,owner,authority,()=>100),next=await restarted.execute({kind:"snapshot.advance",operationId:"financial-pages"});expect(next.state).toBe("exporting");
  const done=JSON.parse((await env.DB.prepare("SELECT financial_cursor FROM assistant_retention_snapshot_sessions WHERE installation_id=? AND operation_id='financial-pages'").bind(scope.installationId).first<string>("financial_cursor"))!);expect(done.counts.assistant_budget_reservations).toBe(300);expect(done.done).toBe(true);
  expect((await budget.status()).committed).toBe(300);await restarted.execute({kind:"snapshot.cancel",operationId:"financial-pages"});
});
test.each([null, false, 0])("corrupt external snapshot metadata %s is never absence or overwritten", async value => {
  await note(); const { manifest } = await sealed(), key = "snapshot:" + await bridgeHash([scope.installationId, "snapshot"]); store.values.set(key, value);
  await expect(authority.snapshotReceipt("snapshot")).rejects.toThrow(); await expect(authority.recordSnapshot(manifest)).rejects.toThrow(); expect(store.values.get(key)).toBe(value);
});
test("unauthenticated and unavailable authority never produces a sealed artifact", async () => {
  const actor = { kind: "extractor" } as { kind: "extractor" | "owner" }, denied = new SnapshotProducer(env.DB, scope, actor as never, authority); actor.kind = "owner";
  await expect(denied.execute({ kind: "snapshot.begin", operationId: "denied" })).rejects.toThrow("owner_required");
  const unavailable = new SnapshotProducer(env.DB, scope, owner, { ...authority, observe: async () => { throw new Error("retention_authority_unavailable"); }, recordSnapshot: authority.recordSnapshot.bind(authority), snapshotReceipt: authority.snapshotReceipt.bind(authority) });
  await expect(unavailable.execute({ kind: "snapshot.begin", operationId: "unavailable" })).rejects.toThrow("retention_authority_unavailable");
  expect(await authority.snapshotReceipt("unavailable")).toBeNull();
});
