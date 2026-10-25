import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import assistant from "../assistant/index";
import type { AssistantEnv } from "../assistant/env";
import type { Env } from "../src/env";
import { deliverCaptureChanges } from "../src/assistant-bridge";
// @ts-expect-error Vite raw SQL import.
import cursorSql from "../migrations/0014_bridge_cursor.sql?raw";
// @ts-expect-error Vite raw SQL import.
import inboxSql from "../assistant/migrations/0004_capture_inbox.sql?raw";

const secret = "synthetic-bridge-secret-for-tests-only";
const receiver: AssistantEnv = { DB: env.DB, BRIDGE_SECRET: secret, BRIDGE_SOURCE_EPOCH: "bridge-e",
  BRIDGE_SOURCE_GENERATION: "bridge-g", INSTALLATION_ID: "bridge-test", OPERATIONAL_GENERATION: "target-g" };
const binding = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => assistant.fetch(new Request(input, init), receiver) };
const sender = (target = binding): Env => ({ ...env, OWNER_SUB: "synthetic-owner", MAINTENANCE: "false",
  INSTALLATION_EPOCH: "bridge-e", CONNECTION_GENERATION: "bridge-g", ASSISTANT_INGRESS: target,
  ASSISTANT_BRIDGE_SECRET: secret, ASSISTANT_INSTALLATION_ID: "bridge-test", ASSISTANT_GENERATION: "target-g" });
const metadata = (sequence = 1, previousSequence = 0) => ({ protocol: 1, installationId: "bridge-test", generation: "target-g",
  sourceEpoch: "bridge-e", sourceGeneration: "bridge-g", sequence, previousSequence,
  chatId: "synthetic-chat", sourceId: "synthetic-message", sourceKind: "message", operation: "upsert", recordedAt: 100 });
const post = (body: unknown, token = secret) => assistant.fetch(new Request("https://assistant.internal/internal/capture", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
}), receiver);
async function count(table: string) { return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n; }
async function seed(n = 1) {
  for (let i = 0; i < n; i++) await env.DB.prepare(`INSERT INTO assistant_capture_changes
    (epoch,generation,chat_id,source_id,source_kind,operation,recorded_at) VALUES('bridge-e','bridge-g','synthetic-chat',?,'message','upsert',100)`)
    .bind(`synthetic-${i}`).run();
  return (await env.DB.prepare("SELECT sequence FROM assistant_capture_changes WHERE epoch='bridge-e' ORDER BY sequence").all<{ sequence: number }>()).results;
}
beforeEach(async () => {
  for (const sql of [cursorSql, inboxSql]) {
    const parts = sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((part: string) => part.trim());
    if (parts.length) await env.DB.batch(parts.map((part: string) => env.DB.prepare(part)));
  }
  await env.DB.exec("DELETE FROM assistant_capture_inbox; DELETE FROM assistant_capture_streams; DELETE FROM assistant_bridge_cursors; DELETE FROM assistant_capture_changes WHERE epoch='bridge-e';");
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("No public network permitted"); });
});
afterEach(() => vi.restoreAllMocks());

it("refuses invalid secrets, namespace, content and oversized metadata without writes", async () => {
  expect((await post(metadata(), "wrong")).status).toBe(403);
  expect((await post({ ...metadata(), generation: "other-target" })).status).toBe(403);
  expect((await post({ ...metadata(), text: "Must never be stored" })).status).toBe(400);
  expect((await post({ ...metadata(), text: "x".repeat(5000) })).status).toBe(413);
  expect(await count("assistant_capture_inbox")).toBe(0);
  expect(await count("assistant_capture_streams")).toBe(0);
});

it("persists receipts once and rejects conflicting metadata or out-of-order progress", async () => {
  expect((await post(metadata(5, 4))).status).toBe(409);
  expect(await count("assistant_capture_inbox")).toBe(0);
  const first = await (await post(metadata())).json();
  expect(await (await post(Object.fromEntries(Object.entries(metadata()).reverse()))).json()).toEqual(first);
  expect((await post({ ...metadata(), operation: "withdraw" })).status).toBe(409);
  expect(await count("assistant_capture_inbox")).toBe(1);
  expect(await env.DB.prepare("SELECT read_sequence,applied_sequence FROM assistant_capture_streams").first())
    .toEqual({ read_sequence: 1, applied_sequence: 0 });
});

