import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { namespaceOccupied } from "../assistant/retention-namespace";
import { AssistantExport } from "../assistant/retention";
import { financialInventory } from "../assistant/retention-financial";
import { SnapshotProducer, type SnapshotAuthorityPort } from "../assistant/retention-snapshot";

const owner = { kind: "owner" } as const;
const namespace = () => ({ installationId: crypto.randomUUID(), generation: "native-current" });
async function conversation(scope: ReturnType<typeof namespace>) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO assistant_native_conversations VALUES(?,?,?,'{}',NULL,1)").bind(id, scope.installationId, scope.generation).run();
  return id;
}
async function children(id: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_native_conversation_events(conversation_id,event_id,revision,task_ref,request_hash,event_json,authority_json,created_at) VALUES(?,'event',1,?,'hash','{}','{}',1)").bind(id, crypto.randomUUID()),
    env.DB.prepare("INSERT INTO assistant_native_reply_intents VALUES(?,?,?,1,'hash','proposed',1)").bind(crypto.randomUUID(), id, crypto.randomUUID()),
  ]);
}
test("native namespace accepts an empty generation while root and child metadata occupy only their own namespace", async () => {
  const scope = namespace(), other = namespace(), old = { ...scope, generation: "old" };
  expect(await namespaceOccupied(env.DB, scope)).toBe(false);
  const oldId = await conversation(old), otherId = await conversation(other);
  await children(oldId); await children(otherId);
  expect(await namespaceOccupied(env.DB, scope)).toBe(false);
  expect(await namespaceOccupied(env.DB, old)).toBe(true);
  expect(await namespaceOccupied(env.DB, other)).toBe(true);
  const root = await conversation(scope);
  expect(await namespaceOccupied(env.DB, scope)).toBe(true);
  await children(root);
  expect(await namespaceOccupied(env.DB, scope)).toBe(true);
  await expect(env.DB.prepare("INSERT INTO assistant_native_reply_intents VALUES('orphan','absent','orphan',1,'hash','proposed',1)").run()).rejects.toThrow();
});
test("native namespace still rejects an unknown table without an owner scope", async () => {
  await env.DB.prepare("CREATE TABLE assistant_unknown_native_scope(value TEXT)").run();
  try { await expect(namespaceOccupied(env.DB, namespace())).rejects.toThrow("restore_schema_unsupported"); }
  finally { await env.DB.prepare("DROP TABLE assistant_unknown_native_scope").run(); }
});
test("native export joins conversation scope and retains receipts across every historical generation and period", async () => {
  const scope = namespace(), old = { ...scope, generation: "old" }, other = namespace();
  const own = await conversation(scope), historic = await conversation(old), foreign = await conversation(other);
  await children(own); await children(historic); await children(foreign);
  for (const [i, recordScope] of [scope, old, other].entries()) await env.DB.prepare("INSERT INTO assistant_native_model_receipts VALUES(?,?,?,'epoch','turn',?,?,'hash','price',10,'uncertain',NULL,NULL,NULL)").bind(recordScope.installationId, recordScope.generation, String(i), `operation-${i}`, `period-${i}`).run();
  const archive = new AssistantExport(env.DB, scope, owner), records: { table: string; value: Record<string, unknown> }[] = [];
  let cursor: string | undefined;
  do {
    const page = await archive.page({ cursor, limit: 50 }); cursor = page.nextCursor;
    for (const part of page.parts) records.push({ table: part.table, value: JSON.parse(atob(part.data)) });
  } while (cursor);
  expect(records.filter(row => row.table === "assistant_native_conversation_events").map(row => row.value.conversation_id)).toEqual([own]);
  expect(records.filter(row => row.table === "assistant_native_reply_intents").map(row => row.value.conversation_id)).toEqual([own]);
  expect(records.filter(row => row.table === "assistant_native_model_receipts").map(row => row.value.generation)).toEqual([scope.generation, old.generation]);
  expect((await financialInventory(env.DB, scope.installationId)).counts.assistant_native_model_receipts).toBe(2);
});
test("native receipt insert, settlement and deletion advance only its installation financial revision", async () => {
  const scope = namespace(), other = namespace();
  for (const recordScope of [scope, other]) await env.DB.prepare("INSERT INTO assistant_retention_installation_gate(installation_id,generation,operation_id,request_hash,token,state,started_at) VALUES(?,?,'operation','hash',?,'idle',1)").bind(recordScope.installationId, recordScope.generation, crypto.randomUUID()).run();
  const revision = (installationId: string) => env.DB.prepare("SELECT financial_revision FROM assistant_retention_installation_gate WHERE installation_id=?").bind(installationId).first<number>("financial_revision");
  await env.DB.prepare("INSERT INTO assistant_native_model_receipts VALUES(?,?,'session','epoch','turn','operation','old-period','hash','price',10,'uncertain',NULL,NULL,NULL)").bind(scope.installationId, scope.generation).run();
  expect(await revision(scope.installationId)).toBe(1);
  await env.DB.prepare("UPDATE assistant_native_model_receipts SET state='complete',input_tokens=1,output_tokens=2,actual_units=3 WHERE installation_id=?").bind(scope.installationId).run();
  expect(await revision(scope.installationId)).toBe(2);
  await env.DB.prepare("DELETE FROM assistant_native_model_receipts WHERE installation_id=?").bind(scope.installationId).run();
  expect(await revision(scope.installationId)).toBe(3);
  expect(await revision(other.installationId)).toBe(0);
});
test("native receipt settlement invalidates a snapshot while keeping its paid custody writable", async () => {
  const scope = namespace();
  await env.DB.prepare("INSERT INTO assistant_native_model_receipts VALUES(?,?,'session','epoch','turn','operation','period','hash','price',10,'uncertain',NULL,NULL,NULL)").bind(scope.installationId, scope.generation).run();
  const authority: SnapshotAuthorityPort = {
    observe: async () => ({ state: "sealed", revision: 1 }),
    recordSnapshot: async () => { throw Error("unexpected seal"); },
    snapshotReceipt: async () => null,
  };
  const producer = new SnapshotProducer(env.DB, scope, owner, authority, () => 100);
  let state = await producer.execute({ kind: "snapshot.begin", operationId: "native-finance" });
  for (let i = 0; state.state === "preparing" && i < 10; i++) state = await producer.execute({ kind: "snapshot.advance", operationId: "native-finance" });
  expect(state.state).toBe("exporting");
  await env.DB.prepare("UPDATE assistant_native_model_receipts SET state='complete',input_tokens=1,output_tokens=2,actual_units=3 WHERE installation_id=?").bind(scope.installationId).run();
  await expect(producer.execute({ kind: "snapshot.page", operationId: "native-finance", index: 0, cursor: null })).rejects.toThrow("snapshot_changed_live_not_sealed");
  await producer.execute({ kind: "snapshot.cancel", operationId: "native-finance" });
});
