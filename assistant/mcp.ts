import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { AssistantEnv } from "./env";
import { SourceController } from "./sources";
import { OwnerControl } from "./control";
import { SourceAccess } from "./access";
import { OriginGuard } from "./origin-guard";
import { bridgeHash } from "./ingress";
import { DecisionJournal } from "./decisions";
import { hostConfiguredSearch } from "./configured-search";
import { TelegramLink, type TelegramLinkCommand } from "./telegram-auth";
import { createTelegramReview } from "./telegram";
import { FollowUps } from "./followups";
import { githubQuery, GitHubReader } from "./connectors/github";
import { calendarQuery, CalendarReader } from "./connectors/calendar";
import { calendarOAuthName, oauthAffinity } from "./connectors/calendar-oauth";
import { Evaluation, evaluationQuery } from "./evaluation";
import { assistantHealth } from "./health";
import { configuredRetirementGuard } from "./retention-authority";
import { AssistantExport } from "./retention";

const id = z.string().min(1).max(256);
export const ownerAffinitySchema = z.object({ installationId: id, generation: id, sourceEpoch: id, sourceGeneration: id }).strict();
export type OwnerAffinity = z.infer<typeof ownerAffinitySchema>;
const listKind = z.enum(["sources", "projects", "missions", "policies", "mandates", "follow_ups", "decisions"]);
export const ownerQuerySchema = z.union([
  githubQuery,
  calendarQuery,
  evaluationQuery,
  z.object({ kind: z.literal("assistant.health") }).strict(),
  z.object({ kind: z.literal("assistant.export"), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ kind: z.literal("source"), id }).strict(),
  z.object({ kind: z.literal("follow_up"), id }).strict(),
  z.object({ kind: z.literal("decision"), id: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: listKind, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
]);
export type OwnerQuery = z.input<typeof ownerQuerySchema>;
/** A named service capability. None of these methods is an agent tool. */
export interface OwnerAssistantRPC {
  telegramLink(expected: OwnerAffinity, command: TelegramLinkCommand): Promise<unknown>;
  telegramReview(expected: OwnerAffinity, command: unknown): Promise<unknown>;
  evaluate(expected: OwnerAffinity, command: unknown): Promise<unknown>;
  source(expected: OwnerAffinity, command: unknown): Promise<unknown>;
  control(expected: OwnerAffinity, command: unknown): Promise<unknown>;
  query(expected: OwnerAffinity, input: unknown): Promise<unknown>;
}
export interface OwnerJournalReader {
  list(input: { cursor?: string; limit: number }): Promise<unknown>;
  get(id: string): Promise<unknown>;
}
const ns = "installation_id=? AND generation=?";
const listings = {
  sources: { table: "assistant_sources", key: "id", columns: "id,origin,audience,status,revision,current_version AS version,conversation_id,project_id", extra: "" },
  projects: { table: "assistant_projects", key: "id", columns: "id,name", extra: "" },
  missions: { table: "assistant_missions", key: "id", columns: "id,revision,objective,source_id,source_revision,project_id,state,next_evaluation_at", extra: "" },
  policies: { table: "assistant_conversation_policies", key: "conversation_id", columns: "conversation_id AS id,revision,kind,excluded,group_mode", extra: "" },
  mandates: { table: "assistant_mandates", key: "id", columns: "id,version,conversation_id,project_id,purpose,status,issued_at,expires_at", extra: "AND version=(SELECT MAX(latest.version) FROM assistant_mandates latest WHERE latest.installation_id=t.installation_id AND latest.generation=t.generation AND latest.id=t.id)" },
  follow_ups: { table: "assistant_follow_ups", key: "id", columns: "id,version,conversation_id,project_id,mission_id,purpose,due_at,timezone,precision,state,next_evaluation_at", extra: "AND version=(SELECT MAX(latest.version) FROM assistant_follow_ups latest WHERE latest.installation_id=t.installation_id AND latest.generation=t.generation AND latest.id=t.id)" },
} as const;

/** Owner-only reads of current canonical state. Lists never return source bodies. */
export class OwnerQueries {
  private readonly scope: Readonly<OwnerAffinity>;
  constructor(private readonly db: D1Database, scope: OwnerAffinity, private readonly origin?: OriginGuard,
    private readonly journal?: OwnerJournalReader) { this.scope = Object.freeze({ ...scope }); }
  async execute(input: unknown): Promise<unknown> {
    const query = ownerQuerySchema.parse(input), keys = [this.scope.installationId, this.scope.generation];
    if(query.kind==="follow_up")return new FollowUps(this.db,this.scope,{origin:this.origin}).get(query.id);
    if (query.kind === "github.list" || query.kind === "github.read") return { state: "pending_configuration", dependency: "github_read" };
    if (query.kind === "calendar.availability" || query.kind === "calendar.propose") return { state: "pending_configuration", dependency: "calendar_read" };
    if (query.kind === "evaluation.sample" || query.kind === "evaluation.metrics" || query.kind === "evaluation.exposure" || query.kind === "assistant.health") return { state: "pending_configuration", dependency: "owner_evaluation" };
    if (query.kind === "assistant.export") { const { kind: _, ...input } = query; return new AssistantExport(this.db, this.scope, { kind: "owner" }).page(input); }
    if (query.kind === "source") {
      const access = new SourceAccess(this.db, this.scope), actor = { kind: "owner" } as const;
      const first = await access.read(actor, query.id);
      if (!first) return { state: "unavailable" };
      if (first.fence.source.origin === "whatsapp") {
        const fence = await this.origin?.fence(query.id);
        if (!fence || !await this.origin?.check(fence)) return { state: "unavailable", reason: "origin_unavailable" };
      } else if (first.fence.source.origin !== "owner_note") return { state: "unavailable", reason: "origin_guard_unavailable" };
      const current = await access.read(actor, query.id, first.fence.source.revision);
      if (!current || JSON.stringify(current) !== JSON.stringify(first)) return { state: "unavailable", reason: "source_changed" };
      return { state: "available", source: current, observation: "current_source", execution: "unconfirmed" };
    }
    if (query.kind === "decision") return this.journal ? this.journal.get(query.id) : { state: "pending_dependency", dependency: 45 };
    if (query.kind === "decisions") return this.journal ? this.journal.list({ cursor: query.cursor, limit: query.limit }) : { state: "pending_dependency", dependency: 45 };
    const listing = listings[query.kind], fingerprint = await bridgeHash(["owner-list-v1", this.scope, query.kind]);
    let after = "";
    if (query.cursor !== undefined) {
      try {
        const cursor = z.object({ fingerprint: z.literal(fingerprint), after: id }).strict().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(query.cursor), c => c.charCodeAt(0)))));
        after = cursor.after;
      } catch { throw new Error("owner_query_cursor"); }
    }
    const rows = (await this.db.prepare(`SELECT ${listing.columns} FROM ${listing.table} t WHERE ${ns} ${listing.extra}
      AND ${listing.key}>? ORDER BY ${listing.key} LIMIT ?`).bind(...keys, after, query.limit + 1).all<Record<string, unknown>>()).results;
    const items = rows.slice(0, query.limit), more = rows.length > query.limit;
    return { items, coverage: more ? "page" : "end_of_listing", ...(more ? {
      nextCursor: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ fingerprint, after: items[items.length - 1].id })))),
    } : {}) };
  }
}
/** Only the authenticated MCP Worker receives this named binding. Public fetch
 * and Flue profiles never receive a route or capability to these controls. */
