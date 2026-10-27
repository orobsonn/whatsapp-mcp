/** Static failure stages only: never pass an error, request, identity or SQL.
 * Diagnostics cannot change the existing admission or uncertainty behavior. */
export type ModelAdmissionFailure = "prepare_denied" | "prepare_error" | "compile_error" | "batch_error" | "predicate_no_row"
  | "recovered_receipt_incomplete" | "recovered_unsettled" | "recovered_current_denied" | "recovered_error"
  | "host_generation_before" | "host_coverage_check" | "host_coverage_denied" | "host_coverage_guard"
  | "host_owner_authority" | "host_owner_period_or_deadline" | "host_generation_after"
  | "host_owner_time" | "host_owner_config_hash" | "host_owner_configuration" | "host_owner_plan_missing"
  | "host_owner_not_admitted" | "host_owner_receipt_scope" | "host_owner_admission_receipt"
  | "host_owner_corpus_changed" | "host_owner_corpus" | "host_owner_manifest_capacity";
/** Inspect only known constants; an unknown error always becomes one static code. */
export function ownerAdmissionFailure(error: unknown): ModelAdmissionFailure {
  try {
    if (error instanceof Error) switch (error.message) {
      case "owner_once_expired_or_changed":
        if (error.cause === "owner_once_time") return "host_owner_time";
        if (error.cause === "owner_once_config_hash") return "host_owner_config_hash";
        break;
      case "owner_once_configuration": return "host_owner_configuration";
      case "owner_once_plan_missing": return "host_owner_plan_missing";
      case "owner_once_not_admitted": return "host_owner_not_admitted";
      case "owner_once_receipt_scope": return "host_owner_receipt_scope";
      case "owner_once_admission_receipt": return "host_owner_admission_receipt";
      case "owner_once_corpus_changed": return "host_owner_corpus_changed";
      case "owner_once_corpus": return "host_owner_corpus";
      case "owner_once_manifest_capacity": return "host_owner_manifest_capacity";
    }
  } catch { /* Even an error with hostile accessors cannot affect a denial. */ }
  return "host_owner_authority";
}
export function reportModelAdmissionFailure(code: ModelAdmissionFailure, startedAt: number) {
  try {
    const elapsed = performance.now() - startedAt;
    console.warn({ event: "model_admission_failure", code,
      elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(3600000, Math.round(elapsed))) : 0 });
  } catch { /* A logging failure must never turn a denial into a retry or throw. */ }
}
