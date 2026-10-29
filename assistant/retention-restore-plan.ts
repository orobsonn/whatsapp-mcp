import { buildSnapshotMembership } from "./retention-membership";
import { verifyManifest, type SnapshotManifest, type SnapshotRecord } from "./retention-snapshot-contract";
import { restoreRecord, type RestoreSourcePair } from "./retention-restore-contract";
const order = `assistant_projects assistant_project_revisions assistant_people assistant_sources assistant_source_versions assistant_source_admissions assistant_origin_conversations assistant_source_origins assistant_origin_versions assistant_conversation_policies assistant_policy_versions assistant_mandates assistant_mandate_actions assistant_mandate_sources assistant_provider_identities assistant_project_memberships assistant_missions assistant_mission_versions assistant_follow_ups assistant_fup_provenance assistant_retention_restored_work assistant_budget_accounts assistant_budget_reservations assistant_native_model_receipts`.split(" ");
/** Offline planning over an integrity-verified bundle; this is not authority,
 * generation allocation or permission to activate a runtime. */
export async function planCanonicalRestore(rawManifest: unknown, input: SnapshotRecord[]) {
  const manifest = await verifyManifest(rawManifest), records = input.map(row => restoreRecord.parse(row));
  if (records.length !== manifest.rowCount) throw new Error("restore_bundle_incomplete");
  const tree = await buildSnapshotMembership(records); if (tree.root !== manifest.rowRoot) throw new Error("restore_bundle_membership");
  const indexed = records.map((record, index) => ({ record, proof: tree.proof(index) }));
  const headers = new Map<string, typeof indexed[number]>(), versions = new Map<string, typeof indexed[number]>();
  for (const row of indexed) {
    if (row.record.table === "assistant_sources") headers.set(String(row.record.value.id), row);
    if (row.record.table === "assistant_source_versions") versions.set(JSON.stringify([row.record.value.source_id, row.record.value.version]), row);
  }
  const pair = (sourceId: string): RestoreSourcePair => {
    const header = headers.get(sourceId); if (!header) throw new Error("restore_source_header_missing");
    const current = header.record.value.status === "withdrawn" ? null : versions.get(JSON.stringify([sourceId, header.record.value.current_version]));
    if (header.record.value.status !== "withdrawn" && !current) throw new Error("restore_current_version_missing");
    return { header, current: current ?? null };
  };
  const relatedSource = (record: SnapshotRecord) => {
    const value = record.value;
    if (record.table === "assistant_sources") return String(value.id);
    if (typeof value.canonical_id === "string") return value.canonical_id;
    if (typeof value.source_id === "string") return value.source_id;
    if (typeof value.proof_source_id === "string") return value.proof_source_id;
    if (record.table === "assistant_mission_versions") { const body = JSON.parse(String(value.body_json)); if (typeof body?.sourceId !== "string") throw new Error("restore_work_provenance"); return body.sourceId as string; }
    if (record.table === "assistant_fup_provenance") { const body = JSON.parse(String(value.body_json)); if (typeof body?.source?.id !== "string") throw new Error("restore_work_provenance"); return body.source.id as string; }
    return undefined;
  };
  const steps = indexed.map(row => { const source = relatedSource(row.record); return { ...row, ...(source ? { source: pair(source) } : {}) }; }).sort((left, right) => order.indexOf(left.record.table) - order.indexOf(right.record.table) || left.proof.index - right.proof.index);
  if (steps.some(step => order.indexOf(step.record.table) < 0)) throw new Error("restore_table_adapter_required");
  return { state: "planned_inactive_authority_unchecked" as const, manifest: manifest as SnapshotManifest, steps, sourceCount: headers.size, excluded: ["jobs", "episodes", "knowledge_operations", "native_conversations", "native_context_registry", "native_reply_actions", "native_telegram_reviews", "native_telegram_callbacks", "native_host_events", "native_capture_intake", "native_owner_responses", "native_host_state", "native_help_questions", "native_help_replies", "curator_state", "curator_runs", "curator_items", "curator_capture_gaps", "curator_notices", "model_receipts", "canonical_extractions", "relation_batches", "owner_canonical_supports", "owner_relation_proofs", "owner_canonical_status", "media_derivations", "telegram", "oauth", "budget_import"] };
}