export class OwnerAssistant extends WorkerEntrypoint<AssistantEnv> implements OwnerAssistantRPC {
  #affinity(input: unknown) {
    const expected = ownerAffinitySchema.parse(input), actual = ownerAffinitySchema.parse({
      installationId: this.env.INSTALLATION_ID, generation: this.env.OPERATIONAL_GENERATION,
      sourceEpoch: this.env.BRIDGE_SOURCE_EPOCH, sourceGeneration: this.env.BRIDGE_SOURCE_GENERATION,
    });
    if (!this.env.DB || Object.keys(actual).some(key => actual[key as keyof OwnerAffinity] !== expected[key as keyof OwnerAffinity]))
      throw new Error("owner_binding_affinity");
    return actual;
  }
  async telegramLink(expected: OwnerAffinity, command: TelegramLinkCommand) {
    const scope = this.#affinity(expected);
    return new TelegramLink(this.env.DB!, scope, this.env.TELEGRAM_BOT_INSTANCE!, this.env.TELEGRAM_WEBHOOK_SECRET!).execute(command);
  }
  async telegramReview(expected: OwnerAffinity, command: unknown) {
    const scope = this.#affinity(expected);
    return (await createTelegramReview(this.env, scope)).execute(command);
  }
  async source(expected: OwnerAffinity, input: unknown) {
    const scope = this.#affinity(expected);
    return new SourceController(this.env.DB!, scope, { kind: "owner" }, Date.now, configuredRetirementGuard(this.env)).execute(input);
  }
  async control(expected: OwnerAffinity, input: unknown) {
    const scope = this.#affinity(expected);
    return new OwnerControl(this.env.DB!, scope, { kind: "owner" }).execute(input);
  }
  async evaluate(expected: OwnerAffinity, input: unknown) {
    const scope = this.#affinity(expected), { origin, semantic } = hostConfiguredSearch(this.env, "owner_read");
    return new Evaluation(this.env.DB!, scope, { kind: "owner" }, new DecisionJournal(this.env.DB!, scope, { kind: "owner" }, { origin, semantic }), { origin }).execute(input);
  }
  async query(expected: OwnerAffinity, input: unknown) {
    const scope = this.#affinity(expected);
    const query = ownerQuerySchema.parse(input);
    if (query.kind === "assistant.health") return assistantHealth(this.env, { kind: "owner" });
    if (query.kind === "evaluation.sample" || query.kind === "evaluation.metrics" || query.kind === "evaluation.exposure") {
      const { origin, semantic } = hostConfiguredSearch(this.env, "owner_read"), evaluation = new Evaluation(this.env.DB!, scope, { kind: "owner" },
        new DecisionJournal(this.env.DB!, scope, { kind: "owner" }, { origin, semantic }), { origin });
      if (query.kind === "evaluation.metrics") return evaluation.metrics();
      if (query.kind === "evaluation.exposure") return evaluation.exposure(query.id);
      const { kind: _, ...input } = query; return evaluation.sample(input);
    }
    if (query.kind === "github.list" || query.kind === "github.read") {
      if (!this.env.GITHUB_READ_REPOSITORIES) return { state: "pending_configuration", dependency: "github_read" };
      return new GitHubReader(this.env.DB!, scope, JSON.parse(this.env.GITHUB_READ_REPOSITORIES), this.env.GITHUB_READ_TOKEN).execute({ kind: "owner" }, query);
    }
    if (query.kind === "calendar.availability" || query.kind === "calendar.propose") {
      if (!this.env.CALENDAR_READ_CALENDARS) return { state: "pending_configuration", dependency: "calendar_read" };
      if (!this.env.CALENDAR_OAUTH) return { state: "pending_configuration", dependency: "calendar_read_oauth" };
      const expected = oauthAffinity.safeParse({ installationId: scope.installationId, generation: scope.generation,
        configurationVersion: Number(this.env.CALENDAR_OAUTH_CONFIGURATION_VERSION), secretEpoch: this.env.CALENDAR_OAUTH_SECRET_EPOCH });
      if (!expected.success) return { state: "pending_configuration", dependency: "calendar_read_oauth" };
      const token = () => this.env.CALENDAR_OAUTH!.get(this.env.CALENDAR_OAUTH!.idFromName(calendarOAuthName(expected.data))).token(expected.data);
      return new CalendarReader(this.env.DB!, scope, JSON.parse(this.env.CALENDAR_READ_CALENDARS), token).execute({ kind: "owner" }, query);
    }
    const { origin, semantic } = hostConfiguredSearch(this.env, "owner_read");
    const journal = new DecisionJournal(this.env.DB!, scope, { kind: "owner" }, { origin, semantic });
    return new OwnerQueries(this.env.DB!, scope, origin, journal).execute(input);
  }
}
