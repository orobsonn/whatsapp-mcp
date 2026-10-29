import {observeSnapshot,snapshotProofPage,PROOF_PAGE_BYTES,PROOF_PAGE_SIZE,type CaptureObservation} from "../src/capture-snapshot-contract";
import type {AccessGuard} from './access';
export type OriginScope = { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
export type OriginRef = { sourceKind: "message" | "media" | "derivative" | "conversation"; sourceId: string; chatId: string };
export type ReaderQuery = OriginRef & { secret: string; sourceEpoch: string; sourceGeneration: string };
export interface SnapshotReader { readSnapshot(input: ReaderQuery): Promise<unknown>; readSnapshotProofs?(input:{secret:string;sourceEpoch:string;sourceGeneration:string;refs:OriginRef[]}):Promise<unknown>; readNativeInput?(input:unknown):Promise<unknown>; installationAffinity?(input: { secret: string }): Promise<unknown>; readRecipientEnvelope?(input:unknown):Promise<unknown>; streamHead?(input:{secret:string;sourceEpoch:string;sourceGeneration:string}):Promise<unknown>; readConversationActivity?(input:{secret:string;sourceEpoch:string;sourceGeneration:string;chatId:string}):Promise<unknown> }
export const scopeKeys = (scope: OriginScope) => [scope.installationId, scope.generation, scope.sourceEpoch, scope.sourceGeneration];
export const originScopeSql = "installation_id=? AND generation=? AND source_epoch=? AND source_generation=?";
export function activeOrigin(getScope: () => OriginScope) {
  const scope = Object.freeze({ ...getScope() });
  if (scopeKeys(scope).some((value) => typeof value !== "string" || !value || value.length > 256)) throw new Error("origin_unconfigured");
  return scope;
}
export type Observation = CaptureObservation;
export type OriginDiagnostic={phase:'pre_fence_sql'|'reader_rpc'|'snapshot_parse'|'post_fence_sql';reason:string;elapsedMs:number};
const diagnosticReasons=new Set(['exception','reader_timeout','reader_unavailable','reader_changed','source_unavailable','snapshot_too_large','snapshot_identity_mismatch','snapshot_incomplete','version_mismatch','media_unavailable','message_unavailable','derivative_unavailable','derivative_without_text','snapshot_changed']);
function originDiagnostic(report:((event:OriginDiagnostic)=>void)|undefined,phase:OriginDiagnostic['phase'],reason:string,started:number){
 // Closed vocabulary only: never record provider exception text, IDs or bodies.
 try{report?.({phase,reason:diagnosticReasons.has(reason)?reason:'exception',elapsedMs:Math.max(0,Date.now()-started)});}catch{/* Diagnostics cannot alter authority. */}
}
export type OriginFence = OriginScope & OriginRef & { canonicalId: string; revision: number; version: number;
  watermark: number; hash: string; conversationKind: "private" | "group"; policyRevision: number; policyMode: string };
type OriginRow = { canonical_id:string;source_kind: OriginRef["sourceKind"]; source_id: string; chat_id: string; watermark: number; observation_hash: string;
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
  async observe(scope: OriginScope, ref: OriginRef,report?:(event:OriginDiagnostic)=>void): Promise<Observation> {
    const started=Date.now();let phase:OriginDiagnostic['phase']='reader_rpc';
    const blocked = (reason: string): Observation => {originDiagnostic(report,phase,reason,started);return { state: "blocked", reason, watermark: null, kind: null, hash: null, sourceVersion: null, content: null };};
    let timer: ReturnType<typeof setTimeout> | undefined,raw:unknown;
    try {
      raw = await Promise.race([
        this.reader.readSnapshot({ sourceKind: ref.sourceKind, sourceId: ref.sourceId, chatId: ref.chatId, sourceEpoch: scope.sourceEpoch, sourceGeneration: scope.sourceGeneration, secret: this.secret }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("reader_timeout")), this.timeoutMs); }),
      ]);
    } catch (error) { return blocked(error instanceof Error && error.message === "reader_timeout" ? "reader_timeout" : "reader_unavailable"); }
    finally { clearTimeout(timer); }
    return observeSnapshot(raw,{...scope,...ref},event=>originDiagnostic(report,event.phase,event.reason,started));
  }

  private fenceQuery(scope: OriginScope, canonicalId: string|string[]):AccessGuard {
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
    return {sql:`SELECT o.canonical_id,o.source_kind,o.source_id,o.chat_id,o.watermark,o.observation_hash,s.revision,s.current_version,
      c.kind,c.watermark AS chat_watermark,c.access_state,p.kind AS policy_kind,COALESCE(p.revision,0) AS policy_revision,
      COALESCE(p.effective_mode,CASE WHEN c.kind='private' THEN 'attend' ELSE 'ignore' END) AS policy_mode
      FROM assistant_source_origins o JOIN assistant_sources s ON s.installation_id=o.installation_id AND s.generation=o.generation AND s.id=o.canonical_id
      JOIN assistant_origin_conversations c ON c.installation_id=o.installation_id AND c.generation=o.generation
        AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id
      LEFT JOIN assistant_conversation_modes p ON p.installation_id=o.installation_id AND p.generation=o.generation AND p.conversation_id=o.chat_id
      WHERE o.installation_id=? AND o.generation=? AND o.source_epoch=? AND o.source_generation=? AND o.canonical_id ${Array.isArray(canonicalId)?'IN(SELECT value FROM json_each(?))':'=?'}
      AND o.tombstoned=0 AND s.status='active' ${ownerPolicy}`,values:[...scopeKeys(scope),Array.isArray(canonicalId)?JSON.stringify(canonicalId):canonicalId]};
  }
  private fenceStatement(scope: OriginScope, canonicalId: string) {
    const query=this.fenceQuery(scope,canonicalId);return this.db.prepare(query.sql).bind(...query.values);
  }
  /** Local half of the same fence snapshot, for a host-owned D1 effect latch.
   * A fresh remote check is still required immediately before that transaction. */
  localGuard(expected:OriginFence):AccessGuard { return this.expectedGuard(expected,false); }
  /** Context validity ignores activity alone; action freshness still uses localGuard. */
  localContextGuard(expected:OriginFence):AccessGuard { return this.expectedGuard(expected,true); }
  private expectedGuard(expected:OriginFence,context:boolean):AccessGuard {
    const scope=activeOrigin(this.getScope);
    if(!expected||JSON.stringify(scopeKeys(scope))!==JSON.stringify(scopeKeys(expected)))return {sql:'0',values:[]};
    const query=this.fenceQuery(scope,expected.canonicalId);
    return {sql:`EXISTS(SELECT 1 FROM (${query.sql}) observed WHERE observed.access_state='available'
      AND (observed.policy_kind IS NULL OR observed.policy_kind=observed.kind)
      AND (observed.policy_mode<>'ignore'${this.purpose === "owner_read" ? " OR observed.kind='group'" : ""})
      AND observed.source_kind IS ? AND observed.source_id IS ? AND observed.chat_id IS ? AND observed.observation_hash IS ?
      AND observed.revision IS ? AND observed.current_version IS ? ${context ? "" : "AND observed.chat_watermark IS ?"}
      AND observed.kind IS ? AND observed.policy_revision IS ? AND observed.policy_mode IS ?)`,
      values:[...query.values,expected.sourceKind,expected.sourceId,expected.chatId,expected.hash,expected.revision,expected.version,...(context?[]:[expected.watermark]),expected.conversationKind,expected.policyRevision,expected.policyMode]};
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
  /** A newer chat watermark only supersedes action intent. It does not change
   * evidence already held in a native transcript or summary. */
  async checkContext(fence:OriginFence,isCurrent:()=>boolean=()=>true,report?:(event:OriginDiagnostic)=>void):Promise<{state:'current'|'changed'|'unavailable'}> {
    if(!fence)return {state:'changed'};
    fence=JSON.parse(JSON.stringify(fence)) as OriginFence;
    const equal=(a:OriginFence|null)=>!!a&&sameFence({...a,watermark:fence.watermark},fence);
    if(!isCurrent()||!fence||JSON.stringify(scopeKeys(activeOrigin(this.getScope)))!==JSON.stringify(scopeKeys(fence)))return {state:'changed'};
    const started=Date.now();let phase:OriginDiagnostic['phase']='pre_fence_sql';
    try {
      if(!equal(await this.fence(fence.canonicalId)))return {state:'changed'};
      phase='reader_rpc';const observed=await this.observe(fence,fence,report);
      if(!isCurrent()||JSON.stringify(scopeKeys(activeOrigin(this.getScope)))!==JSON.stringify(scopeKeys(fence)))return {state:'changed'};
      if(observed.state==='blocked')return {state:observed.reason==='snapshot_identity_mismatch'?'changed':'unavailable'};
      if(observed.state!=='available'||observed.hash!==fence.hash||observed.kind!==fence.conversationKind)return {state:'changed'};
      phase='post_fence_sql';return {state:equal(await this.fence(fence.canonicalId))&&isCurrent()?'current':'changed'};
    } catch { originDiagnostic(report,phase,'exception',started);return {state:'unavailable'}; }
  }
  /** Whole-page proof, never a partial grant. No individual fallback after a
   * batch transport/protocol failure. Scope/cancellation checks bracket awaits. */
  async checkContexts(input:OriginFence[],signal?:AbortSignal,report?:(event:OriginDiagnostic,index?:number)=>void):Promise<{state:'current'|'changed'|'unavailable';proofPages:number;singularChecks:number}>{
    signal?.throwIfAborted();const fences=JSON.parse(JSON.stringify(input)) as OriginFence[];
    if(fences.length>PROOF_PAGE_SIZE||new Set(fences.map(f=>f.canonicalId)).size!==fences.length)throw Error('origin_context_page_limit');
    let proofPages=0,singularChecks=0;const result=(state:'current'|'changed'|'unavailable')=>({state,proofPages,singularChecks});
    if(!fences.length)return result('current');
    const scope=activeOrigin(this.getScope),current=()=>JSON.stringify(scopeKeys(activeOrigin(this.getScope)))===JSON.stringify(scopeKeys(scope));
    if(fences.some(f=>JSON.stringify(scopeKeys(f))!==JSON.stringify(scopeKeys(scope))))return result('changed');
    if(typeof this.reader.readSnapshotProofs!=='function'){
      const states=[];for(let at=0;at<fences.length;at+=8){signal?.throwIfAborted();singularChecks+=Math.min(8,fences.length-at);
        states.push(...await Promise.all(fences.slice(at,at+8).map((f,i)=>this.checkContext(f,()=>!signal?.aborted&&current(),event=>report?.(event,at+i)))));signal?.throwIfAborted();}
      return result(states.some(s=>s.state==='changed')?'changed':states.some(s=>s.state==='unavailable')?'unavailable':'current');
    }
    const started=Date.now();let phase:OriginDiagnostic['phase']='pre_fence_sql',timer:ReturnType<typeof setTimeout>|undefined;
    const local=async()=>{
      const query=this.fenceQuery(scope,fences.map(f=>f.canonicalId)),rows=await this.db.prepare(query.sql).bind(...query.values).all<OriginRow>();
      signal?.throwIfAborted();const byId=new Map<string,OriginFence|null>();for(const row of rows.results){if(byId.has(row.canonical_id))throw Error('origin_context_page_duplicate');byId.set(row.canonical_id,this.fenceRow(scope,row.canonical_id,row));}
      return current()&&fences.every(f=>{const observed=byId.get(f.canonicalId);return observed&&sameFence({...observed,watermark:f.watermark},f);});
    };
    try{
      if(!await local())return result('changed');signal?.throwIfAborted();phase='reader_rpc';proofPages++;
      const raw=await Promise.race([
        this.reader.readSnapshotProofs({secret:this.secret,sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,refs:fences.map(({sourceKind,sourceId,chatId})=>({sourceKind,sourceId,chatId}))}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('reader_timeout')),5000);}),
      ]);clearTimeout(timer);signal?.throwIfAborted();if(!current())return result('changed');phase='snapshot_parse';
      const serialized=JSON.stringify(raw);if(new TextEncoder().encode(serialized).length>PROOF_PAGE_BYTES)throw Error('snapshot_too_large');
      const page=snapshotProofPage.parse(JSON.parse(serialized));
      if(page.state!=='available'){originDiagnostic(event=>report?.(event),'reader_rpc',page.reason,started);return result('unavailable');}
      const key=(r:OriginRef)=>JSON.stringify([r.sourceKind,r.sourceId,r.chatId]),proofs=new Map(page.items.map(p=>[key(p),p]));
      if(page.sourceEpoch!==scope.sourceEpoch||page.sourceGeneration!==scope.sourceGeneration||proofs.size!==page.items.length||proofs.size!==fences.length||fences.some(f=>!proofs.has(key(f))))throw Error('snapshot_identity_mismatch');
      const changed=fences.some(f=>{const p=proofs.get(key(f))!;return p.state==='withdrawn'||p.state==='available'&&(p.hash!==f.hash||p.kind!==f.conversationKind);});
      let unavailable=false;for(let index=0;index<fences.length;index++){const p=proofs.get(key(fences[index]))!;if(p.state==='blocked'){unavailable=true;originDiagnostic(event=>report?.(event,index),'reader_rpc',p.reason??'source_unavailable',started);}}
      phase='post_fence_sql';
      if(!await local())return result('changed');signal?.throwIfAborted();
      return result(changed?'changed':unavailable?'unavailable':'current');
    }catch(error){signal?.throwIfAborted();originDiagnostic(event=>report?.(event),phase,error instanceof Error?error.message:'exception',started);return result('unavailable');}
    finally{clearTimeout(timer);}
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
