import type { CogneeContainer } from "./container";
import type { SnapshotReader } from "./origin-guard";
// Host-only configuration. No outgoing messaging/action credentials.
export interface AssistantEnv {
  DB?: D1Database;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_INSTANCE?: string;
  BRIDGE_SECRET?: string;
  BRIDGE_SOURCE_EPOCH?: string;
  BRIDGE_SOURCE_GENERATION?: string;
  INSTALLATION_ID?: string;
  OPERATIONAL_GENERATION?: string;
  OPENAI_API_KEY?: string;
  FLUE_EPISODES_ENABLED?: string;
  COGNEE?: DurableObjectNamespace<CogneeContainer>;
  CAPTURE_READER?: SnapshotReader;
}
