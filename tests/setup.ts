import { env, applyD1Migrations } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// @ts-expect-error Vite SQL assets. Restore freezes the whole canonical schema;
// legacy fixtures use those same guards, without claiming production activation.
const assistantMigrations = import.meta.glob("../assistant/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
for (const [, sql] of Object.entries(assistantMigrations).sort()) await env.DB.batch(sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|DROP|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
