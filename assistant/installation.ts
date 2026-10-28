import { z } from "zod";

export const INSTALLATION = Object.freeze({ accountId: "ab9f6d8988145943bf8bbab313e45e6e", worker: "personal-assistant-shadow", database: "personal-assistant-shadow-state",
  artifacts: "personal-assistant-shadow-artifacts", pdf: "personal-assistant-pdf-parser", archive: "whatsapp-mcp", archiveOrigin: "https://whatsapp.robsonlins.com" });
const knownDatabases = new Set(["43e62922-40f7-4fb8-8544-8b7f13c693b0", "33766712-30c3-4570-991e-ddf250c52a2e", "baa2a0c3-0d31-45ee-b559-835aa57a49ae"]);
const id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/), database = z.uuid().refine(value => !knownDatabases.has(value));
const image = z.string().regex(new RegExp(`^registry\\.cloudflare\\.com/${INSTALLATION.accountId}/assistant(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[a-f0-9]{64}$`));
export const installationManifest = z.object({ schema: z.literal(1), installationId: id, generation: id, accountId: z.literal(INSTALLATION.accountId),
  databaseId: database.optional(), imageDigest: image.optional(), archiveBaseline: z.object({ versionId: z.uuid(), settingsHash: hash }).strict().optional() }).strict();
export type InstallationManifest = z.infer<typeof installationManifest>;
const ownBindings = [
  { name: "COGNEE", class_name: "CogneeContainer" }, { name: "CALENDAR_OAUTH", class_name: "CalendarOAuth" },
  { name: "RETENTION_AUTHORITY", class_name: "RetentionAuthority" },
] as const;
const services = [
  { binding: "CAPTURE_READER", service: INSTALLATION.archive, entrypoint: "CaptureReader" },
  { binding: "CAPTURE_MEDIA_READER", service: INSTALLATION.archive, entrypoint: "CaptureMediaReader" },
  { binding: "MEDIA_PDF_PARSER", service: INSTALLATION.pdf, entrypoint: "MediaPdfParser" },
] as const;
export const INSTALLATION_SECRET_NAMES = Object.freeze({
  assistant: ["BRIDGE_SECRET", "BRIDGE_SOURCE_EPOCH", "BRIDGE_SOURCE_GENERATION", "OPENAI_API_KEY", "RETENTION_BOOTSTRAP_SEAL"],
  archive: ["ASSISTANT_READER_SECRET", "ASSISTANT_BRIDGE_SECRET"],
  optional: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_INSTANCE", "GITHUB_READ_TOKEN", "GITHUB_READ_REPOSITORIES", "CALENDAR_READ_CALENDARS",
    "CALENDAR_OAUTH_CLIENT_ID", "CALENDAR_OAUTH_CLIENT_SECRET", "CALENDAR_OAUTH_REFRESH_TOKEN", "CALENDAR_OAUTH_ENCRYPTION_KEY", "CALENDAR_OAUTH_CONFIGURATION_VERSION", "CALENDAR_OAUTH_SECRET_EPOCH", "CALENDAR_OAUTH_CREDENTIAL_GENERATION"],
});
export function installationConfigs(input: unknown, repositoryRoot: string) {
  const manifest = installationManifest.parse(input);
  if (!manifest.databaseId || !manifest.imageDigest || !manifest.archiveBaseline) throw new Error("installation_manifest_incomplete");
  const root = repositoryRoot.replace(/\/$/, "");
  const assistant = { $schema: `${root}/node_modules/wrangler/config-schema.json`, name: INSTALLATION.worker, account_id: INSTALLATION.accountId,
    compatibility_date: "2026-10-25", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false, observability: { enabled: false },
    migrations: [{ tag: "flue-runtime-v1", new_sqlite_classes: ["FlueOwnerRuntimeAgent", "FlueInterlocutorRuntimeAgent"] },
      { tag: "assistant-shadow-host-v2", new_sqlite_classes: ownBindings.map(binding => binding.class_name) },
      { tag: "assistant-owner-dialogue-v3", new_sqlite_classes: ["FlueOwnerDialogueRuntimeAgent"] }],
    durable_objects: { bindings: ownBindings.map(binding => ({ ...binding })) },
    containers: [{ name: `${INSTALLATION.worker}-cognee`, class_name: "CogneeContainer", scheduling_policy: "durable_object", images: { cognee: { image: manifest.imageDigest } }, observability: { enabled: false, logs: { enabled: false } } }],
    d1_databases: [{ binding: "DB", database_name: INSTALLATION.database, database_id: manifest.databaseId, migrations_dir: `${root}/assistant/migrations` }],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: INSTALLATION.artifacts }], services: services.map(binding => ({ ...binding })), triggers: { crons: ["* * * * *"] },
    vars: { INSTALLATION_ID: manifest.installationId, OPERATIONAL_GENERATION: manifest.generation, ARTIFACTS_INSTALLATION_ID: manifest.installationId, ARTIFACTS_GENERATION: manifest.generation, FLUE_EPISODES_ENABLED: "shadow", SEMANTIC_SEARCH_MODE: "required",
      ROUTINES_ENABLED: "off", ROUTINES_PAUSED: "true", TELEGRAM_SUMMARIES_ENABLED: "false", MEDIA_CONTEXT_ENABLED: "false", RETENTION_AUTHORITY_REQUIRED: "true" } };
  const pdf = { $schema: `${root}/node_modules/wrangler/config-schema.json`, name: INSTALLATION.pdf, account_id: INSTALLATION.accountId, main: `${root}/assistant/pdf-parser/index.ts`,
    compatibility_date: "2026-10-26", workers_dev: false, preview_urls: false, limits: { cpu_ms: 100 }, observability: { enabled: false } };
  const archiveDelta = { schema: 1 as const, service: INSTALLATION.archive, origin: INSTALLATION.archiveOrigin, baseline: manifest.archiveBaseline,
    additions: [{ name: "ASSISTANT_INGRESS", type: "service", service: INSTALLATION.worker },
      { name: "ASSISTANT_OWNER", type: "service", service: INSTALLATION.worker, entrypoint: "OwnerAssistant" },
      { name: "ASSISTANT_INSTALLATION_ID", type: "plain_text", text: manifest.installationId }, { name: "ASSISTANT_GENERATION", type: "plain_text", text: manifest.generation }],
    secretNames: [...INSTALLATION_SECRET_NAMES.archive], preservation: "all_other_bindings_routes_settings_and_secrets", application: "coordinator_only_after_exact_baseline_recheck", baselineMeaning: "after_prerequisite_code_and_secret_updates" };
  return { assistant, pdf, archiveDelta };
}

