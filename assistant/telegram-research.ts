import type { AssistantEnv } from "./env";
import type { OwnerAffinity } from "./mcp";
import type { Episode } from "./agent/episodes";
import type { RuntimeIdentity } from "./agent/controller";
import { TelegramOwnerInbox, type TelegramOwnerTurn } from "./telegram-owner-inbox";
import { OwnerDialoguePhases } from "./telegram-dialogue-phases";
import { DialogueState, type DialogueWitness } from "./telegram-dialogue-state";
import type { ReplyDependency } from "./telegram-owner-replies";
import { SourceAccess, type AccessGuard } from "./access";
import { jsonStatement } from "./d1-statement";
import { createOpenAIAdapter } from "./model-transport";
import { prepareGitHubQuestion, githubQuestionExplicitReference, githubSelectionPayload, readGitHubQuestionFiles, type GitHubQuestionSnapshot } from "./telegram-github-question";
import { groundedAnswerPayload, renderGroundedAnswer, type AnswerDocument } from "./telegram-grounded-answer";
import type { OriginGuard } from "./origin-guard";

const merge = (...guards: AccessGuard[]): AccessGuard => ({ sql: guards.map(g => `(${g.sql})`).join(" AND "), values: guards.flatMap(g => g.values) });
export type ResearchCheckpoint = { kind: "telegram_owner_research"; mode: "github_question" | "whatsapp_answer"; question: string; dependencies: ReplyDependency[];
  github?: GitHubQuestionSnapshot; documents?: AnswerDocument[]; coverage?: unknown; error?: string };
export type ResearchAnswer = { text: string; dependencies: ReplyDependency[]; witnesses: DialogueWitness[]; checkpointJSON: string;
  intentOperationKey: string; intentRequestHash: string; intentResultHash: string; research: { mode: string; documents: number; commit?: string } };
type Input = { env: AssistantEnv; scope: OwnerAffinity; episode: Episode; identity: RuntimeIdentity; turn: TelegramOwnerTurn; inbox: TelegramOwnerInbox; repository: string; signal?: AbortSignal; origin?: OriginGuard };
/** The host locks this episode to read-only research before external filenames
 * reach either model. No model output from this function can reach a controller. */
