import type { CogneeContainer } from "./container";
import type { SnapshotReader } from "./origin-guard";
// Optional, host-only inference bindings. No messaging/action credentials.
export interface AssistantEnv {
  DB?: D1Database;
  BRIDGE_SECRET?: string;
  BRIDGE_SOURCE_EPOCH?: string;
  BRIDGE_SOURCE_GENERATION?: string;
  INSTALLATION_ID?: string;
  OPERATIONAL_GENERATION?: string;
  OPENAI_API_KEY?: string;
  COGNEE?: DurableObjectNamespace<CogneeContainer>;
  CAPTURE_READER?: SnapshotReader;
}
