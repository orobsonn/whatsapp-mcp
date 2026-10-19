import type { ZapiGroupsClient } from "./zapi-groups";
export type GroupProvider = Pick<
  ZapiGroupsClient,
  | "status"
  | "metadata"
  | "invitationMetadata"
  | "invitationLink"
  | "listChats"
  | "chatMetadata"
  | "listCommunities"
  | "communityMetadata"
  | "mutate"
>;
export interface GroupBinding {
  kind: "group" | "contact" | "member" | "community";
  id: string;
  externalId: string;
  name: string;
  chatId?: string;
}
export interface GroupPrivate {
  operation: Record<string, unknown>;
  bindings: GroupBinding[];
  key: string;
  acceptedGroup?: string;
  inviteTarget?: { name: string; participantsCount: number };
  media?: {
    id: string;
    hash: string;
    version: number;
    objectKey: string;
    mime: string;
    messageId: string | null;
    messageVersion: number;
  };
}
export interface GroupEnvelope {
  operation: Record<string, unknown>;
  targets: { id: string; kind: GroupBinding["kind"]; name: string }[];
  bindingCommitment: string;
  warnings: string[];
}
export interface GroupActionRow {
  id: string;
  epoch: string;
  generation: string;
  envelope_json: string;
  private_json: string;
  hash: string;
  version: number;
  status: string;
  expires_at: number;
  result_json: string | null;
  ack_json: string | null;
  last_error: string | null;
  created_at: number;
}
