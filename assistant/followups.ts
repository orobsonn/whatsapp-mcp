import { z } from "zod";
import { SourceAccess, type AccessGuard } from "./access";
import type { SourceScope } from "./sources";
import { bridgeHash } from "./ingress";
import { JobQueue, type JobScope } from "./queue";
import { seedDecisionJob } from "./decisions";
import type { OriginGuard } from "./origin-guard";
import { normalizeRetrievalInput } from "./retrieval";
import {outgoingProof,outgoingGuard,type OutgoingPort} from './outgoing';
const ns = "installation_id=? AND generation=?";
const id = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().positive();
export const fupProvenanceSchema = z.object({ evidenceKind: z.enum(["owner_directive", "attributed_candidate"]),
  source: z.object({ id, revision: version, version, hash }).strict(), authorId: z.string().max(512).nullable(), authorLabel: z.string().max(512).nullable(),
  candidate: z.object({ batchKey: id, claimIndex: z.number().int().min(0).max(31), requestHash: hash, quote: z.string().min(1).max(4096) }).strict().nullable(),
  conditionStatus: z.enum(["none_explicit", "attributed", "unknown"]),
  temporal: z.object({ dueAt: z.number().int().nonnegative().safe().nullable(), windowEnd: z.number().int().nonnegative().safe().nullable(), timezone: id, precision: z.enum(["unset", "exact", "day", "window"]) }).strict(),
 outgoing:outgoingProof.optional(),}).strict();
/** Only an explicit offset plus an IANA-zone round trip can define civil time.
 * Numeric input remains an already resolved UTC instant, including legacy UTC. */
