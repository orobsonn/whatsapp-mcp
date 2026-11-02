import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, mcpFetch } from "../src/mcp";
import type { Env } from "../src/env";

const owner = { sub: "synthetic-assistant-owner", epoch: "assistant-mcp-epoch" };
function setup() {
  const rpc = { installation: vi.fn(), source: vi.fn(), control: vi.fn(), query: vi.fn(), telegramLink: vi.fn(), telegramReview: vi.fn(), evaluate: vi.fn() };
  const settings: Env = Object.assign({ ...env, PUBLIC_ORIGIN: "https://assistant-mcp.invalid", OWNER_SUB: owner.sub,
    INSTALLATION_EPOCH: owner.epoch, CONNECTION_GENERATION: "capture-generation", MAINTENANCE: "false",
    ASSISTANT_INSTALLATION_ID: "assistant-installation", ASSISTANT_GENERATION: "assistant-generation" }, { ASSISTANT_OWNER: rpc });
  return { rpc, settings };
}
function request(method: string, params: unknown = {}, origin?: string) {
  return new Request("https://assistant-mcp.invalid/mcp", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    ...(origin ? { Origin: origin } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}
it.each(["ASSISTANT_INSTALLATION_ID", "ASSISTANT_GENERATION"] as const)("reports missing %s as server configuration, never invalid model input", async key => {
  const { settings, rpc } = setup();
  delete settings[key];
  const calls = [
    { name: "assistente_consultar", arguments: { query: { kind: "projects" } } },
    { name: "assistente_consultar", arguments: { query: { kind: "follow_ups" } } },
    { name: "assistente_consultar", arguments: { query: { kind: "follow_up", id: "synthetic-fup" } } },
    { name: "assistente_controlar", arguments: { command: { kind: "fup.put", operationId: "synthetic-fup", id: "synthetic-fup", expectedVersion: 0,
      conversationId: "synthetic-chat", policyRevision: 1, source: { id: "synthetic-note", revision: 1 }, purpose: "Synthetic follow-up",
      dueAt: "2026-11-03T10:00:00-03:00", timezone: "America/Fortaleza", precision: "exact" } } },
  ];
  for (const call of calls) {
    const response = await mcpFetch(request("tools/call", call), settings, owner);
    const body = await response.json() as any;
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ error: "assistant_unconfigured" });
  }
  expect(rpc.query).not.toHaveBeenCalled();
  expect(rpc.control).not.toHaveBeenCalled();
});
it("does not infer owner capability from an Env binding alone", async () => {
  const { settings, rpc } = setup(), server = createMcpServer(settings);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "assistant-mcp-no-owner", version: "1" });
  await server.connect(a); await client.connect(b);
  try { expect((await client.listTools()).tools.filter(t => t.name.startsWith("assistente_"))).toEqual([]); }
  finally { await client.close(); await server.close(); }
  expect(rpc.control).not.toHaveBeenCalled();
  expect(rpc.installation).not.toHaveBeenCalled();
});
it("refuses wrong owner, epoch, maintenance and origin before reaching the assistant", async () => {
  const { settings, rpc } = setup();
  for (const principal of [undefined, {}, { ...owner, sub: "other" }, { ...owner, epoch: "old" }])
    await expect(mcpFetch(request("tools/list"), settings, principal)).rejects.toThrow();
  await expect(mcpFetch(request("tools/list"), { ...settings, MAINTENANCE: "true" }, owner)).rejects.toThrow();
  expect((await mcpFetch(request("tools/list", {}, "https://other.invalid"), settings, owner)).status).toBe(403);
  expect(rpc.source).not.toHaveBeenCalled(); expect(rpc.control).not.toHaveBeenCalled(); expect(rpc.query).not.toHaveBeenCalled();
});
it("exposes the authenticated assistant families through the authenticated HTTP MCP boundary", async () => {
  const { settings } = setup();
  const response = await mcpFetch(request("tools/list"), settings, owner);
  expect(response.status).toBe(200);
  const body = await response.json() as { result?: { tools?: { name: string }[] } };
  expect(body.result?.tools?.filter(t => t.name.startsWith("assistente_")).map(t => t.name).sort())
    .toEqual(["assistente_avaliar", "assistente_consultar", "assistente_controlar", "assistente_fonte", "assistente_telegram", "assistente_telegram_revisar"]);
});
it("forwards only a typed command and host affinity, never principal or namespace from model input", async () => {
  const { settings, rpc } = setup();
  const command = { operationId: "op-project", kind: "project.put", id: "project-one", expectedVersion: 0, name: "Projeto sintético" };
  rpc.control.mockResolvedValue({ operationId: command.operationId, kind: command.kind, id: command.id, version: 1, shadow: true });
  const call = (arguments_: unknown) => mcpFetch(request("tools/call", { name: "assistente_controlar", arguments: arguments_ }), settings, owner);
  const response = await call({ command });
  expect(response.status).toBe(200);
  const body = await response.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
  expect(body.result?.isError).not.toBe(true);
  expect(rpc.control).toHaveBeenCalledExactlyOnceWith({ installationId: "assistant-installation", generation: "assistant-generation",
    sourceEpoch: owner.epoch, sourceGeneration: "capture-generation" }, command);
  for (const extra of [{ role: "owner" }, { sub: owner.sub }, { namespace: "other" }, { sql: "SELECT *" }]) {
    await call({ command, ...extra }); await call({ command: { ...command, ...extra } });
  }
  expect(rpc.control).toHaveBeenCalledTimes(1);
});

