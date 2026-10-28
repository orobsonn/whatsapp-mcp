import { z } from "zod";
import { SourceAccess, type AccessGuard } from "./access";
import { SourceController, type SourceScope } from "./sources";
import { sourceFence } from "./agent/contracts";
import type { SourceRetirementGuard } from "./retention-authority";
import type { DialogueWitness } from "./telegram-dialogue-state";
import { jsonStatement } from "./d1-statement";
import { telegramText } from "./telegram-format";

const quoted = '(?:"([^"\\n]+)"|“([^”\\n]+)”|«([^»\\n]+)»)';
export function parseTelegramNoteCommand(text: string): { action: "correct" | "withdraw"; title: string; text?: string } | null {
  const correct = new RegExp('^(?:por favor[,\\s]+)?(?:corrija|corrige)\\s+a\\s+nota\\s+' + quoted + '\\s+para\\s*:\\s*([\\s\\S]+)$', 'iu').exec(text.trim());
  if (correct) { const title = correct[1] || correct[2] || correct[3], body = correct[4].trim(); return title.length <= 512 && body.length > 0 && body.length <= 2048 ? { action: "correct", title, text: body } : null; }
  const withdraw = new RegExp('^(?:por favor[,\\s]+)?(?:esqueça|esqueca|retire)\\s+a\\s+nota\\s+' + quoted + '[.!]?$', 'iu').exec(text.trim());
  const title = withdraw && (withdraw[1] || withdraw[2] || withdraw[3]);
  return title && title.length <= 512 ? { action: "withdraw", title } : null;
}
const frozenSchema = z.object({ kind: z.literal("telegram_owner_note_command"), updateId: z.number().int().nonnegative(), operationId: z.string().min(1),
  title: z.string().min(1).max(512), fence: sourceFence, command: z.union([
    z.object({ kind: z.literal("source.correct"), operationId: z.string(), id: z.string(), expectedRevision: z.number().int().positive(), text: z.string().min(1).max(2048), occurredAt: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("source.withdraw"), operationId: z.string(), id: z.string(), expectedRevision: z.number().int().positive() }).strict(),
  ]) }).strict();
type Input = { episodeId: string; bindingHash: string; updateId: number; operationId: string; text: string; occurredAt: number; guard: () => AccessGuard };
type Result = { state: "clarify"; text: string } | { state: "applied"; text: string; witness: DialogueWitness; checkpointJSON: string };
const clarify = (): Result => ({ state: "clarify", text: "📝 <b>Qual nota você quer alterar?</b>\n\nUse o título completo entre aspas:\n\n<i>Corrija a nota “…” para: …</i>\n<i>Esqueça a nota “…”</i>" });
export async function changeTelegramNote(db: D1Database, scope: SourceScope, input: Input, retirement: SourceRetirementGuard): Promise<Result> {
  const parsed = parseTelegramNoteCommand(input.text); if (!parsed) return clarify();
  const keys = [scope.installationId, scope.generation], episodeKeys = [...keys, input.episodeId, input.bindingHash], access = new SourceAccess(db, scope);
  const read = () => db.prepare("SELECT result_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=?").bind(...episodeKeys).first<{ result_json: string | null }>();
  let stored = await read(); if (!stored) throw Error("note_episode_missing");
  if (stored.result_json === null) {
    const visible = access.ownerRows(Date.now());
    const matches = await db.prepare(`WITH visible AS (${visible.sql}) SELECT v.id,v.revision FROM visible v JOIN assistant_sources s ON s.installation_id=? AND s.generation=? AND s.id=v.id AND s.revision=v.revision WHERE v.origin='owner_note' AND s.title=? ORDER BY v.id LIMIT 2`).bind(...visible.values, ...keys, parsed.title).all<{ id: string; revision: number }>();
    if (matches.results.length !== 1) return clarify();
    const source = await access.read({ kind: "owner" }, matches.results[0].id, matches.results[0].revision); if (!source) return clarify();
    const command = { kind: parsed.action === "correct" ? "source.correct" as const : "source.withdraw" as const, operationId: input.operationId, id: source.id, expectedRevision: source.fence.source.revision,
      ...(parsed.action === "correct" ? { text: parsed.text!, occurredAt: input.occurredAt } : {}) };
    const frozen = frozenSchema.parse({ kind: "telegram_owner_note_command", updateId: input.updateId, operationId: input.operationId, title: parsed.title, fence: source.fence, command });
    const guard = input.guard(), sourceGuard = access.guard({ kind: "owner" }, source.fence, Date.now());
    await jsonStatement(db, `UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json IS NULL AND (${guard.sql}) AND (${sourceGuard.sql})`, [JSON.stringify(frozen), ...episodeKeys, ...guard.values, ...sourceGuard.values]).run();
    stored = await read();
  }
  const frozen = frozenSchema.parse(JSON.parse(stored?.result_json ?? "null")), checkpointJSON = stored!.result_json!;
  if (frozen.operationId !== input.operationId || frozen.updateId !== input.updateId || frozen.title !== parsed.title || frozen.command.operationId !== input.operationId
    || frozen.command.id !== frozen.fence.source.id || frozen.command.expectedRevision !== frozen.fence.source.revision || frozen.command.kind !== (parsed.action === "correct" ? "source.correct" : "source.withdraw")
    || (frozen.command.kind === "source.correct" && (frozen.command.text !== parsed.text || frozen.command.occurredAt !== input.occurredAt))) throw Error("note_checkpoint_conflict");
  const admission = () => {
    const guard = input.guard(), sourceGuard = access.guard({ kind: "owner" }, frozen.fence, Date.now());
    return { sql: `(${guard.sql}) AND (${sourceGuard.sql}) AND EXISTS(SELECT 1 FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json=?)
      AND (SELECT COUNT(*) FROM assistant_sources WHERE installation_id=? AND generation=? AND origin='owner_note' AND status='active' AND title=?)=1`,
      values: [...guard.values, ...sourceGuard.values, ...episodeKeys, checkpointJSON, ...keys, parsed.title] };
  };
  const result = await new SourceController(db, scope, { kind: "owner" }, Date.now, retirement, admission).execute(frozen.command);
  return { state: "applied", text: parsed.action === "correct" ? "✅ <b>Nota corrigida</b>\n\n" + telegramText(frozen.title) : "✅ <b>Nota retirada do uso</b>\n\n" + telegramText(frozen.title),
    checkpointJSON, witness: { kind: "owner_command", operationId: input.operationId, resultJSON: JSON.stringify(result) } };
}
