import { z } from "zod";
import type { AssistantEnv } from "../env";
import type { SourceScope } from "../sources";
import { CalendarReader, calendarConfiguration } from "./calendar";
import { calendarOAuthName, oauthAffinity } from "./calendar-oauth";
import type { ReadFetch, OwnerReadBoundary } from "./read-only";

export type CalendarReadBoundary = OwnerReadBoundary;
/** Shared MCP/Telegram configuration. No credential or transport goes to a model. */
export function configuredCalendar(env: AssistantEnv, scope: SourceScope, boundary?: CalendarReadBoundary, includeEventTitles = false) {
  if (!env.DB || !env.CALENDAR_READ_CALENDARS) return { state: "pending_configuration", dependency: "calendar_read" } as const;
  if (!env.CALENDAR_OAUTH) return { state: "pending_configuration", dependency: "calendar_read_oauth" } as const;
  const affinity = oauthAffinity.safeParse({ installationId: scope.installationId, generation: scope.generation, configurationVersion: Number(env.CALENDAR_OAUTH_CONFIGURATION_VERSION), secretEpoch: env.CALENDAR_OAUTH_SECRET_EPOCH });
  if (!affinity.success) return { state: "pending_configuration", dependency: "calendar_read_oauth" } as const;
  const calendars = z.array(calendarConfiguration).min(1).max(5).parse(JSON.parse(env.CALENDAR_READ_CALENDARS));
  const lifetime = boundary ? AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(15000, boundary.deadlineAt - Date.now()))), ...(boundary.signal ? [boundary.signal] : [])]) : undefined;
  const check = async () => {
    if (!boundary) return;
    if (lifetime!.aborted || Date.now() >= boundary.deadlineAt) throw Error("calendar_dialogue_expired");
    await boundary.check();
    if (lifetime!.aborted || Date.now() >= boundary.deadlineAt) throw Error("calendar_dialogue_expired");
  };
  const token = async () => {
    await check();
    const call = env.CALENDAR_OAUTH!.get(env.CALENDAR_OAUTH!.idFromName(calendarOAuthName(affinity.data))).token(affinity.data);
    let abort: (() => void) | undefined;
    try {
      const result = await (lifetime ? Promise.race([call, new Promise<never>((_, reject) => {
        abort = () => reject(Error("calendar_dialogue_expired")); lifetime.addEventListener("abort", abort, { once: true });
        if (lifetime.aborted) abort();
      })]) : call);
      // A late token cannot start a new GET after its caller lost authority.
      await check(); return result;
    } finally { if (abort) lifetime!.removeEventListener("abort", abort); }
  };
  const request: ReadFetch = async input => {
    await check();
    return (boundary?.request ?? fetch)(lifetime ? new Request(input, { signal: AbortSignal.any([input.signal, lifetime]) }) : input);
  };
  return { state: "ready", calendars, check, reader: new CalendarReader(env.DB, scope, calendars, token, request, Date.now, includeEventTitles) } as const;
}
