import { env } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { installationConfigs, installationPlan, installationManifest, validateAssistantInstallConfig, INSTALLATION } from "../assistant/installation";
import { installationHealth } from "../assistant/installation-health";
import { assistantHealth } from "../assistant/health";
import type { AssistantEnv } from "../assistant/env";
const root = "/synthetic/repository";
const manifest = () => ({ schema: 1, accountId: INSTALLATION.accountId, installationId: "synthetic-install", generation: "synthetic-g1",
  databaseId: "11111111-1111-4111-8111-111111111111", imageDigest: `registry.cloudflare.com/${INSTALLATION.accountId}/assistant-cognee@sha256:${"a".repeat(64)}`,
  archiveBaseline: { versionId: "22222222-2222-4222-8222-222222222222", settingsHash: "b".repeat(64) } });
test("an incomplete plan is inert, names only dedicated resources and never grants a fresh financial cap", () => {
  const { databaseId, imageDigest, archiveBaseline, ...input } = manifest(), plan = installationPlan(input, root);
  expect(plan).toMatchObject({ state: "plan_only", effects: "none", mode: "shadow_staged_paused", missing: ["new_assistant_database_id", "verified_registry_image_digest", "exact_archive_version_and_settings_baseline"],
    budget: { automaticInitialization: false, authorizedTotalMicroUsd: 10000000, ledgerReset: "forbidden" }, rollback: { migrations: "never_automatically_reversed", uncertaintyAndLedger: "preserved" } });
  expect(() => installationConfigs(input, root)).toThrow("installation_manifest_incomplete");
});
test("rendered graph binds only private read capabilities, new state/artifacts, official DO classes and a pinned image", () => {
  const { assistant, pdf, archiveDelta } = installationConfigs(manifest(), root);
  expect(validateAssistantInstallConfig(assistant, root).name).toBe(INSTALLATION.worker);
  expect(assistant.vars).toMatchObject({ ROUTINES_ENABLED: "off", ROUTINES_PAUSED: "true", FLUE_EPISODES_ENABLED: "shadow", SEMANTIC_SEARCH_MODE: "required", MEDIA_CONTEXT_ENABLED: "false", TELEGRAM_SUMMARIES_ENABLED: "false", RETENTION_AUTHORITY_REQUIRED: "true", ARTIFACTS_INSTALLATION_ID: manifest().installationId, ARTIFACTS_GENERATION: manifest().generation });
  expect(assistant.containers[0]).toMatchObject({ scheduling_policy: "durable_object", images: { cognee: { image: manifest().imageDigest } } });
  expect(assistant.containers[0]).not.toHaveProperty("max_instances");
  expect(assistant.services).toContainEqual({ binding: "CAPTURE_READER", service: "whatsapp-mcp", entrypoint: "CaptureReader" });
  expect(assistant.services.every(binding => binding.entrypoint)).toBe(true);
  expect(assistant.durable_objects.bindings.map(binding => binding.class_name)).toEqual(["CogneeContainer", "CalendarOAuth", "RetentionAuthority"]);
  expect(assistant.triggers.crons).toEqual(["* * * * *"]); expect(assistant.workers_dev).toBe(false);
  expect(assistant.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: INSTALLATION.artifacts }]);
  for (const forbidden of ["ZAPI_INSTANCE_TOKEN", "ZAPI_CLIENT_TOKEN", "FISH_API_KEY", "calendar_write", "elo"]) expect(JSON.stringify(assistant)).not.toContain(forbidden);
  expect(pdf).toMatchObject({ name: INSTALLATION.pdf, limits: { cpu_ms: 100 }, workers_dev: false });
  expect(pdf).not.toHaveProperty("services"); expect(pdf).not.toHaveProperty("d1_databases"); expect(pdf).not.toHaveProperty("vars");
  expect(archiveDelta).toMatchObject({ service: "whatsapp-mcp", baseline: manifest().archiveBaseline, preservation: "all_other_bindings_routes_settings_and_secrets" });
  expect(archiveDelta.additions.map(binding => binding.name)).toEqual(["ASSISTANT_INGRESS", "ASSISTANT_OWNER", "ASSISTANT_INSTALLATION_ID", "ASSISTANT_GENERATION"]);
});
test.each(["43e62922-40f7-4fb8-8544-8b7f13c693b0", "33766712-30c3-4570-991e-ddf250c52a2e", "baa2a0c3-0d31-45ee-b559-835aa57a49ae"])("existing archive/laboratory DB %s is never an installation target", databaseId => {
  expect(() => installationManifest.parse({ ...manifest(), databaseId })).toThrow();
});
test("manifest refuses credentials, foreign account, moving image tags and arbitrary worker targets", () => {
  for (const changed of [{ accountId: "0".repeat(32) }, { worker: "elo" }, { OPENAI_API_KEY: "synthetic-private-key" }, { bridgeSecret: "synthetic-private-key" },
    { imageDigest: `registry.cloudflare.com/${INSTALLATION.accountId}/assistant:latest` }, { imageDigest: `registry.cloudflare.com/${"f".repeat(32)}/assistant-cognee@sha256:${"a".repeat(64)}` }, { imageDigest: `registry.cloudflare.com/${INSTALLATION.accountId}/unrelated-assistant@sha256:${"a".repeat(64)}` }, { imageDigest: `docker.io/assistant@sha256:${"a".repeat(64)}` }, { imageDigest: `registry.cloudflare.com/account/elo-assistant@sha256:${"a".repeat(64)}` }])
    expect(() => installationManifest.parse({ ...manifest(), ...changed })).toThrow();
});
test("host config override refuses default archive capabilities, public routes, write credentials and foreign migrations", () => {
  const original = installationConfigs(manifest(), root).assistant;
  for (const mutate of [
    (value: any) => { value.services[0] = { binding: "CAPTURE_READER", service: "whatsapp-mcp" }; },
    (value: any) => { value.services[0].service = "elo"; },
    (value: any) => { value.routes = [{ pattern: "whatsapp.robsonlins.com" }]; },
    (value: any) => { value.vars.ZAPI_INSTANCE_TOKEN = "synthetic-private"; },
    (value: any) => { value.vars.ROUTINES_PAUSED = "false"; },
    (value: any) => { delete value.vars.ARTIFACTS_INSTALLATION_ID; },
    (value: any) => { value.vars.ARTIFACTS_INSTALLATION_ID = "other-installation"; },
    (value: any) => { value.vars.ARTIFACTS_GENERATION = "other-generation"; },
    (value: any) => { value.durable_objects.bindings[0].script_name = "other"; },
    (value: any) => { value.d1_databases[0].migrations_dir = "/other-project/migrations"; },
  ]) { const changed = structuredClone(original); mutate(changed); expect(() => validateAssistantInstallConfig(changed, root)).toThrow(); }
});
test("private installation diagnostics report missing schema/bindings honestly without requiring provider credentials", async () => {
  const result = await installationHealth({});
  expect(result).toMatchObject({ infrastructure: "pending", schema: { state: "unconfigured", coreReady: false }, capture: "unconfigured_or_upgrade_pending", artifacts: "unconfigured", artifactAffinity: "unconfigured", retention: "unconfigured",
    gates: { routineMode: "off", paused: false, pauseConfigured: false, modelKeyConfigured: false }, functionalHomologation: "not_proven_by_health", checkpointHealth: "not_probed_no_container_wake" });
  await expect(assistantHealth({}, { kind: "extractor" })).rejects.toThrow("owner_required");
});
test("binding probes compare affinity privately and never wake a container, refresh OAuth or return secrets", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("external_network_forbidden"); });
  const affinity = vi.fn(async () => ({ observation: "capture_installation_affinity", state: "available", fence: { epoch: "synthetic-private-epoch", generation: "synthetic-private-source-generation" } }));
  const settings = { INSTALLATION_ID: "synthetic", OPERATIONAL_GENERATION: "g", BRIDGE_SECRET: "synthetic-private-bridge-key", BRIDGE_SOURCE_EPOCH: "synthetic-private-epoch", BRIDGE_SOURCE_GENERATION: "synthetic-private-source-generation",
    CAPTURE_READER: { installationAffinity: affinity, readSnapshot: vi.fn() }, ARTIFACTS: env.MEDIA, ARTIFACTS_INSTALLATION_ID: "synthetic", ARTIFACTS_GENERATION: "g",
    RETENTION_AUTHORITY: { idFromName: (name: string) => name, get: () => ({ lookup: async () => ({ state: "sealed", revision: 1, blocked: [] }) }) },
    COGNEE: { get: vi.fn() }, CALENDAR_OAUTH: { get: vi.fn() }, OPENAI_API_KEY: "synthetic-private-provider-key" } as unknown as AssistantEnv;
  try {
    const result = await installationHealth(settings);
    expect(result).toMatchObject({ capture: "affinity_verified", artifacts: "reachable", artifactAffinity: "verified", retention: "sealed", functionalHomologation: "not_proven_by_health" });
    expect(affinity).toHaveBeenCalledWith({ secret: "synthetic-private-bridge-key" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(settings.COGNEE!.get).not.toHaveBeenCalled(); expect(settings.CALENDAR_OAUTH!.get).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(await installationHealth({ ...settings, BRIDGE_SOURCE_GENERATION: "changed" })).toMatchObject({ capture: "affinity_changed" });
  } finally { network.mockRestore(); }
});

