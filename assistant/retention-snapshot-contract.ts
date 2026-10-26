import { z } from "zod";
import { bridgeHash } from "./ingress";
import { appendSnapshotFrontier, snapshotRoot } from "./retention-membership";
export { buildSnapshotMembership, verifySnapshotMembership, appendSnapshotFrontier, snapshotRoot } from "./retention-membership";
const digest = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().nonnegative().safe();
const label = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
export const snapshotNamespace = z.object({ installationId: label, generation: label }).strict();
export const financialTables = new Set(["assistant_budget_accounts", "assistant_budget_reservations"]);
/** Canonical records and their original attribution. Operational effect latches,
 * model/media derivations, jobs, episodes, Telegram and OAuth are excluded. */
export const canonicalSnapshotTables = new Set(`sources source_versions source_admissions source_origins origin_versions origin_conversations people provider_identities projects project_revisions project_memberships conversation_policies policy_versions mandates mandate_actions mandate_sources missions mission_versions follow_ups fup_provenance retention_restored_work`.split(" ").map(name => "assistant_" + name));
const table = z.string().refine(name => canonicalSnapshotTables.has(name) || financialTables.has(name));
export const snapshotExportPage = z.object({ schema: z.literal(2), purpose: z.literal("canonical_snapshot_candidate"), namespace: snapshotNamespace,
  financialScope: z.literal("installation_all_generations_all_periods"), schemaHash: digest,
  parts: z.array(z.object({ table, row: z.number().int().safe(), hash: digest, offset: integer, totalBytes: integer.min(1).max(4194304), encoding: z.literal("base64-json-utf8"), data: z.string().min(1).max(32768).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()).max(50),
  coverage: z.enum(["page", "end_of_listing"]), consistency: z.literal("live_paginated_not_snapshot"), nextCursor: z.string().min(1).max(4096).optional(),
}).strict().refine(page => (page.coverage === "end_of_listing") === (page.nextCursor === undefined));
export const snapshotPacket = z.object({ index: integer, inputCursor: z.string().min(1).max(4096).nullable(), previousChain: digest, page: snapshotExportPage, pageHash: digest, chain: digest }).strict();
export type SnapshotPacket = z.infer<typeof snapshotPacket>;
export const snapshotManifest = z.object({ version: z.literal(1), kind: z.literal("sealed_canonical_snapshot"), namespace: snapshotNamespace,
  schemaHash: digest, operationId: label, quiescenceToken: label, mutationRevision: integer, authorityRevision: integer.min(1), financialHash: digest,
  tables: z.array(table).max(64), counts: z.record(table, integer), pageCount: integer.min(1), rowCount: integer.max(100000), pageChain: digest, rowChain: digest, rowRoot: digest,
  startedAt: integer, sealedAt: integer, seal: digest,
}).strict().refine(value => value.sealedAt >= value.startedAt && [...value.tables].sort().join("\n") === value.tables.join("\n") && new Set(value.tables).size === value.tables.length && value.tables.length === Object.keys(value.counts).length && value.tables.every(name => Object.hasOwn(value.counts, name)) && Object.values(value.counts).reduce((sum, count) => sum + count, 0) === value.rowCount);
export type SnapshotManifest = z.infer<typeof snapshotManifest>;
export type SnapshotRecord = { table: string; row: number; hash: string; value: Record<string, string | number | null | { blobBase64: string }> };
export const snapshotPageSeed = (namespace: z.infer<typeof snapshotNamespace>, schemaHash: string) => bridgeHash(["canonical-snapshot-pages-v1", namespace, schemaHash]);
export const snapshotRowSeed = () => bridgeHash(["canonical-snapshot-rows-v1"]);
export async function packetFor(index: number, inputCursor: string | null, previousChain: string, raw: unknown): Promise<SnapshotPacket> {
  const page = snapshotExportPage.parse(raw), header = { index, inputCursor, previousChain, page }, pageHash = await bridgeHash(header);
  return snapshotPacket.parse({ ...header, pageHash, chain: await bridgeHash([previousChain, pageHash]) });
}
export async function manifestFor(raw: Omit<SnapshotManifest, "seal">): Promise<SnapshotManifest> {
  const { seal: _discard, ...owned } = snapshotManifest.parse({ ...raw, seal: "0".repeat(64) });
  return snapshotManifest.parse({ ...owned, seal: await bridgeHash(owned) });
}
export async function verifyManifest(raw: unknown) {
  const manifest = snapshotManifest.parse(raw), { seal, ...body } = manifest;
  if (await bridgeHash(body) !== seal) throw new Error("snapshot_manifest_hash"); return manifest;
}
/** Offline integrity only. A self-consistent hash is not authorization: restore
 * separately requires the exact receipt in the private external authority. */
export class SnapshotVerifier {
  private readonly manifest: SnapshotManifest;
  private index = 0; private cursor: string | null = null; private chain?: string; private rowChain?: string;
  private rows = 0; private bytes = 0; private ended = false; private failed = false; private manifestChecked = false;
  private counts: Record<string, number> = {}; private last?: { table: string; row: number };
  private frontier: (string | null)[] = [];
  private financialChain?: string;
  private active?: { table: string; row: number; hash: string; total: number; offset: number; chunks: Uint8Array[] };
  constructor(raw: unknown) { this.manifest = snapshotManifest.parse(raw); }
  async accept(raw: unknown): Promise<SnapshotRecord[]> {
    if (this.failed || this.ended) throw new Error("snapshot_verifier_closed");
    try {
      // Parse owns the entire page before any hashing can yield.
      const packet = snapshotPacket.parse(raw);
      if (!this.manifestChecked) { await verifyManifest(this.manifest); this.manifestChecked = true; }
      if (new TextEncoder().encode(JSON.stringify(packet)).length > 131072 || packet.index !== this.index || packet.inputCursor !== this.cursor || packet.page.schemaHash !== this.manifest.schemaHash || JSON.stringify(packet.page.namespace) !== JSON.stringify(this.manifest.namespace)) throw new Error("snapshot_page_identity");
      this.chain ??= await snapshotPageSeed(this.manifest.namespace, this.manifest.schemaHash); this.rowChain ??= await snapshotRowSeed();
      const { pageHash, chain, ...header } = packet;
      if (packet.previousChain !== this.chain || await bridgeHash(header) !== pageHash || await bridgeHash([this.chain, pageHash]) !== chain) throw new Error("snapshot_page_hash");
      const records: SnapshotRecord[] = [];
      for (const part of packet.page.parts) {
        if (!this.manifest.tables.includes(part.table)) throw new Error("snapshot_table");
        if (!this.active) {
          if (part.offset !== 0 || this.last && (part.table < this.last.table || part.table === this.last.table && part.row <= this.last.row)) throw new Error("snapshot_row_order");
          this.active = { table: part.table, row: part.row, hash: part.hash, total: part.totalBytes, offset: 0, chunks: [] };
        }
        const active = this.active;
        if (active.table !== part.table || active.row !== part.row || active.hash !== part.hash || active.total !== part.totalBytes || active.offset !== part.offset) throw new Error("snapshot_row_parts");
        const bytes = Uint8Array.from(atob(part.data), char => char.charCodeAt(0));
        if (bytes.length < 1 || bytes.length > 24576 || active.offset + bytes.length > active.total || (this.bytes += bytes.length) > 67108864) throw new Error("snapshot_capacity");
        active.chunks.push(bytes); active.offset += bytes.length;
        if (active.offset === active.total) {
          const complete = new Uint8Array(active.total); let offset = 0;
          for (const chunk of active.chunks) { complete.set(chunk, offset); offset += chunk.length; }
          if (complete[0] === 239 && complete[1] === 187 && complete[2] === 191) throw new Error("snapshot_row_encoding");
          const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(complete), value: unknown = JSON.parse(decoded);
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64 || Object.keys(value).some(key => !/^[a-z][a-z0-9_]*$/.test(key)) || JSON.stringify(value) !== decoded) throw new Error("snapshot_row_encoding");
          const record = z.record(z.string(), z.union([z.string(), z.number().finite().refine(number => !Number.isInteger(number) || Number.isSafeInteger(number)), z.null(), z.object({ blobBase64: z.string().max(5592408).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict()])).parse(value);
          if (record.installation_id !== this.manifest.namespace.installationId || (!financialTables.has(part.table) && record.generation !== this.manifest.namespace.generation) || await bridgeHash(record) !== active.hash) throw new Error("snapshot_row_hash_or_namespace");
          this.frontier = await appendSnapshotFrontier(this.frontier, this.rows, { table: part.table, row: part.row, hash: active.hash });
          this.rows++; if (this.rows > 100000) throw new Error("snapshot_capacity");
          this.counts[part.table] = (this.counts[part.table] ?? 0) + 1;
          this.rowChain = await bridgeHash([this.rowChain, part.table, part.row, active.hash]);
          if (financialTables.has(part.table)) {
            this.financialChain ??= await bridgeHash(["retention-live-finance-v1", this.manifest.namespace.installationId]);
            this.financialChain = await bridgeHash([this.financialChain, part.table, part.row, active.hash]);
          }
          records.push({ table: part.table, row: part.row, hash: active.hash, value: record }); this.last = { table: part.table, row: part.row }; this.active = undefined;
        }
      }
      this.index++; this.cursor = packet.page.nextCursor ?? null; this.chain = chain; this.ended = packet.page.coverage === "end_of_listing";
      return records;
    } catch (error) { this.failed = true; throw error; }
  }
  async finish() {
    if (this.failed || !this.ended || this.active || this.index !== this.manifest.pageCount || this.rows !== this.manifest.rowCount || this.chain !== this.manifest.pageChain || this.rowChain !== this.manifest.rowChain || this.manifest.tables.some(table => (this.counts[table] ?? 0) !== this.manifest.counts[table])) throw new Error("snapshot_incomplete");
    if (await snapshotRoot(this.rows, this.frontier) !== this.manifest.rowRoot) throw new Error("snapshot_membership_root");
    if ((this.financialChain ?? await bridgeHash(["retention-live-finance-v1", this.manifest.namespace.installationId])) !== this.manifest.financialHash) throw new Error("snapshot_financial_inventory_hash");
    await verifyManifest(this.manifest);
    return { state: "integrity_verified" as const, authority: "unchecked" as const, namespace: this.manifest.namespace, seal: this.manifest.seal, rows: this.rows, bytes: this.bytes };
  }
}
