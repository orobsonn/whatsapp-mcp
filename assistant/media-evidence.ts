import { z } from "zod";
import { sourceTextHash } from "./sources";
const hash = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().positive().safe();
export const mediaEvidenceSchema = z.object({ id: hash, kind: z.enum(["image_context", "pdf_context"]),
  parent: z.object({ id: z.string().min(1).max(256), revision: version, version, hash }).strict(),
  blobHash: hash, configHash: hash, text: z.string().max(32768), textHash: hash, receiptKey: z.string().regex(/^media:[a-f0-9]{64}$/),
  pages: z.array(z.object({ page: version.max(4), state: z.enum(["readable", "unreadable"]) }).strict()).min(1).max(4),
}).strict();
export type MediaEvidence = z.infer<typeof mediaEvidenceSchema>;
export function ownMediaEvidence(input: unknown): MediaEvidence {
  const raw = input as Partial<MediaEvidence> | null;
  if (!raw || typeof raw.text !== "string" || raw.text.length > 32768 || !Array.isArray(raw.pages) || raw.pages.length < 1 || raw.pages.length > 4) throw new Error("media_evidence_limit");
  return mediaEvidenceSchema.parse(input);
}
export async function validateMediaEvidence(input: unknown, parent: { id: string; revision: number; version: number; hash: string }) {
  const evidence = ownMediaEvidence(input);
  if (JSON.stringify(evidence.parent) !== JSON.stringify(parent) || await sourceTextHash(evidence.text) !== evidence.textHash) throw new Error("media_evidence_changed");
  return evidence;
}
/** SQL projection is internal; the parent is always re-authorized by its caller. */
export async function storedMediaEvidence(db: D1Database, scope: { installationId: string; generation: string }, parent: MediaEvidence["parent"]): Promise<MediaEvidence | null> {
  const row = await db.prepare(`SELECT evidence_json FROM assistant_media_artifacts WHERE installation_id=? AND generation=? AND source_id=? AND source_revision=? AND source_version=? AND source_hash=? ORDER BY created_at DESC,operation_key DESC LIMIT 1`)
    .bind(scope.installationId, scope.generation, parent.id, parent.revision, parent.version, parent.hash).first<{ evidence_json: string }>();
  return row ? validateMediaEvidence(JSON.parse(row.evidence_json), parent) : null;
}