export async function answerGitHubQuestion(input: Input): Promise<ResearchAnswer> {
  const { env, scope, episode, identity, turn, inbox, signal } = input, db = env.DB!, binding = episode.binding as any;
  const access = new SourceAccess(db, scope), state = new DialogueState(db, scope), keys = [scope.installationId, scope.generation, episode.id, episode.binding_hash];
  let proofs: DialogueWitness[] = [], dependencies: ReplyDependency[] = [], checkpointJSON: string | null = episode.result ? JSON.stringify(episode.result) : null;
  const guard = () => signal?.aborted ? { sql: "0", values: [] } : merge(inbox.guard(turn), state.guard(proofs), ...dependencies.map(d => access.guard({ kind: "owner" }, d.source, Date.now())),
    { sql: "EXISTS(SELECT 1 FROM assistant_episodes WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND submission_id=? AND state IN ('dispatching','accepted','running') AND deadline>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))", values: [...keys, identity.submissionId] });
  const check = async () => { const g = guard(); if (!await jsonStatement(db, `SELECT 1 WHERE ${g.sql}`, g.values).first()) throw Error("research_denied"); };
  const save = async (record: ResearchCheckpoint) => {
    dependencies = record.dependencies; const g = guard(), serialized = JSON.stringify(record);
    const row = await jsonStatement(db, `UPDATE assistant_episodes SET result_json=? WHERE installation_id=? AND generation=? AND id=? AND binding_hash=? AND result_json IS ? AND (${g.sql}) RETURNING id`, [serialized, ...keys, checkpointJSON, ...g.values]).first();
    if (!row) throw Error("research_checkpoint_conflict"); checkpointJSON = serialized;
  };
  let record: ResearchCheckpoint;
  if (checkpointJSON) {
    record = JSON.parse(checkpointJSON); if (record.kind !== "telegram_owner_research" || record.mode !== "github_question" || record.question !== turn.text) throw Error("research_checkpoint_input");
    dependencies = record.dependencies;
  } else { record = { kind: "telegram_owner_research", mode: "github_question", question: turn.text, dependencies: [] }; await save(record); }
  await check();
  const boundary = { signal, deadlineAt: episode.deadline, check };
  if (!record.github && !record.error && githubQuestionExplicitReference(turn.text)) { record.error = "github_reference_unsupported"; await save(record); }
  if (!record.github && !record.error) {
    try { record.github = await prepareGitHubQuestion(env, scope, input.repository, turn.text, boundary); record.dependencies = record.github.dependencies; }
    catch { record.error = "github_unavailable"; }
    await save(record);
  }
  const phases = new OwnerDialoguePhases(db, { ...scope, period: binding.period }, { lease: binding.lease, episodeId: episode.id, bindingHash: episode.binding_hash, deadlineAt: episode.deadline,
    source: binding.source, identity, config: binding.config }, inbox, turn, createOpenAIAdapter(env.OPENAI_API_KEY!), { signal, origin: input.origin, githubQuestion: true });
  const firstPayload = record.github ? githubSelectionPayload(binding.config.chatModel, record.github) : { model: binding.config.chatModel, max_completion_tokens: 30, messages: [{ role: "system", content: "A consulta GitHub falhou. Responda somente: indisponível." }, { role: "user", content: turn.text }] };
  const selected = await phases.run("intent", firstPayload, dependencies); if (selected.state !== "complete") throw Error("research_selection_incomplete");
  const receipt = async (phase: "intent" | "answer") => {
    const row = await db.prepare("SELECT operation_key,request_hash,result_hash FROM assistant_telegram_dialogue_phases WHERE installation_id=? AND generation=? AND request_id=? AND phase=? AND state='complete' AND purged=0")
      .bind(scope.installationId, scope.generation, binding.source.source.id, phase).first<{ operation_key: string; request_hash: string; result_hash: string }>();
    if (!row) throw Error("research_receipt_missing"); return row;
  };
  const first = await receipt("intent");
  proofs = [{ kind: "owner_model", source: binding.source, operationKey: first.operation_key, requestHash: first.request_hash, resultHash: first.result_hash, bindingHash: episode.binding_hash, submissionId: identity.submissionId }];
  if (record.github && !record.documents && !record.error) {
    try { record.github = await readGitHubQuestionFiles(env, scope, record.github, selected.body, boundary); record.documents = record.github.documents; record.coverage = { ...record.github.coverage, failures: record.github.failures }; }
    catch { record.error = "github_context_unavailable"; }
    await save(record);
  }
  let text = record.error === "github_reference_unsupported" ? "Essa consulta ainda usa somente a branch padrão. Você indicou outra referência; confirme se posso responder sobre a versão padrão ou retire a referência do pedido." : "Não consegui ler os arquivos necessários desse repositório agora. Confirme o nome do repo; se o acesso estiver correto, tente novamente mais tarde.";
  if (record.documents?.length && !record.error) {
    const payload = groundedAnswerPayload(binding.config.chatModel, turn.text, record.documents, record.coverage);
    const answered = await phases.run("answer", payload, dependencies);
    if (answered.state !== "complete") throw Error("research_answer_incomplete");
    try { text = renderGroundedAnswer(answered.body, record.documents); }
    catch { text = "Li os arquivos, mas não consegui sustentar uma resposta à sua pergunta com as evidências encontradas. Preciso investigar mais arquivos para responder com segurança."; }
    const second = await receipt("answer"); proofs.push({ kind: "owner_answer", source: binding.source, operationKey: second.operation_key, requestHash: second.request_hash, resultHash: second.result_hash, bindingHash: episode.binding_hash, submissionId: identity.submissionId });
  }
  await check();
  return { text, dependencies, witnesses: proofs, checkpointJSON: checkpointJSON!, intentOperationKey: first.operation_key, intentRequestHash: first.request_hash, intentResultHash: first.result_hash,
    research: { mode: "github_question", documents: record.documents?.length ?? 0, ...(record.github ? { commit: record.github.commit } : {}) } };
}
