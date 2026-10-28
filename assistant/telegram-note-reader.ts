import { SourceAccess } from "./access";
import type { SourceScope } from "./sources";
import type { ReplyDependency } from "./telegram-owner-replies";
import type { AnswerDocument } from "./telegram-grounded-answer";

type Boundary = { check: () => Promise<void>; deadlineAt: number; signal?: AbortSignal };
export type TelegramNotesRead = { state: "available"; documents: AnswerDocument[]; dependencies: ReplyDependency[];
  coverage: { complete: false; method: "lexical_owner_notes"; limit: 3; gaps: string[] } } | { state: "unavailable"; text: string };
/** Originals taught explicitly by the owner; questions never create facts. */
export async function readTelegramNotes(db: D1Database, scope: SourceScope, question: string, boundary: Boundary): Promise<TelegramNotesRead> {
  const denied = (): TelegramNotesRead => ({ state: "unavailable", text: "Não consegui consultar suas notas atuais agora." });
  const check = async () => { if (boundary.signal?.aborted || Date.now() >= boundary.deadlineAt) throw Error("note_read_expired"); await boundary.check(); };
  try {
    if (!question.trim() || question.length > 8192) return denied();
    await check();
    const access = new SourceAccess(db, scope), visible = access.ownerRows(Date.now());
    const stops = new Set("qual quais que como sobre para das dos uma meu minha voce você notas nota ensinei ensinado contexto memoria memória".split(" "));
    const terms = [...new Set(question.normalize("NFC").toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu) ?? [])].filter(t => t.length > 2 && !stops.has(t)).slice(0, 8);
    const score = terms.length ? terms.map(() => "CASE WHEN instr(lower(v.original_text),lower(?))>0 OR instr(lower(s.title),lower(?))>0 THEN 1 ELSE 0 END").join("+") : "0";
    const rows = await db.prepare(`WITH visible AS (${visible.sql}) SELECT v.id,v.revision,s.title,(${score}) score FROM visible v JOIN assistant_sources s ON s.installation_id=? AND s.generation=? AND s.id=v.id AND s.revision=v.revision
      WHERE v.origin='owner_note' AND v.original_text IS NOT NULL ORDER BY score DESC,v.occurred_at DESC,v.id LIMIT 7`)
      .bind(...visible.values, ...terms.flatMap(t => [t, t]), scope.installationId, scope.generation).all<{ id: string; revision: number; title: string | null; score: number }>();
    const documents: AnswerDocument[] = [], dependencies: ReplyDependency[] = [], gaps = ["bounded_owner_notes", "semantic_search_not_used"];
    if (rows.results.length > 3) gaps.push("note_limit");
    if (terms.length && !rows.results.some(r => r.score > 0)) gaps.push("lexical_no_hit");
    for (const row of rows.results) {
      if (documents.length === 3) break;
      await check(); const current = await access.read({ kind: "owner" }, row.id, row.revision);
      if (!current?.text || current.fence.source.origin !== "owner_note") continue;
      const document: AnswerDocument = { id: current.id, label: row.title || "Nota ensinada por você", text: current.text,
        metadata: { origin: "owner_note", attribution: "explicit_owner_teaching", occurredAt: new Date(current.occurredAt).toISOString() } };
      if (new TextEncoder().encode(JSON.stringify([...documents, document])).length > 15000) { gaps.push("note_bytes_limit"); continue; }
      documents.push(document); dependencies.push({ source: current.fence });
    }
    await check();
    for (const dependency of dependencies) if (!await access.revalidate({ kind: "owner" }, dependency.source)) return denied();
    return { state: "available", documents, dependencies, coverage: { complete: false, method: "lexical_owner_notes", limit: 3, gaps: [...new Set(gaps)] } };
  } catch { return denied(); }
}
