import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
const migrations = await readD1Migrations("./migrations");
export default defineConfig({
  plugins: [cloudflareTest({ main: "./src/index.ts", miniflare: {
    compatibilityDate: "2026-10-19", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    d1Databases: ["DB"], kvNamespaces: ["OAUTH_KV"], r2Buckets: ["MEDIA"],
    durableObjects: { OAUTH_COORDINATOR: { className: "OAuthCoordinator", useSQLite: true } },
    bindings: { TEST_MIGRATIONS: migrations, DEVELOPMENT: "true", RUNTIME_CONFIG: "static",
      PUBLIC_ORIGIN: "http://localhost:8787", ACCESS_ISSUER: "https://owner.cloudflareaccess.com",
      ACCESS_AUD: "test", OWNER_SUB: "owner", INSTALLATION_EPOCH: "epoch", MAINTENANCE: "false",
      ENCRYPTION_KEY: btoa("k".repeat(32)) },
  } })],
  test: { include: ["tests/oauth-coordinator.test.ts"], setupFiles: ["./tests/setup.ts"], fileParallelism: false, testTimeout: 30000 },
});
