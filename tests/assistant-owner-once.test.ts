import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { OwnerAssistant, type OwnerAffinity } from "../assistant/mcp";
import { SourceController } from "../assistant/sources";
import { OwnerControl } from "../assistant/control";
import { InferenceBudget } from "../assistant/budget";
import type { AssistantEnv } from "../assistant/env";
import { JobQueue } from "../assistant/queue";
import { RetentionPurge } from "../assistant/retention-purge";
import { SourceAccess, type AccessGuard } from "../assistant/access";
import { CanonicalEngineGuard, handleBrokerRequest, engineModelAdmission } from "../assistant/container";
import { readOnceGrant, onceReceipt, onceAuthority, onceKey, type OnceGrant } from "../assistant/owner-once-guard";
import type { InitialIngestAdmission } from "../assistant/engine";
import { CogneeModelBroker } from "../assistant/model-broker";
import { DEFAULT_BROKER_CONFIG } from "../assistant/model-transport";
import { hostConfiguredSearch } from "../assistant/configured-search";
import { RetrievalRuns, type CoverageProof } from "../assistant/retrieval-runs";
import { bridgeHash } from "../assistant/ingress";
import { EpisodeController } from "../assistant/agent/controller";
import { runtimeHost } from "../assistant/agent-runtime/runtime";
import type { EpisodeDriver } from "../assistant/agent/controller";
import type { EngineSearch, SearchTicket } from "../assistant/engine";
import { compactStatement } from "../assistant/d1-statement";
import { ownerContextStamp } from "../assistant/relation-visibility";

// @ts-expect-error Vite raw migration fixtures, including future additive files.
const migrations = import.meta.glob("../assistant/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
type Receiver = { ownerOnce(expected: OwnerAffinity, command: unknown): Promise<unknown> };
let scope: OwnerAffinity, settings: AssistantEnv, now: number;
let bootstrap: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  for (const [_, migration] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    const sql = migration.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(part => part.trim());
    if (sql.length) await env.DB.batch(sql.map(part => env.DB.prepare(part)));
  }
  now = Date.parse("2026-10-27T12:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  scope = { installationId: crypto.randomUUID(), generation: "once-g1", sourceEpoch: "once-e1", sourceGeneration: "once-c1" };
  bootstrap = vi.fn(async () => { throw Error("plan_must_not_start_ingestion"); });
  const engine = { lifecycleState: vi.fn(async () => ({ running: false })), reserveInitialIngest: bootstrap, commitInitialIngest: bootstrap, ingest: bootstrap };
  settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation,
    BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration,
    OPENAI_API_KEY: "synthetic-unused-key", FLUE_EPISODES_ENABLED: "shadow", ROUTINES_ENABLED: "shadow", ROUTINES_PAUSED: "true", SEMANTIC_SEARCH_MODE: "required",
    COGNEE: { idFromName: () => ({ toString: () => "synthetic-once-engine" }), get: () => engine } as unknown as NonNullable<AssistantEnv["COGNEE"]> };
  await new OwnerControl(env.DB, scope, { kind: "owner" }).execute({ kind: "project.put", id: "once-project", name: "Synthetic bounded project", expectedVersion: 0, operationId: "once-project" });
  await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).configure(600000);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("plans bounded Owner execution through the authenticated receiver without admitting a model or bootstrap", async () => {
  const text = "Synthetic Owner request: explain the blue test marker. No external action is authorized.";
  const source = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "owner-once-request", text, audience: "owner", projectId: "once-project", occurredAt: now });
  const rpc = new OwnerAssistant(createExecutionContext(), settings) as unknown as Receiver;
  expect(rpc.ownerOnce).toBeTypeOf("function");
  const result = await rpc.ownerOnce(scope, { kind: "owner_once.plan", operationId: "once-valid", sourceId: source.id, expectedRevision: 1,
    projectId: "once-project", query: "Explain the blue test marker using the source.", deadlineAt: now + 600000, maxCostMicroUsd: 600000 });
  expect(result).toMatchObject({ state: "planned", corpus: { sourceCount: 1, utf8Bytes: new TextEncoder().encode(text).length } });
  expect(JSON.stringify(result)).not.toContain(text);
  expect(bootstrap).not.toHaveBeenCalled();
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(0);
  expect(settings.ROUTINES_PAUSED).toBe("true");
});

