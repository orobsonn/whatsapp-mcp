import { z } from "zod";
import { bridgeHash } from "./ingress";
const digest = z.string().regex(/^[a-f0-9]{64}$/), countSchema = z.number().int().min(0).max(100000), indexSchema = z.number().int().nonnegative().safe();
export const membershipProof = z.object({ index: indexSchema, siblings: z.array(digest).max(17), frontier: z.array(digest.nullable()).max(17) }).strict();
export type RowMetadata = { table: string; row: number; hash: string };
const rowMetadata = z.object({ table: z.string().max(128).regex(/^assistant_[a-z0-9_]+$/), row: z.number().int().safe(), hash: digest }).strict();
function frontierFor(count: number, raw: unknown) {
  countSchema.parse(count); const frontier = z.array(digest.nullable()).max(17).parse(raw), size = count ? Math.floor(Math.log2(count)) + 1 : 0;
  if (frontier.length !== size || frontier.some((value, level) => ((count >>> level) & 1) ? value === null : value !== null)) throw new Error("snapshot_frontier_corrupt"); return frontier;
}
export const snapshotLeaf = (index: number, row: RowMetadata) => bridgeHash(["snapshot-leaf-v1", index, row.table, row.row, row.hash]);
export async function appendSnapshotFrontier(raw: unknown, count: number, row: RowMetadata) {
  const frontier = frontierFor(count, raw); if (count >= 100000) throw new Error("snapshot_capacity");
  let level = 0, node = await snapshotLeaf(count, row);
  while ((count >>> level) & 1) { node = await bridgeHash(["snapshot-node-v1", level, frontier[level], node]); frontier[level] = null; level++; }
  frontier[level] = node; return frontierFor(count + 1, frontier);
}
export async function snapshotRoot(count: number, raw: unknown) { return bridgeHash(["snapshot-frontier-v1", count, frontierFor(count, raw)]); }
function mountain(count: number, index: number) {
  let start = 0;
  for (let level = Math.floor(Math.log2(count)); level >= 0; level--) if ((count >>> level) & 1) { const width = 2 ** level; if (index < start + width) return { start, level }; start += width; }
  throw new Error("snapshot_membership_index");
}
/** This exact snapshot format only: at most seventeen sibling/frontier hashes,
 * no generic hashing, tree algorithms, namespaces or paths from tool input. */
export async function verifySnapshotMembership(manifest: { rowCount: number; rowRoot: string }, row: RowMetadata, raw: unknown) {
  const proof = membershipProof.parse(raw), count = countSchema.parse(manifest.rowCount), expectedRoot = digest.parse(manifest.rowRoot), owned = rowMetadata.parse({ table: row.table, row: row.row, hash: row.hash });
  if (proof.index >= count) throw new Error("snapshot_membership_index");
  const frontier = frontierFor(count, proof.frontier), part = mountain(count, proof.index);
  if (proof.siblings.length !== part.level) throw new Error("snapshot_membership_path");
  let node = await snapshotLeaf(proof.index, owned);
  for (let level = 0; level < part.level; level++) node = await bridgeHash(["snapshot-node-v1", level, ...(((proof.index - part.start) >>> level) & 1 ? [proof.siblings[level], node] : [node, proof.siblings[level]])]);
  if (node !== frontier[part.level] || await snapshotRoot(count, frontier) !== expectedRoot) throw new Error("snapshot_membership_hash"); return proof;
}
/** CLI-side proof builder. Leaves are hashes of already verified bundle rows;
 * the server independently verifies membership before every canonical write. */
export async function buildSnapshotMembership(input: RowMetadata[]) {
  if (input.length > 100000) throw new Error("snapshot_capacity");
  const rows = z.array(rowMetadata).max(100000).parse(input.map(row => ({ table: row.table, row: row.row, hash: row.hash })));
  countSchema.parse(rows.length); const levels: string[][] = [[]];
  for (let index = 0; index < rows.length; index++) levels[0].push(await snapshotLeaf(index, rows[index]));
  for (let level = 0; levels[level].length >= 2; level++) {
    const next: string[] = []; for (let index = 0; index + 1 < levels[level].length; index += 2) next.push(await bridgeHash(["snapshot-node-v1", level, levels[level][index], levels[level][index + 1]])); levels.push(next);
  }
  const frontier: (string | null)[] = Array(rows.length ? Math.floor(Math.log2(rows.length)) + 1 : 0).fill(null); let start = 0;
  for (let level = frontier.length - 1; level >= 0; level--) if ((rows.length >>> level) & 1) { frontier[level] = levels[level][start >>> level]; start += 2 ** level; }
  return { root: await snapshotRoot(rows.length, frontier), proof(index: number) {
    indexSchema.parse(index); if (index >= rows.length) throw new Error("snapshot_membership_index"); const part = mountain(rows.length, index), siblings = [];
    for (let level = 0; level < part.level; level++) siblings.push(levels[level][(index >>> level) ^ 1]);
    return membershipProof.parse({ index, frontier, siblings });
  } };
}
