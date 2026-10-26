import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const directory = await mkdtemp(join(tmpdir(), "assistant-retention-codec-")); await chmod(directory, 0o700);
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, "codec.mjs");
await build({ entryPoints: [resolve("assistant/retention-snapshot-contract.ts")], outfile: output, platform: "node", target: "node22", format: "esm", bundle: true, logLevel: "silent" }); await chmod(output, 0o600);
const { SnapshotVerifier, manifestFor, packetFor, snapshotPageSeed, snapshotRowSeed, buildSnapshotMembership, verifySnapshotMembership, appendSnapshotFrontier, snapshotRoot } = await import(pathToFileURL(output).href);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex"), namespace = { installationId: "synthetic-installation", generation: "g1" }, digest = "a".repeat(64);
async function fixture(text = "Synthetic private body", override = {}, table = "assistant_sources") {
  const value = { installation_id: namespace.installationId, generation: namespace.generation, id: "source", title: text, ...override }, bytes = Buffer.from(JSON.stringify(value)), rowHash = hash(value), parts = [];
  for (let offset = 0; offset < bytes.length; offset += 24576) parts.push({ table, row: -3, hash: rowHash, offset, totalBytes: bytes.length, encoding: "base64-json-utf8", data: bytes.subarray(offset, offset + 24576).toString("base64") });
  const packet = await packetFor(0, null, await snapshotPageSeed(namespace, digest), { schema: 2, purpose: "canonical_snapshot_candidate", namespace, financialScope: "installation_all_generations_all_periods", schemaHash: digest, parts, coverage: "end_of_listing", consistency: "live_paginated_not_snapshot" });
  const tree = await buildSnapshotMembership([{ table, row: -3, hash: rowHash }]);
  const financeSeed=hash(["retention-live-finance-v1",namespace.installationId]);
  const manifest = await manifestFor({ version: 1, kind: "sealed_canonical_snapshot", namespace, schemaHash: digest, operationId: "synthetic-snapshot", quiescenceToken: "synthetic-quiescence", mutationRevision: 0, authorityRevision: 1, financialHash:table.startsWith("assistant_budget_")?hash([financeSeed,table,-3,rowHash]):financeSeed, tables: [table], counts: { [table]: 1 }, pageCount: 1, rowCount: 1, pageChain: packet.chain, rowChain: hash([await snapshotRowSeed(), table, -3, rowHash]), rowRoot: tree.root, startedAt: 100, sealedAt: 101 });
  return { packet, manifest, value };
}
test("offline verifier reassembles multibyte chunks and explicitly leaves authority unchecked", async () => {
  const { packet, manifest, value } = await fixture("á🐳".repeat(9000)), verifier = new SnapshotVerifier(manifest);
  assert.ok(packet.page.parts.length > 1); const records = await verifier.accept(packet); assert.deepEqual(records[0].value, value);
  assert.deepEqual(await verifier.finish(), { state: "integrity_verified", authority: "unchecked", namespace, seal: manifest.seal, rows: 1, bytes: Buffer.byteLength(JSON.stringify(value)) });
});
test("raw export cannot impersonate a sealed snapshot packet", async () => {
  const { packet, manifest } = await fixture();
  await assert.rejects(new SnapshotVerifier(manifest).accept(packet.page));
  const wrong = structuredClone(packet); delete wrong.page.purpose;
  await assert.rejects(new SnapshotVerifier(manifest).accept(wrong));
});
test("body corruption, missing pages and wrong canonical namespace fail integrity", async () => {
  const { packet, manifest } = await fixture(), corrupt = structuredClone(packet); corrupt.page.parts[0].data = Buffer.from("forged").toString("base64");
  await assert.rejects(new SnapshotVerifier(manifest).accept(corrupt), /snapshot_page_hash/);
  await assert.rejects(new SnapshotVerifier(manifest).finish(), /snapshot_incomplete/);
  const foreign = await fixture("Synthetic foreign", { generation: "older" });
  await assert.rejects(new SnapshotVerifier(foreign.manifest).accept(foreign.packet), /snapshot_row_hash_or_namespace/);
});
test("manifest and page inputs are owned before hashing yields", async () => {
  const { packet, manifest, value } = await fixture(), verifier = new SnapshotVerifier(manifest), result = verifier.accept(packet);
  packet.page.parts[0].data = Buffer.from("mutation").toString("base64"); manifest.namespace.installationId = "mutant";
  assert.deepEqual((await result)[0].value, value); assert.equal((await verifier.finish()).authority, "unchecked");
});
test("financial rows retain every generation and a checksum alone cannot assert authority", async () => {
  const { packet, manifest } = await fixture("Synthetic financial metadata", { generation: "old-finance" }, "assistant_budget_reservations"), verifier = new SnapshotVerifier(manifest);
  assert.equal((await verifier.accept(packet))[0].value.generation, "old-finance"); assert.equal((await verifier.finish()).authority, "unchecked");
  const wrong = structuredClone(manifest); wrong.seal = "0".repeat(64);
  await assert.rejects(new SnapshotVerifier(wrong).accept(packet), /snapshot_manifest_hash/);
});
test("bounded Merkle membership agrees with the producer frontier for non-power-of-two row counts", async () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({ table: "assistant_sources", row: index, hash: hash(["synthetic row", index]) })), tree = await buildSnapshotMembership(rows);
  let frontier = []; for (let index = 0; index < rows.length; index++) frontier = await appendSnapshotFrontier(frontier, index, rows[index]);
  assert.equal(await snapshotRoot(rows.length, frontier), tree.root);
  for (const index of [0, 7, 8, 11, 12]) { const proof = tree.proof(index); assert.ok(proof.frontier.length <= 17 && proof.siblings.length <= 17); await verifySnapshotMembership({ rowCount: rows.length, rowRoot: tree.root }, rows[index], proof); }
  await assert.rejects(verifySnapshotMembership({ rowCount: rows.length, rowRoot: tree.root }, { ...rows[8], hash: "0".repeat(64) }, tree.proof(8)), /snapshot_membership_hash/);
});
