import type { CogneeContainer } from "./container";
import type { MediaReader } from "./media";
import type { PdfAdmissionReader } from "./media-admission";
import type { SnapshotReader } from "./origin-guard";
import type { CalendarOAuth } from "./connectors/calendar-oauth";
import type { RetentionAuthority } from "./retention-authority";
import type { ApprovedSendActuatorRPC } from "../src/approved-send-contract";
// Host-only owner Telegram notifications; never WhatsApp or Calendar write credentials.
export interface AssistantEnv {
  DB?: D1Database;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_INSTANCE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  BRIDGE_SECRET?: string;
  BRIDGE_SOURCE_EPOCH?: string;
  BRIDGE_SOURCE_GENERATION?: string;
  INSTALLATION_ID?: string;
  OPERATIONAL_GENERATION?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  /** Explicit native model migration; no silent provider fallback. */
  NATIVE_MODEL_PROVIDER?: string;
  FLUE_EPISODES_ENABLED?: string;
  /** Staged OFF by default; no native provider or ingress is admitted otherwise. */
  NATIVE_CONVERSATIONS_MODE?: string;
  ASSISTANT_NATIVE_AUTONOMOUS_ENABLED?: string;
  /** Reconciled historical charges outside this DB, including uncertain costs. */
  NATIVE_BUDGET_EXTERNAL_CARRY_MICROUSD?: string;
  NATIVE_CONTEXT_ADMIN_SECRET?: string;
  /** Explicit cut of the verified Source stream at native activation. */
  NATIVE_CAPTURE_START_AFTER_SEQUENCE?: string;
  /** Private curator capability; does not enable recurring execution by itself. */
  NATIVE_CURATOR_ENABLED?: string;
  /** Explicit recurring activation, OFF until cost review and authorization. */
  NATIVE_CURATOR_SCHEDULE_ENABLED?: string;
  /** Host-only exact operation/window for a one-off sample; conflicts with schedule=true. */
  NATIVE_CURATOR_SAMPLE_REQUEST?: string;
  /** Private operator-selected, one-time revision1→2 continuation of a failed daily run. */
  NATIVE_CURATOR_RESUME_REQUEST?: string;
  FLUE_CONVERSATION_RUNTIME_AGENT?: {idFromName(name:string):DurableObjectId;get(id:DurableObjectId):DurableObjectStub & {eraseNativeContext(secret:string,sessionId:string):Promise<void>}};
  ROUTINES_ENABLED?: string;
  ROUTINES_PAUSED?: string;
  TELEGRAM_SUMMARIES_ENABLED?: string;
  TELEGRAM_SUGGESTIONS_ENABLED?: string;
  PROACTIVE_PILOT_JSON?: string;
  WHATSAPP_APPROVED_SEND_ENABLED?: string;
  WHATSAPP_APPROVED_SEND_SECRET?: string;
  WHATSAPP_APPROVED_SEND?: ApprovedSendActuatorRPC;
  TELEGRAM_OWNER_DIALOGUE_ENABLED?: string;
  MEDIA_CONTEXT_ENABLED?: string;
  COGNEE?: DurableObjectNamespace<CogneeContainer>;
  SEMANTIC_SEARCH_MODE?: string;
  KNOWLEDGE_SERVICE_URL?: string;
  KNOWLEDGE_SERVICE_TOKEN?: string;
  /** Stable shared acervo identity; never derived from a task or restore. */
  KNOWLEDGE_SPACE_GENERATION?: string;
  CAPTURE_READER?: SnapshotReader;
  CAPTURE_MEDIA_READER?: MediaReader;
  MEDIA_PDF_PARSER?: PdfAdmissionReader;
  GITHUB_READ_REPOSITORIES?: string;
  GITHUB_READ_OWNER?: string;
  GITHUB_READ_TOKEN?: string;
  CALENDAR_READ_CALENDARS?: string;
  CALENDAR_WRITE_CALENDAR?: string;
  CALENDAR_OAUTH?: DurableObjectNamespace<CalendarOAuth>;
  CALENDAR_OAUTH_PERMISSION?: "read_only" | "write_owned";
  CALENDAR_OAUTH_CONFIGURATION_VERSION?: string;
  CALENDAR_OAUTH_SECRET_EPOCH?: string;
  CALENDAR_OAUTH_CREDENTIAL_GENERATION?: string;
  CALENDAR_OAUTH_CLIENT_ID?: string;
  CALENDAR_OAUTH_CLIENT_SECRET?: string;
  CALENDAR_OAUTH_REFRESH_TOKEN?: string;
  CALENDAR_OAUTH_ENCRYPTION_KEY?: string;
  RETENTION_AUTHORITY?: DurableObjectNamespace<RetentionAuthority>;
  RETENTION_AUTHORITY_REQUIRED?: string;
  RETENTION_BOOTSTRAP_SEAL?: string;
  ARTIFACTS?: R2Bucket;
  ARTIFACTS_INSTALLATION_ID?: string;
  ARTIFACTS_GENERATION?: string;
  RETENTION_RESTORE_GENERATION?: string;
  RETENTION_GENERATION_SEAL?: string;
  RETENTION_GENERATION_SEAL_REQUIRED?: string;
}
