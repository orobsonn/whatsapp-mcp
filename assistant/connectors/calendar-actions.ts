import { z } from "zod";
import { bridgeHash } from "../ingress";
import { jsonStatement } from "../d1-statement";
import type { AccessGuard } from "../access";
import type { SourceScope } from "../sources";
import type { ReadFetch } from "./read-only";

const instant = z.iso.datetime({ offset: true });
const title = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const changes = z.object({ summary: title.optional(), start: z.object({ dateTime: instant, timeZone: z.literal("America/Fortaleza") }).strict().optional(), end: z.object({ dateTime: instant, timeZone: z.literal("America/Fortaleza") }).strict().optional() }).strict();
export const calendarMutation = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("create"), summary: title, start: instant, end: instant }).strict(),
  z.object({ verb: z.literal("edit"), target: title, dayStart: instant, dayEnd: instant, changes }).strict(),
  z.object({ verb: z.literal("delete"), target: title, dayStart: instant, dayEnd: instant }).strict(),
]).refine(value => value.verb === "create" ? Date.parse(value.end) > Date.parse(value.start) && Date.parse(value.end) - Date.parse(value.start) <= 86400000 : Date.parse(value.dayEnd) - Date.parse(value.dayStart) === 86400000)
.refine(value => value.verb !== "edit" || (Object.keys(value.changes).length > 0 && (!!value.changes.start === !!value.changes.end) && (!value.changes.start || Date.parse(value.changes.end!.dateTime) > Date.parse(value.changes.start.dateTime))));
export type CalendarMutation = z.infer<typeof calendarMutation>;
type Outcome = { state: "applied" | "conflict" | "rejected" | "uncertain"; verb: CalendarMutation["verb"]; eventId: string; summary: string; reason?: string };
const frozen = z.object({ verb: z.enum(["create", "edit", "delete"]), eventId: z.string().regex(/^[a-zA-Z0-9_-]{1,1024}$/), etag: z.string().min(1).max(512).optional(), summary: title, body: z.record(z.string(), z.unknown()).nullable() }).strict();
type Row = { request_id: string; authority_id: string; command_hash: string; command_json: string | null; result_json: string | null; state: string; affinity_hash: string; purged: number };
const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const event = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,1024}$/), etag: z.string().min(1).max(512), summary: z.string().optional(), status: z.string(), eventType: z.string().optional(),
  start: z.object({ dateTime: instant.optional(), date: z.string().optional() }).optional(), end: z.object({ dateTime: instant.optional(), date: z.string().optional() }).optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(), attendees: z.array(z.unknown()).optional(), attendeesOmitted: z.boolean().optional(),
  recurrence: z.array(z.string()).optional(), recurringEventId: z.string().optional(), locked: z.boolean().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional() });
/** Small bounded transport. Only host constants choose Google endpoints/verbs. */
async function exchange(request: ReadFetch, url: URL, token: string, method = "GET", body?: unknown, etag?: string) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("calendar_timeout")); }, 8000); });
  try {
    const response = await Promise.race([request(new Request(url, { method, redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(etag ? { "If-Match": etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })), deadline]);
    if (response.status === 204) return { status: 204, body: null };
    if (!response.body) return { status: response.status, body: null };
    reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }); let text = "", size = 0;
    while (true) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; size += part.value.length; if (size > 131072) throw Error("calendar_response_limit"); text += decoder.decode(part.value, { stream: true }); }
    return { status: response.status, body: JSON.parse(text + decoder.decode()) as unknown };
  } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}
