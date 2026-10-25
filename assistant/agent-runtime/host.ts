import { init } from "@flue/runtime";
import { OwnerRuntime, InterlocutorRuntime } from "./profiles";
const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** Host-only address construction. Admission/authorization belongs to #44;
 * an address, a receipt and a validated proposal are separate states. */
export async function openRuntime(env: { INSTALLATION_ID?: string; OPERATIONAL_GENERATION?: string }, profile: string, jobId: string) {
  const installationId = env.INSTALLATION_ID, generation = env.OPERATIONAL_GENERATION;
  if (!valid(installationId) || !valid(generation) || !valid(jobId) || !["owner", "interlocutor"].includes(profile)) throw new Error("runtime_configuration");
  const seed = Object.freeze({ installationId, generation, jobId });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["runtime-v1", installationId, generation, profile, jobId])));
  const id = "runtime-" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { instance: init(profile === "owner" ? OwnerRuntime : InterlocutorRuntime, { id }), seed };
}
