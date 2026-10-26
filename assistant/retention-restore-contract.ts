import { z } from "zod";
import { canonicalSnapshotTables, financialTables, snapshotManifest } from "./retention-snapshot-contract";
import { membershipProof } from "./retention-membership";
const label = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const restoreRecord = z.object({ table: z.string().refine(name => canonicalSnapshotTables.has(name) || financialTables.has(name)), row: z.number().int().safe(), hash,
  value: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.string(), z.number().finite().refine(value => !Number.isInteger(value) || Number.isSafeInteger(value)), z.null(), z.object({ blobBase64: z.string() }).strict()])) }).strict();
export const provenRestoreRow = z.object({ record: restoreRecord, proof: membershipProof }).strict();
export const restoreSourcePair = z.object({ header: provenRestoreRow, current: provenRestoreRow.nullable() }).strict();
export const restoreCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restore.begin"), operationId: label, manifest: snapshotManifest }).strict(),
  z.object({ kind: z.literal("restore.row"), operationId: label, row: provenRestoreRow, source: restoreSourcePair.optional() }).strict(),
  z.object({ kind: z.literal("restore.finish"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.status"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.advance"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.pause"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.resume"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.release"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.catchup"), operationId: label }).strict(),
  z.object({ kind: z.literal("restore.activate_generation"), operationId: label, commandId: label, expectedSeal: hash,
    budget: z.object({ period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), capMicroUsd: z.number().int().positive().safe() }).strict() }).strict(),
  z.object({ kind: z.literal("restore.reprove_source"), operationId: label, sourceId: label, revision: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal("restore.bind_identity"), operationId: label, commandId: label, provider: z.literal("whatsapp"), address: label, personId: label,
    proof: z.object({ sourceId: label, revision: z.number().int().positive().safe() }).strict(),
    expected: z.union([z.object({ absent: z.literal(true) }).strict(), z.object({ personId: label, proofSourceId: label, proofRevision: z.number().int().positive().safe(), boundAt: z.number().int().nonnegative().safe() }).strict()]) }).strict(),
]);
export type ProvenRestoreRow = z.infer<typeof provenRestoreRow>;
export type RestoreSourcePair = z.infer<typeof restoreSourcePair>;
