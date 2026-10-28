import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { runCalendarAction, type CalendarActionContext, type CalendarMutation } from "../assistant/connectors/calendar-actions";
import { parseCalendarMutation } from "../assistant/telegram-calendar-action";
import { SourceController } from "../assistant/sources";
import { RetentionPurge } from "../assistant/retention-purge";
const now = Date.parse("2026-10-28T10:00:00Z");
const create: CalendarMutation = { verb: "create", summary: "Teste técnico", start: "2026-10-29T14:00:00-03:00", end: "2026-10-29T15:00:00-03:00" };
const edit: CalendarMutation = { verb: "edit", target: "Teste técnico", dayStart: "2026-10-29T03:00:00.000Z", dayEnd: "2026-10-30T03:00:00.000Z", changes: { summary: "Teste revisado" } };
const target = { id: "syntheticevent", etag: '"version1"', summary: "Teste técnico", status: "confirmed", organizer: { self: true } };
function fixture(request: (request: Request) => Promise<Response>) {
  const scope = { installationId: crypto.randomUUID(), generation: "calendar-write" };
  let allowed = true;
  const context: CalendarActionContext = { id: "a".repeat(64), requestId: "request-one", authorityId: "grant-one", affinity: { secretEpoch: "one" }, token: "synthetic-access", guard: () => ({ sql: allowed ? "1" : "0", values: [] }), request };
  return { scope, context, revoke: () => { allowed = false; } };
}
it("parses whole owner instructions with literal titles and civil times; refuses negation, quotation, conditions and incomplete data", () => {
  expect(parseCalendarMutation('Crie o evento “Teste técnico” amanhã das 14h às 15h.', now)).toEqual(create);
  expect(parseCalendarMutation('Renomeie o evento “Teste técnico” amanhã para “Teste revisado”.', now)).toEqual(edit);
  expect(parseCalendarMutation('Exclua o evento “Teste técnico” amanhã.', now)).toMatchObject({ verb: "delete", target: "Teste técnico" });
  expect(parseCalendarMutation('Mude o evento “Teste técnico” amanhã para 30/10/2026 das 16:30 às 17:45.', now)).toMatchObject({ verb: "edit", changes: { start: { dateTime: "2026-10-30T16:30:00-03:00" }, end: { dateTime: "2026-10-30T17:45:00-03:00" } } });
  for (const text of ['Não crie o evento “Teste técnico” amanhã das 14h às 15h.', 'Ele disse: crie o evento “Teste técnico” amanhã das 14h às 15h.', 'Crie o evento “Teste técnico” amanhã das 14h às 15h se eu aprovar.', 'Crie o evento “Teste técnico” amanhã.', 'Crie o evento “Teste técnico” amanhã das 25h às 26h.', 'Exclua o evento “Teste técnico” amanhã?']) expect(parseCalendarMutation(text, now)).toBeNull();
});
it("creates once with a deterministic ID and no invitations, stores receipt and never repeats on restart", async () => {
  const requests: Request[] = [], request = vi.fn(async (req: Request) => { requests.push(req); const body = await req.json() as Record<string, unknown>; return Response.json({ ...body, status: "confirmed", etag: '"created"' }); });
  const f = fixture(request), first = await runCalendarAction(env.DB, f.scope, create, f.context);
  expect(first.outcome.state).toBe("applied");
  expect(await runCalendarAction(env.DB, f.scope, create, f.context)).toEqual(first); expect(request).toHaveBeenCalledTimes(1);
  expect(requests[0].method).toBe("POST"); expect(requests[0].redirect).toBe("manual"); expect(requests[0].url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none");
  expect(first.outcome.eventId).toMatch(/^[a-f0-9]{64}$/);
});
it("a timeout after provider effect remains uncertain across restart with no second POST", async () => {
  const request = vi.fn(async () => { throw Error("network lost after effect"); }), f = fixture(request);
  expect((await runCalendarAction(env.DB, f.scope, create, f.context)).outcome.state).toBe("uncertain");
  expect((await runCalendarAction(env.DB, f.scope, create, f.context)).outcome.state).toBe("uncertain"); expect(request).toHaveBeenCalledTimes(1);
});
it("an already consumed attempt cannot be reclaimed or retargeted", async () => {
  const request = vi.fn(async (req: Request) => Response.json({ ...await req.json() as object, etag: '"created"', status: "confirmed" })), f = fixture(request);
  await runCalendarAction(env.DB, f.scope, create, f.context);
  await expect(runCalendarAction(env.DB, f.scope, { ...create, summary: "Other" }, f.context)).rejects.toThrow("conflict");
  for (const changed of [{ ...f.context, requestId: "another-bot-request" }, { ...f.context, authorityId: "another-grant" }]) await expect(runCalendarAction(env.DB, f.scope, create, changed)).rejects.toThrow("conflict");
  await expect(env.DB.prepare("UPDATE assistant_calendar_actions SET state='prepared' WHERE installation_id=?").bind(f.scope.installationId).run()).rejects.toThrow();
  await expect(env.DB.prepare("DELETE FROM assistant_calendar_actions WHERE installation_id=?").bind(f.scope.installationId).run()).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
});
it("edits an exact unique event with current ETag and treats 412 as a final conflict without auto-reapply", async () => {
  const requests: Request[] = [], request = vi.fn(async (req: Request) => { requests.push(req); return req.method === "PATCH" ? Response.json({ error: "changed" }, { status: 412 }) : Response.json(req.url.includes("timeMin=") ? { items: [target] } : target); }), f = fixture(request);
  const first = await runCalendarAction(env.DB, f.scope, edit, f.context); expect(first.outcome.state).toBe("conflict");
  expect(await runCalendarAction(env.DB, f.scope, edit, f.context)).toEqual(first);
  expect(requests.map(r => r.method)).toEqual(["GET", "GET", "PATCH"]); expect(requests[2].headers.get("If-Match")).toBe(target.etag);
});
it("refuses duplicate titles, incomplete pagination, shared events and recurrence before any effect", async () => {
  for (const mode of ["duplicate", "partial", "shared", "recurring", "changed"] as const) {
    const selected = mode === "shared" ? { ...target, attendees: [{ email: "synthetic@invalid.example" }] } : mode === "recurring" ? { ...target, recurringEventId: "series" } : target;
    const request = vi.fn(async (req: Request) => { expect(req.method).toBe("GET"); return Response.json(req.url.includes("timeMin=") ? { items: mode === "duplicate" ? [target, { ...target, id: "other" }] : [selected], ...(mode === "partial" ? { nextPageToken: "repeated" } : {}) } : mode === "changed" ? { ...selected, etag: '"newer"' } : selected); }), f = fixture(request);
    await expect(runCalendarAction(env.DB, f.scope, edit, f.context)).rejects.toThrow();
  }
});
it("revocation between current read and claim prevents PATCH", async () => {
  const requests: string[] = []; let f: ReturnType<typeof fixture>;
  f = fixture(async req => { requests.push(req.method); if (!req.url.includes("timeMin=")) f.revoke(); return Response.json(req.url.includes("timeMin=") ? { items: [target] } : target); });
  await expect(runCalendarAction(env.DB, f.scope, edit, f.context)).rejects.toThrow("denied"); expect(requests).toEqual(["GET", "GET"]);
});
it("DELETE 404 is uncertain and never claimed as deletion", async () => {
  const requests: Request[] = [], f = fixture(async req => { requests.push(req); return req.method === "DELETE" ? Response.json({ error: "missing" }, { status: 404 }) : Response.json(req.url.includes("timeMin=") ? { items: [target] } : target); });
  const deletion = { verb: "delete", target: edit.target, dayStart: edit.dayStart, dayEnd: edit.dayEnd } as const;
  expect((await runCalendarAction(env.DB, f.scope, deletion, f.context)).outcome.state).toBe("uncertain");
  expect((await runCalendarAction(env.DB, f.scope, deletion, f.context)).outcome.state).toBe("uncertain"); expect(requests).toHaveLength(3);
});
it("real source purge erases event data and preserves the consumed action latch", async () => {
  const request = vi.fn(async (req: Request) => Response.json({ ...await req.json() as object, etag: '"created"', status: "confirmed" })), f = fixture(request);
  const retirement = { allow: async () => {}, withdraw: async () => {} }, sources = new SourceController(env.DB, f.scope, { kind: "owner" }, Date.now, retirement);
  const source = await sources.create({ originKey: "calendar-request", text: "Synthetic technical event request", occurredAt: Date.now() }); f.context.requestId = source.id;
  await runCalendarAction(env.DB, f.scope, create, f.context); await sources.withdraw(source.id, 1);
  const purge = new RetentionPurge(env.DB, f.scope, { kind: "owner" }, Date.now, retirement);
  let state = "pending"; for (let i = 0; i < 25 && state === "pending"; i++) state = (await purge.advance({ kind: "source.purge", operationId: "purge-calendar", sourceId: source.id })).state;
  expect(state).toBe("complete");
  expect(await env.DB.prepare("SELECT state,purged,command_json,result_json FROM assistant_calendar_actions WHERE installation_id=?").bind(f.scope.installationId).first()).toEqual({ state: "applied", purged: 1, command_json: null, result_json: null });
  await expect(runCalendarAction(env.DB, f.scope, create, f.context)).rejects.toThrow("conflict"); expect(request).toHaveBeenCalledTimes(1);
});
