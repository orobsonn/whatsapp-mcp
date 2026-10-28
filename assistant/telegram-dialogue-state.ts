import { z } from "zod";
import { SourceAccess, type AccessGuard } from "./access";
import { sourceFence } from "./agent/contracts";
import type { SourceScope } from "./sources";
import { calendarQuery } from "./connectors/calendar";
const label = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/);
const entity = z.enum(["notes", "missions", "follow_ups", "policies"]);
export const dialogueWitnesses = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner_model"), source: sourceFence, operationKey: label, requestHash: hash, resultHash: hash, bindingHash: hash, submissionId: label }).strict(),
  z.object({ kind: z.literal("owner_listing"), entity, rowsJSON: z.string().max(20000) }).strict(),
  z.object({ kind: z.literal("owner_command"), operationId: label, resultJSON: z.string().max(16384) }).strict(),
  z.object({ kind: z.literal("calendar_observation"), episodeId: hash, bindingHash: hash, submissionId: label, observationJSON: z.string().max(20000) }).strict(),
])).max(4);
export type DialogueWitness = z.infer<typeof dialogueWitnesses>[number];
const views = {
  notes: { from: "assistant_sources t", fields: "'id',t.id,'title',t.title,'revision',t.revision", where: "t.origin='owner_note' AND t.status='active'", order: "t.id" },
  missions: { from: "assistant_missions t LEFT JOIN assistant_sources s ON s.installation_id=t.installation_id AND s.generation=t.generation AND s.id=t.source_id", fields: "'id',t.id,'objective',t.objective,'state',t.state,'revision',t.revision,'source_id',t.source_id,'support_status',s.status,'support_revision',s.revision", where: "1", order: "t.id" },
  follow_ups: { from: "assistant_follow_ups t", fields: "'id',t.id,'purpose',t.purpose,'state',t.state,'version',t.version,'source_id',t.source_id,'due_at',t.due_at", where: "t.version=(SELECT MAX(v.version) FROM assistant_follow_ups v WHERE v.installation_id=t.installation_id AND v.generation=t.generation AND v.id=t.id)", order: "t.id" },
  policies: { from: "assistant_conversation_policies t", fields: "'id',t.conversation_id,'kind',t.kind,'excluded',t.excluded,'group_mode',t.group_mode,'revision',t.revision", where: "1", order: "t.conversation_id" },
} as const;
/** Typed current-state proofs. SQL and identifiers are host constants; rows
 * are bounded, ordered inside the aggregate and never interpreted as tools. */
