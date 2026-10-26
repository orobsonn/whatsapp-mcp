import { env, applyD1Migrations } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// @ts-expect-error Vite raw SQL. Shared optional derivation schema is used by inventory guards.
import media from "../assistant/migrations/0020_media_context.sql?raw";
await env.DB.batch(media.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
// @ts-expect-error Vite raw SQL. Withdrawal barriers are part of the source contract.
import sourceSchema from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL.
import retention from "../assistant/migrations/0024_retention.sql?raw";
for (const sql of [sourceSchema, retention]) await env.DB.batch(sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|DROP|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
