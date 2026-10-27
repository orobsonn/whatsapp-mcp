import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as installedOperator from "../assistant/installation-operator";
import { handleOwnerOnceOperator } from "../assistant/owner-once-operator";
const now = Date.parse("2026-10-27T12:00:00Z"), token = "a".repeat(64);
const scope = { installationId: "synthetic-operator", generation: "g1", sourceEpoch: "e1", sourceGeneration: "c1" };
const command = { kind: "owner_once.plan", operationId: "selected-operation", sourceId: "synthetic-source", expectedRevision: 1,
  projectId: "synthetic-project", query: "Explain the synthetic marker.", deadlineAt: now + 600000, maxCostMicroUsd: 600000 };
type Handler = (request: Request, env: Record<string, unknown>) => Promise<Response>;
function fixture() {
  const ownerOnce = vi.fn(async () => ({ state: "planned", id: "b".repeat(64), jobId: "synthetic-job", corpus: { sourceCount: 1, utf8Bytes: 10 } }));
  const env = { OWNER: { ownerOnce }, INSTALLATION_ID: scope.installationId, OPERATIONAL_GENERATION: scope.generation,
    BRIDGE_SOURCE_EPOCH: scope.sourceEpoch, BRIDGE_SOURCE_GENERATION: scope.sourceGeneration, OWNER_ONCE_OPERATOR_TOKEN: token,
    OWNER_ONCE_OPERATOR_EXPIRES: String(now + 900000), OWNER_ONCE_OPERATOR_PORT: "8979", OWNER_ONCE_OPERATION_ID: command.operationId };
  const request = (body: unknown = command, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:8979/command", {
    method: "POST", headers: { Authorization: "Bearer " + token, ...headers }, body: JSON.stringify(body) });
  return { env, ownerOnce, request };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
it("runs only the pinned Owner command through an authenticated loopback receiver", async () => {
  const handle = (installedOperator as unknown as { handleOwnerOnceOperator?: Handler }).handleOwnerOnceOperator;
  expect(handle).toBeTypeOf("function"); const f = fixture();
  const response = await handle!(f.request(), f.env);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(f.ownerOnce).toHaveBeenCalledExactlyOnceWith(scope, command);
  expect(await response.json()).toMatchObject({ state: "planned" });
});
it.each(["token", "origin", "fetch_site", "expired", "operation", "extra", "oversized"])("refuses %s before invoking the remote capability", async mode => {
  const f = fixture(); let request = f.request();
  if (mode === "token") request = f.request(command, { Authorization: "Bearer " + "0".repeat(64) });
  if (mode === "origin") request = f.request(command, { Origin: "https://foreign.invalid" });
  if (mode === "fetch_site") request = f.request(command, { "Sec-Fetch-Site": "same-origin" });
  if (mode === "expired") f.env.OWNER_ONCE_OPERATOR_EXPIRES = String(now - 1);
  if (mode === "operation") request = f.request({ ...command, operationId: "other-root" });
  if (mode === "extra") request = f.request({ ...command, model: "untrusted-provider" });
  if (mode === "oversized") request = f.request({ ...command, query: "x".repeat(9000) });
  expect((await handleOwnerOnceOperator(request, f.env)).status).toBeGreaterThanOrEqual(400);
  expect(f.ownerOnce).not.toHaveBeenCalled();
});
it("never forwards an unexpected private field in the remote response", async () => {
  const f = fixture(); f.ownerOnce.mockResolvedValueOnce({ state: "planned", privateToken: "synthetic-secret-must-not-leave-rpc" } as never);
  const response = await handleOwnerOnceOperator(f.request(), f.env);
  expect(response.status).toBe(502); expect(await response.text()).not.toContain("synthetic-secret");
  expect(f.ownerOnce).toHaveBeenCalledTimes(1);
});
