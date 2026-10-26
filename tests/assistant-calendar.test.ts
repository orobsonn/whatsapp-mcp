import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { SourceController } from "../assistant/sources";
import { CalendarReader } from "../assistant/connectors/calendar";
import { OwnerAssistant } from "../assistant/mcp";
// @ts-expect-error Vite SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite SQL.
import policy from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite SQL.
import admissions from "../assistant/migrations/0007_source_controls.sql?raw";

let scope: { installationId: string; generation: string }, controller: SourceController, authorization: { sourceId: string; revision: number };
const owner = { kind: "owner" } as const, query = { kind: "calendar.availability", start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T12:00:00-03:00", timeZone: "America/Sao_Paulo" };
const config = () => [{ id: "work", calendarId: "synthetic-private-calendar@example.invalid", projectId: "project", version: 1, authorization }];
const busy = (start = "2026-10-26T10:00:00-03:00", end = "2026-10-26T11:00:00-03:00") => ({ status: "confirmed", start: { dateTime: start }, end: { dateTime: end }, summary: "synthetic-private-title", description: "synthetic-private-notes", attendees: [{ email: "private-person@example.invalid" }] });
beforeEach(async () => {
  for (const schema of [sources, policy, admissions]) await env.DB.batch(schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
  scope = { installationId: crypto.randomUUID(), generation: "calendar-g" };
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "project", "Synthetic project").run();
  controller = new SourceController(env.DB, scope, owner, () => 100);
  const source = await controller.create({ originKey: "calendar-permission", text: "Host config enables selected calendars", occurredAt: 1, projectId: "project" });
  authorization = { sourceId: source.id, revision: source.revision };
});
test("explicit interval and IANA time zone reach GET events only; private event details never return", async () => {
  const requests: Request[] = [], reader = new CalendarReader(env.DB, scope, config(), "synthetic-calendar-secret", async request => { requests.push(request); return Response.json({ items: [busy()] }); }, () => 100);
  const result = await reader.execute(owner, query);
  expect(result).toMatchObject({ state: "available", origin: "calendar", audience: "owner", start: query.start, end: query.end, timeZone: query.timeZone,
    execution: "unconfirmed", busy: [{ start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:00:00.000Z" }], availability: "conflict_observed", coverage: { complete: true, snapshot: "not_atomic", pages: 1 } });
  for (const privateText of ["synthetic-private", "private-person", "synthetic-calendar-secret"]) expect(JSON.stringify(result)).not.toContain(privateText);
  expect(requests).toHaveLength(1); expect(requests[0].method).toBe("GET"); expect(requests[0].body).toBeNull(); expect(requests[0].redirect).toBe("manual");
  const url = new URL(requests[0].url);
  expect(url.origin).toBe("https://www.googleapis.com"); expect(url.pathname).toBe("/calendar/v3/calendars/synthetic-private-calendar%40example.invalid/events");
  expect(url.searchParams.get("timeMin")).toBe(query.start); expect(url.searchParams.get("timeMax")).toBe(query.end); expect(url.searchParams.get("timeZone")).toBe(query.timeZone);
  expect(url.searchParams.get("fields")).toBe("items(status,transparency,start,end),nextPageToken");
});
test("missing/invalid interval, time zone and mutation fields are rejected before any request", async () => {
  const request = vi.fn(async () => Response.json({ items: [] })), reader = new CalendarReader(env.DB, scope, config(), "token", request);
  for (const extra of [{ method: "POST" }, { url: "https://other.invalid" }, { calendars: ["work"] }, { recipients: ["hidden@example.invalid"] }]) await expect(reader.execute(owner, { ...query, ...extra })).rejects.toThrow();
  for (const changed of [{ timeZone: "Unknown/Nowhere" }, { timeZone: undefined }, { start: "2026-10-26T09:00:00" }, { end: query.start }, { end: "2027-10-26T09:00:00Z" }]) await expect(reader.execute(owner, { ...query, ...changed })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
test("each configured calendar is required; one unavailable calendar cannot yield no-conflict availability", async () => {
  const calendars = [...config(), { ...config()[0], id: "personal", calendarId: "other-private@example.invalid" }], requests: Request[] = [];
  const result = await new CalendarReader(env.DB, scope, calendars, "token", async request => { requests.push(request); return requests.length === 1 ? Response.json({ items: [] }) : new Response("synthetic-private-error", { status: 403 }); }).execute(owner, query);
  expect(result).toMatchObject({ availability: "unknown", busy: [], coverage: { complete: false, configuredCalendars: 2, completedCalendars: 1, gaps: ["calendar_unavailable"] } });
  expect(requests).toHaveLength(2); expect(JSON.stringify(result)).not.toContain("private");
});
test("page traversal includes later conflicts and omits cancelled/transparent events", async () => {
  const requests: Request[] = [];
  const result = await new CalendarReader(env.DB, scope, config(), "token", async request => {
    requests.push(request); return requests.length === 1 ? Response.json({ items: [{ ...busy(), status: "cancelled" }, { ...busy(), transparency: "transparent" }], nextPageToken: "second-page" }) : Response.json({ items: [busy(), busy("2026-10-26T10:30:00-03:00", "2026-10-26T12:30:00-03:00")] });
  }).execute(owner, query);
  expect(result).toMatchObject({ availability: "conflict_observed", busy: [{ start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T15:00:00.000Z" }], coverage: { complete: true, pages: 2 } });
  expect(new URL(requests[1].url).searchParams.get("pageToken")).toBe("second-page");
});
test.each(["capacity", "cycle", "all_day", "malformed", "redirect"])("%s is an explicit coverage gap, never a free interval", async kind => {
  let calls = 0;
  const result = await new CalendarReader(env.DB, scope, config(), "token", async () => {
    calls++;
    if (kind === "redirect") return new Response(null, { status: 302, headers: { Location: "https://other.invalid" } });
    if (kind === "malformed") return Response.json({ items: [{ ...busy(), end: { dateTime: "bad" } }] });
    if (kind === "all_day") return Response.json({ items: [{ status: "confirmed", start: { date: "2026-10-26" }, end: { date: "2026-10-27" } }] });
    return Response.json({ items: [], nextPageToken: kind === "cycle" ? "same" : "page-" + calls });
  }).execute(owner, query);
  expect(result).toMatchObject({ availability: "unknown", coverage: { complete: false } }); expect(calls).toBeLessThanOrEqual(3);
});
test("canonical permission withdrawal during response suppresses intervals and local proposals", async () => {
  const reader = new CalendarReader(env.DB, scope, config(), "token", async () => { await controller.withdraw(authorization.sourceId, 1); return Response.json({ items: [busy()] }); });
  const result = await reader.execute(owner, { ...query, kind: "calendar.propose", title: "Synthetic meeting", recipients: ["selected@example.invalid"] });
  expect(result).toEqual({ state: "unavailable", reason: "source_changed", coverage: { complete: false }, availability: "unknown" });
});
test("local proposals preserve explicit owner recipients and offset/time zone without reserving or writing", async () => {
  const requests: Request[] = [], input = { ...query, kind: "calendar.propose", title: "Synthetic meeting", recipients: ["selected@example.invalid", "selected@example.invalid"] };
  const result = await new CalendarReader(env.DB, scope, config(), "token", async request => { requests.push(request); return Response.json({ items: [{ ...busy(), transparency: "transparent" }] }); }).execute(owner, input);
  expect(result).toMatchObject({ availability: "no_conflict_observed", proposal: { title: input.title, recipients: ["selected@example.invalid"], recipientsOrigin: "authenticated_owner_input", start: query.start, end: query.end,
    timeZone: query.timeZone, execution: "unconfirmed", reservation: "not_created" } });
  expect(JSON.stringify(result)).not.toContain("private-person"); expect(requests.every(request => request.method === "GET" && request.body === null)).toBe(true);
});
test("DST repeated hours use explicit absolute offsets instead of guessing local time", async () => {
  const input = { ...query, start: "2026-10-25T02:30:00+02:00", end: "2026-10-25T02:30:00+01:00", timeZone: "Europe/Berlin" };
  const result = await new CalendarReader(env.DB, scope, config(), "token", async () => Response.json({ items: [busy("2026-10-25T02:45:00+02:00", "2026-10-25T02:15:00+01:00")] })).execute(owner, input);
  expect(result).toMatchObject({ timeZone: "Europe/Berlin", busy: [{ start: "2026-10-25T00:45:00.000Z", end: "2026-10-25T01:15:00.000Z" }], availability: "conflict_observed", hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
test("large busy output is bounded with an explicit gap rather than silent truncation", async () => {
  let calls = 0;
  const result = await new CalendarReader(env.DB, scope, config(), "token", async () => {
    const offset = calls++ * 100;
    return Response.json({ items: Array.from({ length: 100 }, (_, i) => busy(new Date(Date.parse(query.start) + (offset + i) * 2000).toISOString(), new Date(Date.parse(query.start) + (offset + i) * 2000 + 1000).toISOString())), ...(calls === 1 ? { nextPageToken: "second" } : {}) });
  }).execute(owner, query) as { busy: unknown[] };
  expect(result).toMatchObject({ coverage: { complete: false, gaps: ["busy_result_limit"] }, availability: "conflict_observed" }); expect(result.busy).toHaveLength(100);
});
test("owner-only support and credential setup fail closed before reading the calendar", async () => {
  const request = vi.fn(async () => Response.json({ items: [] }));
  expect(await new CalendarReader(env.DB, scope, config(), undefined, request).execute(owner, query)).toEqual({ state: "pending_configuration", dependency: "calendar_read_oauth" });
  const reader = new CalendarReader(env.DB, scope, config(), "token", request);
  expect(await reader.execute({ kind: "extractor" }, query)).toMatchObject({ state: "unavailable", availability: "unknown" });
  await controller.changeAudience(authorization.sourceId, 1, "public");
  expect(await reader.execute(owner, query)).toMatchObject({ state: "unavailable", availability: "unknown" }); expect(request).not.toHaveBeenCalled();
});
test("the authenticated RPC reports OAuth missing and exposes configured GET reads without granting write capability", async () => {
  const affinity = { ...scope, sourceEpoch: "capture-e", sourceGeneration: "capture-g" }, settings = { DB: env.DB, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation, BRIDGE_SOURCE_EPOCH: affinity.sourceEpoch, BRIDGE_SOURCE_GENERATION: affinity.sourceGeneration };
  expect(await new OwnerAssistant(createExecutionContext(), settings).query(affinity, query)).toMatchObject({ state: "pending_configuration", dependency: "calendar_read" });
  const configured = { ...settings, CALENDAR_READ_CALENDARS: JSON.stringify(config()) };
  expect(await new OwnerAssistant(createExecutionContext(), configured).query(affinity, query)).toMatchObject({ dependency: "calendar_read_oauth" });
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
  try {
    const rpc = new OwnerAssistant(createExecutionContext(), { ...configured, CALENDAR_READ_ACCESS_TOKEN: "synthetic-token" });
    expect(await rpc.query(affinity, query)).toMatchObject({ origin: "calendar", audience: "owner", availability: "no_conflict_observed" });
    await expect(rpc.query({ ...affinity, generation: "foreign" }, query)).rejects.toThrow("owner_binding_affinity");
    expect(network).toHaveBeenCalledTimes(1); expect((network.mock.calls[0][0] as Request).method).toBe("GET");
  } finally { network.mockRestore(); }
});