test("artifact scope markers gate the own-prefix probe and observed bindings without claiming bucket identity", async () => {
  const head = vi.fn(async () => null);
  const settings = { INSTALLATION_ID: "synthetic/one", OPERATIONAL_GENERATION: "g/one", ARTIFACTS_INSTALLATION_ID: "synthetic/one", ARTIFACTS_GENERATION: "g/one",
    DB: { prepare: () => ({ bind: (...tables: string[]) => ({ all: async () => ({ results: tables.map(name => ({ name })) }), first: async (column: string) => column === "n" ? 5 : null }) }) },
    BRIDGE_SECRET: "synthetic-private-key", BRIDGE_SOURCE_EPOCH: "e", BRIDGE_SOURCE_GENERATION: "g",
    CAPTURE_READER: { installationAffinity: async () => ({ observation: "capture_installation_affinity", state: "available", fence: { epoch: "e", generation: "g" } }) }, ARTIFACTS: { head },
    RETENTION_AUTHORITY: { idFromName: (name: string) => name, get: () => ({ lookup: async () => ({ state: "sealed" }) }) } } as unknown as AssistantEnv;
  expect(await installationHealth(settings)).toMatchObject({ infrastructure: "observed_bindings", artifactAffinity: "verified", artifacts: "reachable", artifactBindingIdentity: "requires_cloud_binding_api_verification" });
  expect(head).toHaveBeenCalledExactlyOnceWith("assistant-artifacts/v1/synthetic%2Fone/g%2Fone/installation-health/no-private-body");
  for (const changed of [{ ARTIFACTS_INSTALLATION_ID: undefined }, { ARTIFACTS_GENERATION: undefined }, { ARTIFACTS_INSTALLATION_ID: "other" }, { ARTIFACTS_GENERATION: "other" }]) {
    head.mockClear();
    expect(await installationHealth({ ...settings, ...changed })).toMatchObject({ infrastructure: "pending", artifactAffinity: Object.values(changed)[0] === undefined ? "unconfigured" : "changed", artifacts: "not_probed_affinity" });
    expect(head).not.toHaveBeenCalled();
  }
  head.mockRejectedValueOnce(new Error("bucket_unavailable"));
  expect(await installationHealth(settings)).toMatchObject({ infrastructure: "pending", artifactAffinity: "verified", artifacts: "unavailable" });
});
