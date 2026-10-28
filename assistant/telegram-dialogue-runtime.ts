import { z } from "zod";
import type { AssistantEnv } from "./env";
import type { OwnerAffinity } from "./mcp";
import { TelegramOwnerInbox } from "./telegram-owner-inbox";
import { TelegramOwnerRequests } from "./telegram-owner-requests";
import { TelegramOwnerReplies } from "./telegram-owner-replies";
import { TelegramBotApi } from "./telegram";
import { DialogueState, dialogueWitnesses, type DialogueWitness } from "./telegram-dialogue-state";
import { OwnerDialoguePhases } from "./telegram-dialogue-phases";
import { Episodes, type Episode } from "./agent/episodes";
import { JobQueue, type JobLease } from "./queue";
import { SourceAccess, type AccessGuard, type SourceFence } from "./access";
import { SourceController } from "./sources";
import { OwnerControl } from "./control";
import { configuredRetirementGuard } from "./retention-authority";
import { assertRestoredGeneration } from "./retention-runtime";
import { DEFAULT_BROKER_CONFIG, createOpenAIAdapter } from "./model-transport";
import { bridgeHash } from "./ingress";
import { jsonStatement } from "./d1-statement";
import { ownerDialogueDriver } from "./agent-runtime/driver";
import { OWNER_DIALOGUE_COMPLETION, type EpisodePayload } from "./agent-runtime/provider";
import type { RuntimeIdentity } from "./agent/controller";
import { nativeReceipt } from "./agent/contracts";

const message = "Execute the admitted private dialogue.";
const intent = z.object({ kind: z.enum(["greet", "list", "note", "mission", "observe", "clarify", "unsupported"]),
  entity: z.enum(["notes", "missions", "follow_ups", "policies"]).nullable(), text: z.string().max(2048).nullable(), title: z.string().max(120).nullable(), conversationId: z.string().max(256).nullable() }).strict();
const intentSchema = { type: "object", additionalProperties: false, required: ["kind", "entity", "text", "title", "conversationId"], properties: {
  kind: { type: "string", enum: ["greet", "list", "note", "mission", "observe", "clarify", "unsupported"] }, entity: { type: ["string", "null"], enum: ["notes", "missions", "follow_ups", "policies", null] },
  text: { type: ["string", "null"] }, title: { type: ["string", "null"] }, conversationId: { type: ["string", "null"] },
} };
const merge = (...guards: AccessGuard[]): AccessGuard => ({ sql: guards.map(g => `(${g.sql})`).join(" AND "), values: guards.flatMap(g => g.values) });
const sqlNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
type Plan = { kind: "telegram_owner_reply_plan"; updateId: number; text: string; witnesses: DialogueWitness[];
  outboxRequestHash: string; intentOperationKey: string; intentRequestHash: string; intentResultHash: string };
/** Owner-only canary coordinator. The model interprets the authenticated
 * request; host readers/controllers produce facts and canonical receipts. */
