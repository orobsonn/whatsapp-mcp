import type { OwnerAssistantRPC } from "./mcp";
import { onceScope } from "./owner-once-guard";
import { onceCommand, onceOperatorResult } from "./owner-once-contract";
import { bridgeHash } from "./ingress";
export type OwnerOnceOperatorEnv = {
  OWNER: Pick<OwnerAssistantRPC, "ownerOnce">;
  INSTALLATION_ID: string; OPERATIONAL_GENERATION: string; BRIDGE_SOURCE_EPOCH: string; BRIDGE_SOURCE_GENERATION: string;
  OWNER_ONCE_OPERATOR_TOKEN: string; OWNER_ONCE_OPERATOR_EXPIRES: string; OWNER_ONCE_OPERATOR_PORT: string; OWNER_ONCE_OPERATION_ID: string;
};
/** Ephemeral local adapter. One pinned operation and remote named service;
 * no deployment, public route, SQL, provider configuration or model tool. */
export async function handleOwnerOnceOperator(request: Request, env: OwnerOnceOperatorEnv): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" };
  const denied = () => Response.json({ state: "denied" }, { status: 403, headers });
  const url = new URL(request.url), expires = Number(env.OWNER_ONCE_OPERATOR_EXPIRES);
  const affinity = onceScope.safeParse({ installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION,
    sourceEpoch: env.BRIDGE_SOURCE_EPOCH, sourceGeneration: env.BRIDGE_SOURCE_GENERATION });
  if (request.method !== "POST" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== env.OWNER_ONCE_OPERATOR_PORT
    || url.pathname !== "/command" || url.search || ["Origin", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-Dest"].some(name => request.headers.has(name))
    || !affinity.success || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 900000
    || !/^[a-f0-9]{64}$/.test(env.OWNER_ONCE_OPERATOR_TOKEN) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.OWNER_ONCE_OPERATION_ID)) return denied();
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization.length > 128) return denied();
  const [actual, expected] = await Promise.all([bridgeHash(authorization), bridgeHash("Bearer " + env.OWNER_ONCE_OPERATOR_TOKEN)]);
  let diff = 0; for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff) return denied();
  let command;
  try {
    const reader = request.body?.getReader(); if (!reader) throw Error("body");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); let text = "", bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 8192) throw Error("limit"); text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); }
    finally { await reader.cancel().catch(() => {}); }
    command = onceCommand.parse(JSON.parse(text));
    if (command.operationId !== env.OWNER_ONCE_OPERATION_ID) throw Error("operation");
  } catch { return Response.json({ state: "invalid_command" }, { status: 400, headers }); }
  if (expires <= Date.now()) return denied();
  if (!env.OWNER?.ownerOnce) return Response.json({ state: "unavailable" }, { status: 503, headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([env.OWNER.ownerOnce(affinity.data, command),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("uncertain")), Math.min(290000, expires - Date.now())); })]);
    const result = onceOperatorResult.parse(raw), serialized = JSON.stringify(result);
    if (new TextEncoder().encode(serialized).length > 8192) throw Error("response_limit");
    return new Response(serialized, { headers: { ...headers, "Content-Type": "application/json" } });
  } catch { return Response.json({ state: "uncertain", reason: "inspect_same_operation_before_advancing" }, { status: 502, headers }); }
  finally { clearTimeout(timer); }
}
export default { fetch: handleOwnerOnceOperator };