export function fupInstant(value: number | string, timezone: string): number {
  if (typeof value === "number") return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[8] === "-00:00") throw new Error("control_input");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number), ms = Number((match[7] ?? "").padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) throw new Error("control_input");
  const civil = new Date(0); civil.setUTCFullYear(year, month - 1, day); civil.setUTCHours(hour, minute, second, ms);
  if (civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 || civil.getUTCDate() !== day) throw new Error("control_input");
  const offset = match[8] === "Z" ? 0 : (Number(match[8].slice(1, 3)) * 60 + Number(match[8].slice(4))) * (match[8][0] === "-" ? -1 : 1);
  if (match[8] !== "Z" && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4)) > 59)) throw new Error("control_input");
  const instant = civil.getTime() - offset * 60000;
  const formatted = new Intl.DateTimeFormat("en", { timeZone: timezone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const values = Object.fromEntries(formatted.map(part => [part.type, part.value]));
  if (![year, month, day, hour, minute, second].every((part, index) => part === Number(values[["year", "month", "day", "hour", "minute", "second"][index]])) || !Number.isSafeInteger(instant) || instant < 0) throw new Error("control_input");
  return instant;
}
type FupInput = { source: { id: string; revision: number }; candidate?: { batchKey: string; claimIndex: number }; condition?: string; dueAt?: number; windowEnd?: number; timezone: string; precision: "unset" | "exact" | "day" | "window" };
/** Build evidence and its admitting guard together. No model-supplied author,
 * permission, origin or namespace is accepted. The command remains authority. */
export async function prepareFupProvenance(db: D1Database, scope: SourceScope, item: FupInput) {
  const access = new SourceAccess(db, scope), source = await access.read({ kind: "owner" }, item.source.id, item.source.revision);
  if (!source) throw new Error("control_precondition");
  const guard = access.guard({ kind: "owner" }, source.fence, Date.now()), keys = [scope.installationId, scope.generation];
  let candidate: z.infer<typeof fupProvenanceSchema>["candidate"] = null;
  if (item.candidate) {
    const row = await db.prepare(`SELECT request_hash,claims_json,author_id,author_label FROM assistant_relation_batches WHERE ${ns} AND operation_key=? AND source_id=? AND source_revision=? AND source_version=? AND source_hash=?`)
      .bind(...keys, item.candidate.batchKey, source.id, source.fence.source.revision, source.fence.source.version, source.fence.source.hash).first<{ request_hash: string; claims_json: string; author_id: string | null; author_label: string | null }>();
    const claim = row && JSON.parse(row.claims_json)[item.candidate.claimIndex];
    if (!row || !claim || typeof claim.quote !== "string" || !source.text?.includes(claim.quote) || row.author_id !== source.authorId || row.author_label !== source.authorLabel || (item.condition && !claim.quote.includes(item.condition))) throw new Error("control_precondition");
    candidate = { ...item.candidate, requestHash: row.request_hash, quote: claim.quote };
    guard.sql += ` AND EXISTS(SELECT 1 FROM assistant_relation_batches WHERE ${ns} AND operation_key=? AND request_hash=? AND claims_json=? AND author_id IS ? AND author_label IS ?)`;
    guard.values.push(...keys, candidate.batchKey, row.request_hash, row.claims_json, source.authorId, source.authorLabel);
  }
  guard.sql += ` AND EXISTS(SELECT 1 FROM assistant_source_versions WHERE ${ns} AND source_id=? AND version=? AND author_id IS ? AND author_label IS ?)`;
  guard.values.push(...keys, source.id, source.fence.source.version, source.authorId, source.authorLabel);
  const body = fupProvenanceSchema.parse({ evidenceKind: candidate ? "attributed_candidate" : "owner_directive", source: { id: source.id, revision: source.fence.source.revision, version: source.fence.source.version, hash: source.fence.source.hash }, authorId: source.authorId, authorLabel: source.authorLabel, candidate,
    conditionStatus: item.condition ? "attributed" : candidate ? "unknown" : "none_explicit", temporal: { dueAt: item.dueAt ?? null, windowEnd: item.windowEnd ?? null, timezone: item.timezone, precision: item.precision } });
  if (new TextEncoder().encode(JSON.stringify(body)).length > 16384) throw new Error("control_input");
  return { guard, body, source };
}
/** Fixed admission predicate shared by occurrence creation and queue insertion.
 * A due observation never overrides current owner intent or a cancelled child. */
export function dueFollowUpGuard(scope:SourceScope, ref:{id:string;version:number}, source:{id:string;revision:number}, now:number, occurrenceId?:string):AccessGuard {
  return {sql:`EXISTS(SELECT 1 FROM assistant_follow_ups f
    JOIN assistant_sources s ON s.installation_id=f.installation_id AND s.generation=f.generation AND s.id=f.source_id AND s.revision=f.source_revision AND s.status='active'
    LEFT JOIN assistant_missions m ON m.installation_id=f.installation_id AND m.generation=f.generation AND m.id=f.mission_id
    WHERE f.installation_id=? AND f.generation=? AND f.id=? AND f.version=? AND f.source_id=? AND f.source_revision=?
    AND f.version=(SELECT MAX(version) FROM assistant_follow_ups v WHERE v.installation_id=f.installation_id AND v.generation=f.generation AND v.id=f.id)
    AND f.state IN ('scheduled','awaiting_condition') AND f.due_at IS NOT NULL AND f.due_at<=? AND f.next_evaluation_at<=?
    AND (f.mission_id IS NULL OR m.state='active')
    AND (EXISTS(SELECT 1 FROM assistant_conversation_policies p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.conversation_id=f.conversation_id AND p.excluded=0 AND (p.kind='private' OR p.group_mode<>'ignore')) OR (NOT EXISTS(SELECT 1 FROM assistant_conversation_policies p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.conversation_id=f.conversation_id) AND EXISTS(SELECT 1 FROM assistant_fup_provenance p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.fup_id=f.id AND p.version=f.version AND json_extract(p.body_json,'$.outgoing.policy.kind')='absent' AND json_extract(p.body_json,'$.outgoing.policy.revision')=0)))
    AND (f.mandate_id IS NULL OR EXISTS(SELECT 1 FROM assistant_mandates g WHERE g.installation_id=f.installation_id AND g.generation=f.generation AND g.id=f.mandate_id AND g.version=f.mandate_version AND g.status='active' AND g.issued_at<=? AND g.expires_at>?
      AND g.version=(SELECT MAX(version) FROM assistant_mandates v WHERE v.installation_id=g.installation_id AND v.generation=g.generation AND v.id=g.id)))
    AND NOT EXISTS(SELECT 1 FROM assistant_fup_provenance p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.fup_id=f.id AND p.version=f.version AND
      (json_extract(p.body_json,'$.source.id') IS NOT s.id OR json_extract(p.body_json,'$.source.revision') IS NOT s.revision OR json_extract(p.body_json,'$.source.version') IS NOT s.current_version OR json_extract(p.body_json,'$.source.hash') IS NOT (SELECT content_hash FROM assistant_source_versions v WHERE v.installation_id=s.installation_id AND v.generation=s.generation AND v.source_id=s.id AND v.version=s.current_version)))
    AND NOT(EXISTS(SELECT 1 FROM assistant_owner_commands c WHERE c.installation_id=f.installation_id AND c.generation=f.generation AND json_extract(c.result_json,'$.fupProvenance')=1 AND json_extract(c.result_json,'$.id')=f.id)
      AND NOT EXISTS(SELECT 1 FROM assistant_fup_provenance p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.fup_id=f.id AND p.version=f.version))
    ${occurrenceId ? `AND EXISTS(SELECT 1 FROM assistant_fup_occurrences o WHERE o.installation_id=f.installation_id AND o.generation=f.generation AND o.id=? AND o.follow_up_id=f.id AND o.follow_up_version=f.version AND o.due_at=f.next_evaluation_at AND o.state IN ('pending','blocked'))` : ""})`,
    values:[scope.installationId,scope.generation,ref.id,ref.version,source.id,source.revision,now,now,now,now,...(occurrenceId?[occurrenceId]:[])]};
}
type DueRow={id:string;version:number;source_id:string;source_revision:number;next_evaluation_at:number;purpose:string;state:string;condition_text:string|null;condition_status:string;due_at:number|null;timezone:string};
type DueItem={id:string;version:number;occurrenceId:string;state:"admitted"|"blocked"|"unavailable";jobId?:string;evaluationState?:string;reason?:"intent_changed"|"input_limit"|"admission_uncertain"};
export class FollowUps {
  private readonly scope:JobScope;
  private readonly clock:()=>number;
  constructor(private readonly db:D1Database,scope:JobScope,private readonly options:{clock?:()=>number;origin?:Pick<OriginGuard,"fence"|"check">;outgoing?:OutgoingPort}={}) {
    if(!scope.installationId||!scope.generation)throw new Error("followup_scope");this.scope=Object.freeze({...scope});this.clock=options.clock??Date.now;
  }
  private statement(query:string,...values:(string|number|null)[]){return this.db.prepare(query).bind(this.scope.installationId,this.scope.generation,...values);}
  async get(id:string) {
    const key=z.string().min(1).max(256).parse(id),row=await this.statement(`SELECT * FROM assistant_follow_ups WHERE ${ns} AND id=? ORDER BY version DESC LIMIT 1`,key).first<DueRow & {due_at:number|null;window_end:number|null;timezone:string;precision:string;condition_text:string|null}>();
    if(!row)return {state:"unavailable"};
    const evaluation=await this.statement(`SELECT j.state FROM assistant_fup_occurrences o LEFT JOIN assistant_jobs j ON j.installation_id=o.installation_id AND j.generation=o.generation AND j.occurrence_id=o.id WHERE o.${ns.replace(" AND "," AND o.")} AND o.follow_up_id=? AND o.follow_up_version=? ORDER BY o.due_at DESC LIMIT 1`,key,row.version).first<{state:string|null}>();
    const enrolled=await this.statement("SELECT 1 FROM assistant_native_task_bindings WHERE installation_id=? AND generation=? AND kind='follow_up' AND resource_id=? AND resource_version=?",key,row.version).first();
    const metadata={id:key,version:row.version,obligationState:row.state,evaluationState:evaluation?.state??"not_evaluated",native:enrolled?'enrolled':'not_enrolled',dueAt:row.due_at,windowEnd:row.window_end,nextEvaluationAt:row.next_evaluation_at,timezone:row.timezone,precision:row.precision};
    const access=new SourceAccess(this.db,this.scope),source=await access.read({kind:"owner"},row.source_id,row.source_revision);
    if(!source)return {...metadata,provenance:{state:"unavailable"}};
    const stored=await this.statement(`SELECT body_json,command_operation_id FROM assistant_fup_provenance WHERE ${ns} AND fup_id=? AND version=?`,key,row.version).first<{body_json:string;command_operation_id:string}>();
    const required=!stored&&await this.statement(`SELECT 1 FROM assistant_owner_commands WHERE ${ns} AND json_extract(result_json,'$.fupProvenance')=1 AND json_extract(result_json,'$.id')=? LIMIT 1`,key).first();
    const parsed=stored?fupProvenanceSchema.safeParse(JSON.parse(stored.body_json)):null;
    if(source.fence.source.origin==="whatsapp") {const fence=await this.options.origin?.fence(source.id);if(!fence||!await this.options.origin!.check(fence))return {...metadata,provenance:{state:"unavailable"}};}
    if(parsed?.success&&parsed.data.outgoing&&(!this.options.outgoing||!await this.options.outgoing.check(parsed.data.outgoing)))return {...metadata,provenance:{state:'unavailable'}};
    if(!await access.revalidate({kind:"owner"},source.fence))return {...metadata,provenance:{state:"unavailable"}};
    if(parsed?.success&&parsed.data.outgoing){const gate=outgoingGuard(this.scope,{id:key,version:row.version},parsed.data.outgoing,this.clock(),source.id);if(!await this.db.prepare('SELECT 1 WHERE '+gate.sql).bind(...gate.values).first())return {...metadata,provenance:{state:'unavailable'}};}
    if(!parsed)return {...metadata,provenance:{state:required?"unavailable":"legacy_unavailable"}};
    if(!parsed.success||parsed.data.source.id!==source.id||parsed.data.source.revision!==source.fence.source.revision||parsed.data.source.version!==source.fence.source.version||parsed.data.source.hash!==source.fence.source.hash)return {...metadata,provenance:{state:"unavailable"}};
    return {...metadata,purpose:row.purpose,condition:row.condition_text,provenance:{...parsed.data,commandOperationId:stored!.command_operation_id}};
  }
  async admitDue(input:{cursor?:string;limit?:number}={}) {
    const query=z.object({cursor:z.string().max(4096).optional(),limit:z.number().int().min(1).max(20).default(20)}).strict().parse(input),now=this.clock();
    if(!Number.isSafeInteger(now)||now<0)throw new Error("followup_clock");
    const fingerprint=await bridgeHash(["due-fup-v1",this.scope]);let after:[number,string,number]|null=null;
    if(query.cursor){try {const value=z.tuple([hash,z.number().int().nonnegative().safe(),id,version]).parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(query.cursor),c=>c.charCodeAt(0)))));if(value[0]!==fingerprint)throw 0;after=[value[1],value[2],value[3]];}catch{throw new Error("followup_cursor");}}
    const rows=await this.statement(`SELECT f.*,(SELECT json_extract(p.body_json,'$.conditionStatus') FROM assistant_fup_provenance p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.fup_id=f.id AND p.version=f.version) condition_status FROM assistant_follow_ups f INDEXED BY assistant_follow_ups_due WHERE f.${ns.replace(" AND "," AND f.")} AND f.state IN ('scheduled','awaiting_condition') AND f.due_at IS NOT NULL AND f.next_evaluation_at<=?
      AND f.version=(SELECT MAX(version) FROM assistant_follow_ups v WHERE v.installation_id=f.installation_id AND v.generation=f.generation AND v.id=f.id)
      ${after?"AND (f.next_evaluation_at,f.id,f.version)>(?,?,?)":""} ORDER BY f.next_evaluation_at,f.id,f.version LIMIT ?`,now,...(after??[]),query.limit+1).all<DueRow>();
    const items:DueItem[]=[];
    for(const row of rows.results.slice(0,query.limit)) {
      const occurrenceId=await bridgeHash([this.scope.installationId,this.scope.generation,row.id,row.version,row.next_evaluation_at]),dedupeKey=await bridgeHash([this.scope.installationId,this.scope.generation,occurrenceId,"shadow-evaluation"]),item:DueItem={id:row.id,version:row.version,occurrenceId,state:"blocked",reason:"intent_changed"};
      try {
        const guard=dueFollowUpGuard(this.scope,row,{id:row.source_id,revision:row.source_revision},this.clock());
        if(!await this.db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()){items.push(item);continue;}
        await this.statement(`INSERT INTO assistant_fup_occurrences SELECT ?,?,?,?,?,?,'pending' WHERE ${guard.sql} ON CONFLICT DO NOTHING`,occurrenceId,row.id,row.version,row.next_evaluation_at,...guard.values).run();
        const live=()=>dueFollowUpGuard(this.scope,row,{id:row.source_id,revision:row.source_revision},this.clock(),occurrenceId);
        const current=live();if(!await this.db.prepare(`SELECT 1 WHERE ${current.sql}`).bind(...current.values).first()){items.push(item);continue;}
        // Recover the original immutable request before reading new source/chat
        // fences: lost ACK plus new context never creates another evaluation.
        const prior=await this.statement(`SELECT j.id,j.state,l.request_hash FROM assistant_jobs j LEFT JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id WHERE j.${ns.replace(" AND "," AND j.")} AND j.dedupe_key=? AND j.occurrence_id=?`,dedupeKey,occurrenceId).first<{id:string;state:string;request_hash:string|null}>();
        let job;
        if(prior){if(!prior.request_hash)throw new Error("followup_ledger_missing");await seedDecisionJob(this.db,this.scope,prior.id,this.clock());job=prior;}
        else {
          const request=`${row.purpose}\nCondition (${row.condition_status??"unknown"}; not proven satisfied): ${row.condition_text??"unspecified"}\nDeadline UTC ms: ${row.due_at}; evaluation UTC ms: ${row.next_evaluation_at}; timezone: ${row.timezone}`;
          try{normalizeRetrievalInput({query:request});}catch{item.reason="input_limit";items.push(item);continue;}
          job=await new JobQueue(this.db,this.scope).enqueue({kind:"follow_up",dedupeKey,sourceId:row.source_id,sourceRevision:row.source_revision,request,runtime:"flue",subject:{kind:"fup_occurrence",occurrenceId,followUpId:row.id,followUpVersion:row.version}},this.clock());
        }
        const final=live();if(!await this.db.prepare(`SELECT 1 WHERE ${final.sql}`).bind(...final.values).first()){items.push(item);continue;}
        item.state="admitted";delete item.reason;item.jobId=job.id;item.evaluationState=job.state;
      }catch{item.state="unavailable";item.reason="admission_uncertain";}
      items.push(item);
    }
    const last=rows.results.slice(0,query.limit).at(-1),more=rows.results.length>query.limit;
    return {items,coverage:more?"page":"end_of_due_listing",...(more&&last?{nextCursor:btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([fingerprint,last.next_evaluation_at,last.id,last.version]))))}: {})};
  }
}