export class TelegramDialogueHost {
  readonly scope: OwnerAffinity;
  readonly inbox: TelegramOwnerInbox;
  private readonly db: D1Database;
  private readonly episodes: Episodes;
  private readonly state: DialogueState;
  constructor(private readonly env: AssistantEnv) {
    if (env.TELEGRAM_OWNER_DIALOGUE_ENABLED !== "shadow" || env.FLUE_EPISODES_ENABLED !== "shadow" || !env.DB || !env.OPENAI_API_KEY || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_INSTANCE || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || !env.BRIDGE_SOURCE_EPOCH || !env.BRIDGE_SOURCE_GENERATION) throw Error("dialogue_unconfigured");
    this.db = env.DB; this.scope = Object.freeze({ installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION, sourceEpoch: env.BRIDGE_SOURCE_EPOCH, sourceGeneration: env.BRIDGE_SOURCE_GENERATION });
    this.inbox = new TelegramOwnerInbox(this.db, this.scope, env.TELEGRAM_BOT_INSTANCE); this.episodes = new Episodes(this.db, this.scope); this.state = new DialogueState(this.db, this.scope);
  }
  private queue(turn: Parameters<TelegramOwnerInbox["guard"]>[0]) { return new JobQueue(this.db, this.scope, { kind: "owner" }, async () => this.inbox.guard(turn)); }
  private replies(signal?: AbortSignal) { return new TelegramOwnerReplies(this.db, this.scope, this.env.TELEGRAM_BOT_INSTANCE!, this.inbox,
    check => new TelegramBotApi(this.env.TELEGRAM_BOT_TOKEN, this.env.TELEGRAM_BOT_INSTANCE!, fetch, async () => {
      if (signal?.aborted) throw Error("dialogue_cancelled"); await check(); if (signal?.aborted) throw Error("dialogue_cancelled");
    })); }
  async start(updateId: number) {
    await assertRestoredGeneration(this.env);
    const turn = await this.inbox.claim(updateId); if (!turn) return { state: "not_claimed" };
    const retirement = configuredRetirementGuard(this.env); if (!retirement) throw Error("dialogue_retention_required");
    const ref = await new TelegramOwnerRequests(this.db, this.inbox, retirement).capture(turn); if (!ref) return { state: "blocked" };
    const source = (await new SourceAccess(this.db, this.scope).read({ kind: "owner" }, ref.id, ref.revision))?.fence; if (!source) return { state: "blocked" };
    const queue = this.queue(turn), period = new Date().toISOString().slice(0, 10), checkpoint = await this.inbox.checkpoint(turn);
    const job = await queue.enqueue({ kind: "reasoning", dedupeKey: "telegram-owner-v1:" + ref.id, sourceId: ref.id, sourceRevision: 1, request: "telegram-owner-dialogue-v1", maxAttempts: 1, runtime: "flue_owner_dialogue" }, Date.now(), { id: crypto.randomUUID(), guard: this.inbox.guard(turn), statements: [] });
    const lease = await queue.claimId(job.id, Date.now(), Math.max(1, turn.deadlineAt - Date.now()), this.inbox.guard(turn)); if (!lease) return { state: "blocked" };
    const ledger = (await queue.ledger(job.id))!, deadlineAt = Math.min(Date.now() + 60000, turn.deadlineAt - 1);
    const binding = { kind: "telegram_owner_dialogue", scope: this.scope, checkpoint, source, lease, config: DEFAULT_BROKER_CONFIG, period, deadlineAt, updateId };
    let episode = await this.episodes.prepare({ lease, requestHash: ledger.request_hash, profile: "owner", checkpoint: checkpoint.fingerprint, binding, deadline: deadlineAt, maxCalls: 2 });
    episode = await this.episodes.envelope(episode.id, { message, initialData: { bindingId: episode.id }, idempotencyKey: "dialogue:" + episode.id });
    if (!await this.episodes.dispatch(episode.id)) return { state: "not_dispatched" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = nativeReceipt.parse(await Promise.race([ownerDialogueDriver(episode.runtime_id).dispatch(episode.envelope as Parameters<ReturnType<typeof ownerDialogueDriver>["dispatch"]>[0]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("dialogue_dispatch_timeout")), 5000); })]));
      await this.episodes.accept(episode.id, { profile: "owner", runtimeId: episode.runtime_id, bindingHash: episode.binding_hash, envelopeHash: episode.dispatch_hash, receipt }, receipt.submissionId);
      return { state: "accepted" };
    } catch {
      // A lost transport acknowledgement cannot cancel a native invocation
      // that has already authenticated its submission and begun execution.
      await this.db.prepare("UPDATE assistant_episodes SET state='uncertain',reason='dispatch_ack' WHERE installation_id=? AND generation=? AND id=? AND submission_id IS NULL AND receipt_json IS NULL AND state='dispatching'")
        .bind(this.scope.installationId, this.scope.generation, episode.id).run();
      return { state: "uncertain" };
    }
    finally { if (timer) clearTimeout(timer); }
  }
  async model(id: string, identity: RuntimeIdentity, payload: EpisodePayload, signal?: AbortSignal): Promise<string> {
    await assertRestoredGeneration(this.env);
    const episode = await this.episodes.get(id), b = episode?.binding as any;
    if (!episode || b?.kind !== "telegram_owner_dialogue" || JSON.stringify(b.scope) !== JSON.stringify(this.scope) || identity.profile !== "owner-dialogue" || identity.runtimeId !== episode.runtime_id
      || !payload.messages.some(m => m.role === "user" && m.content === message) || !await this.episodes.submission(id, identity.submissionId)) throw Error("dialogue_denied");
    const turn = await this.inbox.resume(b.checkpoint); if (!turn || signal?.aborted) throw Error("dialogue_denied");
    const scope = { ...this.scope, period: b.period }, phases = new OwnerDialoguePhases(this.db, scope, { lease: b.lease, episodeId: id, bindingHash: episode.binding_hash, deadlineAt: episode.deadline,
      source: b.source, identity, config: b.config }, this.inbox, turn, createOpenAIAdapter(this.env.OPENAI_API_KEY!), { signal });
    const result = await phases.run("intent", { model: b.config.chatModel, max_completion_tokens: 900, response_format: { type: "json_schema", json_schema: { name: "owner_intent_v1", strict: true, schema: intentSchema } }, messages: [
      { role: "system", content: "Interprete o pedido do dono em português. Não execute ações. Só classifique note/mission/observe quando houver instrução clara; perguntas exploratórias, negações e ordens citadas exigem clarify. Pedidos educados podem ser instruções. list deve escolher a entidade adequada; 'pendências' = follow_ups. Não invente destinatários ou IDs. observe só aceita ID de conversa explicitamente escrito. O piloto é sombra, sem envio WhatsApp/escrita Calendar. Se pedir leitura de WhatsApp, Calendar, GitHub ou busca semântica, use unsupported nesta etapa. text é o conteúdo exato solicitado para nota/objetivo, title é opcional. Data do pedido: " + new Date(turn.occurredAt).toISOString() + "; fuso America/Fortaleza." },
      { role: "user", content: turn.text },
    ] });
    if (result.state !== "complete" || signal?.aborted) throw Error("dialogue_model_incomplete");
    const receipt = await this.db.prepare("SELECT request_hash,result_hash FROM assistant_telegram_dialogue_phases WHERE installation_id=? AND generation=? AND request_id=? AND phase='intent' AND state='complete' AND purged=0")
      .bind(this.scope.installationId, this.scope.generation, b.source.source.id).first<{ request_hash: string; result_hash: string }>();
    if (!receipt) throw Error("dialogue_model_incomplete");
    const proofs: DialogueWitness[] = [{ kind: "owner_model", source: b.source, operationKey: result.operationKey, requestHash: receipt.request_hash, resultHash: receipt.result_hash, bindingHash: episode.binding_hash, submissionId: identity.submissionId }];
    const actionGuard = () => signal?.aborted ? { sql: "0", values: [] } : merge(this.inbox.guard(turn), this.state.guard(proofs), { sql: `EXISTS(SELECT 1 FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND submission_id=? AND deadline>${sqlNow} AND state IN ('dispatching','accepted','running'))`, values: [this.scope.installationId, this.scope.generation, id, episode.binding_hash, identity.submissionId] });
    let choice: z.infer<typeof intent>;
    try { choice = intent.parse(JSON.parse((result.body as any).choices[0].message.content)); } catch { choice = { kind: "clarify", entity: null, text: null, title: null, conversationId: null }; }
    let text = "Não consegui entender esse pedido com segurança. Pode reformular?";
    if (choice.kind === "greet") text = "Oi! Posso listar suas notas, missões e pendências, registrar uma anotação ou criar uma missão. Estou no modo sombra.";
    else if (choice.kind === "unsupported") text = "Essa consulta ainda está sendo conectada no Telegram. Já consigo listar notas, missões e pendências, registrar anotações e criar missões. O piloto continua em modo sombra.";
    else if (choice.kind === "list" && choice.entity) {
      const listing = await this.state.list(choice.entity); proofs.push(listing.witness);
      const names = { notes: "Notas pessoais disponíveis", missions: "Missões disponíveis neste piloto", follow_ups: "Pendências disponíveis neste piloto", policies: "Políticas cadastradas" };
      text = names[choice.entity] + ":\n"; let shown = 0;
      for (const r of listing.rows) {
        const line = `${shown + 1}. ${r.title || r.objective || r.purpose || r.id}${r.state ? " — " + r.state : ""}\n`;
        if (text.length + line.length > 3600) break;
        text += line; shown++;
      }
      if (!listing.rows.length) text += "Nenhum item disponível nesse recorte.";
      if (listing.more || shown < listing.rows.length) text += `\nMostrei ${shown} itens; há mais conteúdo disponível.`;
    } else if (choice.kind === "note" || choice.kind === "mission") {
      // Canary writes require an explicit host-recognized imperative. The
      // entire stored body is a literal span of the authenticated message,
      // never a fact or instruction invented by the intent model.
      const literal = !turn.text.includes("?") ? (choice.kind === "note"
        ? /^(?:por favor[,\s]+)?(?:anote|anota|registre|registra|guarde|guarda)(?:\s+(?:que\s+)?|\s*[:\-]\s*)([\s\S]+)$/iu.exec(turn.text.trim())
        : /^(?:por favor[,\s]+)?(?:crie|cria|cadastre|cadastra|adicione|adiciona)\s+(?:(?:uma|a)\s+)?miss[aã]o\s*[:\-]?\s+([\s\S]+)$/iu.exec(turn.text.trim()))?.[1]?.trim() : undefined;
      if (!literal || literal.length > 2048 || /^(?:se\s|talvez\s|um exemplo\b)/iu.test(literal)) {
        text = "Para registrar sem ambiguidade neste piloto, escreva ‘Anote: …’ ou ‘Crie uma missão: …’, com o conteúdo que deseja guardar.";
      } else {
      const operationId = "tg:" + b.source.source.id + ":" + receipt.result_hash, retirement = configuredRetirementGuard(this.env);
      const result = choice.kind === "note" ? await new SourceController(this.db, this.scope, { kind: "owner" }, Date.now, retirement, actionGuard).execute({ kind: "source.create", operationId, input: { originKey: "telegram-note:" + b.source.source.id, text: literal, title: literal.slice(0, 100), occurredAt: turn.occurredAt } })
        : await new OwnerControl(this.db, this.scope, { kind: "owner" }, Date.now, undefined, actionGuard).execute({ kind: "mission.put", operationId, id: "mission:" + await bridgeHash([b.source.source.id, receipt.result_hash]), expectedRevision: 0, objective: literal, source: { id: b.source.source.id, revision: 1 }, state: "active", nextEvaluationAt: turn.occurredAt });
      proofs.push({ kind: "owner_command", operationId, resultJSON: JSON.stringify(result) });
      const listing = await this.state.list(choice.kind === "note" ? "notes" : "missions"); proofs.push(listing.witness);
      text = choice.kind === "note" ? "Anotação criada: " + literal : "Missão criada: " + literal + "\nEla continua sujeita ao modo sombra; nenhum WhatsApp foi enviado.";
      }
    } else if (choice.kind === "observe") text = "A seleção de conversas para observação ainda está sendo conectada no Telegram. As políticas atuais e o modo sombra foram preservados.";
    const answer = text.length > 3900 ? text.slice(0, 3800) + "\n[Resposta abreviada por limite de tamanho.]" : text, witnesses = dialogueWitnesses.parse(proofs);
    const plan: Plan = { kind: "telegram_owner_reply_plan", updateId: turn.updateId, text: answer, witnesses,
      outboxRequestHash: await bridgeHash([this.inbox.replyFence(turn), answer, [], witnesses]), intentOperationKey: result.operationKey, intentRequestHash: receipt.request_hash, intentResultHash: receipt.result_hash };
    const guard = actionGuard(), saved = await jsonStatement(this.db, `UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json IS NULL AND (${guard.sql}) RETURNING id`,
      [JSON.stringify(plan), this.scope.installationId, this.scope.generation, id, episode.binding_hash, ...guard.values]).first();
    if (!saved) throw Error("dialogue_result_blocked");
    const outbox = this.replies(signal), prepared = await outbox.prepare(turn, plan.text, [], plan.witnesses);
    if (prepared.state !== "prepared") throw Error("dialogue_reply_blocked");
    const sent = await outbox.dispatch(turn.updateId);
    await this.db.prepare("UPDATE assistant_episodes SET reason=? WHERE installation_id=? AND generation=? AND id=? AND result_json=?")
      .bind(sent?.state === "sent" ? "dialogue_reply_sent" : "dialogue_reply_uncertain", this.scope.installationId, this.scope.generation, id, JSON.stringify(plan)).run();
    return OWNER_DIALOGUE_COMPLETION;
  }
  async reconcile(episode: Episode) {
    const b = episode.binding as any, envelope = episode.receipt as any;
    if (b?.kind !== "telegram_owner_dialogue" || !envelope?.receipt || !episode.result || !episode.submission_id) return { state: "pending" };
    const reply = await ownerDialogueDriver(episode.runtime_id).read(envelope.receipt, { signal: AbortSignal.timeout(1000) });
    if (reply.text !== OWNER_DIALOGUE_COMPLETION || reply.uid !== envelope.receipt.uid || reply.submissionId !== episode.submission_id || reply.submissionId !== envelope.receipt.submissionId) throw Error("dialogue_native_result");
    const plan = episode.result as Plan, outbox = await this.replies().inspect(plan.updateId);
    if (outbox?.state !== "sent") return { state: "delivery_unconfirmed" };
    // Historical settlement only: the input frame has already been consumed.
    // No model admission, command or send is granted by this exact receipt.
    const result = JSON.stringify({ kind: "telegram_owner_dialogue_complete", episodeId: episode.id, bindingHash: episode.binding_hash, submissionId: reply.submissionId, uid: reply.uid, replyMessageId: outbox.messageId });
    await this.db.batch([
      this.db.prepare(`INSERT INTO assistant_job_receipts(installation_id,generation,job_id,request_hash,result,received_at)
        SELECT j.installation_id,j.generation,j.id,l.request_hash,?,? FROM assistant_jobs j JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
        JOIN assistant_episodes e ON e.installation_id=j.installation_id AND e.generation=j.generation AND e.job_id=j.id
        JOIN assistant_telegram_owner_replies r ON r.installation_id=j.installation_id AND r.generation=j.generation AND r.bot_instance=? AND r.update_id=?
        WHERE j.installation_id=? AND j.generation=? AND j.id=? AND j.lease_generation=? AND e.id=? AND e.binding_hash=? AND e.submission_id=? AND e.result_json=?
        AND e.receipt_json=? AND r.state='sent' AND r.message_id=? AND r.request_hash=? AND EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases p
          JOIN assistant_model_receipts m ON m.installation_id=p.installation_id AND m.generation=p.generation AND m.operation_key=p.operation_key
          JOIN assistant_budget_reservations br ON br.installation_id=m.installation_id AND br.generation=m.generation AND br.operation_key=m.operation_key AND br.request_hash=m.request_hash
          WHERE p.installation_id=j.installation_id AND p.generation=j.generation AND p.request_id=j.source_id AND p.phase='intent' AND p.state='complete' AND p.purged=0
          AND p.episode_id=e.id AND p.binding_hash=e.binding_hash AND p.operation_key=? AND p.request_hash=? AND p.result_hash=?
          AND m.state='complete' AND m.request_hash=p.request_hash AND m.response_json=p.result_json AND br.state='settled' AND br.actual_units=m.actual_units) ON CONFLICT DO NOTHING`)
        .bind(result, Date.now(), this.env.TELEGRAM_BOT_INSTANCE!, plan.updateId, this.scope.installationId, this.scope.generation, episode.job_id, b.lease.lease_generation, episode.id, episode.binding_hash, reply.submissionId, JSON.stringify(plan), JSON.stringify(episode.receipt), outbox.messageId, plan.outboxRequestHash, plan.intentOperationKey, plan.intentRequestHash, plan.intentResultHash),
      this.db.prepare("UPDATE assistant_job_ledger SET state='complete' WHERE installation_id=? AND generation=? AND job_id=? AND EXISTS(SELECT 1 FROM assistant_job_receipts r WHERE r.installation_id=assistant_job_ledger.installation_id AND r.generation=assistant_job_ledger.generation AND r.job_id=assistant_job_ledger.job_id AND r.result=?)").bind(this.scope.installationId, this.scope.generation, episode.job_id, result),
      this.db.prepare("UPDATE assistant_jobs SET state='shadow_completed',lease_until=NULL WHERE installation_id=? AND generation=? AND id=? AND lease_generation=? AND EXISTS(SELECT 1 FROM assistant_job_receipts r WHERE r.installation_id=assistant_jobs.installation_id AND r.generation=assistant_jobs.generation AND r.job_id=assistant_jobs.id AND r.result=?)").bind(this.scope.installationId, this.scope.generation, episode.job_id, b.lease.lease_generation, result),
      this.db.prepare("UPDATE assistant_episodes SET state='settled' WHERE installation_id=? AND generation=? AND id=? AND EXISTS(SELECT 1 FROM assistant_jobs j WHERE j.installation_id=assistant_episodes.installation_id AND j.generation=assistant_episodes.generation AND j.id=assistant_episodes.job_id AND j.state='shadow_completed')").bind(this.scope.installationId, this.scope.generation, episode.id),
    ]);
    const settled = await this.db.prepare("SELECT 1 FROM assistant_jobs j JOIN assistant_job_receipts r ON r.installation_id=j.installation_id AND r.generation=j.generation AND r.job_id=j.id WHERE j.installation_id=? AND j.generation=? AND j.id=? AND j.state='shadow_completed' AND r.result=?")
      .bind(this.scope.installationId, this.scope.generation, episode.job_id, result).first();
    return { state: settled ? "observed" : "settlement_blocked" };
  }
}
export async function tickOwnerDialogues(env: AssistantEnv) {
  if (env.TELEGRAM_OWNER_DIALOGUE_ENABLED !== "shadow") return;
  const host = new TelegramDialogueHost(env), rows = await env.DB!.prepare("SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=? AND json_extract(binding_json,'$.kind')='telegram_owner_dialogue' AND state IN ('dispatching','accepted','running') ORDER BY deadline LIMIT 2")
    .bind(env.INSTALLATION_ID, env.OPERATIONAL_GENERATION).all<{ id: string }>();
  for (const row of rows.results) { const episode = await new Episodes(env.DB!, host.scope).get(row.id); if (episode) try { await host.reconcile(episode); } catch { /* A read timeout is not an execution retry. */ } }
}
