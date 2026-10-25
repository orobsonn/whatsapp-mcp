import type { Env } from "./env";
import { assertActive } from "./core";
import { bridgeHash, captureMetadata, readBridgeJson } from "../assistant/ingress";

export async function deliverCaptureChanges(env: Env): Promise<number> {
  if (!env.ASSISTANT_INGRESS || !env.ASSISTANT_BRIDGE_SECRET || env.ASSISTANT_BRIDGE_SECRET.length < 32 ||
      !env.ASSISTANT_INSTALLATION_ID || !env.ASSISTANT_GENERATION) return 0;
  assertActive(env);
  const keys = [env.INSTALLATION_EPOCH, env.CONNECTION_GENERATION, env.ASSISTANT_INSTALLATION_ID, env.ASSISTANT_GENERATION];
  const scope = "epoch=? AND generation=? AND installation_id=? AND target_generation=?";
  await env.DB.prepare(`INSERT INTO assistant_bridge_cursors(epoch,generation,installation_id,target_generation)
    VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).bind(...keys).run();
  const row = await env.DB.prepare(`SELECT acknowledged_sequence FROM assistant_bridge_cursors WHERE ${scope}`)
    .bind(...keys).first<{ acknowledged_sequence: number }>();
  if (!row) throw new Error("bridge_cursor_missing");
  let cursor = row.acknowledged_sequence, delivered = 0;
  const events = await env.DB.prepare(`SELECT sequence,chat_id,source_id,source_kind,operation,recorded_at
    FROM assistant_capture_changes WHERE epoch=? AND generation=? AND sequence>? ORDER BY sequence LIMIT 10`)
    .bind(env.INSTALLATION_EPOCH, env.CONNECTION_GENERATION, cursor)
    .all<{ sequence: number; chat_id: string; source_id: string; source_kind: string; operation: string; recorded_at: number }>();
  for (const item of events.results) {
    const event = captureMetadata.parse({ protocol: 1, installationId: env.ASSISTANT_INSTALLATION_ID,
      generation: env.ASSISTANT_GENERATION, sourceEpoch: env.INSTALLATION_EPOCH,
      sourceGeneration: env.CONNECTION_GENERATION, sequence: item.sequence, previousSequence: cursor,
      chatId: item.chat_id, sourceId: item.source_id, sourceKind: item.source_kind, operation: item.operation, recordedAt: item.recorded_at });
    const metadataHash = await bridgeHash(event);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const exchange = async () => {
      const response = await env.ASSISTANT_INGRESS!.fetch(new Request("https://assistant.internal/internal/capture", {
        method: "POST", headers: { Authorization: `Bearer ${env.ASSISTANT_BRIDGE_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify(event), signal: controller.signal,
      }));
      if (!response.ok) throw new Error("bridge_rejected");
      return readBridgeJson(response);
    };
    let receipt: unknown;
    try {
      receipt = await Promise.race([exchange(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("bridge_timeout")); }, 2000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
    if (!receipt || typeof receipt !== "object" || !("sequence" in receipt) || receipt.sequence !== item.sequence ||
        !("metadataHash" in receipt) || receipt.metadataHash !== metadataHash || !("state" in receipt) || receipt.state !== "received")
      throw new Error("bridge_invalid_receipt");
    const advanced = await env.DB.prepare(`UPDATE assistant_bridge_cursors SET acknowledged_sequence=?
      WHERE ${scope} AND acknowledged_sequence=? RETURNING acknowledged_sequence`)
      .bind(item.sequence, ...keys, cursor).all();
    if (advanced.results.length !== 1) break;
    cursor = item.sequence; delivered++;
  }
  return delivered;
}
