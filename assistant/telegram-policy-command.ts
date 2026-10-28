import { z } from "zod";
import type { AssistantEnv } from "./env";
import type { OwnerAffinity } from "./mcp";
import type { AccessGuard } from "./access";
import { OwnerControl } from "./control";
import { OriginGuard, type SnapshotReader } from "./origin-guard";
import type { DialogueWitness } from "./telegram-dialogue-state";
import { jsonStatement } from "./d1-statement";
import { telegramText } from "./telegram-format";

const quoted = '(?:"([^"\\n]+)"|“([^”\\n]+)”|«([^»\\n]+)»)';
export function parseTelegramPolicyCommand(text: string): { action: "observe" | "ignore" | "exclude"; name: string } | null {
  for (const [action, prefix, suffix] of [["observe", '(?:acompanhe|acompanha)\\s+em\\s+sombra\\s+o\\s+grupo\\s+', ''], ["ignore", '(?:ignore|ignora)\\s+o\\s+grupo\\s+', ''], ["exclude", '(?:exclua|exclui)\\s+a\\s+conversa\\s+', '\\s+do\\s+assistente']] as const) {
    const found = new RegExp('^(?:por favor[,\\s]+)?' + prefix + quoted + suffix + '[.!]?$', 'iu').exec(text.trim()), name = found && (found[1] || found[2] || found[3]);
    if (name && name.length <= 256) return { action, name };
  }
  return null;
}
const id = z.string().min(1).max(256), rev = z.number().int().nonnegative().safe();
const commandSchema = z.object({ kind: z.literal("policy.put"), operationId: id, id, expectedRevision: rev, conversationKind: z.enum(["private", "group"]), excluded: z.literal(true).optional(), groupMode: z.enum(["ignore", "observe", "respond"]) }).strict().refine(command => command.groupMode !== "respond" || command.excluded === true);
const frozenSchema = z.object({ kind: z.literal("telegram_owner_policy_command"), updateId: rev, operationId: id, action: z.enum(["observe", "ignore", "exclude"]), name: id,
  target: z.object({ chatId: id, kind: z.enum(["private", "group"]), watermark: rev, hash: z.string().regex(/^[a-f0-9]{64}$/), sourceVersion: rev.nullable(), revision: rev, excluded: z.number().int().min(0).max(1), groupMode: z.enum(["ignore", "observe", "respond"]) }).strict(), command: commandSchema }).strict().refine(frozen => frozen.command.groupMode !== "respond" || (frozen.action === "exclude" && frozen.command.excluded === true && frozen.command.groupMode === frozen.target.groupMode));
type Input = { episodeId: string; bindingHash: string; updateId: number; operationId: string; text: string; guard: () => AccessGuard };
type Result = { state: "clarify"; text: string } | { state: "applied"; text: string; witness: DialogueWitness; checkpointJSON: string };
const clarify = (): Result => ({ state: "clarify", text: "⚙️ <b>Qual conversa você quer configurar?</b>\n\nUse o nome completo entre aspas:\n\n<i>Acompanhe em sombra o grupo “…”</i>\n<i>Ignore o grupo “…”</i>\n<i>Exclua a conversa “…” do assistente</i>" });
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("pt-BR");
const discoverySchema = z.object({ observation: z.literal("capture_conversation_search"), requestId: id, sourceEpoch: id, sourceGeneration: id, state: z.literal("available"),
  refs: z.array(z.object({ chatId: id, kind: z.enum(["private", "group"]) }).strict()).max(20), complete: z.boolean(), nextCursor: id.nullable() }).strict();
