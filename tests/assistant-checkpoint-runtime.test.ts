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
import {CogneeEngine} from ${JSON.stringify(join(root, "assistant/engine.ts"))};
const scope=${JSON.stringify(scope)};
export class Probe extends DurableObject {
 async fetch(request){const input=await request.json();const storage=this.ctx.storage;
  if(input.op==='seed'){await storage.deleteAll();await storage.put(input.data);return Response.json({ok:true})}
  if(input.op==='read')return Response.json(Object.fromEntries(await storage.list()));
  const wrapped=input.rollback?{get:(...a)=>storage.get(...a),transaction:fn=>storage.transaction(tx=>{let writes=0;return fn({get:(...a)=>tx.get(...a),put:async(...a)=>{if(++writes===3)throw new Error('synthetic_rollback');return tx.put(...a)}})})}:storage;
  const store=makeCheckpointStore(wrapped,scope);
  try{
   if(input.op.startsWith('engine')){
    const fence={...scope,actor:'owner',source:{id:'source',revision:1,version:1,hash:'a'.repeat(64),audience:'owner',origin:'owner_note',conversationId:null,projectId:null},policy:null,identity:null,mandate:null};
    const search={actor:{kind:'owner'},permits:[{source:fence}],query:'Synthetic query',allowedSources:[{id:'source',version:1,hash:'a'.repeat(64)}],limit:2};
    const increment=key=>storage.transaction(async tx=>{await tx.put(key,((await tx.get(key))??0)+1)});
    const engineStore={get:key=>storage.get(key),put:(key,value)=>storage.put(key,value),transaction:async action=>{
      let claimed=false;const result=await storage.transaction(tx=>action({get:key=>tx.get(key),list:options=>tx.list(options),put:async(key,value)=>{
       if(key.startsWith('search-ticket:')&&value.state==='attempting'){if(input.rollbackClaim)throw new Error('rollback_claim');claimed=true}await tx.put(key,value);
      }}));if(claimed&&input.ackLostClaim)throw new Error('claim_ack_lost');return result;
    }};
    const port={running:true,start:async()=>{throw new Error('unexpected_wake')},destroy:async()=>{},deny:async()=>{},intercept:async()=>{},request:async(path,body)=>{
      if(path!=='/search')throw new Error('unexpected_path');await increment('effectCalls');return {ok:true,result:{candidates:[{...body.allowedSources[0],via:['chunks'],relationCount:0}],missing:[]}};
    }};
    const guard={check:async()=>true,issue:async()=>{await increment('permitCalls');if(input.holdPermit)await new Promise(resolve=>setTimeout(resolve,50));return 'synthetic-permit'},revoke:async()=>{}};
    const engine=new CogneeEngine(scope,engineStore,port,guard,()=>100);
    if(input.op==='enginePrepare')return Response.json(await engine.prepare(input.alias,search));
    if(input.op==='engineSubmit')return Response.json(await engine.submit(input.ticket));
    if(input.op==='engineLookup')return Response.json(await engine.lookupTicket(input.ticket));
    if(input.op==='engineSearch')return Response.json(await engine.search(search));
   }
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
  execFileSync(join(root, "node_modules/esbuild/bin/esbuild"), [app, "--bundle", "--format=esm", "--external:cloudflare:workers", "--external:node:async_hooks", "--outfile=" + join(scratch, "app.mjs")], { cwd: root, stdio: "pipe" });
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

async function engineTickets() {
  await call({ op: "seed", data: { index: { namespace: JSON.stringify(scope), epoch: "synthetic-index", revision: "a".repeat(64), sources: [], lost: false, indexState: "checkpoint_confirmed" } } });
  const first=(await call({op:"enginePrepare",alias:"original"})).data,second=(await call({op:"enginePrepare",alias:"another"})).data;
  expect(first.state).toBe("prepared");expect(second.state).toBe("prepared");expect(first.ticket.operationId).toBe(second.ticket.operationId);
  return {first:first.ticket,second:second.ticket};
}
test("native DO metadata migration preserves legacy shared-operation uncertainty across restart and direct search",async()=>{
  const {first,second}=await engineTickets(),state=(await call({op:"read"})).data;
  for(const [key,value]of Object.entries(state))if(key.startsWith("search-ticket:")&&(value as any).ticket.alias==="original")(value as any).state="attempting";
  await call({op:"seed",data:state});await worker.dispose();worker=start();
  expect((await call({op:"engineLookup",ticket:second})).data).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect((await call({op:"engineSubmit",ticket:second})).data).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  expect((await call({op:"engineSearch"})).data).toMatchObject({state:"uncertain",reason:"engine_operation_uncertain"});
  const stored=(await call({op:"read"})).data;expect(stored.permitCalls??0).toBe(0);expect(stored.effectCalls??0).toBe(0);
  expect(stored["search-operation:"+first.operationId]).toMatchObject({alias:"original",requestHash:first.requestHash});
});
test.each(["rollback","ack_lost"])("native operation and ticket claims survive %s with the correct effect boundary",async mode=>{
  const {first,second}=await engineTickets();
  expect((await call({op:"engineSubmit",ticket:first,rollbackClaim:mode==="rollback",ackLostClaim:mode==="ack_lost"})).status).toBe(409);
  const before=(await call({op:"read"})).data;expect(before.permitCalls??0).toBe(0);expect(before.effectCalls??0).toBe(0);
  expect(!!before["search-operation:"+first.operationId]).toBe(mode==="ack_lost");
  await worker.dispose();worker=start();
  expect((await call({op:"engineSubmit",ticket:second})).data.state).toBe(mode==="ack_lost"?"uncertain":"complete");
  const after=(await call({op:"read"})).data;expect(after.effectCalls??0).toBe(mode==="ack_lost"?0:1);
});
test("restoring a confirmed checkpoint preserves an uncertain search claim and refuses its old submit", async () => {
  const { first, second } = await engineTickets();
  expect((await call({ op: "engineSubmit", ticket: first, ackLostClaim: true })).status).toBe(409);
  const before = (await call({ op: "read" })).data;
  const record = structuredClone(records().state.candidate!);
  record.manifest.indexEpoch = before.index.epoch; record.manifest.indexRevision = before.index.revision; record.manifest.sources = [];
  record.manifestHash = hash(canonical(record.manifest)); record.id = hash([record.manifestHash, record.snapshot.id]);
  const index = { indexEpoch: record.manifest.indexEpoch, indexRevision: record.manifest.indexRevision, sources: [] };
  const state = { ...before, index: { ...before.index, lost: true }, quarantine: true, maintenance: false,
    checkpoint: { revision: 1, owner: "synthetic-confirmed-owner", phase: "confirmed", confirmed: record, index } };
  await call({ op: "seed", data: state });
  expect((await call({ op: "restore" })).data).toMatchObject({ result: { state: "checkpoint_confirmed", id: record.id }, snapshots: 0 });
  const restored = (await call({ op: "read" })).data;
  const searches = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith("search-")));
  expect(searches(restored)).toEqual(searches(before));
  expect(restored).toMatchObject({ index: { lost: false }, quarantine: false, maintenance: false, active: null });
  expect((await call({ op: "engineLookup", ticket: second })).data.state).toBe("uncertain");
  expect((await call({ op: "engineSubmit", ticket: second })).data.state).toBe("uncertain");
  const after = (await call({ op: "read" })).data;
  expect(after.effectCalls ?? 0).toBe(0); expect(after.permitCalls ?? 0).toBe(0);
});
test("native SQLite admits one physical search for concurrent aliases and shares only its exact completed receipt",async()=>{
  const {first,second}=await engineTickets();
  const results=await Promise.all([call({op:"engineSubmit",ticket:first,holdPermit:true}),call({op:"engineSubmit",ticket:second,holdPermit:true})]);
  expect(results.some(result=>result.data.state==="complete")).toBe(true);
  const state=(await call({op:"read"})).data;expect(state.permitCalls).toBe(1);expect(state.effectCalls).toBe(1);
  expect((await call({op:"engineLookup",ticket:first})).data).toMatchObject({state:"complete",operationId:first.operationId});
  expect((await call({op:"engineLookup",ticket:second})).data).toMatchObject({state:"complete",operationId:first.operationId});
  expect((await call({op:"engineSubmit",ticket:second})).data.state).toBe("complete");
  expect((await call({op:"read"})).data.effectCalls).toBe(1);
});