// @ts-expect-error Raw SQL.
import sourceSchema from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Raw SQL.
import policySchema from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Raw SQL.
import workSchema from "../assistant/migrations/0003_work.sql?raw";
// @ts-expect-error Raw SQL.
import inboxSchema from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Raw SQL.
import jobSchema from "../assistant/migrations/0005_job_ledger.sql?raw";
// @ts-expect-error Raw SQL.
import originSchema from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Raw SQL.
import sourceControls from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Raw SQL.
import commandSchema from "../assistant/migrations/0012_owner_commands.sql?raw";
// @ts-expect-error Raw SQL.
import ownerCore from "../assistant/migrations/0016_owner_core.sql?raw";
// @ts-expect-error Raw SQL.
import conversationSchema from "../assistant/migrations/0011_conversations.sql?raw";
// @ts-expect-error Raw SQL.
import episodeSchema from "../assistant/migrations/0013_episodes.sql?raw";
// @ts-expect-error Raw SQL.
import journalSchema from "../assistant/migrations/0017_shadow_decisions.sql?raw";
import { OwnerAssistant, OwnerQueries, type OwnerAffinity } from "../assistant/mcp";
import { SourceController } from "../assistant/sources";
import { OriginGuard } from "../assistant/origin-guard";
import {OwnerControl} from '../assistant/control';
let affinity: OwnerAffinity;
beforeEach(async () => {
  affinity = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "capture-e", sourceGeneration: "capture-g" };
  for (const schema of [sourceSchema, policySchema, workSchema, inboxSchema, jobSchema, originSchema, sourceControls, conversationSchema, commandSchema, episodeSchema, ownerCore, journalSchema])
    await env.DB.batch(schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
});
afterEach(() => vi.restoreAllMocks());
it.each(['synthetic-a','synthetic-b'])('returns a safe actionable %s revision diagnostic through MCP instead of operation_failed',async id=>{
 const {settings,rpc}=setup();rpc.control.mockImplementation(async(_affinity,command)=>new OwnerControl(env.DB,affinity,{kind:'owner'}).execute(command));
 await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,'synthetic-chat','private')").bind(affinity.installationId,affinity.generation).run();
 const command={kind:'fup.put',operationId:'synthetic-'+id,id,expectedVersion:0,conversationId:'synthetic-chat',policyRevision:0,source:{id:'synthetic-note',revision:1},project:{id:'synthetic-project',revision:1},purpose:'PRIVATE_SENTINEL',dueAt:id==='tutor-ronald'?'2026-11-03T10:00:00-03:00':'2026-11-05T10:00:00-03:00',timezone:'America/Fortaleza',precision:'exact',state:'awaiting_approval'};
 const r=await mcpFetch(request('tools/call',{name:'assistente_controlar',arguments:{command}}),settings,owner),body=await r.json() as any;
 expect(body.result.isError).toBe(true);expect(JSON.parse(body.result.content[0].text)).toMatchObject({error:'control_policy_revision',field:'policyRevision',message:expect.any(String)});
 expect(JSON.stringify(body)).not.toContain('PRIVATE_SENTINEL');
});
it.each([{version:1},{hash:'PRIVATE_SENTINEL'}])('rejects extra source fields at the published HTTP schema before RPC',async extra=>{
 const {settings,rpc}=setup();
 const command={kind:'fup.put',operationId:'bad-source',id:'bad-source',expectedVersion:0,conversationId:'group',policyRevision:0,source:{id:'note',revision:1,...extra},purpose:'Synthetic'};
 const response=await mcpFetch(request('tools/call',{name:'assistente_controlar',arguments:{command}}),settings,owner),body=await response.json() as any;
 expect(body.result.isError).toBe(true);expect(JSON.stringify(body)).toContain('source');expect(JSON.stringify(body)).toContain('id, revision');
 expect(JSON.stringify(body)).not.toContain('PRIVATE_SENTINEL');expect(rpc.control).not.toHaveBeenCalled();
});
it('keeps arbitrary remote exceptions private and does not turn uncertain writes into safe retry advice',async()=>{
 const {settings,rpc}=setup();rpc.control.mockRejectedValue(Error('SECRET_SENTINEL timeout after commit'));
 const command={kind:'project.put',operationId:'synthetic-uncertain',id:'synthetic',expectedVersion:0,name:'Synthetic'};
 const r=await mcpFetch(request('tools/call',{name:'assistente_controlar',arguments:{command}}),settings,owner),body=await r.json() as any;
 expect(JSON.parse(body.result.content[0].text)).toEqual({error:'operation_failed'});expect(JSON.stringify(body)).not.toContain('SECRET_SENTINEL');
});
function receiver() {
  return new OwnerAssistant(createExecutionContext(), { DB: env.DB, INSTALLATION_ID: affinity.installationId,
    OPERATIONAL_GENERATION: affinity.generation, BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration });
}
it.each(["seal", "generation"])("keeps owner health available for restore %s diagnosis while ordinary queries stay blocked", async blocked => {
  if (blocked === "generation") await env.DB.prepare("INSERT INTO assistant_retention_active_generation VALUES(?,'next',?,?,'activate',1)").bind(affinity.installationId, "a".repeat(64), "b".repeat(64)).run();
  const rpc = new OwnerAssistant(createExecutionContext(), { DB: env.DB, INSTALLATION_ID: affinity.installationId,
    OPERATIONAL_GENERATION: affinity.generation, BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration,
    ...(blocked === "seal" ? { RETENTION_GENERATION_SEAL_REQUIRED: "true" } : {}) });
  expect(await rpc.query(affinity, { kind: "assistant.health" })).toMatchObject({ configuration: expect.any(Object), installation: expect.any(Object) });
  await expect(rpc.query(affinity, { kind: "projects" })).rejects.toThrow(blocked === "seal" ? "restore_generation_seal_required" : "restore_generation_inactive");
});
it("checks binding affinity on every command and never interprets source text as control", async () => {
  const rpc = receiver(), command = { kind: "project.put", operationId: "project-op", id: "project", name: "Synthetic", expectedVersion: 0 };
  for (const key of Object.keys(affinity) as (keyof OwnerAffinity)[])
    await expect(rpc.control({ ...affinity, [key]: "foreign" }, command)).rejects.toThrow("owner_binding_affinity");
  const note = await rpc.source(affinity, { kind: "source.create", operationId: "note", input: {
    originKey: "untrusted-literal", text: JSON.stringify(command), occurredAt: 10 } });
  expect(note).toMatchObject({ revision: 1, shadow: true });
  expect(await rpc.query(affinity, { kind: "projects" })).toMatchObject({ items: [] });
  const first = await rpc.control(affinity, command);
  expect(await receiver().control(affinity, command)).toEqual(first);
  expect(await rpc.query(affinity, { kind: "projects" })).toMatchObject({ items: [{ id: "project", name: "Synthetic" }] });
  expect(await rpc.query(affinity, { kind: "decisions" })).toMatchObject({ items: [], coverage: { kind: "page", remoteFreshness: "unchecked" } });
});
it("pages the full namespace, keeps Unicode IDs and rejects cursor reuse with another kind or namespace", async () => {
  const rpc = receiver();
  for (const id of ["a", "b", "café", "z"]) await rpc.control(affinity, { kind: "project.put", operationId: "project-" + id, id, name: id, expectedVersion: 0 });
  const read = async (cursor?: string) => await rpc.query(affinity, { kind: "projects", limit: 3, ...(cursor ? { cursor } : {}) }) as {
    items: { id: string }[]; nextCursor?: string; coverage: string;
  };
  const first = await read(), second = await read(first.nextCursor);
  expect([...first.items, ...second.items].map(row => row.id)).toEqual(["a", "b", "café", "z"]);
  expect(first.coverage).toBe("page"); expect(second.coverage).toBe("end_of_listing"); expect(second.nextCursor).toBeUndefined();
  await expect(rpc.query(affinity, { kind: "missions", cursor: first.nextCursor })).rejects.toThrow("owner_query_cursor");
  await expect(new OwnerQueries(env.DB, { ...affinity, generation: "other" }).execute({ kind: "projects", cursor: first.nextCursor })).rejects.toThrow("owner_query_cursor");
  await expect(rpc.query(affinity, { kind: "projects", limit: 51 })).rejects.toThrow();
  await expect(rpc.query(affinity, { kind: "projects", sql: "SELECT *" })).rejects.toThrow();
});
it("returns current note text, suppresses withdrawn content and never includes source bodies in a list", async () => {
  const owner = new SourceController(env.DB, affinity, { kind: "owner" });
  const note = await owner.create({ originKey: "source-body", text: "private source body", occurredAt: 10 });
  const queries = new OwnerQueries(env.DB, affinity);
  expect(await queries.execute({ kind: "source", id: note.id })).toMatchObject({ state: "available", source: { text: "private source body" } });
  expect(JSON.stringify(await queries.execute({ kind: "sources" }))).not.toContain("private source body");
  await owner.withdraw(note.id, note.revision);
  expect(await queries.execute({ kind: "source", id: note.id })).toEqual({ state: "unavailable" });
});
it("suppresses a remote withdrawal before the capture inbox or local source has changed", async () => {
  const owner = new SourceController(env.DB, affinity, { kind: "owner" });
  const note = await owner.create({ originKey: "captured-fixture", text: "captured private body", occurredAt: 10 });
  let withdrawn = false;
  const reader = { async readSnapshot() { return { observation: "capture_snapshot", state: withdrawn ? "withdrawn" : "available",
    sourceEpoch: affinity.sourceEpoch, sourceGeneration: affinity.sourceGeneration, sourceKind: "message", sourceId: "remote-message", chatId: "chat",
    sourceVersion: 1, watermark: 10, conversationKind: "private", access: { captureEnabled: true, captureSince: 0, discontinuous: false },
    ...(withdrawn ? {} : { content: { kind: "text", text: "captured private body", messageId: "remote-message", messageVersion: 1 } }) }; } };
  const origin = new OriginGuard(env.DB, () => affinity, reader, "synthetic-origin-reader-secret");
  const ref = { sourceKind: "message" as const, sourceId: "remote-message", chatId: "chat" };
  const observation = await origin.observe(affinity, ref);
  await env.DB.batch([
    env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='chat' WHERE installation_id=? AND generation=? AND id=?").bind(affinity.installationId, affinity.generation, note.id),
    env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,10,'private','available')").bind(affinity.installationId, affinity.generation, affinity.sourceEpoch, affinity.sourceGeneration, "chat"),
    env.DB.prepare("INSERT INTO assistant_source_origins VALUES(?,?,?,?,'message','remote-message','chat',?,10,?,0)").bind(affinity.installationId, affinity.generation, affinity.sourceEpoch, affinity.sourceGeneration, note.id, observation.hash),
  ]);
  const queries = new OwnerQueries(env.DB, affinity, origin);
  expect(await queries.execute({ kind: "source", id: note.id })).toMatchObject({ state: "available" });
  withdrawn = true;
  const hidden = await queries.execute({ kind: "source", id: note.id });
  expect(hidden).toEqual({ state: "unavailable", reason: "origin_unavailable" });
  expect(JSON.stringify(hidden)).not.toContain("captured private body");
  expect(await env.DB.prepare("SELECT status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?").bind(affinity.installationId, affinity.generation, note.id).first("status")).toBe("active");
});