/** Host build override only: generated input cannot redirect deployment/capabilities. */
export function validateAssistantInstallConfig(input: unknown, repositoryRoot: string) {
  const config = z.object({ name: z.literal(INSTALLATION.worker), account_id: z.literal(INSTALLATION.accountId), workers_dev: z.literal(false), preview_urls: z.literal(false),
    routes: z.array(z.never()).optional(), d1_databases: z.tuple([z.object({ binding: z.literal("DB"), database_name: z.literal(INSTALLATION.database), database_id: database,
      migrations_dir: z.string().min(1) }).strict()]), r2_buckets: z.tuple([z.object({ binding: z.literal("ARTIFACTS"), bucket_name: z.literal(INSTALLATION.artifacts) }).strict()]),
    services: z.array(z.object({ binding: z.string(), service: z.string(), entrypoint: z.string() }).strict()).length(3),
    durable_objects: z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() }).strict()).length(3) }).strict(),
    containers: z.tuple([z.object({ name: z.literal(`${INSTALLATION.worker}-cognee`), class_name: z.literal("CogneeContainer"), scheduling_policy: z.literal("durable_object"),
      images: z.object({ cognee: z.object({ image }).strict() }).strict(), observability: z.object({ enabled: z.literal(false), logs: z.object({ enabled: z.literal(false) }).strict() }).strict() }).strict()]),
    vars: z.object({ INSTALLATION_ID: id, OPERATIONAL_GENERATION: id, ARTIFACTS_INSTALLATION_ID: id, ARTIFACTS_GENERATION: id, FLUE_EPISODES_ENABLED: z.literal("shadow"), SEMANTIC_SEARCH_MODE: z.literal("required"),
      ROUTINES_ENABLED: z.literal("off"), ROUTINES_PAUSED: z.literal("true"), TELEGRAM_SUMMARIES_ENABLED: z.literal("false"), MEDIA_CONTEXT_ENABLED: z.literal("false"), RETENTION_AUTHORITY_REQUIRED: z.literal("true") }).strict(),
    $schema: z.string(), compatibility_date: z.literal("2026-10-25"), compatibility_flags: z.tuple([z.literal("nodejs_compat")]),
    observability: z.object({ enabled: z.literal(false) }).strict(), triggers: z.object({ crons: z.tuple([z.literal("* * * * *")]) }).strict(),
    migrations: z.array(z.object({ tag: z.string(), new_sqlite_classes: z.array(z.string()) }).strict()).length(3),
  }).strict().parse(input);
  if (JSON.stringify(config.services) !== JSON.stringify(services) || JSON.stringify(config.durable_objects.bindings) !== JSON.stringify(ownBindings) ||
    JSON.stringify(config.migrations) !== JSON.stringify([{ tag: "flue-runtime-v1", new_sqlite_classes: ["FlueOwnerRuntimeAgent", "FlueInterlocutorRuntimeAgent"] },
      { tag: "assistant-shadow-host-v2", new_sqlite_classes: ownBindings.map(binding => binding.class_name) },
      { tag: "assistant-owner-dialogue-v3", new_sqlite_classes: ["FlueOwnerDialogueRuntimeAgent"] }])) throw new Error("installation_capability_config");
  if (config.vars.ARTIFACTS_INSTALLATION_ID !== config.vars.INSTALLATION_ID || config.vars.ARTIFACTS_GENERATION !== config.vars.OPERATIONAL_GENERATION) throw new Error("installation_artifact_affinity");
  const root = repositoryRoot.replace(/\/$/, "");
  if (config.d1_databases[0].migrations_dir !== `${root}/assistant/migrations` || config.$schema !== `${root}/node_modules/wrangler/config-schema.json`) throw new Error("installation_config_path");
  return config;
}

