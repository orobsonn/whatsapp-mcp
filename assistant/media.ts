import { SourceAccess, type TrustedActor,type AccessGuard } from "./access";
import { InferenceBudget, type BudgetScope } from "./budget";
import { bridgeHash } from "./ingress";
import { sourceTextHash } from "./sources";
import type { OriginFence, OriginGuard, OriginScope } from "./origin-guard";
import type { RetrievedSource } from "./retrieval";
import type { CaptureMediaResult } from "../src/assistant-media-reader";
import { admitMedia, type MediaAdmission, type PdfAdmissionReader } from "./media-admission";
import { mediaModelConfig, mediaPayload, mediaOutput, mediaUsage, type MediaModelPort,type MediaModelProvider } from "./media-model";
import { storedMediaEvidence, type MediaEvidence } from "./media-evidence";
import { retentionExecutionGuard } from "./retention-execution";
import {compactStatement} from './d1-statement';
import {sqlAnd} from './sql-conjunction';
export interface MediaReader { readBoundedMedia(input: { secret: string; sourceEpoch: string; sourceGeneration: string; chatId: string; mediaId: string; expectedMessageVersion: number; expectedMediaVersion: number; expectedBlobHash: string }): Promise<CaptureMediaResult> }
type Options = { origin: OriginGuard; reader: MediaReader; secret: string; model: MediaModelPort; modelProvider?:MediaModelProvider;pdfParser?: PdfAdmissionReader; timeoutMs?: number;
 accessPurpose?:'archive'|'knowledge';assertAuthority?:()=>Promise<void>;authorityGuard?:()=>AccessGuard;modelGuard?:()=>AccessGuard };
type Outcome = { state: "complete"; evidence: MediaEvidence; coverage: { complete: boolean; unreadablePages: number[] } } | { state: "pending"; reason: string; operationKey?: string } | { state: "existing_audio"; source: RetrievedSource };
type Receipt = { state: string; request_hash: string | null; admission_json: string | null; response_json: string | null; actual_units: number | null; reason: string | null };
const ns = "installation_id=? AND generation=?";
const complete = (evidence: MediaEvidence): Outcome => { const unreadablePages = evidence.pages.filter(row => row.state === "unreadable").map(row => row.page); return { state: "complete", evidence, coverage: { complete: !unreadablePages.length, unreadablePages } }; };
const pending = (reason: string, operationKey?: string): Outcome => ({ state: "pending", reason, ...(operationKey ? { operationKey } : {}) });
/** One captured file per operation. No public endpoint, action/control capability,
 * generic URL reader or ASR producer. Derivations depend on current parent ACL. */
