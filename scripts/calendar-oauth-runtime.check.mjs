import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("production OAuth DO enforces its nominal identity, persists encrypted cache across cold restart, and preserves attempting uncertainty", { timeout: 60000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "assistant-oauth-native-")); let worker, calls = 0;
  const affinity = { installationId: "synthetic-native", generation: "g1", configurationVersion: 1, secretEpoch: "epoch-one" };
  const source = `
import {CalendarOAuth,calendarOAuthName} from ${JSON.stringify(join(root, "assistant/connectors/calendar-oauth.ts"))};
const affinity=${JSON.stringify(affinity)};
export class Probe extends CalendarOAuth {
 async inspect(){return await this.ctx.storage.get('credentials')??null}
 async interrupt(){const row=await this.ctx.storage.get('credentials');await this.ctx.storage.put('credentials',{...row,phase:'attempting'});return{ok:true}}
}
export default{async fetch(request,env){const input=await request.json();const stub=env.CALENDAR_OAUTH.get(env.CALENDAR_OAUTH.idFromName(input.wrong?'wrong-instance':calendarOAuthName(affinity)));
try{if(input.op==='inspect')return Response.json(await stub.inspect());if(input.op==='interrupt')return Response.json(await stub.interrupt());if(input.op==='public')return stub.fetch('https://synthetic.invalid/');return Response.json(await stub.token({...affinity,...input.affinity}))}catch{return Response.json({state:'denied'},{status:403})}}};`;
  const app = join(scratch, "app.ts"), bundle = join(scratch, "app.mjs");
  await writeFile(app, source);
  execFileSync(join(root, "node_modules/esbuild/bin/esbuild"), [app, "--bundle", "--format=esm", "--external:cloudflare:workers", "--external:node:async_hooks", "--outfile=" + bundle], { cwd: root, stdio: "pipe" });
  const script = await readFile(bundle, "utf8");
  const start = (credentialGeneration = affinity.generation) => new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-10-25", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CALENDAR_OAUTH: { className: "Probe", useSQLite: true } }, bindings: { INSTALLATION_ID: affinity.installationId, OPERATIONAL_GENERATION: affinity.generation,
      CALENDAR_OAUTH_CONFIGURATION_VERSION: "1", CALENDAR_OAUTH_SECRET_EPOCH: affinity.secretEpoch, CALENDAR_OAUTH_CREDENTIAL_GENERATION: credentialGeneration,
      CALENDAR_OAUTH_CLIENT_ID: "synthetic-client", CALENDAR_OAUTH_CLIENT_SECRET: "synthetic-client-secret", CALENDAR_OAUTH_REFRESH_TOKEN: "synthetic-refresh-secret", CALENDAR_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
    outboundService: async request => { calls++; assert.equal(request.url, "https://oauth2.googleapis.com/token"); assert.equal(request.method, "POST");
      return Response.json({ access_token: "synthetic-access-secret", refresh_token: "synthetic-rotated-secret", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events.readonly" }); },
  }), resourcePersistencePath: join(scratch, "state") });
  const call = async input => { const response = await worker.dispatchFetch("https://synthetic.invalid/", { method: "POST", body: JSON.stringify(input) }); return { status: response.status, value: await response.json() }; };
  try {
    worker = start("old-generation");
    assert.deepEqual((await call({})).value, { state: "pending_configuration" }); assert.equal(calls, 0);
    assert.equal((await call({ op: "inspect" })).value, null);
    await worker.dispose(); worker = start();
    assert.equal((await call({ wrong: true })).status, 403); assert.equal(calls, 0);
    assert.equal((await call({ affinity: { generation: "wrong" } })).status, 403); assert.equal(calls, 0);
    const results = await Promise.all([call({}), call({})]); assert.ok(results.every(result => result.value.state === "ready")); assert.equal(calls, 1);
    const encrypted = (await call({ op: "inspect" })).value; assert.equal(encrypted.phase, "ready");
    for (const secret of ["synthetic-access-secret", "synthetic-refresh-secret", "synthetic-rotated-secret", "synthetic-client-secret"]) assert.equal(JSON.stringify(encrypted).includes(secret), false);
    await worker.dispose(); worker = start();
    assert.equal((await call({})).value.state, "ready"); assert.equal(calls, 1);
    const publicResponse = await worker.dispatchFetch("https://synthetic.invalid/", { method: "POST", body: JSON.stringify({ op: "public" }) }); assert.equal(publicResponse.status, 403);
    await call({ op: "interrupt" }); await worker.dispose(); worker = start();
    assert.deepEqual((await call({})).value, { state: "uncertain" }); assert.equal(calls, 1);
  } finally { await worker?.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
