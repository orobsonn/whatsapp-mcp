import { z } from "zod";
import type { AccessGuard } from "./access";
import type { SourceScope } from "./sources";
import { OwnerControl } from "./control";
import { jsonStatement } from "./d1-statement";
import type { DialogueWitness } from "./telegram-dialogue-state";
import { telegramText } from "./telegram-format";

const label = z.string().min(1).max(256), revision = z.number().int().positive();
const frozenSchema = z.object({ kind: z.literal("telegram_owner_mission_command"), updateId: z.number().int().nonnegative(), operationId: label,
  command: z.object({ kind: z.literal("mission.set_state"), operationId: label, id: label, expectedRevision: revision, state: z.enum(["resolved", "cancelled", "paused"]) }).strict(),
  target: z.object({ id: label, revision, objective: z.string().min(1).max(2048), sourceId: label, sourceRevision: revision, state: label }).strict() }).strict();
type Input = { episodeId: string; bindingHash: string; updateId: number; operationId: string; text: string; guard: () => AccessGuard };
type Result = { state: "clarify"; text: string } | { state: "applied"; text: string; witness: DialogueWitness; checkpointJSON: string };
const clarify = (): Result => ({ state: "clarify", text: "🎯 <b>Qual missão você quer alterar?</b>\n\nEscreva a ação e o objetivo completo. Use aspas se houver uma condição no título:\n\n<i>Conclua a missão: “…”</i>\n<i>Cancele a missão: “…”</i>\n<i>Pause a missão: “…”</i>" });

/** An administrative command, not proof that the mission's work was performed.
 * Its existing episode freezes selection before the effect, including on retry. */
export async function setTelegramMissionState(db: D1Database, scope: SourceScope, input: Input): Promise<Result> {
  const match = !input.text.includes("?") && /^(?:por favor[,\s]+)?(conclua|finalize|finaliza|cancele|cancela|pause|pausa)\s+(?:(?:a|essa|esta)\s+)?miss[aã]o(?:\s*[:\-]\s*|\s+)([\s\S]+)$/iu.exec(input.text.trim());
  if (!match || !match[2].trim() || match[2].trim().length > 2048) return clarify();
  const raw = match[2].trim(), quoted = /^(?:"[\s\S]+"|“[\s\S]+”|«[\s\S]+»)$/u.test(raw);
  // A condition may belong to a title or qualify the requested action. Only
  // explicit title delimiters remove that ambiguity; never evaluate it here.
  if (!quoted && /\b(?:se|caso|quando|desde\s+que)\b/iu.test(raw)) return clarify();
  const objective = quoted ? raw.slice(1, -1) : raw, state = /^(?:conclua|finaliz)/iu.test(match[1]) ? "resolved" : /^cancel/iu.test(match[1]) ? "cancelled" : "paused";
  const keys = [scope.installationId, scope.generation], episodeKeys = [...keys, input.episodeId, input.bindingHash];
  const read = () => db.prepare("SELECT result_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=?").bind(...episodeKeys).first<{ result_json: string | null }>();
  let stored = await read(); if (!stored) throw Error("mission_episode_missing");
  if (stored.result_json === null) {
    const targets = (await db.prepare("SELECT id,revision,objective,source_id AS sourceId,source_revision AS sourceRevision,state FROM assistant_missions WHERE installation_id=? AND generation=? AND objective=? ORDER BY id LIMIT 2").bind(...keys, objective).all()).results;
    if (targets.length !== 1) return clarify();
    const target = frozenSchema.shape.target.parse(targets[0]), frozen = frozenSchema.parse({ kind: "telegram_owner_mission_command", updateId: input.updateId, operationId: input.operationId, target,
      command: { kind: "mission.set_state", operationId: input.operationId, id: target.id, expectedRevision: target.revision, state } });
    const guard = input.guard();
    await jsonStatement(db, `UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json IS NULL AND (${guard.sql})`, [JSON.stringify(frozen), ...episodeKeys, ...guard.values]).run();
    stored = await read();
  }
  const frozen = frozenSchema.parse(JSON.parse(stored?.result_json ?? "null")), checkpointJSON = stored!.result_json!;
  if (frozen.operationId !== input.operationId || frozen.updateId !== input.updateId || frozen.command.operationId !== input.operationId || frozen.command.state !== state
    || frozen.target.objective !== objective || frozen.command.id !== frozen.target.id || frozen.command.expectedRevision !== frozen.target.revision) throw Error("mission_checkpoint_conflict");
  const target = frozen.target;
  const admission = () => {
    const guard = input.guard();
    return { sql: `(${guard.sql}) AND EXISTS(SELECT 1 FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json=?)
      AND (SELECT COUNT(*) FROM assistant_missions WHERE installation_id=? AND generation=? AND objective=?)=1
      AND EXISTS(SELECT 1 FROM assistant_missions WHERE installation_id=? AND generation=? AND id=? AND revision=? AND objective=? AND source_id=? AND source_revision=? AND state=?)`,
      values: [...guard.values, ...episodeKeys, checkpointJSON, ...keys, objective, ...keys, target.id, target.revision, objective, target.sourceId, target.sourceRevision, target.state] };
  };
  const result = await new OwnerControl(db, scope, { kind: "owner" }, Date.now, undefined, admission).execute(frozen.command);
  const labels = { resolved: ["✅", "concluída"], cancelled: ["❌", "cancelada"], paused: ["⏸️", "pausada"] }, [icon, label] = labels[state];
  return { state: "applied", text: `${icon} <b>Você marcou a missão como ${label}</b>\n\n${telegramText(objective, 2500)}`, checkpointJSON,
    witness: { kind: "owner_command", operationId: input.operationId, resultJSON: JSON.stringify(result) } };
}
