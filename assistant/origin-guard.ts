import { z } from "zod";
import { bridgeHash } from "./ingress";
import type {AccessGuard} from './access';
export type OriginScope = { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
export type OriginRef = { sourceKind: "message" | "media" | "derivative" | "conversation"; sourceId: string; chatId: string };
export type ReaderQuery = OriginRef & { secret: string; sourceEpoch: string; sourceGeneration: string };
export interface SnapshotReader { readSnapshot(input: ReaderQuery): Promise<unknown>; installationAffinity?(input: { secret: string }): Promise<unknown>; readRecipientEnvelope?(input:unknown):Promise<unknown>; streamHead?(input:{secret:string;sourceEpoch:string;sourceGeneration:string}):Promise<unknown> }
export const scopeKeys = (scope: OriginScope) => [scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration];
export const originScopeSql = "installation_id=? AND generation=? AND source_epoch=? AND source_generation=?";
export function activeOrigin(getScope: () => OriginScope) {
  const scope = Object.freeze({ ...getScope() });
  if (scopeKeys(scope).some((value) => typeof value !== "string" || !value || value.length > 256)) throw new Error("origin_unconfigured");
  return scope;
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().max(512);
const content = z.object({
  kind: label, text: z.string().nullable().optional(), name: label.optional(), authorId: label.nullable().optional(),
  authorName: label.nullable().optional(), fromMe: z.boolean().optional(), occurredAt: integer.optional(), receivedAt: integer.optional(),
  messageId: label.optional(), messageVersion: integer.optional(), mediaVersion: integer.optional(),
  media: z.object({ id: label, version: integer, hash: z.string().regex(/^[a-f0-9]{64}$/), size: integer.nullable(), mime: label.nullable() }).optional(),
});
const snapshot = z.object({
  observation: z.literal("capture_snapshot"), state: z.enum(["available", "withdrawn", "blocked"]), reason: label.optional(),
  sourceEpoch: label.optional(), sourceGeneration: label.optional(), sourceKind: z.enum(["message", "media", "derivative", "conversation"]).optional(),
  sourceId: label.optional(), chatId: label.optional(), sourceVersion: integer.nullable().optional(), watermark: integer.nullable().optional(),
  conversationKind: z.enum(["private", "group"]).optional(),
  access: z.object({ captureEnabled: z.boolean(), captureSince: integer.nullable(), discontinuous: z.boolean() }).optional(), content: content.optional(),
});
export type Observation = {
  state: "available" | "withdrawn" | "blocked"; reason: string | null; watermark: number | null;
  kind: "private" | "group" | null; conversationWithdrawn?: boolean; hash: string | null; sourceVersion: number | null; content: z.infer<typeof content> | null;
};
export type OriginFence = OriginScope & OriginRef & { canonicalId: string; revision: number; version: number;
  watermark: number; hash: string; conversationKind: "private" | "group"; policyRevision: number; policyMode: string };
type OriginRow = { source_kind: OriginRef["sourceKind"]; source_id: string; chat_id: string; watermark: number; observation_hash: string;
  revision: number; current_version: number; policy_kind: string | null; kind: "private" | "group"; chat_watermark: number; access_state: string; policy_revision: number; policy_mode: string };
// Persistence/schema parsing may reorder properties. Compare the exact flat
// field set and values; additional or changed fields still deny the reference.
export function sameFence(current: OriginFence | null, expected: OriginFence): boolean {
  if (!current || Object.keys(current).length !== Object.keys(expected).length) return false;
  return (Object.keys(current) as (keyof OriginFence)[]).every(key => Object.hasOwn(expected, key) && current[key] === expected[key]);
}

/** Remote observations only: eight in flight, one fixed total five-second
 * deadline. Late RPCs can finish but cannot publish or start more checks. */
export async function checkOriginsWithin(fences:OriginFence[],check:(fence:OriginFence)=>Promise<boolean>):Promise<boolean> {
  if(!fences.length)return true;
  let next=0,stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<boolean>(resolve=>{timer=setTimeout(()=>{stopped=true;resolve(false);},5000);});
  const work=Promise.all(Array.from({length:Math.min(8,fences.length)},async()=>{
    while(!stopped && next<fences.length){const fence=fences[next++];let valid=false;try{valid=await check(fence);}catch{/* A failed observation denies the whole proof. */}if(!valid){stopped=true;return false;}}
    return !stopped;
  })).then(results=>results.every(Boolean));
  try{return await Promise.race([work,deadline]);}finally{stopped=true;clearTimeout(timer);}
}

// Reader responses remain observations. Consumers must also enforce local ACL
// in their admission/publication mutation; no cross-worker transaction exists.
export class OriginGuard {
  constructor(private readonly db: D1Database, private readonly getScope: () => OriginScope,
    private readonly reader: SnapshotReader, private readonly secret: string, private readonly timeoutMs = 2000,
    private readonly purpose: "automation" | "owner_read" = "automation") {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("origin_reader_deadline");
    if (purpose !== "automation" && purpose !== "owner_read") throw new Error("origin_reader_purpose");
  }
  async observe(scope: OriginScope, ref: OriginRef): Promise<Observation> {
    const blocked = (reason: string): Observation => ({ state: "blocked", reason, watermark: null, kind: null, hash: null, sourceVersion: null, content: null });
    let parsed: z.infer<typeof snapshot>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.reader.readSnapshot({ sourceKind: ref.sourceKind, sourceId: ref.sourceId, chatId: ref.chatId, sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration, secret: this.secret }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("reader_timeout")), this.timeoutMs); }),
      ]);
      // Own every nested field synchronously before hashing yields.
      const serialized = JSON.stringify(raw);
      if (new TextEncoder().encode(serialized).length > 32768) return blocked("snapshot_too_large");
      parsed = snapshot.parse(JSON.parse(serialized));
    } catch (error) { return blocked(error instanceof Error && error.message === "reader_timeout" ? "reader_timeout" : "reader_unavailable"); }
    finally { clearTimeout(timer); }
    if (parsed.sourceEpoch !== scope.sourceEpoch || parsed.sourceGeneration !== scope.sourceGeneration || parsed.chatId !== ref.chatId ||
      parsed.sourceId !== ref.sourceId || parsed.sourceKind !== ref.sourceKind) return blocked("snapshot_identity_mismatch");
    if (parsed.state === "blocked") {
      const known = ["reader_unavailable", "source_unavailable", "snapshot_too_large", "version_mismatch", "media_unavailable", "message_unavailable", "derivative_unavailable", "derivative_without_text"];
      return blocked(known.includes(parsed.reason ?? "") ? parsed.reason! : "source_unavailable");
    }
    if (!Number.isSafeInteger(parsed.watermark) || !parsed.conversationKind || !parsed.access) return blocked("snapshot_incomplete");
    const base = { state: parsed.state, reason: null, watermark: parsed.watermark!, kind: parsed.conversationKind,
      hash: null, conversationWithdrawn: !parsed.access.captureEnabled, sourceVersion: parsed.sourceVersion ?? null, content: parsed.content ?? null };
    if (parsed.state === "withdrawn" || !parsed.access.captureEnabled) return { ...base, state: "withdrawn", content: null };
    if (!parsed.content || (ref.sourceKind !== "conversation" && (!parsed.content.messageId || !parsed.content.messageVersion))) return blocked("snapshot_incomplete");
    return { ...base, hash: await bridgeHash([parsed.sourceVersion ?? null, parsed.access, parsed.content]) };
  }
  private fenceQuery(scope: OriginScope, canonicalId: string):AccessGuard {
    // The trusted Owner read adapter may inspect captured groups without
    // enabling automation. Exclusions and restored policy quarantine remain
    // separate denials: both are represented as "ignore" in the public view.
    const ownerPolicy = this.purpose === "owner_read" ? `AND NOT EXISTS(
      SELECT 1 FROM assistant_conversation_policies owner_policy
      WHERE owner_policy.installation_id=o.installation_id AND owner_policy.generation=o.generation AND owner_policy.conversation_id=o.chat_id
      AND (owner_policy.excluded=1 OR EXISTS(SELECT 1 FROM assistant_retention_quarantines owner_quarantine
        WHERE owner_quarantine.installation_id=owner_policy.installation_id AND owner_quarantine.generation=owner_policy.generation
        AND owner_quarantine.kind='policy' AND owner_quarantine.conversation_id=owner_policy.conversation_id
        AND owner_quarantine.version=owner_policy.revision AND owner_quarantine.active=1)))` : "";
    return {sql:`SELECT o.source_kind,o.source_id,o.chat_id,o.watermark,o.observation_hash,s.revision,s.current_version,
      c.kind,c.watermark AS chat_watermark,c.access_state,p.kind AS policy_kind,COALESCE(p.revision,0) AS policy_revision,
      COALESCE(p.effective_mode,CASE WHEN c.kind='private' THEN 'attend' ELSE 'ignore' END) AS policy_mode
      FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
      JOIN assistant_origin_conversations c ON c.installation_id=o.installation_id AND c.generation=o.generation
        AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id
      LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
      WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.canonical_id=?
      AND o.tombstoned=0 AND s.status='active' ${ownerPolicy}`,values:[...scopeKeys(scope),canonicalId]};
  }
  private fenceStatement(scope: OriginScope, canonicalId: string) {
    const query=this.fenceQuery(scope,canonicalId);return this.db.prepare(query.sql).bind(...query.values);
  }
  /** Local half of the same fence snapshot, for a host-owned D1 effect latch.
   * A fresh remote check is still required immediately before that transaction. */
  localGuard(expected:OriginFence):AccessGuard {
    const scope=activeOrigin(this.getScope);
    if(!expected||JSON.stringify(scopeKeys(scope))!==JSON.stringify(scopeKeys(expected)))return {sql:'0',values:[]};
    const query=this.fenceQuery(scope,expected.canonicalId);
    return {sql:`EXISTS(SELECT 1 FROM (${query.sql}) observed WHERE observed.access_state='available'
      AND (observed.policy_kind IS NULL OR observed.policy_kind=observed.kind)
      AND (observed.policy_mode<>'ignore'${this.purpose === "owner_read" ? " OR observed.kind='group'" : ""})
      AND observed.source_kind IS ? AND observed.source_id IS ? AND observed.chat_id IS ? AND observed.observation_hash IS ?
      AND observed.revision IS ? AND observed.current_version IS ? AND observed.chat_watermark IS ?
      AND observed.kind IS ? AND observed.policy_revision IS ? AND observed.policy_mode IS ?)`,
      values:[...query.values,expected.sourceKind,expected.sourceId,expected.chatId,expected.hash,expected.revision,expected.version,expected.watermark,expected.conversationKind,expected.policyRevision,expected.policyMode]};
  }
  private fenceRow(scope: OriginScope, canonicalId: string, row: OriginRow | null): OriginFence | null {
    if (!row || row.access_state !== "available" || !row.kind || (row.policy_kind !== null && row.policy_kind !== row.kind)
      || row.policy_mode === "ignore" && !(this.purpose === "owner_read" && row.kind === "group")) return null;
    return { ...scope, canonicalId, sourceKind: row.source_kind, sourceId: row.source_id, chatId: row.chat_id,
      revision: row.revision, version: row.current_version, watermark: row.chat_watermark, hash: row.observation_hash,
      conversationKind: row.kind, policyRevision: row.policy_revision, policyMode: row.policy_mode };
  }
  async fence(canonicalId: string): Promise<OriginFence | null> {
    const scope = activeOrigin(this.getScope);
    return this.fenceRow(scope, canonicalId, await this.fenceStatement(scope, canonicalId).first<OriginRow>());
  }
  /** Same statement and mapper as fence(), grouped for the bounded host scan. */
  async fences(canonicalIds: string[]): Promise<(OriginFence | null)[]> {
    if (canonicalIds.length > 6) throw new Error("origin_fence_batch_limit");
    const scope = activeOrigin(this.getScope); canonicalIds = [...canonicalIds];
    if (!canonicalIds.length) return [];
    const rows = await this.db.batch<OriginRow>(canonicalIds.map(id => this.fenceStatement(scope, id)));
    if (rows.length !== canonicalIds.length) throw new Error("origin_fence_batch_result");
    return rows.map((row, index) => this.fenceRow(scope, canonicalIds[index], row.results[0] ?? null));
  }
  async check(fence: OriginFence,isCurrent:()=>boolean=()=>true): Promise<boolean> {
    if (fence) fence = JSON.parse(JSON.stringify(fence)) as OriginFence;
    if (!isCurrent()||!fence || JSON.stringify(scopeKeys(activeOrigin(this.getScope))) !== JSON.stringify(scopeKeys(fence))) return false;
    const current = await this.fence(fence.canonicalId);
    if (!isCurrent()||!sameFence(current, fence)) return false;
    const observed = await this.observe(fence, fence);
    return isCurrent()&&JSON.stringify(scopeKeys(activeOrigin(this.getScope))) === JSON.stringify(scopeKeys(fence)) && observed.state === "available"
      && observed.watermark === fence.watermark && observed.hash === fence.hash && observed.kind === fence.conversationKind
      && sameFence(await this.fence(fence.canonicalId), fence)&&isCurrent();
  }
}