export async function changeTelegramPolicy(env: AssistantEnv, scope: OwnerAffinity, input: Input): Promise<Result> {
  const parsed = parseTelegramPolicyCommand(input.text); if (!parsed) return clarify();
  const db = env.DB!, reader = env.CAPTURE_READER as SnapshotReader & { searchConversations?: (input: unknown) => Promise<unknown> };
  if (!db || !reader?.searchConversations || !env.BRIDGE_SECRET || env.BRIDGE_SECRET.length < 32) return clarify();
  const keys = [scope.installationId, scope.generation], originKeys = [...keys, scope.sourceEpoch, scope.sourceGeneration], episodeKeys = [...keys, input.episodeId, input.bindingHash];
  const origin = new OriginGuard(db, () => scope, reader, env.BRIDGE_SECRET, 2000, "owner_read");
  const check = async () => { const g = input.guard(); if (!await jsonStatement(db, `SELECT 1 WHERE ${g.sql}`, g.values).first()) throw Error("policy_denied"); };
  const read = () => db.prepare("SELECT result_json FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=?").bind(...episodeKeys).first<{ result_json: string | null }>();
  let stored = await read(); if (!stored) throw Error("policy_episode_missing");
  if (stored.result_json === null) {
    await check(); const requestId = crypto.randomUUID(), found = new Map<string, "private" | "group">(); let cursor: string | null = null, complete = false;
    for (let page = 0; page < 5 && !complete; page++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const value = await Promise.race([reader.searchConversations({ secret: env.BRIDGE_SECRET, sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration, name: parsed.name, requestId, cursor }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("policy_discovery_timeout")), 2000); })]).finally(() => clearTimeout(timer));
      await check();
      if (new TextEncoder().encode(JSON.stringify(value)).length > 12288) return clarify();
      const result = discoverySchema.safeParse(value); if (!result.success) return clarify(); const r = result.data;
      if (r.requestId !== requestId || r.sourceEpoch !== scope.sourceEpoch || r.sourceGeneration !== scope.sourceGeneration || (r.complete ? r.nextCursor !== null : !r.nextCursor || r.nextCursor === cursor)) return clarify();
      for (const ref of r.refs) { if (found.has(ref.chatId) && found.get(ref.chatId) !== ref.kind) return clarify(); found.set(ref.chatId, ref.kind); }
      cursor = r.nextCursor; complete = r.complete;
    }
    if (!complete || found.size !== 1) return clarify();
    const [chatId, kind] = [...found][0]; if (parsed.action !== "exclude" && kind !== "group") return clarify();
    const observed = await origin.observe(scope, { sourceKind: "conversation", sourceId: chatId, chatId });
    if (observed.state !== "available" || observed.kind !== kind || !observed.hash || observed.watermark === null || !observed.content?.name || normalize(observed.content.name) !== normalize(parsed.name)) return clarify();
    const local = await db.prepare("SELECT kind,watermark FROM assistant_origin_conversations WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND chat_id=? AND access_state='available'").bind(...originKeys, chatId).first<{ kind: string; watermark: number }>();
    if (!local || local.kind !== kind || local.watermark !== observed.watermark) return clarify();
    const current = await db.prepare("SELECT revision,kind,excluded,group_mode FROM assistant_conversation_policies WHERE installation_id=? AND generation=? AND conversation_id=?").bind(...keys, chatId).first<{ revision: number; kind: string; excluded: number; group_mode: "ignore" | "observe" | "respond" }>();
    if (current && current.kind !== kind) return clarify();
    if (current?.excluded && parsed.action !== "exclude") return { state: "clarify", text: "Essa conversa está excluída. Não vou reativá-la ao alterar o acompanhamento." };
    const target = { chatId, kind, watermark: observed.watermark, hash: observed.hash, sourceVersion: observed.sourceVersion, revision: current?.revision ?? 0, excluded: current?.excluded ?? 0, groupMode: current?.group_mode ?? "ignore" };
    const command = { kind: "policy.put" as const, operationId: input.operationId, id: chatId, expectedRevision: target.revision, conversationKind: kind,
      groupMode: parsed.action === "exclude" ? target.groupMode : parsed.action === "observe" ? "observe" : "ignore", ...(parsed.action === "exclude" ? { excluded: true as const } : {}) };
    const frozen = frozenSchema.parse({ kind: "telegram_owner_policy_command", updateId: input.updateId, operationId: input.operationId, action: parsed.action, name: parsed.name, target, command }), g = input.guard();
    await jsonStatement(db, `UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json IS NULL AND (${g.sql})`, [JSON.stringify(frozen), ...episodeKeys, ...g.values]).run();
    stored = await read();
  }
  const frozen = frozenSchema.parse(JSON.parse(stored?.result_json ?? "null")), checkpointJSON = stored!.result_json!, target = frozen.target;
  if (frozen.operationId !== input.operationId || frozen.updateId !== input.updateId || frozen.action !== parsed.action || frozen.name !== parsed.name || frozen.command.operationId !== input.operationId
    || frozen.command.id !== target.chatId || frozen.command.conversationKind !== target.kind || frozen.command.expectedRevision !== target.revision
    || frozen.command.groupMode !== (parsed.action === "exclude" ? target.groupMode : parsed.action === "observe" ? "observe" : "ignore") || (frozen.command.excluded === true) !== (parsed.action === "exclude")) throw Error("policy_checkpoint_conflict");
  // A recovered command receipt is historical; no fresh discovery/selection.
  const receipt = await db.prepare("SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id=?").bind(...keys, input.operationId).first();
  if (!receipt) {
    await check(); const observed = await origin.observe(scope, { sourceKind: "conversation", sourceId: target.chatId, chatId: target.chatId });
    if (observed.state !== "available" || observed.kind !== target.kind || observed.watermark !== target.watermark || observed.hash !== target.hash || observed.sourceVersion !== target.sourceVersion || !observed.content?.name || normalize(observed.content.name) !== normalize(frozen.name)) throw Error("policy_origin_changed");
  }
  const admission = () => { const g = input.guard(); return { sql: `(${g.sql}) AND EXISTS(SELECT 1 FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json=?)
    AND EXISTS(SELECT 1 FROM assistant_origin_conversations WHERE installation_id=? AND generation=? AND source_epoch=? AND source_generation=? AND chat_id=? AND kind=? AND watermark=? AND access_state='available')
    AND ${target.revision ? "EXISTS(SELECT 1 FROM assistant_conversation_policies WHERE installation_id=? AND generation=? AND conversation_id=? AND revision=? AND kind=? AND excluded=? AND group_mode=?)" : "NOT EXISTS(SELECT 1 FROM assistant_conversation_policies WHERE installation_id=? AND generation=? AND conversation_id=?)"}`,
    values: [...g.values, ...episodeKeys, checkpointJSON, ...originKeys, target.chatId, target.kind, target.watermark, ...keys, target.chatId, ...(target.revision ? [target.revision, target.kind, target.excluded, target.groupMode] : [])] }; };
  const result = await new OwnerControl(db, scope, { kind: "owner" }, Date.now, undefined, admission).execute(frozen.command);
  const text = parsed.action === "exclude" ? "Conversa excluída do uso pelo assistente." : parsed.action === "observe" ? "Grupo configurado para acompanhamento em sombra." : "Grupo configurado para ignorar.";
  return { state: "applied", text: "✅ <b>Política atualizada</b>\n\n" + telegramText(frozen.name) + "\n\n" + text + " As rotinas continuam pausadas, sem envios automáticos.", checkpointJSON,
    witness: { kind: "owner_command", operationId: input.operationId, resultJSON: JSON.stringify(result) } };
}
