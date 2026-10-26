import { init } from "@flue/runtime";
import { OwnerRuntime, InterlocutorRuntime } from "./profiles";
import type { EpisodeDriver } from "../agent/controller";
/** Public Flue APIs only; persisted native idempotency envelopes own replay. */
export const episodeDriver: EpisodeDriver = (profile, runtimeId) => init(profile === "owner" ? OwnerRuntime : InterlocutorRuntime, { id: runtimeId });
