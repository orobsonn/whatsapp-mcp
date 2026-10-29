import { init } from "@flue/runtime";
import { OwnerRuntime, InterlocutorRuntime, OwnerDialogueRuntime } from "./entry";
import type { EpisodeDriver } from "../agent/controller";
/** Public Flue APIs only; persisted native idempotency envelopes own replay. */
export const episodeDriver: EpisodeDriver = (profile, runtimeId) => init(profile === "owner" ? OwnerRuntime : InterlocutorRuntime, { id: runtimeId });
export const ownerDialogueDriver = (runtimeId: string) => init(OwnerDialogueRuntime, { id: runtimeId });
