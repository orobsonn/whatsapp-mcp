import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
import type { ReplyDependency } from "./telegram-owner-replies";
import { configuredCalendar, type CalendarReadBoundary } from "./connectors/configured-calendar";
import { ConnectorAccess } from "./connectors/read-only";
import { fupInstant } from "./followups";
import type { CalendarEventObservation } from "./connectors/calendar";
import { telegramExcerpt } from "./telegram-format";

const timeZone = "America/Fortaleza";
/** Deliberately resolved in the host, anchored to the original message date.
 * Unsupported ranges ask for clarification; they never silently widen a read. */
export function calendarDayQuery(text: string, occurredAt: number) {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(?:semana|mes|manha|tarde|noite|madrugada|periodo)\b|\b(?:as|das|entre|desde|ate)\s+\d|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*h\b/.test(normalized)) return null;
  const hour = "(?:\\d{1,2}|uma?|duas?|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|meio|meia)";
  if (new RegExp(`\\b(?:as|das|entre|desde|ate)\\s+${hour}\\b|\\bde\\s+${hour}\\s+(?:a|ate|as|e)\\s+${hour}\\b|\\b${hour}\\s+horas?\\b|\\b\\d{1,2}h\\d{2}\\b|\\bou\\b`).test(normalized)) return null;
  const relative = [...normalized.matchAll(/\b(depois de amanha|amanha|hoje)\b/g)], explicit = [...normalized.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)];
  if (/\b\d{1,2}[/.\-]\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/.test(normalized.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, ""))) return null;
  if (relative.length + explicit.length !== 1) return null;
  let year: number, month: number, day: number;
  if (explicit.length) [day, month, year] = explicit[0].slice(1).map(Number);
  else {
    const civil = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(occurredAt).map(p => [p.type, p.value]));
    const shifted = new Date(Date.UTC(Number(civil.year), Number(civil.month) - 1, Number(civil.day) + ({ hoje: 0, amanha: 1, "depois de amanha": 2 }[relative[0][1]] ?? 0)));
    year = shifted.getUTCFullYear(); month = shifted.getUTCMonth() + 1; day = shifted.getUTCDate();
  }
  const civil = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || civil.getUTCFullYear() !== year || civil.getUTCMonth() + 1 !== month || civil.getUTCDate() !== day) return null;
  const iso = (value: Date) => value.toISOString().slice(0, 10) + "T00:00:00-03:00";
  try {
    const start = fupInstant(iso(civil), timeZone), next = new Date(civil.getTime() + 86400000), end = fupInstant(iso(next), timeZone);
    return { kind: "calendar.availability" as const, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone };
  } catch { return null; }
}
export function renderCalendarObservation(raw: unknown) {
  const result = raw as { start: string; busy: { start: string; end: string }[]; events?: CalendarEventObservation[]; eventsCoverage?: { complete: boolean }; coverage: { complete: boolean; gaps: string[]; configuredCalendars: number } };
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "short" }).format(new Date(result.start));
  const clock = (at: string) => new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
  let text = `🗓️ <b>SUA AGENDA · ${date}</b>\n\n`;
  if (result.events) {
    let shown = 0, abbreviated = false;
    for (const event of result.events) {
      const title = telegramExcerpt(event.title, 320); abbreviated ||= title.truncated || event.titleTruncated;
      let when = "Horário indisponível";
      if (event.start?.date && event.end?.date) when = "Dia inteiro";
      else if (event.start?.dateTime && event.end?.dateTime) {
        const day = (at: string) => new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(new Date(at));
        when = day(event.start.dateTime) === day(event.end.dateTime) ? `${clock(event.start.dateTime)}–${clock(event.end.dateTime)}` : `${day(event.start.dateTime)} ${clock(event.start.dateTime)} → ${day(event.end.dateTime)} ${clock(event.end.dateTime)}`;
      }
      const line = `📌 <b>${when}</b>\n${title.html}${event.transparent ? "\n<i>Não bloqueia horário.</i>" : ""}\n\n`;
      if (text.length + line.length > 3300) break;
      text += line; shown++;
    }
    if (!result.events.length) text += result.eventsCoverage?.complete ? "✅ Nenhum compromisso observado nesse recorte.\n\n" : "⚠️ A leitura parcial não permite concluir quais compromissos há nesse dia.\n\n";
    if (shown < result.events.length) text += `📄 Mostrei ${shown} compromissos; há mais no recorte consultado.\n\n`;
    if (!result.eventsCoverage?.complete) text += "⚠️ Há lacunas na leitura dos compromissos.\n\n";
    if (abbreviated) text += "<i>Há títulos abreviados.</i>\n\n";
    if (!result.coverage.complete) text += "ℹ️ A consulta de horários livres também tem lacunas.\n\n";
    return text + `📍 <i>Horário de Fortaleza · ${result.coverage.configuredCalendars} agenda(s) autorizada(s).</i>\n\n<i>Consulta de leitura · a agenda pode mudar após a consulta.</i>`;
  }
  if (result.busy.length) {
    const shown = result.busy.slice(0, 50);
    text += "<b>Horários ocupados observados</b>\n\n" + shown.map(b => `⏳ ${clock(b.start)}–${clock(b.end)}`).join("\n");
    if (shown.length < result.busy.length) text += `\n\nMostrei ${shown.length} de ${result.busy.length} intervalos.`;
  } else text += result.coverage.complete ? "✅ Não observei conflito nesse dia nas agendas autorizadas consultadas." : "⚠️ A leitura incompleta não permite concluir se há horários ocupados nesse dia.";
  if (!result.coverage.complete) text += "\n\nHá lacunas na consulta; a disponibilidade continua parcial.";
  return text + `\n\n📍 <i>Horário de Fortaleza · ${result.coverage.configuredCalendars} agenda(s) autorizada(s).</i>\n\n<i>Somente leitura · a agenda pode mudar após a consulta.</i>`;
}
function calendarReplyProjection(raw: Record<string, any>) {
  const busy = raw.busy.slice(0, 10), events = raw.events.slice(0, 10);
  const result = { state: "available", origin: "calendar", audience: "owner", start: raw.start, end: raw.end, timeZone: raw.timeZone,
    busy, events, availability: raw.availability, observedAt: raw.observedAt, execution: "unconfirmed",
    coverage: { ...raw.coverage, complete: raw.coverage.complete && busy.length === raw.busy.length, gaps: [...raw.coverage.gaps, ...(busy.length < raw.busy.length ? ["telegram_busy_excerpt"] : [])] },
    eventsCoverage: { ...raw.eventsCoverage, complete: raw.eventsCoverage.complete && events.length === raw.events.length, returnedEvents: events.length,
      gaps: [...raw.eventsCoverage.gaps, ...(events.length < raw.events.length ? ["telegram_event_excerpt"] : [])] },
    sourceObservationHash: raw.hash, projection: "telegram_calendar_event_excerpt_v1" };
  while (new TextEncoder().encode(JSON.stringify(result)).length > 6000 && events.length) {
    events.pop(); result.eventsCoverage.complete = false; result.eventsCoverage.returnedEvents = events.length;
    if (!result.eventsCoverage.gaps.includes("telegram_event_excerpt")) result.eventsCoverage.gaps.push("telegram_event_excerpt");
  }
  return result;
}
export type CalendarObservation = { kind: "calendar"; query: NonNullable<ReturnType<typeof calendarDayQuery>>; result: unknown };
type Result = { state: "available"; text: string; observation: CalendarObservation; dependencies: ReplyDependency[] } | { state: "clarify" | "unavailable"; text: string };
export async function readTelegramCalendar(env: AssistantEnv, scope: SourceScope, text: string, occurredAt: number, boundary: CalendarReadBoundary): Promise<Result> {
  const query = calendarDayQuery(text, occurredAt);
  if (!query) return { state: "clarify", text: "🗓️ <b>Qual dia você quer consultar?</b>\n\nPor enquanto consulto um dia inteiro. Diga hoje, amanhã ou uma data completa (DD/MM/AAAA)." };
  try {
    await boundary.check();
    const configured = configuredCalendar(env, scope, boundary, true);
    if (configured.state !== "ready") return { state: "unavailable", text: "🔧 <b>Agenda indisponível</b>\n\nA conexão ou autorização do Google precisa ser verificada. Não consegui consultar os horários." };
    await configured.check();
    const dependencies: ReplyDependency[] = [], access = new ConnectorAccess(env.DB!, scope);
    for (const calendar of configured.calendars) {
      const source = await access.admit({ kind: "owner" }, calendar);
      if (!source) return { state: "unavailable", text: "🔒 <b>Agenda indisponível</b>\n\nNão há uma autorização ativa para consultar esta agenda." };
      if (!dependencies.some(dep => dep.source.source.id === source.source.id)) dependencies.push({ source });
    }
    const result = await configured.reader.execute({ kind: "owner" }, query) as Record<string, any>;
    await configured.check();
    if (result.state !== "available") return { state: "unavailable", text: "⚠️ <b>Não consegui concluir a consulta</b>\n\nA disponibilidade da agenda continua desconhecida." };
    const projection = calendarReplyProjection(result);
    return { state: "available", text: renderCalendarObservation(projection), observation: { kind: "calendar", query, result: projection }, dependencies: dependencies.sort((a, b) => a.source.source.id.localeCompare(b.source.source.id)) };
  } catch { return { state: "unavailable", text: "⚠️ <b>Consulta interrompida</b>\n\nNão consegui concluir a leitura da agenda. Ainda não posso informar os horários disponíveis." }; }
}
