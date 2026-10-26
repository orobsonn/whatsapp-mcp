import { z } from "zod";
import { bridgeHash } from "./ingress";
import { installationCommand, type OwnerAssistantRPC } from "./mcp";
export type InstallationOperatorEnv = {
  OWNER: Pick<OwnerAssistantRPC, "installation">; INSTALLATION_ID: string; OPERATIONAL_GENERATION: string;
  INSTALLATION_OPERATOR_TOKEN: string; INSTALLATION_OPERATOR_EXPIRES: string; INSTALLATION_OPERATOR_PORT: string;
};
/** Local-only loopback adapter. Configured with one remote named service; never
 * a public deployment, MCP tool, SQL endpoint or source-content capability. */
export async function handleInstallationOperator(request: Request, env: InstallationOperatorEnv): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, denied = () => Response.json({ state: "denied" }, { status: 403, headers });
  const url = new URL(request.url), expires = Number(env.INSTALLATION_OPERATOR_EXPIRES);
  if (request.method !== "POST" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== env.INSTALLATION_OPERATOR_PORT || url.pathname !== "/command" || url.search || request.headers.has("Origin") || request.headers.has("Sec-Fetch-Mode") || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 900000 || !/^[a-f0-9]{64}$/.test(env.INSTALLATION_OPERATOR_TOKEN)) return denied();
  const authorization = request.headers.get("Authorization") ?? ""; if (authorization.length > 128) return denied();
  const [actual, wanted] = await Promise.all([bridgeHash(authorization), bridgeHash("Bearer " + env.INSTALLATION_OPERATOR_TOKEN)]); let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ wanted.charCodeAt(i); if (diff) return denied();
  let input: z.infer<typeof installationCommand>;
  try {
    const reader = request.body?.getReader(); if (!reader) throw Error("body"); const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 1024) throw Error("limit"); chunks.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    input = installationCommand.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch { return Response.json({ state: "invalid_command" }, { status: 400, headers }); }
  if (expires <= Date.now()) return denied();
  if (!env.OWNER?.installation) return Response.json({ state: "unavailable" }, { status: 503, headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([env.OWNER.installation({ installationId: env.INSTALLATION_ID, generation: env.OPERATIONAL_GENERATION }, input), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("uncertain")), 35000); })]);
    const serialized = JSON.stringify(result); if (!serialized || new TextEncoder().encode(serialized).length > 2097152) throw Error("response_limit");
    return new Response(serialized, { headers: { ...headers, "Content-Type": "application/json" } });
  } catch { return Response.json({ state: "uncertain", reason: "inspect_same_installation_and_configured_seal_before_repeating" }, { status: 502, headers }); }
  finally { clearTimeout(timer); }
}
export default { fetch: handleInstallationOperator };
