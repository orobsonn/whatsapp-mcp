import { env, applyD1Migrations } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// @ts-expect-error Vite raw SQL. Shared optional derivation schema is used by inventory guards.
import media from "../assistant/migrations/0020_media_context.sql?raw";
await env.DB.batch(media.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
