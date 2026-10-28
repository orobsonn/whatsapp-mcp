import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
import type { ReplyDependency } from "./telegram-owner-replies";
import { configuredCalendar, type CalendarReadBoundary } from "./connectors/configured-calendar";
import { ConnectorAccess } from "./connectors/read-only";
import { fupInstant } from "./followups";

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
  const result = raw as { start: string; busy: { start: string; end: string }[]; coverage: { complete: boolean; gaps: string[]; configuredCalendars: number } };
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "short" }).format(new Date(result.start));
  const clock = (at: string) => new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
  let text = `🗓️ <b>SUA AGENDA · ${date}</b>\n\n`;
  if (result.busy.length) {
    const shown = result.busy.slice(0, 50);
    text += "<b>Horários ocupados observados</b>\n\n" + shown.map(b => `⏳ ${clock(b.start)}–${clock(b.end)}`).join("\n");
    if (shown.length < result.busy.length) text += `\n\nMostrei ${shown.length} de ${result.busy.length} intervalos.`;
  } else text += result.coverage.complete ? "✅ Não observei conflito nesse dia nas agendas autorizadas consultadas." : "⚠️ A leitura incompleta não permite concluir se há horários ocupados nesse dia.";
  if (!result.coverage.complete) text += "\n\nHá lacunas na consulta; a disponibilidade continua parcial.";
  return text + `\n\n📍 <i>Horário de Fortaleza · ${result.coverage.configuredCalendars} agenda(s) autorizada(s).</i>\n\n<i>Somente leitura · a agenda pode mudar após a consulta.</i>`;
}
export type CalendarObservation = { kind: "calendar"; query: NonNullable<ReturnType<typeof calendarDayQuery>>; result: unknown };
type Result = { state: "available"; text: string; observation: CalendarObservation; dependencies: ReplyDependency[] } | { state: "clarify" | "unavailable"; text: string };
export async function readTelegramCalendar(env: AssistantEnv, scope: SourceScope, text: string, occurredAt: number, boundary: CalendarReadBoundary): Promise<Result> {
  const query = calendarDayQuery(text, occurredAt);
  if (!query) return { state: "clarify", text: "🗓️ <b>Qual dia você quer consultar?</b>\n\nPor enquanto consulto um dia inteiro. Diga hoje, amanhã ou uma data completa (DD/MM/AAAA)." };
  try {
    await boundary.check();
    const configured = configuredCalendar(env, scope, boundary);
    if (configured.state !== "ready") return { state: "unavailable", text: "🔧 <b>Agenda indisponível</b>\n\nA conexão ou autorização do Google precisa ser verificada. Não consegui consultar os horários." };
    await configured.check();
    const dependencies: ReplyDependency[] = [], access = new ConnectorAccess(env.DB!, scope);
    for (const calendar of configured.calendars) {
      const source = await access.admit({ kind: "owner" }, calendar);
      if (!source) return { state: "unavailable", text: "🔒 <b>Agenda indisponível</b>\n\nNão há uma autorização ativa para consultar esta agenda." };
      if (!dependencies.some(dep => dep.source.source.id === source.source.id)) dependencies.push({ source });
    }
    const result = await configured.reader.execute({ kind: "owner" }, query) as { state: string };
    await configured.check();
    if (result.state !== "available") return { state: "unavailable", text: "⚠️ <b>Não consegui concluir a consulta</b>\n\nA disponibilidade da agenda continua desconhecida." };
    return { state: "available", text: renderCalendarObservation(result), observation: { kind: "calendar", query, result }, dependencies: dependencies.sort((a, b) => a.source.source.id.localeCompare(b.source.source.id)) };
  } catch { return { state: "unavailable", text: "⚠️ <b>Consulta interrompida</b>\n\nNão consegui concluir a leitura da agenda. Ainda não posso informar os horários disponíveis." }; }
}
