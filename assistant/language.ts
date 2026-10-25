export type ActionReference = { installationId: string; generation: string; actionId: string; requestHash: string; destination: string; kind: "send_text" | "send_audio" | "calendar_write"; conversationKind: "private" | "group" };
export type ActionReceipt = ActionReference & { state: "accepted" | "sent" | "delivered" | "read" | "failed" | "uncertain" | "shadow_completed" };
const states = {
  accepted: "Aceito pelo provedor; entrega não confirmada.", sent: "Enviado pelo provedor; entrega não confirmada.",
  delivered: "Entrega confirmada pelo provedor.", read: "Leitura confirmada pelo provedor.", failed: "A operação falhou.",
  uncertain: "Resultado incerto; não repetir automaticamente.", shadow_completed: "Processamento em sombra concluído; nenhuma ação externa confirmada.",
};
/** Both reference and receipt must come from the authenticated host ledger.
 * Source text is always a separate untrusted field, never parsed as a receipt.
 * Return structured fields; callers must render evidence as quoted data. */
export function operationalLanguage(action: ActionReference, receipt?: ActionReceipt, evidence: { sourceId: string; text: string }[] = []) {
  if (!action || Object.values(action).some(value => typeof value !== "string" || !value || value.length > 256) || !/^[a-f0-9]{64}$/.test(action.requestHash) || evidence.length > 10) throw new Error("language_input");
  const matches = receipt && ["installationId", "generation", "actionId", "requestHash", "destination", "kind", "conversationKind"].every(key => action[key as keyof ActionReference] === receipt[key as keyof ActionReference]);
  const state = matches && Object.hasOwn(states, receipt.state) ? receipt.state : "unconfirmed";
  let text = state === "unconfirmed" ? "Sem confirmação de execução." : states[state];
  if (action.conversationKind === "group" && (state === "delivered" || state === "read")) text += " Estado agregado do grupo, sem confirmação individual de todos os participantes.";
  return { state, text, evidence: evidence.map(row => {
    if (typeof row.sourceId !== "string" || !row.sourceId || row.sourceId.length > 256 || typeof row.text !== "string" || row.text.length > 32768) throw new Error("language_input");
    return { sourceId: row.sourceId, text: row.text, trusted: false as const };
  }) };
}
