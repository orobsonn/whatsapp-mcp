import type { InferenceBudget } from "./budget";
export type InferenceRequest = Readonly<{ model: string; input: string; maxOutputTokens: number; priceVersion: string }>;
type Adapter = (request: InferenceRequest) => Promise<{ output: string; cost: number }>;
/** Used before the queue's exclusive attempt admission. The queue, not the
 * reservation alone, fences execution; a prior uncertain charge never retries. */
export async function prepareInference(budget:InferenceBudget,key:string,hash:string,ceiling:number):Promise<"ready"|"budget_blocked">{
  try {
    const reservation=await budget.reserve(key,hash,ceiling);
    return reservation.state==='reserved' ? 'ready' : 'budget_blocked';
  } catch(error) {
    if(error instanceof Error && ['budget_exhausted','budget_blocked','budget_unconfigured'].includes(error.message))return 'budget_blocked';
    throw error;
  }
}

/** Ceiling and actual cost come from trusted host pricing, never model text.
 * Adapter deadlines belong to the execution boundary; a rejection is uncertain.
 */
export async function invokeBudgeted(budget: InferenceBudget, key: string, request: InferenceRequest,
  ceiling: number, adapter: Adapter): Promise<{ state: string; output?: string }> {
  if (!request || Object.keys(request).sort().join(",") !== "input,maxOutputTokens,model,priceVersion" ||
      typeof request.model !== "string" || !request.model || request.model.length > 256 ||
      typeof request.priceVersion !== "string" || !request.priceVersion || request.priceVersion.length > 256 ||
      typeof request.input !== "string" || new TextEncoder().encode(request.input).length > 65536 ||
      !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) throw new Error("invalid_inference_request");
  const snapshot = Object.freeze({ model: request.model, input: request.input,
    maxOutputTokens: request.maxOutputTokens, priceVersion: request.priceVersion });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const reservation = await budget.reserve(key, hash, ceiling);
  if (!reservation.created) return { state: "already_reserved" };
  try {
    const result = await adapter(snapshot);
    await budget.settle(key, hash, result.cost);
    return { state: "complete", output: result.output };
  } catch {
    await budget.uncertain(key);
    return { state: "uncertain" };
  }
}
