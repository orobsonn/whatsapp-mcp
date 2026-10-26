import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { INSTALLATION, INSTALLATION_SECRET_NAMES, installationManifest, installationConfigs, installationPlan } from "../assistant/installation.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const smokeManifest = z.object({ schema: z.literal(1), runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), sourceHead: z.string().regex(/^[a-f0-9]{40}$/),
  installation: installationManifest, phase: z.enum(["staged", "shadow_fixture"]).default("staged"), configHash: sha,
  versions: z.object({ assistant: z.uuid(), archive: z.uuid(), parser: z.uuid() }).strict(),
  budget: z.object({ committedMicroUsd: z.number().int().nonnegative().max(10000000), includesUncertain: z.literal(true), evidenceHash: sha,
    additionalCeilingMicroUsd: z.number().int().nonnegative().max(10000000) }).strict(),
}).strict().refine(value => value.budget.committedMicroUsd + value.budget.additionalCeilingMicroUsd <= 10000000, "global_budget_ceiling");
const criteria = Object.freeze({ "16.311": "pending_real_capture_extraction_search_flue_decision_review", "16.312": "pending_real_duplicate_crash_correction_revocation_budget",
  "16.313": "pending_runtime_effect_proof", "16.314": "pending_channel_configuration_and_client_homologation", "16.315": "pending_final_adversarial_review" });
function parsed(input, actualHead) {
  const manifest = smokeManifest.parse(input);
  if (actualHead !== manifest.sourceHead) throw new Error("smoke_source_head_changed");
  const config = installationConfigs(manifest.installation, root);
  if (hash(config) !== manifest.configHash) throw new Error("smoke_installation_config_changed");
  return { manifest, config };
}
export function smokePlan(input, actualHead) {
  const { manifest } = parsed(input, actualHead);
  return { schema: 1, state: "plan_only", effects: "none", runId: manifest.runId, sourceHead: manifest.sourceHead, sourceHeadProvenance: "local_checkout_only", artifactMatch: "unproven_requires_live_bundle_comparison", configHash: manifest.configHash,
    namespaceHash: hash([manifest.installation.installationId, manifest.installation.generation]), phase: manifest.phase,
    installation: installationPlan(manifest.installation, root), criteria, paidCalls: 0,
    budget: { state: "provided_snapshot_requires_live_recheck", authorizedTotalMicroUsd: 10000000, ...manifest.budget },
    channels: { google: "requires_own_readonly_consent", mcp: "requires_authenticated_client_homologation", telegram: "requires_own_link_and_consent" },
    transport: { cloudMethods: ["GET"], redirects: "error", whatsappSend: false, calendarWrite: false, modelCalls: false, proofScope: "this_cli_only" } };
}
async function boundedJson(response) {
  if (Number(response.headers.get("content-length")) > 262144 || !response.body) throw new Error("smoke_response_limit");
  const reader = response.body.getReader(), parts = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 262144) throw new Error("smoke_response_limit"); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const deploymentMatches = (value, expected) => Array.isArray(value?.deployments) && value.deployments[0]?.versions?.length === 1 && value.deployments[0].versions[0]?.version_id === expected && value.deployments[0].versions[0]?.percentage === 100;
