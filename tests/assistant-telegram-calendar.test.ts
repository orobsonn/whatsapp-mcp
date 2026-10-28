import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { calendarDayQuery, renderCalendarObservation, readTelegramCalendar } from "../assistant/telegram-calendar";
import { SourceController } from "../assistant/sources";
import type { AssistantEnv } from "../assistant/env";

const occurredAt = Date.parse("2026-10-28T01:00:00Z"); // Still 27 October in Fortaleza.
it("anchors relative and explicit civil dates to the authenticated message in Fortaleza", () => {
  expect(calendarDayQuery("Tenho algum horário ocupado amanhã na agenda?", occurredAt)).toEqual({ kind: "calendar.availability", start: "2026-10-28T03:00:00.000Z", end: "2026-10-29T03:00:00.000Z", timeZone: "America/Fortaleza" });
  expect(calendarDayQuery("Agenda depois de amanhã", occurredAt)?.start).toBe("2026-10-29T03:00:00.000Z");
  expect(calendarDayQuery("Agenda em 29/02/2028", occurredAt)?.end).toBe("2028-03-01T03:00:00.000Z");
});
it("asks for clarification instead of silently choosing a conflicting day or broader time range", () => {
  for (const text of ["agenda", "hoje ou amanhã", "31/02/2026", "amanhã das 9 às 10", "amanhã às 9h", "semana que vem", "hoje de manhã", "amanhã e 30/10/2026", "amanhã às nove", "amanhã de 9 a 10", "hoje ou 28/10"])
    expect(calendarDayQuery(text, occurredAt), text).toBeNull();
});
it("renders only observed busy intervals and keeps incomplete coverage explicit", () => {
  const partial = { state: "available", start: "2026-10-28T03:00:00Z", end: "2026-10-29T03:00:00Z", timeZone: "America/Fortaleza", busy: [], coverage: { complete: false, gaps: ["all_day_or_incomplete_event"], configuredCalendars: 1, completedCalendars: 1 } };
  expect(renderCalendarObservation(partial)).toContain("não permite concluir");
  expect(renderCalendarObservation(partial)).not.toContain("está livre");
  const text = renderCalendarObservation({ ...partial, busy: [{ start: "2026-10-28T12:00:00Z", end: "2026-10-28T13:00:00Z" }] });
  expect(text).toContain("09:00–10:00"); expect(text.toLowerCase()).toContain("somente leitura");
});

async function configured(tokenEffect?: () => void) {
  const scope = { installationId: crypto.randomUUID(), generation: "calendar-dialogue", sourceEpoch: "calendar-epoch", sourceGeneration: "calendar-capture" };
  await env.DB.prepare("INSERT INTO assistant_projects VALUES(?,?,?,?)").bind(scope.installationId, scope.generation, "calendar", "Synthetic calendar").run();
  const source = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "calendar-consent", text: "Synthetic readonly authorization", occurredAt, projectId: "calendar" });
  const token = vi.fn(async () => { tokenEffect?.(); return { state: "ready", accessToken: "synthetic-calendar-token", expiresAt: Date.now() + 60000 }; });
  const settings = { DB: env.DB, CALENDAR_READ_CALENDARS: JSON.stringify([{ id: "primary", calendarId: "primary", projectId: "calendar", version: 1, authorization: { sourceId: source.id, revision: 1 } }]),
    CALENDAR_OAUTH_CONFIGURATION_VERSION: "1", CALENDAR_OAUTH_SECRET_EPOCH: "synthetic-epoch", CALENDAR_OAUTH: { idFromName: () => ({}), get: () => ({ token }) } } as unknown as AssistantEnv;
  return { scope, settings, token, source };
}
it("revalidates the native frame after the token RPC before issuing any Calendar GET", async () => {
  let current = true;
  const f = await configured(() => { current = false; }), request = vi.fn(async () => Response.json({ items: [] }));
  const result = await readTelegramCalendar(f.settings, f.scope, "Agenda amanhã", occurredAt, { deadlineAt: Date.now() + 60000,
    check: async () => { if (!current) throw Error("frame_revoked"); }, request });
  expect(result.state).toBe("unavailable"); expect(f.token).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
});
it("uses the real reader, returns its authorization fences, and never reads after native cancellation", async () => {
  const stop = new AbortController(), f = await configured(), request = vi.fn(async () => Response.json({ items: [] }));
  const options = { deadlineAt: Date.now() + 60000, check: async () => {}, request, signal: stop.signal };
  const result = await readTelegramCalendar(f.settings, f.scope, "Agenda amanhã", occurredAt, options);
  expect(result).toMatchObject({ state: "available", dependencies: [{ source: { source: { id: f.source.id } } }], observation: { kind: "calendar", result: { availability: "no_conflict_observed", coverage: { complete: true } } } });
  expect(request).toHaveBeenCalledOnce(); stop.abort();
  expect((await readTelegramCalendar(f.settings, f.scope, "Agenda amanhã", occurredAt, options)).state).toBe("unavailable");
  expect(request).toHaveBeenCalledOnce(); expect(f.token).toHaveBeenCalledOnce();
});
