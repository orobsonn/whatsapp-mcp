// Ingress-only configuration. No provider credentials or mutation bindings.
export interface AssistantEnv {
  DB?: D1Database;
  BRIDGE_SECRET?: string;
  BRIDGE_SOURCE_EPOCH?: string;
  BRIDGE_SOURCE_GENERATION?: string;
  INSTALLATION_ID?: string;
  OPERATIONAL_GENERATION?: string;
}
