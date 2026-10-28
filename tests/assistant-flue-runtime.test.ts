import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(import.meta.dirname, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "assistant-flue-runtime-")));
let fixture: any;
let runtime: Miniflare | undefined;
let externalCalls = 0;
function configAt(directory: string): any {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = configAt(path); if (found) return found; }
    else if (entry.name === "wrangler.json") {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value.durable_objects) return { ...value, artifact: path };
    }
  }
}
beforeAll(() => {
  execFileSync("npm", ["run", "build:assistant"], { cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  buildFixture();
});
afterAll(async () => { await runtime?.dispose(); rmSync(scratch, { recursive: true, force: true }); expect(externalCalls).toBe(0); });
test("official assistant bundle retains isolated SQLite runtime classes", () => {
  const config = configAt(join(root, "dist/assistant"));
  expect(config?.durable_objects?.bindings?.map((binding: any) => binding.class_name)).toEqual(expect.arrayContaining(["FlueOwnerRuntimeAgent", "FlueInterlocutorRuntimeAgent", "FlueOwnerDialogueRuntimeAgent"]));
  expect(config.migrations.flatMap((migration: any) => migration.new_sqlite_classes ?? [])).toEqual(expect.arrayContaining(["FlueOwnerRuntimeAgent", "FlueInterlocutorRuntimeAgent", "FlueOwnerDialogueRuntimeAgent"]));
});

// Only this disposable test application registers a synthetic provider and
// diagnostic routes. The production application has neither capability.
function buildFixture() {
  const app = join(scratch, "app.ts"), config = join(scratch, "vite.config.mts");
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  writeFileSync(join(scratch, "wrangler.jsonc"), readFileSync(join(root, "assistant/wrangler.jsonc")));
  writeFileSync(app, `
import production from ${JSON.stringify(join(root, "assistant/index.ts"))};
import {openRuntime} from ${JSON.stringify(join(root, "assistant/agent-runtime/host.ts"))};
import {setProvider} from ${JSON.stringify(join(root, "node_modules/@flue/runtime/dist/index.mjs"))};
import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(join(root, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js"))};
const faux=fauxProvider({provider:'assistant-host',models:[{id:'shadow',contextWindow:32768,maxTokens:2048}],tokensPerSecond:100000});
const answer=context=>fauxAssistantMessage(JSON.stringify({users:context.messages.filter(m=>m.role==='user').length}));
faux.setResponses(Array.from({length:20},()=>answer));setProvider(faux.provider);
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path!=='/__test/dispatch'&&path!=='/__test/read')return production.fetch(request,env);
 try {const input=await request.json();
  if(Object.keys(input).some(k=>!['profile','jobId','message','receipt'].includes(k)))return Response.json({error:'invalid_input'},{status:400});
  const {instance,seed}=await openRuntime(env,input.profile,input.jobId);
  const result=path.endsWith('/dispatch')?await instance.dispatch({message:input.message,initialData:seed}):await instance.read(input.receipt,{signal:AbortSignal.timeout(15000)});
  return Response.json({id:instance.id,result});
 }catch{return Response.json({error:'runtime_rejected'},{status:400});}
}};`);
  writeFileSync(config, `
import {defineConfig} from 'vite';
import {flue,flueWorkerConfig} from '@flue/vite';
import {cloudflare} from '@cloudflare/vite-plugin';
export default defineConfig({root:${JSON.stringify(scratch)},envDir:false,
 plugins:[flue({target:'cloudflare',app:${JSON.stringify(app)},cloudflare:${JSON.stringify(join(root,"assistant/cloudflare.ts"))},agents:${JSON.stringify(join(root,"assistant/agent-runtime/profiles.ts"))},providers:[],tracing:false}),cloudflare({configPath:${JSON.stringify(join(scratch,"wrangler.jsonc"))},config:flueWorkerConfig(),persistState:false})],
 build:{outDir:${JSON.stringify(join(scratch,"dist"))},emptyOutDir:true}});`);
  execFileSync(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", config], { cwd: root, stdio: "pipe" });
  fixture = configAt(join(scratch, "dist"));
}
function start(config: any, state: string, installationId = "synthetic-installation", generation = "synthetic-generation") {
  const base = resolve(config.artifact, ".."), scripts: string[] = [];
  function visit(directory: string) { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); if (entry.isDirectory()) visit(path); else if (/\.m?js$/.test(path)) scripts.push(path);
  } }
  visit(base);
  const main = resolve(base, config.main);
  return new Miniflare({ ...convertV4MiniflareOptions({ workers: [{ name: "assistant-runtime-test", modulesRoot: base,
    modules: [main, ...scripts.filter(path => path !== main)].map(path => ({ type: "ESModule" as const, path })),
    compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ...Object.fromEntries(config.durable_objects.bindings.map((binding: any) => [binding.name, { className: binding.class_name, useSQLite: true }])), COGNEE_EXPORT_PROBE: { className: "CogneeContainer", useSQLite: true } },
    d1Databases: ["DB"],
    bindings: { INSTALLATION_ID: installationId, OPERATIONAL_GENERATION: generation,
      BRIDGE_SECRET: "synthetic_bridge_secret_0000000000000000", BRIDGE_SOURCE_EPOCH: "synthetic-epoch", BRIDGE_SOURCE_GENERATION: "synthetic-source-generation" },
    outboundService: () => { externalCalls++; throw new Error("external_network_forbidden"); },
  }, { name: "export-probe", modules: true, script: "export default {fetch(request,env){return env.BROKER.fetch(request)}};", serviceBindings: { BROKER: { name: "assistant-runtime-test", entrypoint: "CogneeBroker", props: {} } } }] }), resourcePersistencePath: join(scratch, state) });
}
async function call(path: string, body: any) {
  const response = await runtime!.dispatchFetch(`https://runtime.test${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status >= 500) throw new Error(text);
  return { status: response.status, body: JSON.parse(text) as any };
}
async function restart(config: any, state: string, installation?: string, generation?: string) {
  await runtime?.dispose(); runtime = start(config, state, installation, generation);
}
test("host namespace supports real dispatch/read and retained conversation after process restart", async () => {
  await restart(fixture, "retained");
  const input = { profile: "owner", jobId: "synthetic-job", message: "first synthetic message" };
  const first = await call("/__test/dispatch", input);
  expect(first.status).toBe(200);
  const read = await call("/__test/read", { profile: input.profile, jobId: input.jobId, receipt: first.body.result });
  expect(JSON.parse(read.body.result.text)).toEqual({ users: 1 });
  await runtime!.dispose(); runtime = start(fixture, "retained");
  const replay = await call("/__test/read", { profile: input.profile, jobId: input.jobId, receipt: first.body.result });
  expect(replay.body).toEqual(read.body);
  const second = await call("/__test/dispatch", { ...input, message: "second synthetic message" });
  expect(second.body.id).toBe(first.body.id);
  const continued = await call("/__test/read", { profile: input.profile, jobId: input.jobId, receipt: second.body.result });
  expect(JSON.parse(continued.body.result.text)).toEqual({ users: 2 });
  const interlocutor = await call("/__test/dispatch", { ...input, profile: "interlocutor" });
  expect(interlocutor.body.id).not.toBe(first.body.id);
  const isolated = await call("/__test/read", { profile: "interlocutor", jobId: input.jobId, receipt: interlocutor.body.result });
  expect(JSON.parse(isolated.body.result.text)).toEqual({ users: 1 });
});
test("host installation and generation isolate the same profile/job across runtime restarts", async () => {
  await restart(fixture, "namespace-scopes");
  const input = { profile: "owner", jobId: "synthetic-job", message: "synthetic" };
  const original = await call("/__test/dispatch", input);
  await call("/__test/read", { profile: input.profile, jobId: input.jobId, receipt: original.body.result });
  for (const [installation, generation] of [["other-installation", "synthetic-generation"], ["synthetic-installation", "other-generation"]]) {
    await restart(fixture, "namespace-scopes", installation, generation);
    const receipt = await call("/__test/dispatch", input);
    expect(receipt.status).toBe(200); expect(receipt.body.id).not.toBe(original.body.id);
    const reply = await call("/__test/read", { profile: input.profile, jobId: input.jobId, receipt: receipt.body.result });
    expect(JSON.parse(reply.body.result.text)).toEqual({ users: 1 });
  }
});
test("test application cannot replace the production deployment redirect", () => {
  const directory = join(root, "assistant/.wrangler/deploy");
  const redirect = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
  expect(resolve(directory, redirect.configPath).startsWith(join(root, "dist/assistant/"))).toBe(true);
});
test("unknown profile and absent host namespace cannot allocate an instance", async () => {
  await restart(fixture, "invalid-profile");
  expect((await call("/__test/dispatch", { profile: "privileged-child", jobId: "synthetic-job", message: "synthetic" })).status).toBe(400);
  await runtime!.dispose(); runtime = start(fixture, "invalid-namespace", "", "");
  expect((await call("/__test/dispatch", { profile: "owner", jobId: "synthetic-job", message: "synthetic" })).status).toBe(400);
  for (const binding of fixture.durable_objects.bindings) expect(await runtime!.listDurableObjectIds(binding.name)).toEqual([]);
});
test("production artifact preserves health and denies public agent/history/action routes", async () => {
  await restart(configAt(join(root, "dist/assistant")), "production");
  const health = await runtime!.dispatchFetch("https://runtime.test/health");
  expect(await health.json()).toEqual({ mode: "shadow", capabilities: { whatsappSend: false, whatsappAutonomousSend: false, calendarWrite: false } });
  for (const path of ["/__test/dispatch", "/agents/owner-runtime/job", "/agents/owner-runtime/job/history", "/agents/interlocutor-runtime/job/stream", "/send", "/calendar/write"]) {
    const response = await runtime!.dispatchFetch("https://runtime.test" + path, { method: "POST", body: "{}" });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "shadow_only" });
  }
  const namespace = await runtime!.getDurableObjectNamespace("COGNEE_EXPORT_PROBE");
  expect((await namespace.get(namespace.idFromName("synthetic")).fetch("https://runtime.test/")).status).toBe(403);
  expect((await (await runtime!.getWorker("export-probe")).fetch("https://runtime.test/")).status).toBe(403);
});
test("production artifact delivers authenticated capture metadata to real D1 without inference", async () => {
  await restart(configAt(join(root, "dist/assistant")), "capture");
  const db = await runtime!.getD1Database("DB");
  const sql = readFileSync(join(root, "assistant/migrations/0004_capture_inbox.sql"), "utf8").replace(/^--.*$/gm, "");
  await db.batch(sql.split(";").filter(part => part.trim()).map(part => db.prepare(part)));
  const event = { protocol: 1, installationId: "synthetic-installation", generation: "synthetic-generation", sourceEpoch: "synthetic-epoch", sourceGeneration: "synthetic-source-generation", sequence: 1, previousSequence: 0,
    chatId: "synthetic-chat", sourceId: "synthetic-message", sourceKind: "message", operation: "upsert", recordedAt: 1 };
  const send = (authorization: string) => runtime!.dispatchFetch("https://runtime.test/internal/capture", { method: "POST", headers: { Authorization: authorization }, body: JSON.stringify(event) });
  expect((await send("Bearer wrong-synthetic-secret")).status).toBe(403);
  expect(await db.prepare("SELECT count(*) AS n FROM assistant_capture_inbox").first("n")).toBe(0);
  const response = await send("Bearer synthetic_bridge_secret_0000000000000000");
  expect(response.status).toBe(200); expect((await response.json() as any).state).toBe("received");
  expect(await db.prepare("SELECT application_state FROM assistant_capture_inbox").first("application_state")).toBe("pending");
});