it("runs authenticated HTTP source and control commands through the actual D1 controllers", async () => {
  const { settings } = setup();
  settings.ASSISTANT_INSTALLATION_ID = affinity.installationId; settings.ASSISTANT_GENERATION = affinity.generation;
  settings.INSTALLATION_EPOCH = affinity.sourceEpoch; settings.CONNECTION_GENERATION = affinity.sourceGeneration;
  settings.ASSISTANT_OWNER = receiver();
  const principal = { sub: settings.OWNER_SUB, epoch: settings.INSTALLATION_EPOCH };
  const call = async (name: string, arguments_: unknown) => {
    const response = await mcpFetch(request("tools/call", { name, arguments: arguments_ }), settings, principal);
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).not.toBe(true);
    return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
  };
  const create = { kind: "source.create", operationId: "http-note", input: { originKey: "http-note", text: "Original HTTP note", occurredAt: 10 } };
  const first = await call("assistente_fonte", { command: create });
  await call("assistente_fonte", { command: { kind: "source.correct", operationId: "http-correct", id: first.id, expectedRevision: 1, text: "Corrected HTTP note", occurredAt: 20 } });
  expect(await call("assistente_fonte", { command: create })).toEqual(first);
  const current = await call("assistente_consultar", { query: { kind: "source", id: first.id } });
  expect(current).toMatchObject({ state: "available", source: { text: "Corrected HTTP note", fence: { source: { revision: 2 } } } });
  const project = { kind: "project.put", operationId: "http-project", id: "http-project", expectedVersion: 0, name: "HTTP project" };
  expect(await call("assistente_controlar", { command: project })).toMatchObject({ id: "http-project", version: 1, shadow: true });
  expect(await call("assistente_consultar", { query: { kind: "projects" } })).toMatchObject({ items: [{ id: "http-project", name: "HTTP project" }] });
});
it("reports an absent assistant binding as unavailable, without inventing an empty query", async () => {
  const { settings } = setup(); settings.ASSISTANT_OWNER = undefined;
  const response = await mcpFetch(request("tools/call", { name: "assistente_consultar", arguments: { query: { kind: "projects" } } }), settings, owner);
  expect(response.status).toBe(200);
  const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true); expect(body.result.content[0].text).toContain("assistant_unconfigured");
});