export function installationPlan(input: unknown, repositoryRoot: string) {
  const manifest = installationManifest.parse(input), root = repositoryRoot.replace(/\/$/, ""), missing = [
    ...(!manifest.databaseId ? ["new_assistant_database_id"] : []), ...(!manifest.imageDigest ? ["verified_registry_image_digest"] : []), ...(!manifest.archiveBaseline ? ["exact_archive_version_and_settings_baseline"] : [])];
  return { schema: 1, state: "plan_only", effects: "none", resources: { worker: INSTALLATION.worker, database: INSTALLATION.database, artifacts: INSTALLATION.artifacts, pdf: INSTALLATION.pdf },
    mode: "shadow_staged_paused", missing, imageProof: "digest_requires_build_fingerprint_and_cloud_inspect", secrets: INSTALLATION_SECRET_NAMES,
    budget: { automaticInitialization: false, authorizedTotalMicroUsd: 10000000, remaining: "subtract_live_all_generations_periods_and_prior_installations_including_uncertain_reserves", ledgerReset: "forbidden" },
    steps: [
      { id: "inventory", action: "verify_named_resources_and_archive_baseline_without_secret_values" },
      { id: "archive_schema", action: "inspect_archive_migration_metadata_and_exported_read_capabilities_before_separate_reviewed_additive_upgrade", argv: ["wrangler", "d1", "migrations", "list", "DB", "--remote", "--config", `${root}/wrangler.jsonc`] },
      { id: "provision", action: "create_only_new_assistant_database_and_private_artifacts_bucket", argv: ["wrangler", "d1", "create", INSTALLATION.database, "--json"], then: ["wrangler", "r2", "bucket", "create", INSTALLATION.artifacts] },
      { id: "render", action: "render_private_configs_from_completed_manifest" },
      { id: "migrate", action: "apply_additive_assistant_migrations_only", argv: ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "<private-assistant-config>"] },
      { id: "parser", action: "deploy_isolated_parser_zero_bindings_secrets", argv: ["wrangler", "deploy", "--config", "<private-pdf-config>"] },
      { id: "build", action: "official_flue_build_with_validated_private_config_override", envNames: ["ASSISTANT_INSTALL_CONFIG"], argv: ["npm", "run", "build:assistant"] },
      { id: "deploy_staged", action: "deploy_built_output_config_not_the_unbundled_entry", argv: ["wrangler", "deploy", "--config", `${root}/dist/assistant/personal_assistant_shadow/wrangler.json`] },
      { id: "secrets", action: "provision_fresh_shared_bridge_key_selectively_and_other_private_host_secrets_without_stdout" },
      { id: "archive", action: "review_exact_assistant_only_archive_delta_preserving_every_other_resource_and_secret" },
      { id: "affinity", action: "private_named_capture_reader_handshake_save_0600_and_pin_affinity_never_autorotate" },
      { id: "retention", action: "seal_external_retention_authority_from_verified_canonical_inventory_never_assume_empty" },
      { id: "verify", action: "authenticated_health_bindings_schema_and_real_cron_smoke_zero_whatsapp_calendar_write" },
      { id: "activate_shadow", action: "separate_reviewed_flag_change_only_after_integrated_gates_budget_and_checkpoint_proofs" },
    ], rollback: { workerOnly: true, migrations: "never_automatically_reversed", generation: "never_reset_as_retry", uncertaintyAndLedger: "preserved" } };
}
