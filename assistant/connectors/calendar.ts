import { z } from "zod";
import type { TrustedActor, SourceFence } from "../access";
import type { SourceScope } from "../sources";
import { bridgeHash } from "../ingress";
import { connectorAuthority, ConnectorAccess, readJson, type ReadFetch } from "./read-only";
import type { CalendarTokenSource, CalendarTokenResult } from "./calendar-oauth";

const id = z.string().min(1).max(256), instant = z.iso.datetime({ offset: true });
const timezone = z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
const window = { start: instant, end: instant, timeZone: timezone };
function civilInstant(value: string, timeZone: string) {
  const at = new Date(value), parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).formatToParts(at).map(part => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "Z" : parts.timeZoneName.replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(at.getUTCMilliseconds()).padStart(3, "0")}${offset}`;
}
export const calendarQuery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calendar.availability"), ...window }).strict(),
  z.object({ kind: z.literal("calendar.propose"), ...window, recipients: z.array(z.email().max(254)).min(1).max(20), title: z.string().min(1).max(256) }).strict(),
]).refine(value => Date.parse(value.end) > Date.parse(value.start) && Date.parse(value.end) - Date.parse(value.start) <= 31 * 86400000, "calendar_interval");
export const calendarConfiguration = connectorAuthority.extend({ id, calendarId: z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).strict();
const date = z.object({ dateTime: instant.optional(), date: z.iso.date().optional(), timeZone: z.string().max(128).optional() });
const event = z.object({ status: z.enum(["confirmed", "tentative", "cancelled"]), transparency: z.enum(["opaque", "transparent"]).optional(), start: date.optional(), end: date.optional() });
const page = z.object({ items: z.array(event).max(100), nextPageToken: z.string().min(1).max(2048).optional() });
type Busy = { start: string; end: string };

/** Reads every configured calendar; callers cannot omit one and claim global availability. */
export class CalendarReader {
  private readonly calendars: z.infer<typeof calendarConfiguration>[];
  private readonly access: ConnectorAccess;
  constructor(db: D1Database, scope: SourceScope, calendars: unknown, private readonly token: string | CalendarTokenSource | undefined,
    private readonly request: ReadFetch = request => fetch(request), private readonly clock = Date.now) {
    this.calendars = z.array(calendarConfiguration).min(1).max(5).parse(calendars);
    if (new Set(this.calendars.map(item => item.id)).size !== this.calendars.length || new Set(this.calendars.map(item => item.calendarId)).size !== this.calendars.length) throw new Error("calendar_configuration");
    this.access = new ConnectorAccess(db, scope, clock);
  }
  async execute(actor: TrustedActor, input: unknown): Promise<unknown> {
    const query = calendarQuery.parse(input);
    if (!this.token) return { state: "pending_configuration", dependency: "calendar_read_oauth" };
    const fences: SourceFence[] = [];
    for (const calendar of this.calendars) {
      const fence = await this.access.admit(actor, calendar);
      if (!fence) return { state: "unavailable", reason: "source_denied", coverage: { complete: false }, availability: "unknown" };
      fences.push(fence);
    }
    let credential: CalendarTokenResult;
    try { credential = typeof this.token === "function" ? await this.token() : { state: "ready", accessToken: this.token, expiresAt: Date.now() + 3600000 }; }
    catch { return { state: "unavailable", dependency: "calendar_read_oauth", coverage: { complete: false }, availability: "unknown" }; }
    if (credential.state !== "ready") return { state: credential.state, dependency: "calendar_read_oauth", coverage: { complete: false }, availability: "unknown" };
    if (!credential.accessToken || /[\u0000-\u0020\u007f]/.test(credential.accessToken) || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now())
      return { state: "unavailable", dependency: "calendar_read_oauth", coverage: { complete: false }, availability: "unknown" };
    if (!await this.access.currentMany(actor, fences)) return { state: "unavailable", reason: "source_changed", coverage: { complete: false }, availability: "unknown" };
    const begin = Date.parse(query.start), end = Date.parse(query.end), gaps = new Set<string>(), intervals: Busy[] = [], deadline = Date.now() + 12000;
    let pages = 0, completedCalendars = 0;
    for (let index = 0; index < this.calendars.length; index++) {
      const calendar = this.calendars[index], tokens = new Set<string>(); let nextPageToken: string | undefined;
      try {
        for (let count = 0; count < 3; count++) {
          if (Date.now() >= deadline) throw new Error("calendar_deadline");
          if (!await this.access.current(actor, fences[index])) throw new Error("source_changed");
          const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.calendarId)}/events`);
          // Google ignores fractional seconds in bounds. Expand outwards, then
          // clip observed events to the exact requested interval below.
          const timeMin = begin % 1000 ? new Date(Math.floor(begin / 1000) * 1000).toISOString() : query.start;
          const timeMax = end % 1000 ? new Date(Math.ceil(end / 1000) * 1000).toISOString() : query.end;
          url.search = new URLSearchParams({ timeMin, timeMax, timeZone: query.timeZone, singleEvents: "true", orderBy: "startTime", maxResults: "100",
            fields: "items(status,transparency,start,end),nextPageToken", ...(nextPageToken ? { pageToken: nextPageToken } : {}) }).toString();
          const value = page.parse(await readJson(url, { Authorization: `Bearer ${credential.accessToken}`, Accept: "application/json" }, this.request, 262144, Math.max(1, Math.min(8000, deadline - Date.now()))));
          pages++;
          for (const item of value.items) {
            if (item.status === "cancelled" || item.transparency === "transparent") continue;
            if (!item.start?.dateTime || !item.end?.dateTime) { gaps.add("all_day_or_incomplete_event"); continue; }
            const start = Date.parse(item.start.dateTime), finish = Date.parse(item.end.dateTime);
            if (finish <= start) { gaps.add("invalid_event_interval"); continue; }
            if (start < end && finish > begin) intervals.push({ start: new Date(Math.max(start, begin)).toISOString(), end: new Date(Math.min(finish, end)).toISOString() });
          }
          if (!value.nextPageToken) { completedCalendars++; nextPageToken = undefined; break; }
          if (tokens.has(value.nextPageToken)) throw new Error("calendar_page_cycle");
          tokens.add(value.nextPageToken); nextPageToken = value.nextPageToken;
        }
        if (nextPageToken) gaps.add("page_limit");
      } catch { gaps.add("calendar_unavailable"); }
    }
    intervals.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    const busy: Busy[] = [];
    for (const interval of intervals) {
      const previous = busy.at(-1);
      if (previous && previous.end >= interval.start) { if (previous.end < interval.end) previous.end = interval.end; }
      else busy.push({ ...interval });
    }
    if (busy.length > 100) { busy.splice(100); gaps.add("busy_result_limit"); }
    const complete = completedCalendars === this.calendars.length && !gaps.size;
    const availability = busy.length ? "conflict_observed" : complete ? "no_conflict_observed" : "unknown";
    const result = { state: "available", origin: "calendar", audience: "owner", start: query.start, end: query.end, timeZone: query.timeZone,
      busy, availability, observedAt: this.clock(), execution: "unconfirmed", coverage: { complete, pages, configuredCalendars: this.calendars.length, completedCalendars, gaps: [...gaps], snapshot: "not_atomic" },
      sources: this.calendars.map(item => ({ id: item.id, projectId: item.projectId, configurationVersion: item.version })) };
    const hash = await bridgeHash([result, fences]);
    // Final coherent D1 proof is mandatory even for partial/error/empty results,
    // after hashing and every remote await that could race with withdrawal.
    if (!await this.access.currentMany(actor, fences)) return { state: "unavailable", reason: "source_changed", coverage: { complete: false }, availability: "unknown" };
    return query.kind === "calendar.propose" ? { ...result, hash, proposal: { kind: "calendar_proposal", title: query.title,
      start: new Date(begin).toISOString(), end: new Date(end).toISOString(), localStart: civilInstant(query.start, query.timeZone), localEnd: civilInstant(query.end, query.timeZone),
      timeZone: query.timeZone, recipients: [...new Set(query.recipients)], recipientsOrigin: "authenticated_owner_input", execution: "unconfirmed", reservation: "not_created" } } : { ...result, hash };
  }
}
