"use agent";
import { useInitialData, useModel } from "@flue/runtime";
import * as v from "valibot";

const seed = v.union([v.strictObject({ installationId: v.string(), generation: v.string(), jobId: v.string() }),
  v.strictObject({ bindingId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)) })]);
function configure() {
  useInitialData<v.InferOutput<typeof seed>>();
  // Only a host binding can resolve this provider; initialData grants no power.
  useModel("assistant-host/shadow", { compaction: false });
}
export function OwnerRuntime() { configure(); return "Owner shadow runtime. No operational tools or delegation."; }
OwnerRuntime.agentName = "owner-runtime";
OwnerRuntime.initialData = seed;
OwnerRuntime.durability = { maxAttempts: 1, timeoutMs: 60000 };
export function InterlocutorRuntime() { configure(); return "Interlocutor shadow runtime. No owner authority, operational tools or delegation."; }
InterlocutorRuntime.agentName = "interlocutor-runtime";
InterlocutorRuntime.initialData = seed;
InterlocutorRuntime.durability = { maxAttempts: 1, timeoutMs: 60000 };

// Its native transcript contains only a host binding and a generic message.
// The host executes private phases and returns only a completion marker.
const dialogueSeed = v.strictObject({ bindingId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)) });
export function OwnerDialogueRuntime() {
  useInitialData<v.InferOutput<typeof dialogueSeed>>();
  useModel("assistant-host/owner-dialogue", { compaction: false });
  return "Execute the admitted private owner dialogue. Return only its completion marker. No tools or delegation.";
}
OwnerDialogueRuntime.agentName = "owner-dialogue-runtime";
OwnerDialogueRuntime.initialData = dialogueSeed;
// A private dialogue may have two paid phases. Match the host's two-minute
// ceiling; its immutable input frame/lease can still expire earlier.
OwnerDialogueRuntime.durability = { maxAttempts: 1, timeoutMs: 120000 };
