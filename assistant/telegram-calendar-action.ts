import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
import type { AccessGuard } from "./access";
import { bridgeHash } from "./ingress";
import { calendarDayQuery } from "./telegram-calendar";
import { calendarConfiguration } from "./connectors/calendar";
import { ConnectorAccess } from "./connectors/read-only";
import { calendarOAuthName, oauthAffinity } from "./connectors/calendar-oauth";
import { calendarMutation, runCalendarAction, type CalendarMutation } from "./connectors/calendar-actions";
import type { DialogueWitness } from "./telegram-dialogue-state";
import type { ReplyDependency } from "./telegram-owner-replies";
import { telegramText } from "./telegram-format";

const timezone = "America/Fortaleza";
const quoted = '["“]([^"“”\\n]{1,256})["”]';
const day = '(hoje|amanh[ãa]|depois de amanh[ãa]|\\d{1,2}/\\d{1,2}/\\d{4})';
const times = '(\\d{1,2})(?::(\\d{2})|h(\\d{2})?)?';
const prefix = '(?:por favor[,\\s]+)?';
function interval(dayText: string, hours: string[], occurredAt: number) {
  const query = calendarDayQuery(dayText, occurredAt); if (!query) return null;
  const civil = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(query.start));
  const values = [0, 3].map(offset => { const hour = Number(hours[offset]), minute = Number(hours[offset + 1] || hours[offset + 2] || 0); return hour <= 23 && minute <= 59 ? `${civil}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-03:00` : null; });
  return values.every(Boolean) && Date.parse(values[1]!) > Date.parse(values[0]!) ? { start: values[0]!, end: values[1]! } : null;
}
/** Parse the authenticated whole instruction, never a quoted order extracted by a model. */
export function parseCalendarMutation(text: string, occurredAt: number): CalendarMutation | null {
  const input = text.trim().replace(/[.!]$/, "");
  let match = new RegExp(`^${prefix}(?:crie|cria|agende|agenda)\\s+(?:(?:um|o)\\s+)?(?:evento|compromisso)\\s+${quoted}\\s+(?:para |no dia |em )?${day}\\s+das?\\s+${times}\\s+[aà]s?\\s+${times}$`, "iu").exec(input);
  let result: unknown;
  if (match) { const span = interval(match[2], match.slice(3), occurredAt); if (!span) return null; result = { verb: "create", summary: match[1], ...span }; }
  else {
    match = new RegExp(`^${prefix}(renomeie|renomeia|exclua|exclui|apague|apaga|cancele|cancela|altere|altera|mude|muda)\\s+(?:(?:o|um)\\s+)?(?:evento|compromisso)\\s+${quoted}\\s+(?:de |do dia |no dia |em )?${day}(?:\\s+para\\s+([\\s\\S]+))?$`, "iu").exec(input);
    if (!match) return null;
    const query = calendarDayQuery(match[3], occurredAt); if (!query) return null;
    const base = { target: match[2], dayStart: query.start, dayEnd: query.end };
    if (/^(?:exclu|apag|cancel)/iu.test(match[1])) { if (match[4]) return null; result = { verb: "delete", ...base }; }
    else if (/^renome/i.test(match[1])) { const name = new RegExp(`^${quoted}$`, "u").exec(match[4] ?? ""); if (!name) return null; result = { verb: "edit", ...base, changes: { summary: name[1] } }; }
    else {
      const shift = new RegExp(`^(?:${day}\\s+)?das?\\s+${times}\\s+[aà]s?\\s+${times}$`, "iu").exec(match[4] ?? ""); if (!shift) return null;
      const span = interval(shift[1] ?? match[3], shift.slice(2), occurredAt); if (!span) return null;
      result = { verb: "edit", ...base, changes: { start: { dateTime: span.start, timeZone: timezone }, end: { dateTime: span.end, timeZone: timezone } } };
    }
  }
  const parsed = calendarMutation.safeParse(result); return parsed.success ? parsed.data : null;
}
const help = "🗓️ <b>Me diga a alteração e o evento</b>\n\nUse o título entre aspas e informe o dia. Exemplos:\n\n<i>Crie o evento “Revisão” amanhã das 14h às 15h.</i>\n\n<i>Renomeie o evento “Revisão” amanhã para “Planejamento”.</i>\n\n<i>Mude o evento “Planejamento” amanhã para das 16h às 17h.</i>\n\n<i>Exclua o evento “Planejamento” amanhã.</i>";
export async function changeTelegramCalendar(env: AssistantEnv, scope: SourceScope, input: { text: string; occurredAt: number; updateId: number; requestId: string; guard: () => AccessGuard; deadlineAt: number; signal?: AbortSignal; dependencies: ReplyDependency[] }) {
  const mutation = parseCalendarMutation(input.text, input.occurredAt);
  if (!mutation) return { text: help };
  if (!env.DB || !env.CALENDAR_OAUTH || env.CALENDAR_OAUTH_PERMISSION !== "write_owned" || !env.CALENDAR_WRITE_CALENDAR) return { text: "🔧 <b>Alterações na agenda em configuração</b>\n\nA conexão Google ainda precisa permitir criar, editar e excluir eventos. A leitura dos seus compromissos continua disponível." };
  try {
    const calendar = calendarConfiguration.parse(JSON.parse(env.CALENDAR_WRITE_CALENDAR));
    if (calendar.calendarId !== "primary") throw Error("calendar_write_configuration");
    const authority = await new ConnectorAccess(env.DB, scope).admit({ kind: "owner" }, calendar); if (!authority) throw Error("calendar_write_authority");
    input.dependencies.push({ source: authority });
    const affinity = oauthAffinity.parse({ installationId: scope.installationId, generation: scope.generation, configurationVersion: Number(env.CALENDAR_OAUTH_CONFIGURATION_VERSION), secretEpoch: env.CALENDAR_OAUTH_SECRET_EPOCH });
    const lifetime = AbortSignal.any([AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now())), ...(input.signal ? [input.signal] : [])]);
    const guard = () => lifetime.aborted ? { sql: "0", values: [] } : input.guard();
    const token = await env.CALENDAR_OAUTH.get(env.CALENDAR_OAUTH.idFromName(calendarOAuthName(affinity, "write_owned"))).token(affinity, "write_owned");
    if (token.state !== "ready" || token.expiresAt <= Date.now()) throw Error("calendar_write_consent");
    const id = await bridgeHash(["telegram-calendar-action-v1", scope.installationId, scope.generation, input.requestId, input.updateId]);
    const result = await runCalendarAction(env.DB, scope, mutation, { id, requestId: input.requestId, authorityId: authority.source.id, affinity: { ...affinity, permission: "write_owned", calendar }, guard, token: token.accessToken,
      request: request => fetch(new Request(request, { signal: AbortSignal.any([request.signal, lifetime]) })) });
    const { outcome } = result;
    const states = { create: "criado", edit: "alterado", delete: "excluído" };
    const text = outcome.state === "applied" ? `✅ <b>Evento ${states[outcome.verb]} na sua agenda</b>\n\n${telegramText(outcome.summary, 1200)}`
      : outcome.state === "conflict" ? "⚠️ <b>O evento mudou durante a operação</b>\n\nNão apliquei a alteração sobre a versão nova. Consulte o evento e faça um novo pedido."
      : outcome.state === "rejected" ? "⚠️ <b>O Google recusou a alteração</b>\n\nNão confirmei a operação. É preciso verificar a conexão e as permissões."
      : "⚠️ <b>Não consegui confirmar a alteração</b>\n\nA operação pode ter sido realizada no Google. Não vou repeti-la automaticamente; confira a agenda antes de fazer outro pedido.";
    return { text, ...(result.resultJSON ? { witness: { kind: "calendar_action", actionId: id, resultJSON: result.resultJSON } as DialogueWitness } : {}) };
  } catch { return { text: "⚠️ <b>Não consegui alterar esse evento</b>\n\nConfira o título e o dia. Nesta etapa, altero eventos únicos da sua agenda principal, organizados por você e sem convidados. Se o pedido chegou ao Google sem confirmação, ele não será repetido automaticamente." }; }
}