it("delivers at most ten events and advances only acknowledged metadata", async () => {
  const events = await seed(12);
  expect(await deliverCaptureChanges(sender())).toBe(10);
  expect(await count("assistant_capture_inbox")).toBe(10);
  expect(await env.DB.prepare("SELECT acknowledged_sequence FROM assistant_bridge_cursors").first())
    .toEqual({ acknowledged_sequence: events[9].sequence });
  expect(await env.DB.prepare("SELECT read_sequence,applied_sequence FROM assistant_capture_streams").first())
    .toEqual({ read_sequence: events[9].sequence, applied_sequence: 0 });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("replays the same event key after a lost acknowledgement", async () => {
  await seed(); let loseAck = true; const keys: number[] = [];
  const target = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); keys.push((await request.clone().json() as { sequence: number }).sequence);
    const result = await assistant.fetch(request, receiver);
    if (loseAck) { loseAck = false; throw new Error("Synthetic lost acknowledgement"); }
    return result;
  } };
  await expect(deliverCaptureChanges(sender(target))).rejects.toThrow();
  expect(await env.DB.prepare("SELECT acknowledged_sequence FROM assistant_bridge_cursors").first()).toEqual({ acknowledged_sequence: 0 });
  expect(await deliverCaptureChanges(sender(target))).toBe(1);
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  expect(await count("assistant_capture_inbox")).toBe(1);
});

it("keeps the cursor on failure and serializes concurrent acknowledgement with CAS", async () => {
  await seed();
  await expect(deliverCaptureChanges(sender({ fetch: async () => new Response(null, { status: 503 }) }))).rejects.toThrow();
  expect(await env.DB.prepare("SELECT acknowledged_sequence FROM assistant_bridge_cursors").first()).toEqual({ acknowledged_sequence: 0 });
  const delivered = await Promise.all([deliverCaptureChanges(sender()), deliverCaptureChanges(sender())]);
  expect(delivered.reduce((a, b) => a + b, 0)).toBe(1);
  expect(await count("assistant_capture_inbox")).toBe(1);
});

it("stays disabled when configuration is incomplete", async () => {
  await seed(); const incomplete = { ...sender(), ASSISTANT_BRIDGE_SECRET: undefined };
  expect(await deliverCaptureChanges(incomplete)).toBe(0);
  expect(await count("assistant_bridge_cursors")).toBe(0);
  expect(await count("assistant_capture_inbox")).toBe(0);
});

it("transports derivative, media and access events without requiring contiguous global integers", async () => {
  for (const [sequence, previousSequence, sourceKind, operation] of [
    [2, 0, "derivative", "upsert"], [5, 2, "media", "withdraw"], [9, 5, "conversation", "access"],
  ] as const) expect((await post({ ...metadata(sequence, previousSequence), sourceKind, operation })).status).toBe(200);
  expect(await count("assistant_capture_inbox")).toBe(3);
  expect(await env.DB.prepare("SELECT read_sequence,applied_sequence FROM assistant_capture_streams").first())
    .toEqual({ read_sequence: 9, applied_sequence: 0 });
});

it("does not advance after a deadline or an acknowledgement with the wrong digest", async () => {
  const [event] = await seed();
  await expect(deliverCaptureChanges(sender({ fetch: async () => new Promise<Response>(() => {}) }))).rejects.toThrow("bridge_timeout");
  await expect(deliverCaptureChanges(sender({ fetch: async () => Response.json({ sequence: event.sequence,
    metadataHash: "0".repeat(64), state: "received" }) }))).rejects.toThrow("bridge_invalid_receipt");
  expect(await env.DB.prepare("SELECT acknowledged_sequence FROM assistant_bridge_cursors").first()).toEqual({ acknowledged_sequence: 0 });
  expect(await count("assistant_capture_inbox")).toBe(0);
});