it("routes authenticated review commands with host affinity and rejects injected authority before binding",async()=>{
 const {settings,rpc}=setup(),command={kind:"topics.ensure"};rpc.telegramReview.mockResolvedValue({mode:"shadow",topics:[]});
 for(const principal of [undefined,{}, {...owner,sub:"other"}])await expect(mcpFetch(request("tools/call",{name:"assistente_telegram_revisar",arguments:{command}}),settings,principal)).rejects.toThrow();
 expect(rpc.telegramReview).not.toHaveBeenCalled();
 const response=await mcpFetch(request("tools/call",{name:"assistente_telegram_revisar",arguments:{command}}),settings,owner);
 expect(response.status).toBe(200);expect(rpc.telegramReview).toHaveBeenCalledExactlyOnceWith({installationId:"assistant-installation",generation:"assistant-generation",sourceEpoch:owner.epoch,sourceGeneration:"capture-generation"},command);
 await mcpFetch(request("tools/call",{name:"assistente_telegram_revisar",arguments:{command:{...command,chatId:"foreign"}}}),settings,owner);expect(rpc.telegramReview).toHaveBeenCalledTimes(1);
 rpc.telegramReview.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_TOKEN"));const failed=await mcpFetch(request("tools/call",{name:"assistente_telegram_revisar",arguments:{command}}),settings,owner);expect(await failed.text()).not.toContain("SYNTHETIC_PRIVATE_TOKEN");
});

it("registers owner evaluation commands through the authenticated MCP boundary without inferring human action",async()=>{
 const {settings,rpc}=setup(),command={kind:"evaluation.assess",operationId:"owner-rating",exposureId:"a".repeat(64),basis:"owner_report",label:"unknown"};
 rpc.evaluate.mockResolvedValue({id:"receipt",basis:"owner_assessment_at_exposure"});
 const call=(arguments_:unknown,principal:unknown=owner)=>mcpFetch(request("tools/call",{name:"assistente_avaliar",arguments:arguments_}),settings,principal);
 await expect(call({command},{...owner,sub:"foreign"})).rejects.toThrow();expect(rpc.evaluate).not.toHaveBeenCalled();
 expect((await call({command})).status).toBe(200);
 expect(rpc.evaluate).toHaveBeenCalledExactlyOnceWith({installationId:"assistant-installation",generation:"assistant-generation",sourceEpoch:owner.epoch,sourceGeneration:"capture-generation"},command);
 for(const extra of [{basis:"fromMe"},{basis:"telegram_simulation"},{actor:{kind:"owner"}},{namespace:"foreign"}])await call({command:{...command,...extra}});
 expect(rpc.evaluate).toHaveBeenCalledTimes(1);
});
