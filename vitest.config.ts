import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
const migrations = await readD1Migrations("./migrations");
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-19",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        d1Databases: ["DB", "RECIPIENT_DB"],
        r2Buckets: ["MEDIA", "ARTIFACTS"],
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          RUNTIME_CONFIG: "static",
          DEVELOPMENT: "true",
          PUBLIC_ORIGIN: "http://localhost:8787",
          ACCESS_ISSUER: "",
          ACCESS_AUD: "",
          OWNER_SUB: "",
          INSTALLATION_EPOCH: "unconfigured",
          CONNECTION_GENERATION: "unconfigured",
          CONNECTED_PHONE: "",
          MEDIA_HOSTS: "",
          TRANSCRIPTION_ENABLED: "false",
          MAINTENANCE: "true",
        },
      },
    }),
  ],
  test: { setupFiles: ["./tests/setup.ts"], testTimeout: 30000, fileParallelism: false, exclude: [...configDefaults.exclude, "tests/assistant-native-agent-runtime.test.ts", "tests/oauth-coordinator.test.ts", "tests/assistant-flue-runtime.test.ts", "tests/assistant-episodes.test.ts", "tests/assistant-checkpoint-runtime.test.ts", "tests/assistant-owner-binding-runtime.test.ts", "tests/assistant-scheduled-runtime.test.ts", "tests/assistant-telegram-runtime.test.ts"] },
});