export type CalendarActionContext = { id: string; requestId: string; authorityId: string; affinity: unknown; guard: () => AccessGuard; token: string; request?: ReadFetch };
/** A single admitted Google write. An uncertain/recovered claim never writes again. */
export async function runCalendarAction(db: D1Database, scope: SourceScope, input: CalendarMutation, context: CalendarActionContext): Promise<{ id: string; outcome: Outcome; resultJSON: string | null }> {
  const command = calendarMutation.parse(input), request = context.request ?? fetch, keys = [scope.installationId, scope.generation, context.id];
  const commandHash = await bridgeHash(command), affinityHash = await bridgeHash(context.affinity);
  const read = () => db.prepare("SELECT request_id,authority_id,command_hash,command_json,result_json,state,affinity_hash,purged FROM assistant_calendar_actions WHERE installation_id=? AND generation=? AND id=?").bind(...keys).first<Row>();
  const check = async () => { const guard = context.guard(); if (!await jsonStatement(db, `SELECT 1 WHERE (${guard.sql})`, guard.values).first()) throw Error("calendar_action_denied"); };
  let row = await read();
  if (!row) {
    await check(); let selected: z.infer<typeof frozen>;
    if (command.verb === "create") {
      const eventId = await bridgeHash(["calendar-event-v1", ...keys, commandHash, affinityHash]);
      selected = { verb: "create", eventId, summary: command.summary, body: { id: eventId, summary: command.summary,
        start: { dateTime: command.start, timeZone: "America/Fortaleza" }, end: { dateTime: command.end, timeZone: "America/Fortaleza" },
        reminders: { useDefault: false }, extendedProperties: { private: { assistantAction: eventId, assistantBody: commandHash } } } };
    } else {
      const matches: z.infer<typeof event>[] = [], seen = new Set<string>(); let pageToken: string | undefined, complete = false;
      for (let page = 0; page < 5; page++) {
        await check(); const url = new URL(base); url.search = new URLSearchParams({ timeMin: command.dayStart, timeMax: command.dayEnd, singleEvents: "true", maxResults: "100", showDeleted: "false", fields: "items(id,etag,summary,status,eventType,organizer/self,attendees,attendeesOmitted,recurrence,recurringEventId,locked),nextPageToken", ...(pageToken ? { pageToken } : {}) }).toString();
        const response = await exchange(request, url, context.token); await check(); if (response.status !== 200) throw Error("calendar_selection_unavailable");
        const parsed = z.object({ items: z.array(event).max(100).default([]), nextPageToken: z.string().min(1).max(2048).optional() }).parse(response.body);
        for (const item of parsed.items) if (item.status !== "cancelled" && item.summary === command.target) matches.push(item);
        pageToken = parsed.nextPageToken; if (!pageToken) { complete = true; break; } if (seen.has(pageToken)) throw Error("calendar_selection_partial"); seen.add(pageToken);
      }
      if (!complete || matches.length !== 1) throw Error("calendar_target_ambiguous");
      const match = matches[0];
      await check(); const latest = await exchange(request, new URL(base + "/" + encodeURIComponent(match.id)), context.token); await check();
      if (latest.status !== 200) throw Error("calendar_selection_unavailable");
      const target = event.parse(latest.body);
      if (target.id !== match.id || target.etag !== match.etag || target.summary !== command.target || target.status === "cancelled") throw Error("calendar_target_changed");
      // Shared and recurring mutations need an explicit product path; never silently
      // change invitations or an entire series under an ordinary single-event request.
      if (target.organizer?.self !== true || target.attendees?.length || target.attendeesOmitted || target.recurrence?.length || target.recurringEventId || target.locked || (target.eventType && target.eventType !== "default")) throw Error("calendar_target_unsupported");
      selected = { verb: command.verb, eventId: target.id, etag: target.etag, summary: command.verb === "edit" ? command.changes.summary ?? command.target : command.target, body: command.verb === "edit" ? command.changes : null };
    }
    const guard = context.guard(), now = Date.now();
    await jsonStatement(db, `INSERT INTO assistant_calendar_actions(installation_id,generation,id,request_id,authority_id,affinity_hash,command_hash,command_json,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,'prepared',?,? WHERE (${guard.sql}) ON CONFLICT DO NOTHING`, [...keys, context.requestId, context.authorityId, affinityHash, commandHash, JSON.stringify(frozen.parse(selected)), now, now, ...guard.values]).run();
    row = await read();
  }
  if (!row || row.purged || row.request_id !== context.requestId || row.authority_id !== context.authorityId || row.command_hash !== commandHash || row.affinity_hash !== affinityHash || !row.command_json) throw Error("calendar_action_conflict");
  const selected = frozen.parse(JSON.parse(row.command_json));
  if (row.result_json) return { id: context.id, outcome: JSON.parse(row.result_json), resultJSON: row.result_json };
  const uncertain: Outcome = { state: "uncertain", verb: selected.verb, eventId: selected.eventId, summary: selected.summary };
  const guard = context.guard();
  // A committed claim with a lost ACK intentionally does not reach the provider.
  const claim = await jsonStatement(db, `UPDATE assistant_calendar_actions SET state='attempting',updated_at=? WHERE installation_id=? AND generation=? AND id=? AND state='prepared' AND purged=0 AND command_json=? AND (${guard.sql}) RETURNING id`, [Date.now(), ...keys, row.command_json, ...guard.values]).first();
  if (!claim) return { id: context.id, outcome: uncertain, resultJSON: null };
  let outcome = uncertain;
  try {
    await check(); const url = new URL(base + (selected.verb === "create" ? "" : "/" + encodeURIComponent(selected.eventId)));
    url.searchParams.set("sendUpdates", "none");
    const response = await exchange(request, url, context.token, selected.verb === "create" ? "POST" : selected.verb === "edit" ? "PATCH" : "DELETE", selected.body ?? undefined, selected.etag);
    if (selected.verb === "delete" && response.status === 204) outcome = { ...uncertain, state: "applied" };
    else if (selected.verb !== "delete" && response.status === 200) {
      const applied = event.parse(response.body);
      const body = selected.body as { start?: { dateTime: string }; end?: { dateTime: string } } | null;
      if (applied.id === selected.eventId && applied.status !== "cancelled" && applied.summary === selected.summary
        && (!body?.start || Date.parse(applied.start?.dateTime ?? "") === Date.parse(body.start.dateTime))
        && (!body?.end || Date.parse(applied.end?.dateTime ?? "") === Date.parse(body.end.dateTime))
        && (selected.verb !== "create" || (applied.extendedProperties?.private?.assistantAction === selected.eventId && applied.extendedProperties?.private?.assistantBody === commandHash))) outcome = { ...uncertain, state: "applied" };
    } else if (response.status === 412 || response.status === 409) outcome = { ...uncertain, state: "conflict", reason: "event_changed" };
    else if ([400, 401, 403, 422].includes(response.status)) outcome = { ...uncertain, state: "rejected", reason: "provider_rejected" };
  } catch { /* An external effect may already exist: never automatically retry. */ }
  const resultJSON = JSON.stringify(outcome);
  await db.prepare("UPDATE assistant_calendar_actions SET state=?,result_json=?,updated_at=? WHERE installation_id=? AND generation=? AND id=? AND state='attempting' AND purged=0 AND command_json=?").bind(outcome.state, resultJSON, Date.now(), ...keys, row.command_json).run();
  await check(); const final = await read();
  if (!final || final.purged || final.result_json !== resultJSON) throw Error("calendar_result_unavailable");
  return { id: context.id, outcome, resultJSON };
}