function graphChecks(assistant, archive, parser, config, manifest) {
  const bindings = Array.isArray(assistant?.bindings) ? assistant.bindings : [], archiveBindings = Array.isArray(archive?.bindings) ? archive.bindings : [];
  const binding = name => bindings.find(item => item?.name === name), archiveBinding = name => archiveBindings.find(item => item?.name === name);
  const expectedVars = { ...config.assistant.vars, ...(manifest.phase === "shadow_fixture" ? { ROUTINES_ENABLED: "shadow", ROUTINES_PAUSED: "false" } : {}) };
  const known = new Map([...Object.keys(expectedVars).map(name => [name, "plain_text"]), ...config.assistant.services.map(item => [item.binding, "service"]),
    ...[...config.assistant.durable_objects.bindings.map(item => item.name), "FLUE_OWNER_RUNTIME_AGENT", "FLUE_INTERLOCUTOR_RUNTIME_AGENT"].map(name => [name, "durable_object_namespace"]),
    ["DB", "d1"], ["ARTIFACTS", "r2_bucket"], ...[...INSTALLATION_SECRET_NAMES.assistant, ...INSTALLATION_SECRET_NAMES.optional].map(name => [name, "secret_text"])]);
  return { ownDatabase: binding("DB")?.type === "d1" && binding("DB")?.id === manifest.installation.databaseId,
    ownArtifacts: binding("ARTIFACTS")?.type === "r2_bucket" && binding("ARTIFACTS")?.bucket_name === INSTALLATION.artifacts,
    namedReaders: config.assistant.services.every(item => { const actual = binding(item.binding); return actual?.type === "service" && actual.service === item.service && actual.entrypoint === item.entrypoint; }),
    durableClassShape: [...config.assistant.durable_objects.bindings, { name: "FLUE_OWNER_RUNTIME_AGENT", class_name: "FlueOwnerRuntimeAgent" }, { name: "FLUE_INTERLOCUTOR_RUNTIME_AGENT", class_name: "FlueInterlocutorRuntimeAgent" }]
      .every(item => { const actual = binding(item.name); return actual?.type === "durable_object_namespace" && actual.class_name === item.class_name && (!actual.script_name || actual.script_name === INSTALLATION.worker); }),
    expectedGates: Object.entries(expectedVars).every(([name, value]) => binding(name)?.type === "plain_text" && binding(name)?.text === value),
    noUnexpectedBindings: bindings.length > 0 && new Set(bindings.map(item => item?.name)).size === bindings.length && bindings.every(item => item && known.get(item.name) === item.type),
    archiveDelta: config.archiveDelta.additions.every(item => { const actual = archiveBinding(item.name); return actual?.type === item.type && (item.type === "service" ? actual.service === item.service && actual.entrypoint === item.entrypoint : actual.text === item.text); }),
    parserIsolated: Array.isArray(parser?.bindings) && parser.bindings.length === 0,
    providerKeyNamePresent: binding("OPENAI_API_KEY")?.type === "secret_text",
    bridgeSecretNamesPresent: ["BRIDGE_SECRET", "BRIDGE_SOURCE_EPOCH", "BRIDGE_SOURCE_GENERATION"].every(name => binding(name)?.type === "secret_text"),
  };
}
/** Fixed Cloudflare metadata GETs only. Does not invoke any service/DO/model. */
export async function smokePreflight(input, { actualHead, token, fetcher = globalThis.fetch } = {}) {
  const { manifest, config } = parsed(input, actualHead), plan = smokePlan(input, actualHead), observations = [];
  const paths = { assistantSettings: `/workers/scripts/${INSTALLATION.worker}/settings`, assistantDeployments: `/workers/scripts/${INSTALLATION.worker}/deployments`,
    assistantSchedules: `/workers/scripts/${INSTALLATION.worker}/schedules`, archiveSettings: `/workers/scripts/${INSTALLATION.archive}/settings`, archiveDeployments: `/workers/scripts/${INSTALLATION.archive}/deployments`,
    parserSettings: `/workers/scripts/${INSTALLATION.pdf}/settings`, parserDeployments: `/workers/scripts/${INSTALLATION.pdf}/deployments`,
    database: `/d1/database/${manifest.installation.databaseId}`, artifacts: `/r2/buckets/${INSTALLATION.artifacts}` };
  const values = {};
  for (const [resource, path] of Object.entries(paths)) {
    if (typeof token !== "string" || !token.trim()) { observations.push({ resource, method: "GET", state: "credential_unavailable", attempted: false }); continue; }
    let status = null;
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${INSTALLATION.accountId}${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
      status = response.status; if (!response.ok) throw new Error("smoke_http");
      const envelope = await boundedJson(response); if (envelope?.success !== true || envelope.result === undefined || envelope.result === null) throw new Error("smoke_api");
      values[resource] = envelope.result; observations.push({ resource, method: "GET", state: "observed", attempted: true, status, responseHash: hash(envelope.result) });
    } catch { observations.push({ resource, method: "GET", state: status === 404 ? "absent" : "unavailable", attempted: true, status }); }
  }
  const checks = graphChecks(values.assistantSettings, values.archiveSettings, values.parserSettings, config, manifest);
  Object.assign(checks, { assistantVersion: deploymentMatches(values.assistantDeployments, manifest.versions.assistant), archiveVersion: deploymentMatches(values.archiveDeployments, manifest.versions.archive),
    parserVersion: deploymentMatches(values.parserDeployments, manifest.versions.parser), schedulerConfigured: Array.isArray(values.assistantSchedules?.schedules) && values.assistantSchedules.schedules.some(item => item?.cron === "* * * * *"),
    databaseOwnership: values.database?.uuid === manifest.installation.databaseId && values.database?.name === INSTALLATION.database, artifactsOwnership: values.artifacts?.name === INSTALLATION.artifacts });
  return { ...plan, state: "preflight_only", effects: "cloud_metadata_reads_only", infrastructure: Object.values(checks).every(Boolean) ? "metadata_matches_not_functional_proof" : "pending",
    checks, observations, proofGaps: ["durable_namespace_ids_not_pinned_or_verified", "metadata_reads_not_an_atomic_snapshot", "binding_rpc_not_invoked", "database_rows_and_schema_not_probed", "image_digest_and_build_fingerprint_not_verified", "cron_execution_not_observed", "ledger_snapshot_not_live_verified", "functional_chain_not_run"], readiness: "pending" };
}
export async function main(args = process.argv.slice(2)) {
  const [command, name, path, ...extra] = args;
  if (command === "--help" || !command) { console.log("Shadow pilot evidence planner. plan/preflight --manifest FILE only. Preflight performs fixed Cloudflare metadata GETs, with CLOUDFLARE_API_TOKEN from process environment. No seeds, writes, model calls, sends or provider proxies. Outputs redacted JSON; no readiness claim."); return; }
  if (!["plan", "preflight"].includes(command) || name !== "--manifest" || !path || extra.length) throw new Error("smoke_arguments");
  const body = await readFile(path, "utf8"); if (Buffer.byteLength(body) > 65536) throw new Error("smoke_manifest_limit");
  const input = JSON.parse(body), actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  console.log(JSON.stringify(command === "plan" ? smokePlan(input, actualHead) : await smokePreflight(input, { actualHead, token: process.env.CLOUDFLARE_API_TOKEN }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Shadow evidence rejected. Check reviewed manifest, HEAD, private configuration hashes and own resource metadata. No cloud write or provider call was executed."); process.exitCode = 1; });
