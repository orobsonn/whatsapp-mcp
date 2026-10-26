import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { bridgeHash } from "./ingress";
import type { AssistantEnv } from "./env";
import type { SourceScope } from "./sources";
const digest = z.string().regex(/^[a-f0-9]{64}$/), label = z.string().min(1).max(256);
const hashes = z.array(digest).min(1).max(128);
const manifestSchema = z.object({ installationId: label, generation: label, sourceCount: z.number().int().min(0).max(10000), sourceInventoryHash: digest,
  tombstoneCount: z.number().int().min(0).max(20000), tombstoneDigest: digest }).strict();
export type RetirementManifest = z.infer<typeof manifestSchema>;
type State = { phase: "preparing" | "sealed"; manifest: RetirementManifest; seal: string; revision: number; nextPage: number; count: number; chain: string; lastKey: string | null };
const stateSchema = z.object({ phase: z.enum(["preparing", "sealed"]), manifest: manifestSchema, seal: digest, revision: z.number().int().positive().safe(),
  nextPage: z.number().int().nonnegative().safe(), count: z.number().int().nonnegative().safe(), chain: digest, lastKey: digest.nullable() }).strict();
export interface RetirementStore { get<T>(key: string): Promise<T | undefined>; transaction<T>(action: (store: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>): Promise<T> }
export type RetirementLookup = { state: "sealed"; revision: number; blocked: string[] } | { state: "unavailable" };
export interface RetirementAuthorityPort { lookup(installationId: string, keys: string[]): Promise<RetirementLookup>; record(installationId: string, keys: string[]): Promise<RetirementLookup> }
export interface SourceRetirementGuard { allow(origin: string, originKey: string, sourceId?: string): Promise<void>; withdraw(origin: string, originKey: string, sourceId: string): Promise<void> }
const initialChain = () => bridgeHash(["retention-tombstones-v1"]);
export async function retirementKeys(installationId: string, origin: string, originKey: string, sourceId?: string) {
  return [await bridgeHash(["retired-origin-v1", installationId, origin, originKey]), ...(sourceId ? [await bridgeHash(["retired-id-v1", installationId, sourceId])] : [])].sort();
}
/** Monotonic installation-wide hashes live outside the restorable D1 database.
 * Bootstrap is host-provisioned proof, never an empty-list inference or model command. */
export class RetentionAuthorityCore {
  private readonly installationId: string;
  constructor(private readonly store: RetirementStore, installationId: string, private readonly expectedBootstrapSeal?: string) { this.installationId = label.parse(installationId); }
  private expected(installationId: string) { if (installationId !== this.installationId) throw new Error("retention_authority_affinity"); }
  private async read(store: Pick<RetirementStore, "get"> = this.store): Promise<State | undefined> {
    const raw = await store.get<unknown>("state"); if (raw === undefined) return;
    const state = stateSchema.parse(raw);
    if (state.manifest.installationId !== this.installationId || await bridgeHash(state.manifest) !== state.seal || state.count > state.manifest.tombstoneCount ||
      (state.phase === "sealed" && (state.count !== state.manifest.tombstoneCount || state.chain !== state.manifest.tombstoneDigest))) throw new Error("retention_authority_corrupt");
    return state;
  }
  async begin(raw: unknown) {
    const manifest = manifestSchema.parse(raw); this.expected(manifest.installationId);
    const seal = await bridgeHash(manifest);
    if (!this.expectedBootstrapSeal || seal !== this.expectedBootstrapSeal) throw new Error("retention_bootstrap_seal");
    const initial: State = { phase: "preparing", manifest, seal, revision: 1, nextPage: 0, count: 0, chain: await initialChain(), lastKey: null };
    try { await this.store.transaction(async store => { const previous = await this.read(store); if (previous) { if (previous.seal !== seal) throw new Error("retention_bootstrap_conflict"); return; } await store.put("state", initial); }); }
    catch { if ((await this.read())?.seal !== seal) throw new Error("retention_bootstrap_uncertain"); }
    return { seal, phase: (await this.read())!.phase };
  }
  async append(seal: string, page: number, raw: unknown) {
    digest.parse(seal); z.number().int().nonnegative().safe().parse(page); const keys = hashes.parse(raw), requestHash = await bridgeHash([seal, page, keys]);
    const previous = await this.store.get<{ requestHash: string; revision: number }>("page:" + page);
    if (previous) { if (previous.requestHash !== requestHash) throw new Error("retention_bootstrap_conflict"); return previous; }
    let receipt: { requestHash: string; revision: number } | undefined;
    try { await this.store.transaction(async store => {
      const state = await this.read(store);
      if (!state || state.phase !== "preparing" || state.seal !== seal || state.nextPage !== page || keys.some((key, index) => key <= (index ? keys[index - 1] : state.lastKey ?? "")) || state.count + keys.length > state.manifest.tombstoneCount) throw new Error("retention_bootstrap_conflict");
      for (const key of keys) await store.put("retired:" + key, true);
      receipt = { requestHash, revision: state.revision + 1 };
      await store.put("page:" + page, receipt);
      await store.put("state", { ...state, revision: receipt.revision, nextPage: page + 1, count: state.count + keys.length, lastKey: keys.at(-1)!, chain: await bridgeHash([state.chain, keys]) });
    }); } catch { const observed = await this.store.get<typeof receipt>("page:" + page); if (!observed || observed.requestHash !== requestHash) throw new Error("retention_bootstrap_uncertain"); receipt = observed; }
    return receipt!;
  }
  async seal(seal: string) {
    digest.parse(seal);
    try { await this.store.transaction(async store => { const state = await this.read(store);
      if (!state || state.seal !== seal || state.count !== state.manifest.tombstoneCount || state.chain !== state.manifest.tombstoneDigest) throw new Error("retention_bootstrap_incomplete");
      if (state.phase !== "sealed") await store.put("state", { ...state, phase: "sealed", revision: state.revision + 1 });
    }); } catch { const state = await this.read(); if (state?.phase !== "sealed" || state.seal !== seal) throw new Error("retention_bootstrap_uncertain"); }
    return { state: "sealed" as const, revision: (await this.read())!.revision };
  }
  async lookup(installationId: string, raw: string[]): Promise<RetirementLookup> {
    this.expected(installationId); const keys = hashes.parse(raw);
    return this.store.transaction(async store => { const state = await this.read(store); if (state?.phase !== "sealed") return { state: "unavailable" };
      const blocked: string[] = []; for (const key of keys) if (await store.get<boolean>("retired:" + key)) blocked.push(key);
      return { state: "sealed", revision: state.revision, blocked };
    });
  }
  async record(installationId: string, raw: string[]): Promise<RetirementLookup> {
    this.expected(installationId); const keys = [...new Set(hashes.parse(raw))].sort();
    try { return await this.store.transaction(async store => { const state = await this.read(store); if (state?.phase !== "sealed") return { state: "unavailable" };
      let changed = false; for (const key of keys) if (!await store.get<boolean>("retired:" + key)) { changed = true; await store.put("retired:" + key, true); }
      if (changed) await store.put("state", { ...state, revision: state.revision + 1 });
      return { state: "sealed", revision: state.revision + (changed ? 1 : 0), blocked: keys };
    }); } catch { const proof = await this.lookup(installationId, keys); if (proof.state !== "sealed" || proof.blocked.length !== keys.length) throw new Error("retention_record_uncertain"); return proof; }
  }
}
export function retentionAuthorityName(installationId: string) { return JSON.stringify(["assistant-retention-authority-v1", label.parse(installationId)]); }
/** Private named binding only; a second arbitrary DO cannot own independent tombstones. */
export class RetentionAuthority extends DurableObject<AssistantEnv> {
  private core() {
    const installationId = label.parse(this.env.INSTALLATION_ID);
    if (!this.env.RETENTION_AUTHORITY || this.ctx.id.toString() !== this.env.RETENTION_AUTHORITY.idFromName(retentionAuthorityName(installationId)).toString()) throw new Error("retention_authority_instance");
    return new RetentionAuthorityCore({ get: key => this.ctx.storage.get(key), transaction: action => this.ctx.storage.transaction(store => action({ get: key => store.get(key), put: (key, value) => store.put(key, value) })) }, installationId, this.env.RETENTION_BOOTSTRAP_SEAL);
  }
  begin(manifest: RetirementManifest) { return this.core().begin(manifest); }
  append(seal: string, page: number, keys: string[]) { return this.core().append(seal, page, keys); }
  seal(seal: string) { return this.core().seal(seal); }
  lookup(installationId: string, keys: string[]) { return this.core().lookup(installationId, keys); }
  record(installationId: string, keys: string[]) { return this.core().record(installationId, keys); }
  fetch() { return Promise.resolve(new Response("forbidden", { status: 403 })); }
}
export function sourceRetirementGuard(installationId: string, authority: RetirementAuthorityPort): SourceRetirementGuard {
  return {
    async allow(origin, originKey, sourceId) { const proof = await authority.lookup(installationId, await retirementKeys(installationId, origin, originKey, sourceId));
      if (proof.state !== "sealed") throw new Error("retention_authority_unavailable"); if (proof.blocked.length) throw new Error("source_retired"); },
    async withdraw(origin, originKey, sourceId) { const keys = await retirementKeys(installationId, origin, originKey, sourceId), proof = await authority.record(installationId, keys);
      if (proof.state !== "sealed" || keys.some(key => !proof.blocked.includes(key))) throw new Error("retention_authority_unavailable"); },
  };
}
export function configuredRetirementGuard(env: AssistantEnv) {
  if (env.RETENTION_AUTHORITY_REQUIRED !== undefined && !["true", "false"].includes(env.RETENTION_AUTHORITY_REQUIRED)) throw new Error("retention_authority_configuration");
  if (!env.RETENTION_AUTHORITY && env.RETENTION_AUTHORITY_REQUIRED !== "true") return undefined; // Legacy fixtures/installation remain explicit.
  if (!env.RETENTION_AUTHORITY || !env.INSTALLATION_ID) throw new Error("retention_authority_unconfigured");
  return sourceRetirementGuard(env.INSTALLATION_ID, env.RETENTION_AUTHORITY.get(env.RETENTION_AUTHORITY.idFromName(retentionAuthorityName(env.INSTALLATION_ID))));
}

/** Bootstrap is provisioned against this exact live D1 inventory. This helper
 * returns a plan, never writes secrets or assumes an unavailable authority empty. */
export async function retirementBootstrapPlan(db: D1Database, scope: SourceScope) {
  let after: [string, string] | null = null, sourceCount = 0, inventory = await bridgeHash(["retention-inventory-v1"]); const retired = new Set<string>();
  type SourceRow = { generation: string; id: string; origin: string; origin_key: string; status: string; revision: number; current_version: number | null };
  for (;;) {
    const rows: SourceRow[] = (await db.prepare(`SELECT generation,id,origin,origin_key,status,revision,current_version FROM assistant_sources WHERE installation_id=? ${after ? "AND (generation,id)>(?,?)" : ""} ORDER BY generation,id LIMIT 128`)
      .bind(scope.installationId, ...(after ?? [])).all<SourceRow>()).results;
    if (!rows.length) break;
    sourceCount += rows.length; if (sourceCount > 10000) throw new Error("retention_bootstrap_capacity"); inventory = await bridgeHash([inventory, rows]);
    for (const row of rows) if (row.status === "withdrawn") for (const key of await retirementKeys(scope.installationId, row.origin, row.origin_key, row.id)) retired.add(key);
    after = [rows.at(-1)!.generation, rows.at(-1)!.id];
  }
  const keys = [...retired].sort(), pages: string[][] = []; let chain = await initialChain();
  for (let offset = 0; offset < keys.length; offset += 128) { const page = keys.slice(offset, offset + 128); pages.push(page); chain = await bridgeHash([chain, page]); }
  const manifest = manifestSchema.parse({ installationId: scope.installationId, generation: scope.generation, sourceCount, sourceInventoryHash: inventory, tombstoneCount: keys.length, tombstoneDigest: chain });
  return { manifest, pages, seal: await bridgeHash(manifest), consistency: "live_inventory_requires_final_recheck" };
}
export async function bootstrapRetirementAuthority(env: AssistantEnv) {
  if (!env.DB || !env.INSTALLATION_ID || !env.OPERATIONAL_GENERATION || !env.RETENTION_AUTHORITY) throw new Error("retention_authority_unconfigured");
  const scope = { installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION }, plan = await retirementBootstrapPlan(env.DB, scope);
  if (plan.seal !== env.RETENTION_BOOTSTRAP_SEAL) throw new Error("retention_bootstrap_seal");
  const authority = env.RETENTION_AUTHORITY.get(env.RETENTION_AUTHORITY.idFromName(retentionAuthorityName(scope.installationId)));
  await authority.begin(plan.manifest); for (let page = 0; page < plan.pages.length; page++) await authority.append(plan.seal, page, plan.pages[page]);
  if ((await retirementBootstrapPlan(env.DB, scope)).seal !== plan.seal) throw new Error("retention_bootstrap_changed");
  return authority.seal(plan.seal);
}