async function fixture(text = "Synthetic private blue marker") {
  const sources = new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  const source = await sources.create({ originKey: crypto.randomUUID(), text, audience: "owner", projectId: "once-project", occurredAt: now });
  const rpc = new OwnerAssistant(createExecutionContext(), settings) as unknown as Receiver;
  const command = { kind: "owner_once.plan", operationId: "once-case", sourceId: source.id, expectedRevision: 1,
    projectId: "once-project", query: "Explain the private blue marker", deadlineAt: now + 600000, maxCostMicroUsd: 600000 };
  return { sources, source, rpc, command };
}
it.each(["time", "config_hash", "configuration"] as const)("reports only a static Owner %s admission failure", async kind => {
  const f = await fixture(); await f.rpc.ownerOnce(scope, f.command);
  await f.rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: f.command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const grant = (await readOnceGrant(settings, onceReceipt.parse(JSON.parse(raw!))))!;
  if (kind === "time") vi.setSystemTime(f.command.deadlineAt);
  if (kind === "config_hash") settings.MEDIA_CONTEXT_ENABLED = "true";
  if (kind === "configuration") settings.SEMANTIC_SEARCH_MODE = "lexical_fallback";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await engineModelAdmission(settings, "2026-10-27", undefined, grant)!.prepare({ key: "private-key", hash: "a".repeat(64), recovered: false })).toBeNull();
  expect(warn).toHaveBeenCalledExactlyOnceWith({ event: "model_admission_failure", code: `host_owner_${kind}`, elapsedMs: expect.any(Number) });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(grant.token);
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(0);
});
async function recoveryFixture(){
 const f=await fixture(),old=await f.rpc.ownerOnce(scope,f.command) as {id:string;jobId:string};
 await f.rpc.ownerOnce(scope,{kind:"owner_once.advance",operationId:f.command.operationId});
 vi.setSystemTime(f.command.deadlineAt+1);
 const witness={state:"available",indexEpoch:crypto.randomUUID(),operationId:"d".repeat(64),witnessHash:"e".repeat(64)};
 const prepare=vi.fn(async()=>witness);Object.assign(settings.COGNEE!.get(settings.COGNEE!.idFromName("synthetic")),{prepareInitialRecovery:prepare});
 const recovery={kind:"owner_once.recovery_plan",operationId:"once-recovery",previousOperationId:f.command.operationId,deadlineAt:Date.now()+600000,maxCostMicroUsd:600000};
 return {...f,old,recovery,witness,prepare};
}
it("admits a separate expired-bootstrap recovery with the same private question and original budget period, without granting execution",async()=>{
 const f=await recoveryFixture(),result=await f.rpc.ownerOnce(scope,f.recovery) as {id:string;jobId:string};
 expect(result).toMatchObject({state:"planned",period:"2026-10-27",maxCostMicroUsd:600000});expect(result.id).not.toBe(f.old.id);
 const row=await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id=?").bind(scope.installationId,onceKey(result.id)).first<string>("result_json");
 const receipt=JSON.parse(row!);expect(receipt).toMatchObject({queryHash:await bridgeHash(f.command.query),recovery:{previousId:f.old.id,indexEpoch:f.witness.indexEpoch,witnessHash:f.witness.witnessHash}});
 expect(JSON.stringify(result)).not.toContain(f.command.query);expect(row).not.toContain(f.command.query);
 expect(await new JobQueue(env.DB,scope).ledger(result.jobId)).toMatchObject({state:"prepared",request_json:expect.stringContaining(f.command.query)});
 expect(await f.rpc.ownerOnce(scope,f.recovery)).toEqual(result);expect(f.prepare).toHaveBeenCalledTimes(1);
 expect(await f.rpc.ownerOnce(scope,{kind:"owner_once.status",operationId:f.command.operationId})).toMatchObject({state:"blocked",id:f.old.id});
 await expect(f.rpc.ownerOnce(scope,{...f.recovery,deadlineAt:f.recovery.deadlineAt+1})).rejects.toThrow("control_operation_conflict");expect(bootstrap).not.toHaveBeenCalled();
});
it("does not resurrect a predecessor's private ledger when it is purged between reading and the admission batch",async()=>{
 const f=await recoveryFixture(),batch=env.DB.batch.bind(env.DB),fault=vi.spyOn(env.DB,"batch").mockImplementationOnce(async statements=>{
  fault.mockRestore();await env.DB.prepare("UPDATE assistant_job_ledger SET request_json='{}' WHERE installation_id=? AND job_id=?").bind(scope.installationId,f.old.jobId).run();return batch(statements);
 });
 await expect(f.rpc.ownerOnce(scope,f.recovery)).rejects.toThrow("job_admission_changed");
 expect(await env.DB.prepare("SELECT COUNT(*) FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("COUNT(*)")).toBe(1);
 expect(bootstrap).not.toHaveBeenCalled();
});
it("admits one recovery plan per predecessor atomically, even with competing Owner operation IDs",async()=>{
 const f=await recoveryFixture(),results=await Promise.allSettled([f.rpc.ownerOnce(scope,f.recovery),f.rpc.ownerOnce(scope,{...f.recovery,operationId:"competing-recovery"})]);
 expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_owner_commands WHERE installation_id=? AND json_extract(result_json,'$.recovery.previousId')=?").bind(scope.installationId,f.old.id).first("n")).toBe(1);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(2);expect(bootstrap).not.toHaveBeenCalled();
});
it.each(["live","day","cap","max_cost","withdraw","addition","lease","ledger_hash","actor","paid","chain"])("refuses a new recovery after predecessor %s changes",async mode=>{
 const f=await recoveryFixture();
 if(mode==="live")vi.setSystemTime(f.command.deadlineAt-1);
 if(mode==="day")vi.setSystemTime(Date.parse("2026-10-28T00:00:00Z"));
 if(mode==="cap")await env.DB.prepare("UPDATE assistant_budget_accounts SET cap_units=500000 WHERE installation_id=?").bind(scope.installationId).run();
 if(mode==="max_cost")f.recovery.maxCostMicroUsd=500000;
 if(mode==="withdraw")await f.sources.withdraw(f.source.id,1);
 if(mode==="addition")await f.sources.create({originKey:"recovery-new-support",text:"Another support",audience:"owner",projectId:f.command.projectId,occurredAt:Date.now()});
 if(mode==="lease")await env.DB.prepare("UPDATE assistant_jobs SET attempts=1,lease_generation=1 WHERE installation_id=? AND id=?").bind(scope.installationId,f.old.jobId).run();
 if(mode==="ledger_hash")await env.DB.prepare("UPDATE assistant_job_ledger SET request_json='{}' WHERE installation_id=? AND job_id=?").bind(scope.installationId,f.old.jobId).run();
 if(mode==="actor"){
  const old=await new JobQueue(env.DB,scope).ledger(f.old.jobId),raw=JSON.stringify({...JSON.parse(old!.request_json),actor:{kind:"interlocutor",provider:"synthetic",address:"guest",conversationId:"foreign",conversationKind:"private",action:"reply_text"}});
  await env.DB.prepare("DELETE FROM assistant_decision_jobs WHERE installation_id=? AND job_id=?").bind(scope.installationId,f.old.jobId).run();
  const {sourceTextHash}=await import("../assistant/sources");await env.DB.prepare("UPDATE assistant_job_ledger SET request_json=?,request_hash=? WHERE installation_id=? AND job_id=?").bind(raw,await sourceTextHash(raw),scope.installationId,f.old.jobId).run();
 }
 if(mode==="paid")await new InferenceBudget(env.DB,{...scope,period:"2026-10-27"}).reserve("synthetic-previous-paid","f".repeat(64),1);
 if(mode==="chain"){
  await f.rpc.ownerOnce(scope,f.recovery);await f.rpc.ownerOnce(scope,{kind:"owner_once.advance",operationId:f.recovery.operationId});vi.setSystemTime(f.recovery.deadlineAt+1);
  f.recovery={...f.recovery,operationId:"third-descendant",previousOperationId:f.recovery.operationId,deadlineAt:Date.now()+600000};
 }
 const before=await env.DB.prepare("SELECT COUNT(*) n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n");
 await expect(f.rpc.ownerOnce(scope,{...f.recovery,deadlineAt:Date.now()+600000})).rejects.toThrow();
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(before);expect(bootstrap).not.toHaveBeenCalled();
});
it("requires the new admission, exact predecessor and zero-history guard at the Core maintenance boundary, without authorizing the old grant",async()=>{
 const f=await recoveryFixture(),plan=await f.rpc.ownerOnce(scope,f.recovery) as {id:string};
 const raw=await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id=?").bind(scope.installationId,onceKey(plan.id)).first<string>("result_json"),receipt=onceReceipt.parse(JSON.parse(raw!));
 const input={actor:{kind:"owner"} as const,source:(await new SourceAccess(env.DB,scope).read({kind:"owner"},f.source.id))!},guard=new CanonicalEngineGuard(settings);
 const admission={kind:"owner_once" as const,itemId:plan.id,owner:crypto.randomUUID()};expect(await guard.checkInitialRecovery(admission,input,receipt.recovery!)).toBe(false);
 await f.rpc.ownerOnce(scope,{kind:"owner_once.advance",operationId:f.recovery.operationId});admission.owner=(await readOnceGrant(settings,receipt))!.token;
 expect(await guard.checkInitialRecovery(admission,input,receipt.recovery!)).toBe(true);
 expect(await guard.checkInitialRecovery(admission,input,{...receipt.recovery!,previousJobHash:"f".repeat(64)})).toBe(false);
 await new InferenceBudget(env.DB,{...scope,period:"2026-10-27"}).reserve("synthetic-new-paid","f".repeat(64),1);
 expect(await guard.checkInitialRecovery(admission,input,receipt.recovery!)).toBe(false);
 expect(await guard.checkInitialAdmission(admission,input)).toBe(true);
});
it("inspects the same expired Owner operation without granting execution or forwarding private Core fields", async () => {
  const {rpc,command}=await fixture();const plan=await rpc.ownerOnce(scope,command) as {id:string};
  const observe=vi.fn(async()=>({state:"observed",imageConfigured:true,activePresent:false,quarantine:true,
    index:{state:"present",epoch:crypto.randomUUID(),revision:"empty",sourceCount:0,lost:true},
    initial:{state:"present",itemId:plan.id,admissionState:"uncertain",indexEpoch:crypto.randomUUID(),operationId:"b".repeat(64),hasAccess:false,hasReceipt:false},
    token:"PRIVATE_MUST_NOT_ESCAPE"}));
  Object.assign(settings.COGNEE!.get(settings.COGNEE!.idFromName("synthetic")),{initialObservation:observe});
  vi.setSystemTime(command.deadlineAt+1);
  const result=await rpc.ownerOnce(scope,{kind:"owner_once.inspect",operationId:command.operationId});
  expect(result).toMatchObject({state:"blocked",executionMetadata:{state:"observed",initial:{state:"present",itemId:plan.id,hasAccess:false}}});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_MUST_NOT_ESCAPE");expect(observe).toHaveBeenCalledTimes(1);expect(bootstrap).not.toHaveBeenCalled();
});
it("does not probe Core for a missing Owner plan and never attributes another root's initial ticket",async()=>{
  const {rpc,command}=await fixture(),observe=vi.fn(async()=>({state:"observed",imageConfigured:true,activePresent:false,quarantine:true,index:{state:"absent"},
    initial:{state:"present",itemId:"f".repeat(64),admissionState:"uncertain",indexEpoch:crypto.randomUUID(),operationId:"b".repeat(64),hasAccess:false,hasReceipt:false}}));
  Object.assign(settings.COGNEE!.get(settings.COGNEE!.idFromName("synthetic")),{initialObservation:observe});
  expect(await rpc.ownerOnce(scope,{kind:"owner_once.inspect",operationId:command.operationId})).toMatchObject({state:"unavailable"});expect(observe).not.toHaveBeenCalled();
  await rpc.ownerOnce(scope,command);
  const result=await rpc.ownerOnce(scope,{kind:"owner_once.inspect",operationId:command.operationId});expect(result).toMatchObject({state:"blocked",reason:"execution_metadata_unavailable"});
  expect(JSON.stringify(result)).not.toContain("b".repeat(64));expect(bootstrap).not.toHaveBeenCalled();
});
it("rejects inspection after the active generation changes without asking Core for metadata",async()=>{
  const {rpc,command}=await fixture();await rpc.ownerOnce(scope,command);
  const observe=vi.fn();Object.assign(settings.COGNEE!.get(settings.COGNEE!.idFromName("synthetic")),{initialObservation:observe});
  await env.DB.prepare("INSERT INTO assistant_retention_active_generation VALUES(?,?,?,?,?,1)").bind(scope.installationId,"other-generation","a".repeat(64),"b".repeat(64),"synthetic-inspection-gate").run();
  expect(await rpc.ownerOnce(scope,{kind:"owner_once.inspect",operationId:command.operationId})).toMatchObject({state:"blocked",reason:"execution_metadata_unavailable"});expect(observe).not.toHaveBeenCalled();
});
const retirement = { allow: async () => {}, withdraw: async () => {} };
async function purge(id: string) {
  const retention = new RetentionPurge(env.DB, scope, { kind: "owner" }, Date.now, retirement);
  for (let i = 0; i < 20; i++) {
    const result = await retention.advance({ kind: "source.purge", operationId: `purge-${id}`, sourceId: id });
    if (result.state !== "pending") { expect(result.state).toBe("complete"); return; }
  }
  throw Error("synthetic_purge_no_progress");
}
it("recovers the same plan after a lost receipt ACK and rejects a changed question", async () => {
  const { rpc, command } = await fixture(), batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementation(async statements => {
    const result = await batch(statements);
    if (await env.DB.prepare("SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first()) {
      fault.mockRestore(); throw Error("synthetic_plan_ack_lost");
    }
    return result;
  });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("synthetic_plan_ack_lost");
  const recovered = await rpc.ownerOnce(scope, command);
  expect(recovered).toMatchObject({ state: "planned" });
  expect(await rpc.ownerOnce(scope, command)).toEqual(recovered);
  await expect(rpc.ownerOnce(scope, { ...command, query: "Another question" })).rejects.toThrow("control_operation_conflict");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(1);
});
it("keeps private bodies, question and raw catalog names out of immutable receipts", async () => {
  const { rpc, command } = await fixture("secret body only in canonical source");
  await rpc.ownerOnce(scope, command);
  const rows = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).all();
  const stored = JSON.stringify(rows.results);
  for (const privateText of ["secret body only in canonical source", command.query, "Synthetic bounded project"]) expect(stored).not.toContain(privateText);
});
it.each(["withdraw", "addition", "revision"] as const)("blocks the original receipt after corpus %s without making a fresh job", async mode => {
  const { rpc, command, source, sources } = await fixture();
  await rpc.ownerOnce(scope, command);
  if (mode === "withdraw") await sources.withdraw(source.id, 1);
  if (mode === "revision") await sources.correct(source.id, 1, { text: "Revised marker", occurredAt: now });
  if (mode === "addition") await sources.create({ originKey: "support", text: "New supporting original", audience: "owner", projectId: "once-project", occurredAt: now });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "blocked" });
  expect(await rpc.ownerOnce(scope, command)).toMatchObject({ state: "blocked" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(1);
  expect(bootstrap).not.toHaveBeenCalled();
});
it("refuses a concurrently enlarged corpus in the same receipt transaction", async () => {
  const { rpc, command, sources } = await fixture(), batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    fault.mockRestore();
    await sources.create({ originKey: "concurrent-support", text: "Concurrent support", audience: "owner", projectId: "once-project", occurredAt: now });
    return batch(statements);
  });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("job_admission_changed");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
});
it("counts UTF8 bytes and rejects an oversized original", async () => {
  const { rpc, command } = await fixture("é".repeat(12001));
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("owner_once_corpus");
});
it("rejects the twenty fifth authorized original instead of truncating the project", async () => {
  const { rpc, command, sources } = await fixture();
  for (let i = 0; i < 24; i++) await sources.create({ originKey: `support-${i}`, text: `Support ${i}`, audience: "owner", projectId: "once-project", occurredAt: now });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("owner_once_corpus");
});
it.each(["foreign_affinity", "foreign_project", "wrong_revision", "deadline", "budget", "arbitrary_actor", "query_bytes"])("rejects %s before creating execution work", async mode => {
  const { rpc, command } = await fixture();
  const raw: Record<string, unknown> = { ...command };
  if (mode === "foreign_project") raw.projectId = "foreign-project";
  if (mode === "wrong_revision") raw.expectedRevision = 2;
  if (mode === "deadline") raw.deadlineAt = now + 900001;
  if (mode === "budget") raw.maxCostMicroUsd = 100;
  if (mode === "arbitrary_actor") raw.actor = { kind: "owner" };
  if (mode === "query_bytes") raw.query = "é".repeat(1025);
  await expect(rpc.ownerOnce(mode === "foreign_affinity" ? { ...scope, generation: "foreign" } : scope, raw)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
});
it.each(["pause", "cap", "utc_day", "hold"])("blocks a recovered plan after %s changes", async mode => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  if (mode === "pause") settings.ROUTINES_PAUSED = "false";
  if (mode === "cap") await env.DB.prepare("UPDATE assistant_budget_accounts SET cap_units=700000 WHERE installation_id=?").bind(scope.installationId).run();
  if (mode === "utc_day") vi.setSystemTime(now + 86400000);
  if (mode === "hold") await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold(installation_id,operation_id,target_generation,active,created_at) VALUES(?,'synthetic-hold',?,1,?)").bind(scope.installationId, scope.generation, now).run();
  expect(await rpc.ownerOnce(scope, command)).toMatchObject({ state: "blocked" });
});
it("does not let the generic queue claim a plan before explicit Owner admission", async () => {
  const { rpc, command } = await fixture(); const result = await rpc.ownerOnce(scope, command) as { jobId: string };
  const queue = new JobQueue(env.DB, scope);
  expect(await queue.claim(now)).toBeNull();
  expect(await queue.claimId(result.jobId, now)).toBeNull();
  expect((await queue.get(result.jobId))?.attempts).toBe(0);
});
it("does not rewrite a private question after withdrawal and purge win the admission race", async () => {
  const { rpc, command, source, sources } = await fixture(), batch = env.DB.batch.bind(env.DB);
  const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    fault.mockRestore(); await sources.withdraw(source.id, 1); await purge(source.id); return batch(statements);
  });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("job_admission_changed");
  for (const table of ["assistant_jobs", "assistant_job_ledger"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE installation_id=?`).bind(scope.installationId).first("n")).toBe(0);
  }
});
it("purges a planned job when a supporting original is removed, retaining only its nontext replay tombstone", async () => {
  const { rpc, command, sources } = await fixture();
  const support = await sources.create({ originKey: "support-to-purge", text: "Private supporting body", audience: "owner", projectId: "once-project", occurredAt: now });
  const planned = await rpc.ownerOnce(scope, command) as { jobId: string };
  await sources.withdraw(support.id, 1); await purge(support.id);
  expect(await new JobQueue(env.DB, scope).get(planned.jobId)).toBeNull();
  expect(await rpc.ownerOnce(scope, command)).toMatchObject({ state: "blocked", jobId: planned.jobId });
  const tombstone = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  expect(tombstone).toBeTruthy(); expect(tombstone).not.toContain(command.query); expect(tombstone).not.toContain("Private supporting body");
});
it("does not invalidate source authority merely because ingestion adds derived relations", async () => {
  const { rpc, command, source } = await fixture(); await rpc.ownerOnce(scope, command);
  const current = (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, source.id))!;
  await env.DB.prepare("INSERT INTO assistant_relation_batches VALUES(?,?,?,?,?,1,1,?,'synthetic-author',NULL,'[]')")
    .bind(scope.installationId, scope.generation, "synthetic-derived-after-plan", "a".repeat(64), source.id, current.fence.source.hash).run();
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "planned" });
});
it("invalidates source authority when the selected project metadata changes", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  await new OwnerControl(env.DB, scope, { kind: "owner" }).execute({ kind: "project.put", id: "once-project", name: "Changed project metadata", expectedVersion: 1, operationId: "project-rename" });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "blocked" });
});
it("bounds metadata volume even when the original corpus is small", async () => {
  const { rpc, command, source } = await fixture(), control = new OwnerControl(env.DB, scope, { kind: "owner" });
  for (let i = 0; i < 18; i++) await control.execute({ kind: "mission.put", operationId: `large-mission-${i}`, id: `large-${i}`,
    expectedRevision: 0, objective: "x".repeat(2048), source: { id: source.id, revision: 1 }, state: "draft" });
  await expect(rpc.ownerOnce(scope, command)).rejects.toThrow("owner_once_manifest_capacity");
});
it("rechecks expiry after status awaits rather than reporting an expired plan as usable", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  const namespace = settings.COGNEE!, original = namespace.idFromName.bind(namespace);
  vi.spyOn(namespace, "idFromName").mockImplementationOnce(name => { vi.setSystemTime(command.deadlineAt + 1); return original(name); });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "blocked" });
});
it("records explicit admission separately from planning and recovers its original receipt without charging", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  const first = await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  expect(first).toMatchObject({ state: "admitted" });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toEqual(first);
  expect(await rpc.ownerOnce(scope, command)).toEqual(first);
  const receipts = await env.DB.prepare("SELECT result_json,token FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-admit-v1:%'").bind(scope.installationId).all<{ result_json: string; token: string }>();
  expect(receipts.results).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain(receipts.results[0].token);
  expect(bootstrap).not.toHaveBeenCalled();
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(0);
});
it("does not admit a withdrawn plan or create a replacement operation", async () => {
  const { rpc, command, source, sources } = await fixture(); await rpc.ownerOnce(scope, command);
  await sources.withdraw(source.id, 1);
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId })).toMatchObject({ state: "blocked" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-admit-v1:%'").bind(scope.installationId).first("n")).toBe(0);
});
it("admits bootstrap under pause only with the separate current Owner receipt", async () => {
  const { rpc, command, source } = await fixture(); const planned = await rpc.ownerOnce(scope, command) as { id: string };
  const input = { actor: { kind: "owner" } as const, source: (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, source.id))! };
  const guard = new CanonicalEngineGuard(settings);
  const admission = { kind: "owner_once", itemId: planned.id, owner: crypto.randomUUID() } as InitialIngestAdmission;
  expect(await guard.checkInitialAdmission(admission, input)).toBe(false);
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const grant = (await readOnceGrant(settings, onceReceipt.parse(JSON.parse(raw!))))!;
  admission.owner = grant.token;
  expect(await guard.checkInitialAdmission(admission, input)).toBe(true);
  expect(await guard.checkInitialAdmission(admission, input, crypto.randomUUID())).toBe(false);
  expect(await guard.checkInitialAdmission({ itemId: admission.itemId, owner: admission.owner }, input)).toBe(false);
  expect(await guard.checkInitialAdmission({ ...admission, owner: crypto.randomUUID() }, input)).toBe(false);
});
it("redacts durable admission grants from the paginated MCP export, including reconstructed chunks", async () => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const token = await env.DB.prepare("SELECT token FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-admit-v1:%'").bind(scope.installationId).first<string>("token");
  expect(token).toBeTruthy();
  const reader = new OwnerAssistant(createExecutionContext(), settings);
  type Part = { table: string; row: number; offset: number; data: string };
  const rows = new Map<number, Part[]>(); let cursor: string | undefined;
  do {
    const page = await reader.query(scope, { kind: "assistant.export", limit: 50, ...(cursor ? { cursor } : {}) }) as { parts: Part[]; nextCursor?: string };
    for (const part of page.parts.filter(part => part.table === "assistant_owner_commands")) rows.set(part.row, [...(rows.get(part.row) ?? []), part]);
    cursor = page.nextCursor;
  } while (cursor);
  const exported = [...rows.values()].map(parts => {
    const chunks = parts.sort((a, b) => a.offset - b.offset).map(part => Uint8Array.from(atob(part.data), c => c.charCodeAt(0)));
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  });
  expect(JSON.stringify(exported)).not.toContain(token!);
  expect(exported.find(row => row.operation_id.startsWith("owner-once-admit-v1:"))).toMatchObject({ token: null });
  expect(await rpc.ownerOnce(scope, { kind: "owner_once.status", operationId: command.operationId })).toMatchObject({ state: "admitted" });
});
it("fences the broker after a stale host grant when a supporting source is withdrawn", async () => {
  const { rpc, command, source, sources } = await fixture();
  const support = await sources.create({ originKey: "broker-support", text: "Synthetic broker support PRIVATE_SUPPORT_MARKER", audience: "owner", projectId: "once-project", occurredAt: now });
  await rpc.ownerOnce(scope, command); await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const grant = (await readOnceGrant(settings, onceReceipt.parse(JSON.parse(raw!))))!;
  const bodies: string[] = [];
  const adapter = async (request: { body: string }) => { bodies.push(request.body); return { status: 200, actualUnits: 2,
    body: JSON.stringify({ choices: [{ message: { content: "Synthetic reply PRIVATE_SUPPORT_MARKER" } }] }) }; };
  const permit = await new CogneeModelBroker(env.DB, { ...scope, period: "2026-10-27" }, DEFAULT_BROKER_CONFIG, adapter)
    .issuePermit(source.id, 1, now + 600000);
  let revoke = false;
  const rawAuthority = await onceAuthority(settings, scope, grant, Date.now());
  expect(await env.DB.prepare(`SELECT 1 WHERE ${rawAuthority.guard.sql}`).bind(...rawAuthority.guard.values).first()).not.toBeNull();
  const preflight = await engineModelAdmission(settings, "2026-10-27", undefined, grant)!.prepare({ key: "synthetic-preflight", hash: "a".repeat(64), recovered: false });
  expect(preflight).not.toBeNull();
  expect(await env.DB.prepare(`SELECT 1 WHERE ${preflight!.guard.sql}`).bind(...preflight!.guard.values).first()).not.toBeNull();
  const host = { authorize: async () => { if (revoke) await sources.withdraw(support.id, 1);
    return { token: permit, period: "2026-10-27", ownerOnce: grant }; } };
  const invoke = (text: string) => handleBrokerRequest(new Request("http://broker.internal/v1/chat/completions", { method: "POST",
    body: JSON.stringify({ model: DEFAULT_BROKER_CONFIG.chatModel, messages: [{ role: "user", content: text }] }) }), "synthetic-epoch", host,
    (period: string, _proof: unknown, admitted?: OnceGrant) => new CogneeModelBroker(env.DB, { ...scope, period }, DEFAULT_BROKER_CONFIG, adapter, Date.now,
      engineModelAdmission(settings, period, undefined, admitted)));
  expect((await invoke("First authorized synthetic request")).status).toBe(200);
  revoke = true;
  expect((await invoke("A different request after revocation")).status).toBe(403);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toContain(grant.token);
  const held = (await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed;
  expect(JSON.stringify((await env.DB.prepare("SELECT response_json FROM assistant_model_receipts WHERE installation_id=? AND source_id=?").bind(scope.installationId, source.id).all()).results)).toContain("PRIVATE_SUPPORT_MARKER");
  await purge(support.id);
  expect((await env.DB.prepare("SELECT response_json FROM assistant_model_receipts WHERE installation_id=? AND source_id=?").bind(scope.installationId, source.id).all()).results).toEqual([]);
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(held);
});
it("rechecks the full Owner manifest for late engine permits instead of just the anchor", async () => {
  const { rpc, command, source, sources } = await fixture();
  const support = await sources.create({ originKey: "late-ingest-support", text: "Synthetic ingestion support", audience: "owner", projectId: "once-project", occurredAt: now });
  await rpc.ownerOnce(scope, command); await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const grant = (await readOnceGrant(settings, onceReceipt.parse(JSON.parse(raw!))))!;
  const current = (await new SourceAccess(env.DB, scope).read({ kind: "owner" }, source.id))!;
  const guard = new CanonicalEngineGuard(settings), permits = [{ source: current.fence, ownerOnce: grant }];
  expect(await guard.check({ kind: "owner" }, permits)).toBe(true);
  await sources.withdraw(support.id, 1);
  expect(await guard.check({ kind: "owner" }, permits)).toBe(false);
});
type SelectedSearch = { start(actor: { kind: "owner" }, key: string, input: { query: string; projectId: string },
  admission: { ownerOnceId: string; guard: AccessGuard }): Promise<{ runId: string }> };
it("binds the retrieval question to its Owner plan and purges the run when a supporting original is removed", async () => {
  const { rpc, command, sources } = await fixture();
  const support = await sources.create({ originKey: "search-support", text: "Private planned retrieval support", audience: "owner", projectId: "once-project", occurredAt: now });
  await rpc.ownerOnce(scope, command); await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const receipt = onceReceipt.parse(JSON.parse(raw!)), grant = (await readOnceGrant(settings, receipt))!;
  const authority = await onceAuthority(settings, scope, grant, Date.now());
  const selected = hostConfiguredSearch(settings, "owner_read").search as unknown as SelectedSearch;
  const admission = { ownerOnceId: receipt.id, guard: authority.guard };
  const run = await selected.start({ kind: "owner" }, onceKey(receipt.id), { query: command.query, projectId: command.projectId }, admission);
  const stored = await env.DB.prepare("SELECT request_json FROM assistant_retrieval_runs WHERE installation_id=? AND id=?").bind(scope.installationId, run.runId).first<string>("request_json");
  expect(JSON.parse(stored!).ownerOnceId).toBe(receipt.id); expect(stored).not.toContain(grant.token);
  await sources.withdraw(support.id, 1); await purge(support.id);
  expect(await env.DB.prepare("SELECT 1 FROM assistant_retrieval_runs WHERE installation_id=? AND id=?").bind(scope.installationId, run.runId).first()).toBeNull();
  await expect(selected.start({ kind: "owner" }, onceKey(receipt.id), { query: command.query, projectId: command.projectId }, admission)).rejects.toThrow();
});
it("does not treat the reserved Owner key as an ordinary unadmitted retrieval", async () => {
  const { rpc, command } = await fixture(); const plan = await rpc.ownerOnce(scope, command) as { id: string };
  const { search } = hostConfiguredSearch(settings, "owner_read");
  await expect(search.start({ kind: "owner" }, onceKey(plan.id), { query: command.query, projectId: command.projectId })).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_retrieval_runs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
});
it.each(["query", "project", "limit", "entities", "missing_provider", "fallback"])("refuses Owner retrieval with %s outside its admitted contract", async mode => {
  const { rpc, command } = await fixture(); await rpc.ownerOnce(scope, command);
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const receipt = onceReceipt.parse(JSON.parse(raw!)), grant = (await readOnceGrant(settings, receipt))!;
  const authority = await onceAuthority(settings, scope, grant, Date.now()), configured = hostConfiguredSearch(settings, "owner_read");
  const search = mode === "missing_provider" ? new RetrievalRuns(env.DB, scope, { purpose: "owner_read", semantic: configured.semantic })
    : mode === "fallback" ? new RetrievalRuns(env.DB, scope, { purpose: "owner_read", semantic: { ...configured.semantic!, mode: "lexical_fallback" }, ownerOncePlan: configured.ownerOncePlan }) : configured.search;
  const input = { query: mode === "query" ? "Another question" : command.query, projectId: mode === "project" ? "foreign-project" : command.projectId,
    ...(mode === "limit" ? { limit: 1 } : {}), ...(mode === "entities" ? { entities: [{ kind: "project" as const, id: "foreign" }] } : {}) };
  await expect(search.start({ kind: "owner" }, onceKey(receipt.id), input, { ownerOnceId: receipt.id, guard: authority.guard })).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_retrieval_runs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
});
it.each(["   ", Array.from({ length: 33 }, (_, i) => `distinct${i}`).join(" ")])("refuses an unusable retrieval question before any indexing admission: %s", async query => {
  const { rpc, command } = await fixture();
  await expect(rpc.ownerOnce(scope, { ...command, query })).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assistant_jobs WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);
  expect(bootstrap).not.toHaveBeenCalled();
});
it.each([
  ...[false,true].flatMap(embedding=>[
    {sources:1,embedding,reverse:false,drift:false},
    {sources:2,embedding,reverse:false,drift:false},
    {sources:2,embedding,reverse:true,drift:false},
  ]),
  {sources:2,embedding:true,reverse:true,drift:true},
])
  ("carries the original grant only into internal semantic permits with $sources sources embedding=$embedding reverse=$reverse drift=$drift", async ({ sources, embedding, reverse, drift }) => {
  const firstId = reverse ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : "00000000-0000-4000-8000-000000000001";
  const nextId = reverse ? "00000000-0000-4000-8000-000000000001" : "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const uuid = vi.spyOn(crypto,"randomUUID").mockReturnValueOnce("22222222-2222-4222-8222-222222222222").mockReturnValueOnce(firstId);
  const { rpc, command, source } = await fixture(); uuid.mockRestore(); expect(source.id).toBe(firstId);
  let secondSource: {id:string;revision:number} | undefined;
  if (sources === 2) {
    const secondUuid = vi.spyOn(crypto,"randomUUID").mockReturnValueOnce(nextId);
    secondSource = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "second-semantic-source", text: "Second private technical note for the blue marker", audience: "owner", projectId: "once-project", occurredAt: now });
    secondUuid.mockRestore(); expect(secondSource.id).toBe(nextId);
  }
  const stamp=ownerContextStamp(scope,new SourceAccess(env.DB,scope).ownerRows(now),scope);
  const catalog=JSON.parse((await env.DB.prepare(stamp.sql).bind(...stamp.values).first<string>("value"))!);
  expect(catalog.every(Array.isArray)).toBe(true);
  expect(catalog.map((row:unknown[])=>row[0])).toEqual([firstId,...(secondSource?[secondSource.id]:[])].sort());
  await rpc.ownerOnce(scope, command);
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const receipt = onceReceipt.parse(JSON.parse(raw!)), grant = (await readOnceGrant(settings, receipt))!, authority = await onceAuthority(settings, scope, grant, Date.now());
  const { search, semantic } = hostConfiguredSearch(settings, "owner_read");
  const prepare = vi.fn(async (_key: string, _input: unknown) => ({ state: "blocked" as const, reason: "synthetic_no_model_submission" }));
  Object.assign(semantic!.engine, { prepare });
  let progress = await search.start({ kind: "owner" }, onceKey(receipt.id), { query: command.query, projectId: command.projectId }, { ownerOnceId: receipt.id, guard: authority.guard });
  for (let i = 0; i < 3 && progress.state === "pending"; i++) progress = await search.step({ kind: "owner" }, { runId: progress.runId, stepId: `semantic-${i}`, expectedCheckpoint: progress.checkpoint });
  await search.result({ kind: "owner" }, progress.runId);
  expect(prepare).toHaveBeenCalled();
  const request = prepare.mock.calls[0][1] as { permits: { ownerOnce?: OnceGrant }[] };
  expect(request.permits.length).toBeGreaterThan(0);
  expect(request.permits.every(permit => JSON.stringify(permit.ownerOnce) === JSON.stringify(grant))).toBe(true);
  const stored = await env.DB.prepare("SELECT r.request_json,s.proof_json FROM assistant_retrieval_runs r LEFT JOIN assistant_retrieval_semantic s ON s.installation_id=r.installation_id AND s.generation=r.generation AND s.run_id=r.id WHERE r.installation_id=? AND r.id=?").bind(scope.installationId, progress.runId).first();
  expect(JSON.stringify(stored)).not.toContain(grant.token);
  const proof=JSON.parse((stored as {proof_json:string}).proof_json) as CoverageProof;
  const combined=await engineModelAdmission(settings,"2026-10-27",proof,grant)!.prepare({key:"synthetic-combined-proof",hash:"b".repeat(64),recovered:false});
  expect(combined).not.toBeNull();
  expect(await compactStatement(env.DB,`SELECT 1 WHERE ${combined!.guard.sql}`,combined!.guard.values).first()).not.toBeNull();
  const current=(await new SourceAccess(env.DB,scope).read({kind:"owner"},receipt.sourceId))!;
  const adapter=vi.fn(async()=>({status:200,actualUnits:1,body:embedding ? JSON.stringify({data:[{index:0,embedding:Array(1536).fill(0.01)}]}) : '{"choices":[{"message":{"content":"Synthetic combined reply"}}]}'}));
  const admission=engineModelAdmission(settings,"2026-10-27",proof,grant)!;
  const checkedAdmission=drift ? {...admission,prepare:async (request:{key:string;hash:string;recovered:boolean})=>{
    const prepared=await admission.prepare(request);
    await new SourceController(env.DB,scope,{kind:"owner"}).correct(secondSource!.id,1,{text:"Changed technical support after admission preparation",occurredAt:now});
    return prepared;
  }} : admission;
  const broker=new CogneeModelBroker(env.DB,{...scope,period:"2026-10-27"},DEFAULT_BROKER_CONFIG,adapter,Date.now,checkedAdmission);
  const permit=await broker.issuePermit(current.id,1,now+600000);
  const invoke=()=>handleBrokerRequest(new Request("http://broker.internal"+(embedding?"/v1/embeddings":"/v1/chat/completions"),{method:"POST",body:JSON.stringify(embedding?{model:DEFAULT_BROKER_CONFIG.embeddingModel,input:"Synthetic combined proof"}:{model:DEFAULT_BROKER_CONFIG.chatModel,messages:[{role:"user",content:"Synthetic combined proof"}]})}),"synthetic-epoch",{authorize:async()=>({token:permit,period:"2026-10-27",coverage:proof,ownerOnce:grant})},()=>broker);
  const firstStatus=(await invoke()).status;
  if(drift){
    expect(firstStatus).toBe(403);expect(adapter).not.toHaveBeenCalled();
    expect((await new InferenceBudget(env.DB,{...scope,period:"2026-10-27"}).status()).committed).toBe(DEFAULT_BROKER_CONFIG.embeddingCeiling);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_model_receipts WHERE installation_id=?").bind(scope.installationId).first("n")).toBe(0);return;
  }
  expect(firstStatus).toBe(200);expect((await invoke()).status).toBe(200);expect(adapter).toHaveBeenCalledTimes(1);
  await new SourceController(env.DB,scope,{kind:"owner"}).withdraw(current.id,1);
  expect((await invoke()).status).not.toBe(200);expect(adapter).toHaveBeenCalledTimes(1);
  expect(bootstrap).not.toHaveBeenCalled();
});
async function readyOwnerWork() {
  const { rpc, command } = await fixture(); const planned = await rpc.ownerOnce(scope, command) as { jobId: string };
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%'").bind(scope.installationId).first<string>("result_json");
  const receipt = onceReceipt.parse(JSON.parse(raw!)), grant = (await readOnceGrant(settings, receipt))!, authority = await onceAuthority(settings, scope, grant, Date.now());
  const { search, semantic } = hostConfiguredSearch(settings, "owner_read"), epoch = crypto.randomUUID();
  const records = new Map<string, { ticket: SearchTicket; input: EngineSearch; submitted: boolean }>();
  const complete = (record: { ticket: SearchTicket; input: EngineSearch }) => ({ state: "complete" as const, operationId: record.ticket.operationId,
    indexRevision: record.ticket.indexRevision, indexState: "checkpoint_confirmed" as const,
    result: { candidates: record.input.allowedSources.map(ref => ({ ...ref, via: ["chunks"], relationCount: 0 })), missing: [] } });
  // Synthetic semantic dependency only; the real controller/budget/D1 are used.
  Object.assign(semantic!.engine, {
    prepare: async (alias: string, input: EngineSearch) => {
      const old = records.get(alias); if (old) return { state: "prepared", ticket: old.ticket };
      const ticket = { alias, requestHash: await bridgeHash(input), operationId: await bridgeHash(["synthetic-owner-search", alias, input]), indexEpoch: epoch, indexRevision: "c".repeat(64) };
      records.set(alias, { ticket, input, submitted: false }); return { state: "prepared", ticket };
    },
    lookupTicket: async (ticket: SearchTicket) => { const record = records.get(ticket.alias)!; return record.submitted ? complete(record)
      : { state: "uncertain", reason: "not_submitted", operationId: ticket.operationId }; },
    submit: async (ticket: SearchTicket) => { const record = records.get(ticket.alias)!; record.submitted = true; return complete(record); },
  });
  let progress = await search.start({ kind: "owner" }, onceKey(receipt.id), { query: command.query, projectId: command.projectId }, { ownerOnceId: receipt.id, guard: authority.guard });
  for (let i = 0; i < 3 && progress.state === "pending"; i++) progress = await search.step({ kind: "owner" }, { runId: progress.runId, stepId: `ready-${i}`, expectedCheckpoint: progress.checkpoint });
  await search.advanceSemantic({ kind: "owner" }, progress.runId);
  expect((await search.result({ kind: "owner" }, progress.runId)).state).toBe("ready");
  const lease = (await new JobQueue(env.DB, scope).claimId(planned.jobId, now, 90000, authority.guard))!;
  expect(lease).not.toBeNull();
  return { search, runId: progress.runId, lease, receipt, grant, command };
}
it("refuses a planned Owner job in a controller without its bounded-work authority", async () => {
  const { search, runId, lease } = await readyOwnerWork();
  const model = vi.fn(async () => { throw Error("unadmitted_model"); });
  const host = new EpisodeController(env.DB, { ...scope, period: "2026-10-27" }, search, model, DEFAULT_BROKER_CONFIG, { purpose: "owner_read" });
  await expect(host.prepare(lease, "owner", runId)).rejects.toThrow("episode_denied");
  expect(model).not.toHaveBeenCalled();
});
it("publishes one bounded shadow proposal and keeps it readable after execution expires without another model call", async () => {
  const work = await readyOwnerWork(); const bodies: string[] = [];
  const model = async (request: { body: string }) => {
    bodies.push(request.body); const task = JSON.parse(JSON.parse(request.body).messages.at(-1).content), source = task.sources[0];
    return { status: 200, actualUnits: 2, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "proposed", text: "Synthetic bounded proposal.",
      citations: [{ id: source.id, revision: source.revision, version: source.version, hash: source.hash, quote: source.text, media: null }] }) } }] }) };
  };
  const host = runtimeHost(settings, "owner_read", { model });
  const episode = await host.prepare(work.lease, "owner", work.runId);
  expect(episode.deadline).toBeLessThanOrEqual(work.receipt.deadlineAt);
  expect(JSON.stringify(episode.binding)).not.toContain(work.grant.token);
  const driver: EpisodeDriver = (profile, runtimeId) => ({
    dispatch: async () => ({ submissionId: "synthetic-owner-submission", uid: "synthetic-owner-uid", acceptedAt: new Date(now).toISOString() }),
    read: async receipt => ({ ...receipt, text: await host.model(episode.id, { profile, runtimeId, submissionId: receipt.submissionId },
      { messages: [{ role: "user", content: host.message(episode) }] }), data: {} }),
  });
  expect(await host.dispatch(episode.id, driver)).toMatchObject({ state: "accepted" });
  const result = await host.read(episode.id, driver); expect(result).toMatchObject({ state: "shadow_completed" });
  expect(bodies).toHaveLength(1); expect(bodies[0]).not.toContain(work.grant.token);
  vi.setSystemTime(work.receipt.deadlineAt + 1);
  const current = await new OwnerAssistant(createExecutionContext(), settings).query(scope, { kind: "decision", id: result.decisionId });
  expect(current).toMatchObject({ freshness: "current" });
  expect(bodies).toHaveLength(1);
});
it("does not mix two Owner roots merely because their questions and sources match", async () => {
  const work = await readyOwnerWork(), rpc = new OwnerAssistant(createExecutionContext(), settings);
  const command = { ...work.command, operationId: "different-owner-root" };
  const planned = await rpc.ownerOnce(scope, command) as { jobId: string };
  await rpc.ownerOnce(scope, { kind: "owner_once.advance", operationId: command.operationId });
  const raw = await env.DB.prepare("SELECT result_json FROM assistant_owner_commands WHERE installation_id=? AND operation_id LIKE 'owner-once-v1:%' AND json_extract(result_json,'$.jobId')=?").bind(scope.installationId, planned.jobId).first<string>("result_json");
  const receipt = onceReceipt.parse(JSON.parse(raw!)), grant = (await readOnceGrant(settings, receipt))!, authority = await onceAuthority(settings, scope, grant, now);
  const lease = (await new JobQueue(env.DB, scope).claimId(planned.jobId, now, 90000, authority.guard))!;
  const host = runtimeHost(settings, "owner_read", { model: async () => { throw Error("wrong_root_must_not_call_model"); } });
  await expect(host.prepare(lease, "owner", work.runId)).rejects.toThrow("episode_denied");
});
it("rejects model admission when its Root authority disappears after the guard was prepared", async () => {
  const work = await readyOwnerWork(), original = settings.DB!;
  let prepared = false, revoked = false;
  settings.DB = { prepare(sql: string) { if (sql.startsWith("INSERT INTO assistant_model_receipts")) prepared = true; return original.prepare(sql); },
    async batch(statements: D1PreparedStatement[]) {
      if (prepared && !revoked) { revoked = true; await original.prepare("DELETE FROM assistant_owner_commands WHERE installation_id=? AND operation_id=?").bind(scope.installationId, `owner-once-admit-v1:${work.receipt.id}`).run(); }
      return original.batch(statements);
    } } as D1Database;
  const model = vi.fn(async () => { throw Error("revoked_model_must_not_run"); }), host = runtimeHost(settings, "owner_read", { model });
  const episode = await host.prepare(work.lease, "owner", work.runId);
  const receipt = { submissionId: "synthetic-revoked-submission", uid: "synthetic-revoked-uid", acceptedAt: new Date(now).toISOString() };
  const driver: EpisodeDriver = () => ({ dispatch: async () => receipt, read: async () => { throw Error("not_used"); } });
  expect(await host.dispatch(episode.id, driver)).toMatchObject({ state: "accepted" });
  await expect(host.model(episode.id, { profile: "owner", runtimeId: episode.runtime_id, submissionId: receipt.submissionId },
    { messages: [{ role: "user", content: host.message(episode) }] })).rejects.toThrow();
  expect(revoked).toBe(true); expect(model).not.toHaveBeenCalled();
  expect((await new InferenceBudget(env.DB, { ...scope, period: "2026-10-27" }).status()).committed).toBe(DEFAULT_BROKER_CONFIG.chatCeiling);
});
it("does not replay an uncertain native envelope after the Owner source is withdrawn", async () => {
  const work = await readyOwnerWork(), host = runtimeHost(settings, "owner_read", { model: async () => { throw Error("not_used"); } });
  const episode = await host.prepare(work.lease, "owner", work.runId), dispatch = vi.fn(async () => { throw Error("synthetic_dispatch_ACK_lost"); });
  const driver: EpisodeDriver = () => ({ dispatch, read: async () => { throw Error("not_used"); } });
  expect(await host.dispatch(episode.id, driver)).toMatchObject({ state: "uncertain" });
  await new SourceController(env.DB, scope, { kind: "owner" }, Date.now, retirement).withdraw(work.command.sourceId, 1);
  expect(await host.reconcile(episode.id, driver)).toMatchObject({ state: "blocked" });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