export class DialogueState {
  constructor(private readonly db: D1Database, private readonly scope: SourceScope) {}
  private listing(kind: z.infer<typeof entity>) {
    const view = views[kind];
    const supports = new SourceAccess(this.db, this.scope).ownerSupportRows();
    // The initial canary reads local Owner notes/directives only. WhatsApp
    // supports require their remote origin proofs before joining this view.
    const join = kind === "policies" ? "" : ` JOIN (${supports.sql}) permitted ON permitted.id=${kind === "notes" ? "t.id" : "t.source_id"}
      AND permitted.revision=${kind === "notes" ? "t.revision" : "t.source_revision"} AND permitted.origin IN ('owner_note','owner_request')`;
    const values = [...(kind === "policies" ? [] : supports.values), this.scope.installationId, this.scope.generation];
    return { sql: `SELECT COALESCE(json_group_array(json(row)), '[]') AS value FROM (
      SELECT json_object(${view.fields}) AS row FROM ${view.from}${join} WHERE t.installation_id=? AND t.generation=? AND (${view.where}) ORDER BY ${view.order} LIMIT 11)`, values };
  }
  async list(kind: z.infer<typeof entity>) {
    const query = this.listing(entity.parse(kind));
    const value = (await this.db.prepare(query.sql).bind(...query.values).first<string>("value"))!;
    return { rows: (JSON.parse(value) as Record<string, unknown>[]).slice(0, 10), more: JSON.parse(value).length > 10,
      witness: { kind: "owner_listing", entity: kind, rowsJSON: value } as DialogueWitness };
  }
  guard(raw: unknown): AccessGuard {
    const proofs = dialogueWitnesses.parse(raw), guards: AccessGuard[] = [];
    if (new TextEncoder().encode(JSON.stringify(proofs)).length > 32768) throw Error("dialogue_witness_size");
    for (const proof of proofs) {
      if (proof.kind === "owner_listing") {
        if (!Array.isArray(JSON.parse(proof.rowsJSON)) || new TextEncoder().encode(proof.rowsJSON).length > 20000) throw Error("dialogue_witness_rows");
        const query = this.listing(proof.entity); guards.push({ sql: `(${query.sql})=?`, values: [...query.values, proof.rowsJSON] });
      } else if (proof.kind === "owner_command") guards.push({ sql: `EXISTS(SELECT 1 FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id=? AND result_json=?)`, values: [this.scope.installationId, this.scope.generation, proof.operationId, proof.resultJSON] });
      else if (proof.kind === "calendar_observation") {
        if (new TextEncoder().encode(proof.observationJSON).length > 20000) throw Error("dialogue_observation_size");
        const observation = JSON.parse(proof.observationJSON), query = calendarQuery.parse(observation.query);
        const admission = proofs.find(p => p.kind === "owner_model" && p.bindingHash === proof.bindingHash && p.submissionId === proof.submissionId);
        if (!admission || admission.kind !== "owner_model" || observation.kind !== "calendar" || query.kind !== "calendar.availability" || observation.result?.state !== "available" || observation.result?.origin !== "calendar") throw Error("dialogue_observation_input");
        guards.push({ sql: `EXISTS(SELECT 1 FROM assistant_episodes e WHERE e.installation_id=? AND e.generation=? AND e.id=? AND e.binding_hash=? AND e.submission_id=?
          AND e.profile='owner' AND e.state IN ('dispatching','accepted','running') AND e.deadline>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
          AND json_extract(e.binding_json,'$.kind')='telegram_owner_dialogue' AND json_extract(e.binding_json,'$.source.source.id')=?
          AND json_extract(e.result_json,'$.kind')='telegram_owner_reply_plan' AND json_extract(e.result_json,'$.observation')=?)`,
          values: [this.scope.installationId, this.scope.generation, proof.episodeId, proof.bindingHash, proof.submissionId, admission.source.source.id, proof.observationJSON] });
      }
      else {
        if (proof.source.source.origin !== "owner_request" || proof.source.actor !== "owner") throw Error("dialogue_witness_source");
        guards.push(new SourceAccess(this.db, this.scope).guard({ kind: "owner" }, proof.source, Date.now()), {
          sql: `EXISTS(SELECT 1 FROM assistant_telegram_dialogue_phases p JOIN assistant_model_receipts m ON m.installation_id=p.installation_id AND m.generation=p.generation AND m.operation_key=p.operation_key
            JOIN assistant_episodes e ON e.installation_id=p.installation_id AND e.generation=p.generation AND e.id=p.episode_id
            WHERE p.installation_id=? AND p.generation=? AND p.request_id=? AND p.phase='intent' AND p.state='complete' AND p.purged=0 AND p.operation_key=? AND p.request_hash=? AND p.result_hash=?
            AND e.binding_hash=? AND e.submission_id=? AND e.state IN ('dispatching','accepted','running') AND e.deadline>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
            AND m.request_hash=p.request_hash AND m.source_id=p.request_id AND m.state='complete' AND m.actual_units IS NOT NULL AND m.response_json=p.result_json)`,
          values: [this.scope.installationId, this.scope.generation, proof.source.source.id, proof.operationKey, proof.requestHash, proof.resultHash, proof.bindingHash, proof.submissionId],
        });
      }
    }
    return { sql: ["1", ...guards.map(g => `(${g.sql})`)].join(" AND "), values: guards.flatMap(g => g.values) };
  }
}