export class MediaContext {
  private readonly scope: Readonly<BudgetScope & OriginScope>;
  private readonly access: SourceAccess;
  private readonly budget: InferenceBudget;
  private readonly timeout: number;
  constructor(private readonly db: D1Database, scope: BudgetScope & OriginScope, private readonly options: Options, private readonly clock = Date.now) {
    this.scope = Object.freeze({ ...scope }); this.access = new SourceAccess(db, scope, clock,options.accessPurpose??'archive'); this.budget = new InferenceBudget(db, scope);
    this.timeout = options.timeoutMs ?? 45000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000) throw new Error("media_configuration");
  }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  private sql(query: string, ...values: (string | number | null)[]) { return this.db.prepare(query).bind(...values); }
  private receipt(key: string) { return this.sql(`SELECT state,request_hash,admission_json,response_json,actual_units,reason FROM assistant_media_receipts WHERE ${ns} AND operation_key=?`, ...this.keys(), key).first<Receipt>(); }
  private otherAttemptGuard(ref:{id:string;revision:number;version:number;hash:string},key:string):AccessGuard{
    return {sql:`NOT EXISTS(SELECT 1 FROM assistant_media_receipts other WHERE other.installation_id=? AND other.generation=? AND other.source_id=? AND other.source_revision=? AND other.source_version=? AND other.source_hash=? AND other.operation_key<>? AND other.state IN ('attempting','uncertain','response_ready'))`,values:[...this.keys(),ref.id,ref.revision,ref.version,ref.hash,key]};
  }
  private async fresh(actor: TrustedActor, parent: RetrievedSource, origin: OriginFence) {
    // Remote observation can yield while a local mandate/identity/ACL is revoked.
    // Re-read local authority last, with the current clock, before returning.
    // Source reads stay internal; the full authority proof follows their awaits.
    // Repeating it before them rescans the entire native history without
    // replacing the final proof or its atomic local guard.
    if(!await this.access.revalidate(actor,parent.fence)||!await this.options.origin.check(origin))return false;
    await this.options.assertAuthority?.();
    const source=this.access.guard(actor,parent.fence,this.clock()),host=this.options.authorityGuard?.();
    return !!await this.sql(`SELECT 1 WHERE (${source.sql})${host?` AND (${host.sql})`:''}`,...source.values,...(host?.values??[])).first();
  }
  async read(actor: TrustedActor, parent: RetrievedSource): Promise<MediaEvidence | null> {
    const current = parent?.fence ? await this.access.read(actor, parent.id, parent.fence.source.revision) : null;
    if (!current || JSON.stringify(current.fence) !== JSON.stringify(parent.fence) || current.fence.source.origin !== "whatsapp") return null;
    const origin = await this.options.origin.fence(parent.id); if (!origin || !await this.fresh(actor, current, origin)) return null;
    const ref = { id: current.id, revision: current.fence.source.revision, version: current.fence.source.version, hash: current.fence.source.hash };
    const evidence = await storedMediaEvidence(this.db, this.scope, ref);
    return evidence && await this.fresh(actor, current, origin) ? evidence : null;
  }
  async interpret(actor: TrustedActor, sourceId: string): Promise<Outcome> {
    // Actor is host supplied; neither the model nor file chooses it.
    actor = Object.freeze({ ...actor });
    const parent = await this.access.read(actor, sourceId); if (!parent || parent.fence.source.origin !== "whatsapp") return pending("media_source_unavailable");
    const origin = await this.options.origin.fence(sourceId); if (!origin || !await this.fresh(actor, parent, origin)) return pending("media_origin_unavailable");
    const observation = await this.options.origin.observe(origin, origin), content = observation.content;
    if (observation.state !== "available" || observation.hash !== origin.hash || observation.watermark !== origin.watermark || !content) return pending("media_origin_changed");
    // Existing real transcripts are already materialized text sources. No new ASR.
    if (origin.sourceKind === "derivative" && typeof content.text === "string" && content.kind === "transcript") {
      return await this.fresh(actor, parent, origin) ? { state: "existing_audio", source: { ...parent, origin } } : pending("media_origin_changed");
    }
    if (content.kind === "audio") return pending("audio_transcription_pending");
    if(content.kind==='pdf'&&this.options.modelProvider==='deepseek')return pending('media_pdf_model_unavailable');
    const media = content.media;
    if (origin.sourceKind !== "media" || !media || media.id !== origin.sourceId || !["image", "pdf"].includes(content.kind) || !content.messageVersion || !media.version || !media.mime) return pending("media_unsupported");
    const ref = { id: parent.id, revision: parent.fence.source.revision, version: parent.fence.source.version, hash: parent.fence.source.hash };
    const config=mediaModelConfig(this.options.modelProvider),configHash = await bridgeHash(config), key = "media:" + await bridgeHash([...this.keys(), ref, media.hash, configHash]);
    const cached = await this.read(actor, parent); if (cached?.receiptKey === key) return complete(cached);
    // Provider/configuration migration cannot bypass an unresolved prior
    // attempt against this same exact parent. Its custody stays intact.
    const prior=await this.sql(`SELECT operation_key FROM assistant_media_receipts WHERE ${ns} AND source_id=? AND source_revision=? AND source_version=? AND source_hash=? AND operation_key<>? AND state IN ('attempting','uncertain','response_ready') LIMIT 1`,...this.keys(),ref.id,ref.revision,ref.version,ref.hash,key).first<{operation_key:string}>();
    if(prior)return pending('media_prior_attempt_unresolved',prior.operation_key);
    let receipt = await this.receipt(key);
    if (receipt?.actual_units !== null && receipt?.actual_units !== undefined) return this.finish(actor, parent, origin, key, configHash, media.hash, receipt);
    if (receipt && ["parsing", "attempting", "uncertain", "blocked"].includes(receipt.state)) return pending(receipt.reason ?? (receipt.state === "parsing" ? "media_parse_interrupted" : "media_uncertain"), key);
    let binary: CaptureMediaResult;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    try { binary = await Promise.race([this.options.reader.readBoundedMedia({ secret: this.options.secret, sourceEpoch: origin.sourceEpoch, sourceGeneration: origin.sourceGeneration,
      chatId: origin.chatId, mediaId: media.id, expectedMessageVersion: content.messageVersion, expectedMediaVersion: media.version, expectedBlobHash: media.hash }), new Promise<never>((_, reject) => { readTimer = setTimeout(() => reject(new Error("media_read_timeout")), 2000); })]); }
    catch { return pending("media_reader_unavailable", key); }
    finally { clearTimeout(readTimer); }
    if (binary.state !== "available") return pending("media_reader_unavailable", key);
    // Own the bytes before hashing/await; nominal RPC is still checked locally.
    if (!(binary.bytes instanceof Uint8Array) || binary.bytes.length < 1 || binary.bytes.length > 2097152) return pending("media_bytes_limit", key);
    const bytes = binary.bytes.slice();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    if (binary.observation !== "capture_media" || binary.sourceEpoch !== origin.sourceEpoch || binary.sourceGeneration !== origin.sourceGeneration || binary.chatId !== origin.chatId || binary.mediaId !== media.id || binary.messageVersion !== content.messageVersion || binary.mediaVersion !== media.version || binary.mime !== media.mime || binary.blobHash !== media.hash || digest !== media.hash || binary.size !== bytes.length || media.size !== bytes.length || binary.watermark !== origin.watermark || !await this.fresh(actor, parent, origin)) return pending("media_reference_changed", key);
    let admission: MediaAdmission;
    if (!receipt) {
      const guard = this.access.guard(actor, parent.fence, this.clock());
      let claimed;
      try { claimed = await this.sql(`INSERT INTO assistant_media_receipts(installation_id,generation,operation_key,source_id,source_revision,source_version,source_hash,blob_hash,config_hash,state,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,'parsing',? WHERE ${guard.sql} ON CONFLICT DO NOTHING RETURNING operation_key`, ...this.keys(), key, ref.id, ref.revision, ref.version, ref.hash, media.hash, configHash, this.clock(), ...guard.values).all(); }
      catch { return pending("media_parse_claim_uncertain", key); }
      if (claimed.results.length !== 1) return pending("media_busy", key);
      try {
        admission = await admitMedia(bytes, media.mime, this.options.pdfParser);
        await this.sql(`UPDATE assistant_media_receipts SET state='prepared',admission_json=? WHERE ${ns} AND operation_key=? AND state='parsing'`, JSON.stringify(admission), ...this.keys(), key).run();
      } catch {
        await this.sql(`UPDATE assistant_media_receipts SET state='blocked',reason='media_parse_failed' WHERE ${ns} AND operation_key=? AND state='parsing'`, ...this.keys(), key).run();
        return pending("media_parse_failed", key);
      }
      receipt = await this.receipt(key);
    }
    if (receipt?.state !== "prepared" || !receipt.admission_json) return pending("media_busy", key);
    admission = JSON.parse(receipt.admission_json) as MediaAdmission;
    const body = mediaPayload(bytes, media.mime, admission,this.options.modelProvider), requestHash = await bridgeHash(body);
    if (!await this.fresh(actor, parent, origin)) return pending("media_origin_changed", key);
    try { const reserved = await this.budget.reserve(key, requestHash, config.ceilingUnits); if (!reserved.created) return pending("media_reservation_uncertain", key); }
    catch { return pending("media_budget_unavailable", key); }
    const guard = this.access.guard(actor, parent.fence, this.clock()), execution = retentionExecutionGuard(this.scope),modelGuard=this.options.modelGuard?.()??{sql:'1',values:[]},other=this.otherAttemptGuard(ref,key);
    try {
      if (!await this.fresh(actor, parent, origin)) { await this.budget.settle(key, requestHash, 0); return pending("media_origin_changed", key); }
      const admitted = await this.sql(`UPDATE assistant_media_receipts SET state='attempting',request_hash=? WHERE ${ns} AND operation_key=? AND state='prepared' AND ${guard.sql} AND ${execution.sql} AND (${modelGuard.sql}) AND (${other.sql}) RETURNING operation_key`, requestHash, ...this.keys(), key, ...guard.values, ...execution.values,...modelGuard.values,...other.values).all();
      if (admitted.results.length !== 1) return pending("media_admission_uncertain", key);
    } catch { return pending("media_admission_uncertain", key); }
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, knownActual: number | null = null;
    try {
      // A withdrawal after admission must still prevent sending its body.
      if (!await this.fresh(actor, parent, origin)) { await this.budget.settle(key, requestHash, 0); return pending("media_origin_changed", key); }
      // Source/Origin, native context, restore and spend must share this LAST
      // local snapshot. An earlier awaited fresh() does not authorize upload
      // after a withdrawal committed during a later budget/restore query.
      const finalGuards=[this.access.guard(actor,parent.fence,this.clock()),this.options.origin.localGuard(origin),
        this.options.authorityGuard?.(),retentionExecutionGuard(this.scope),this.options.modelGuard?.(),this.otherAttemptGuard(ref,key)].filter((g):g is AccessGuard=>g!==undefined);
      const allowed=await compactStatement(this.db,`SELECT 1 WHERE ${sqlAnd(finalGuards.map(g=>`(${g.sql})`))}`,finalGuards.flatMap(g=>g.values)).first();
      if(!allowed)return pending('media_authority_changed',key);
      // No further await between this snapshot and the provider invocation.
      const result = await Promise.race([this.options.model({ body, signal: abort.signal }), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("media_timeout")); }, this.timeout); })]);
      if (typeof result.body !== "string" || new TextEncoder().encode(result.body).length > 262144 || result.status !== 200) throw 0;
      const parsed: unknown = JSON.parse(result.body); knownActual = mediaUsage(parsed,this.options.modelProvider);
      // Preserve financial truth even for incomplete/refusal/malformed output.
      mediaOutput(parsed, admission.pages,this.options.modelProvider);
      const saved = await this.sql(`UPDATE assistant_media_receipts SET state='response_ready',response_json=?,actual_units=? WHERE ${ns} AND operation_key=? AND state='attempting' RETURNING operation_key`, result.body, knownActual, ...this.keys(), key).all();
      if (saved.results.length !== 1) { await this.budget.settle(key, requestHash, knownActual); return pending("media_retired", key); }
    } catch {
      await Promise.allSettled([this.sql(`UPDATE assistant_media_receipts SET state='uncertain',actual_units=? WHERE ${ns} AND operation_key=? AND state='attempting'`, knownActual, ...this.keys(), key).run(), knownActual === null ? this.budget.uncertain(key) : this.budget.settle(key, requestHash, knownActual)]);
      return pending("media_uncertain", key);
    } finally { clearTimeout(timer); abort.abort(); }
    const persisted = await this.receipt(key);
    if (!persisted) { if (knownActual !== null) await this.budget.settle(key, requestHash, knownActual); return pending("media_retired", key); }
    return this.finish(actor, parent, origin, key, configHash, media.hash, persisted);
  }
  private async finish(actor: TrustedActor, parent: RetrievedSource, origin: OriginFence, key: string, configHash: string, blobHash: string, receipt: Receipt): Promise<Outcome> {
    if (!receipt.request_hash || receipt.actual_units === null) return pending("media_uncertain", key);
    try { await this.budget.settle(key, receipt.request_hash, receipt.actual_units); }
    catch { return pending("media_settlement_pending", key); }
    if (!receipt.response_json || !receipt.admission_json || !["response_ready", "complete"].includes(receipt.state)) return pending("media_uncertain", key);
    const admission = JSON.parse(receipt.admission_json) as MediaAdmission, output = mediaOutput(JSON.parse(receipt.response_json), admission.pages,this.options.modelProvider);
    const ref = { id: parent.id, revision: parent.fence.source.revision, version: parent.fence.source.version, hash: parent.fence.source.hash };
    const evidence: MediaEvidence = { id: await bridgeHash(key), kind: admission.kind, parent: ref, blobHash, configHash, text: output.text, textHash: await sourceTextHash(output.text), receiptKey: key, pages: output.pages };
    if (!await this.fresh(actor, parent, origin)) return pending("media_origin_changed", key);
    const guard = this.access.guard(actor, parent.fence, this.clock());
    try {
      await this.db.batch([
        this.sql(`INSERT INTO assistant_media_artifacts SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND NOT EXISTS(SELECT 1 FROM assistant_media_artifacts WHERE ${ns} AND operation_key=?)`, ...this.keys(), key, ref.id, ref.revision, ref.version, ref.hash, blobHash, configHash, evidence.textHash, JSON.stringify(evidence), this.clock(), ...guard.values, ...this.keys(), key),
        this.sql(`UPDATE assistant_media_receipts SET state='complete' WHERE ${ns} AND operation_key=? AND state='response_ready' AND EXISTS(SELECT 1 FROM assistant_media_artifacts WHERE ${ns} AND operation_key=?)`, ...this.keys(), key, ...this.keys(), key),
      ]);
    } catch { return pending("media_publication_pending", key); }
    const current = await this.read(actor, parent);
    return current?.receiptKey === key ? complete(current) : pending("media_origin_changed", key);
  }
}
