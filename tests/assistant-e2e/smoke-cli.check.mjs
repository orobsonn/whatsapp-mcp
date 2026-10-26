import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installationConfigs, INSTALLATION } from "../../assistant/installation.ts";
import { smokePlan, smokePreflight } from "../../scripts/assistant-smoke.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture() {
  const installation = { schema: 1, accountId: INSTALLATION.accountId, installationId: "synthetic-e2e", generation: "g1", databaseId: "11111111-1111-4111-8111-111111111111",
    imageDigest: `registry.cloudflare.com/${INSTALLATION.accountId}/assistant-cognee@sha256:${"a".repeat(64)}`, archiveBaseline: { versionId: "22222222-2222-4222-8222-222222222222", settingsHash: "b".repeat(64) } };
  return { schema: 1, runId: "synthetic-run-1", sourceHead: "c".repeat(40), installation, configHash: digest(installationConfigs(installation, root)),
    versions: { assistant: "33333333-3333-4333-8333-333333333333", archive: "22222222-2222-4222-8222-222222222222", parser: "44444444-4444-4444-8444-444444444444" },
    budget: { committedMicroUsd: 48405, includesUncertain: true, evidenceHash: "d".repeat(64), additionalCeilingMicroUsd: 600000 } };
}
function metadata(input) {
  const config = installationConfigs(input.installation, root), assistant = { bindings: [
    ...Object.entries(config.assistant.vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    ...config.assistant.services.map(({ binding: name, ...other }) => ({ type: "service", name, ...other })),
    ...[...config.assistant.durable_objects.bindings, { name: "FLUE_OWNER_RUNTIME_AGENT", class_name: "FlueOwnerRuntimeAgent" }, { name: "FLUE_INTERLOCUTOR_RUNTIME_AGENT", class_name: "FlueInterlocutorRuntimeAgent" }].map(item => ({ type: "durable_object_namespace", ...item })),
    { type: "d1", name: "DB", id: input.installation.databaseId }, { type: "r2_bucket", name: "ARTIFACTS", bucket_name: INSTALLATION.artifacts },
    ...["OPENAI_API_KEY", "BRIDGE_SECRET", "BRIDGE_SOURCE_EPOCH", "BRIDGE_SOURCE_GENERATION"].map(name => ({ type: "secret_text", name })) ] };
  const deploy = version_id => ({ deployments: [{ versions: [{ version_id, percentage: 100 }] }] });
  return { assistant, responses: [assistant, deploy(input.versions.assistant), { schedules: [{ cron: "* * * * *" }] }, { bindings: config.archiveDelta.additions }, deploy(input.versions.archive), { bindings: [] }, deploy(input.versions.parser), { uuid: input.installation.databaseId, name: INSTALLATION.database }, { name: INSTALLATION.artifacts }] };
}
const reply = result => Response.json({ success: true, result });
test("planner is inert and missing credentials never create network calls or a readiness claim", async () => {
  const input = fixture(), plan = smokePlan(input, input.sourceHead);
  assert.equal(plan.effects, "none"); assert.equal(plan.transport.whatsappSend, false); assert.equal(plan.transport.calendarWrite, false); assert.equal(plan.paidCalls, 0);
  let calls = 0; const result = await smokePreflight(input, { actualHead: input.sourceHead, fetcher: async () => { calls++; throw new Error("forbidden"); } });
  assert.equal(calls, 0); assert.equal(result.readiness, "pending"); assert.equal(result.observations.length, 9); assert.ok(result.observations.every(item => !item.attempted));
});
test("manifest cannot change source/config, add credentials/URLs or authorize a fresh budget beyond global total", () => {
  const input = fixture();
  for (const changed of [{ sourceHead: "e".repeat(40) }, { configHash: "f".repeat(64) }, { OPENAI_API_KEY: "private-do-not-print" }, { modelUrl: "https://attacker.invalid" },
    { budget: { ...input.budget, additionalCeilingMicroUsd: 10000000 } }, { installation: { ...input.installation, databaseId: "33766712-30c3-4570-991e-ddf250c52a2e" } }])
    assert.throws(() => smokePlan({ ...input, ...changed }, input.sourceHead));
});
test("preflight uses nine exact account metadata GETs and redacts all response bodies and token", async () => {
  const input = fixture(), { responses } = metadata(input), requests = [];
  const result = await smokePreflight(input, { actualHead: input.sourceHead, token: "synthetic-private-token", fetcher: async (url, init) => {
    requests.push({ url, method: init.method, redirect: init.redirect }); assert.equal(init.headers.Authorization, "Bearer synthetic-private-token");
    return reply({ ...responses[requests.length - 1], arbitraryPrivateBody: "synthetic-private-body" });
  } });
  assert.equal(requests.length, 9); assert.ok(requests.every(item => item.method === "GET" && item.redirect === "error" && item.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${INSTALLATION.accountId}/`)));
  assert.ok(requests.every(item => !item.url.includes("query") && !item.url.includes("elo") && !item.url.includes("lab")));
  assert.equal(result.infrastructure, "metadata_matches_not_functional_proof"); assert.equal(result.readiness, "pending");
  assert.equal(JSON.stringify(result).includes("synthetic-private"), false); assert.equal(JSON.stringify(result).includes("bindings\""), false);
  assert.equal(result.criteria["16.311"], "pending_real_capture_extraction_search_flue_decision_review");
});
test("stale deployment history, unknown binding and response redirects fail closed without follow-up destinations", async () => {
  const input = fixture(), { responses } = metadata(input); let calls = 0;
  responses[0].bindings.push({ type: "secret_text", name: "ZAPI_INSTANCE_TOKEN" });
  responses[1].deployments.unshift({ versions: [{ version_id: "55555555-5555-4555-8555-555555555555", percentage: 100 }] });
  const result = await smokePreflight(input, { actualHead: input.sourceHead, token: "synthetic", fetcher: async () => ++calls === 3 ? new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }) : reply(responses[calls - 1]) });
  assert.equal(calls, 9); assert.equal(result.checks.noUnexpectedBindings, false); assert.equal(result.checks.assistantVersion, false); assert.equal(result.checks.schedulerConfigured, false); assert.equal(result.infrastructure, "pending");
});
test("oversized JSON and API errors expose only unavailable metadata observations", async () => {
  const input = fixture(); let calls = 0;
  const result = await smokePreflight(input, { actualHead: input.sourceHead, token: "synthetic", fetcher: async () => ++calls === 1
    ? new Response("synthetic-private-overlimit", { headers: { "content-length": "262145" } }) : Response.json({ success: false, errors: [{ message: "synthetic-private-error" }] }) });
  assert.ok(result.observations.every(item => item.state === "unavailable")); assert.equal(JSON.stringify(result).includes("synthetic-private"), false);
});
