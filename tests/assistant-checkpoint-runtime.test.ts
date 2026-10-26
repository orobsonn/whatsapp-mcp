import { afterAll, beforeAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { CheckpointState } from "../assistant/checkpoints";
const root = resolve(import.meta.dirname, ".."), scratch = realpathSync(mkdtempSync(join(tmpdir(), "assistant-checkpoint-proof-")));
let worker: Miniflare, external = 0;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = { installationId: "synthetic-checkpoint", generation: "g1" };
function start() {
  return new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: readFileSync(join(scratch, "app.mjs"), "utf8"),
    compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"], durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
    outboundService: () => { external++; throw new Error("network_forbidden"); },
  }), resourcePersistencePath: join(scratch, "state") });
}
beforeAll(() => {
  const app = join(scratch, "app.ts");
  writeFileSync(app, `
import {DurableObject} from 'cloudflare:workers';
import {makeCheckpointStore} from ${JSON.stringify(join(root, "assistant/container.ts"))};
import {CheckpointController} from ${JSON.stringify(join(root, "assistant/checkpoints.ts"))};
const scope=${JSON.stringify(scope)};
export class Probe extends DurableObject {
 async fetch(request){const input=await request.json();const storage=this.ctx.storage;
  if(input.op==='seed'){await storage.deleteAll();await storage.put(input.data);return Response.json({ok:true})}
  if(input.op==='read')return Response.json(Object.fromEntries(await storage.list()));
  const wrapped=input.rollback?{get:(...a)=>storage.get(...a),transaction:fn=>storage.transaction(tx=>{let writes=0;return fn({get:(...a)=>tx.get(...a),put:async(...a)=>{if(++writes===3)throw new Error('synthetic_rollback');return tx.put(...a)}})})}:storage;
  const store=makeCheckpointStore(wrapped,scope);
  try{
   if(input.op==='cas')return Response.json({accepted:await store.compareAndSet(input.revision,input.next)});
   if(input.op==='restore'){
    const previous=await store.read(), record=previous.candidate??previous.confirmed;let snapshots=0;
    const cas=store.compareAndSet;if(input.ackLost)store.compareAndSet=async(...args)=>{if(input.ackLost==='before_claim'&&args[1].phase==='restoring')throw new Error('synthetic_claim_ack_lost');const ok=await cas(...args);if(ok&&args[1].phase===(input.ackLost==='claim'?'restoring':'confirmed'))throw new Error('synthetic_ack_lost');return ok};
    const check=async fence=>{if(!await store.owns(fence))throw new Error('checkpoint_fenced')};
    const port={deny:check,destroy:check,restore:async(snapshot,fence)=>{await check(fence);if(snapshot.id!==record.snapshot.id)throw new Error('snapshot_changed')},
     snapshot:async()=>{snapshots++;throw new Error('unexpected_snapshot')},quiesce:async()=>{throw new Error('unexpected_quiesce')},
     inspect:async fence=>{await check(fence);const {imageRef,...identity}=record.manifest.identity;return{...identity,indexEpoch:record.manifest.indexEpoch,indexRevision:record.manifest.indexRevision,manifestHash:record.manifestHash,closed:false,poisoned:false,pendingOperations:0,sources:record.manifest.sources.map(({id,version,hash})=>({id,version,hash,originalHash:hash,chunks:1}))}}};
    const result=await new CheckpointController(record.manifest.identity,store,port,async()=>true,()=>100).restore();return Response.json({result,snapshots});
   }
  }catch{return Response.json({error:'synthetic_operation_failed'},{status:409})}
  return new Response('blocked',{status:403});
 }
}
export default {fetch(request,env){return env.PROBE.get(env.PROBE.idFromName('synthetic')).fetch(request)}};
`);
  execFileSync(join(root, "node_modules/esbuild/bin/esbuild"), [app, "--bundle", "--format=esm", "--external:cloudflare:workers", "--outfile=" + join(scratch, "app.mjs")], { cwd: root, stdio: "pipe" });
  worker = start();
});
afterAll(async () => { await worker?.dispose(); rmSync(scratch, { recursive: true, force: true }); expect(external).toBe(0); });
async function call(input: unknown) { const response = await worker.dispatchFetch("https://synthetic.test/", { method: "POST", body: JSON.stringify(input) }); return { status: response.status, data: await response.json() as any }; }
function records() {
  const identity = { ...scope, imageRef: "pinned-synthetic", buildFingerprint: "b".repeat(64), configurationHash: "c".repeat(64), engineVersion: "1.6.5" };
  const record = (count: number) => {
    const manifest = { identity, indexEpoch: "same-index", indexRevision: String(count).repeat(64), sources: Array.from({ length: count }, (_, i) => ({ id: "source-" + i, revision: 1, version: 1, hash: "a".repeat(64) })) };
    const manifestHash = hash(canonical(manifest)), snapshot = { id: "snapshot-" + count, size: count * 600000 };
    return { id: hash([manifestHash, snapshot.id]), manifest, manifestHash, snapshot, createdAt: 100, restoredAt: 100 };
  };
  const candidate = record(9), confirmed = record(2), index = { indexEpoch: candidate.manifest.indexEpoch, indexRevision: candidate.manifest.indexRevision, sources: candidate.manifest.sources };
  const state: CheckpointState = { revision: 14, owner: "interrupted-owner", phase: "restoring", candidate, confirmed, index };
  return { state, next: { ...state, revision: 15, phase: "confirmed" as const, confirmed: candidate, candidate: undefined },
    data: { checkpoint: state, index: { namespace: JSON.stringify(scope), epoch: index.indexEpoch, revision: index.indexRevision, sources: index.sources, lost: true, indexState: "needs_checkpoint" }, maintenance: true, quarantine: true, active: { token: "synthetic-stale-capability" } } };
}
test("real durable transaction publishes checkpoint, index and admission gates together or rolls all back", async () => {
  const input = records(); await call({ op: "seed", data: input.data });
  expect((await call({ op: "cas", revision: 14, next: input.next, rollback: true })).status).toBe(409);
  expect((await call({ op: "read" })).data).toEqual(input.data);
  expect((await call({ op: "cas", revision: 14, next: input.next })).data).toEqual({ accepted: true });
  expect((await call({ op: "read" })).data).toMatchObject({ checkpoint: { phase: "confirmed", confirmed: { id: input.next.confirmed.id } }, index: { indexState: "checkpoint_confirmed", lost: false }, maintenance: false, quarantine: false, active: null });
});
test.each(["epoch", "revision", "sources", "namespace"])("a replacement index %s cannot be overwritten by an old checkpoint commit", async field => {
  const input = records();
  if (field === "epoch") input.data.index.epoch = "replacement";
  if (field === "revision") input.data.index.revision = "f".repeat(64);
  if (field === "sources") input.data.index.sources = [];
  if (field === "namespace") input.data.index.namespace = JSON.stringify({ ...scope, generation: "foreign" });
  await call({ op: "seed", data: input.data });
  expect((await call({ op: "cas", revision: 14, next: input.next })).data).toEqual({ accepted: false });
  expect((await call({ op: "read" })).data).toEqual(input.data);
});
test("confirmation requires the same owner and exact persisted candidate", async () => {
  for (const fault of ["owner", "candidate"]) {
    const input = records();
    if (fault === "owner") input.next.owner = "foreign-owner";
    else input.next.confirmed = input.state.confirmed!;
    await call({ op: "seed", data: input.data });
    expect((await call({ op: "cas", revision: 14, next: input.next })).data).toEqual({ accepted: false });
    expect((await call({ op: "read" })).data).toEqual(input.data);
  }
});
test.each(["commit", "claim", "legacy", "confirmed"])("cold recovery %s reuses candidate9 without snapshot or model", async mode => {
  const input = records();
  if (mode === "confirmed") { input.state.phase = "confirmed"; input.state.confirmed = input.next.confirmed; input.state.candidate = undefined; delete input.state.index; }
  await call({ op: "seed", data: input.data });
  if (mode === "legacy") { delete input.state.index; await call({ op: "seed", data: input.data }); }
  await worker.dispose(); worker = start();
  expect((await call({ op: "restore", ackLost: mode })).data).toMatchObject({ result: { state: "checkpoint_confirmed", id: input.next.confirmed.id }, snapshots: 0 });
  await worker.dispose(); worker = start();
  expect((await call({ op: "read" })).data).toMatchObject({ checkpoint: { phase: "confirmed", confirmed: { id: input.next.confirmed.id, manifest: { sources: expect.any(Array) } } }, maintenance: false });
  expect((await call({ op: "read" })).data.checkpoint.confirmed.manifest.sources).toHaveLength(9);
});
test("a claim ACK lost before commit remains closed and a later explicit recovery reuses the same candidate", async () => {
  const input = records(); await call({ op: "seed", data: input.data });
  expect((await call({ op: "restore", ackLost: "before_claim" })).data).toMatchObject({ result: { state: "uncertain" }, snapshots: 0 });
  expect((await call({ op: "read" })).data).toEqual(input.data);
  expect((await call({ op: "restore" })).data).toMatchObject({ result: { state: "checkpoint_confirmed", id: input.next.confirmed.id }, snapshots: 0 });
});
