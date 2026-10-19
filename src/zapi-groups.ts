import {
  ProviderUncertainError,
  ZapiClient,
  ZapiError,
  type ZapiSendIds,
} from "./zapi";

export type ZapiGroupMutation =
  | {
      operation: "create";
      groupName: string;
      phones: string[];
      autoInvite: boolean;
    }
  | { operation: "name"; groupId: string; groupName: string }
  | {
      operation: "photo";
      groupId: string;
      bytes: Uint8Array;
      mime: "image/png" | "image/jpeg" | "image/webp";
    }
  | {
      operation: "add_participants";
      groupId: string;
      phones: string[];
      autoInvite: boolean;
    }
  | {
      operation:
        | "remove_participants"
        | "approve_participants"
        | "reject_participants"
        | "promote_admins"
        | "demote_admins";
      groupId: string;
      phones: string[];
    }
  | {
      operation: "leave" | "reset_invite" | "chat_clear" | "chat_delete";
      groupId: string;
    }
  | {
      operation: "settings";
      groupId: string;
      adminOnlyMessage: boolean;
      adminOnlySettings: boolean;
      requireAdminApproval: boolean;
      adminOnlyAddMember: boolean;
    }
  | { operation: "description"; groupId: string; groupDescription: string }
  | { operation: "accept_invite"; url: string }
  | {
      operation: "mention_members";
      groupId: string;
      message: string;
      mentioned: string[];
      delayMessage?: number;
    }
  | {
      operation: "mention_groups";
      groupId: string;
      message: string;
      groupMentioned: { phone: string; subject: string }[];
      delayMessage?: number;
    }
  | {
      operation: "mention_all";
      groupId: string;
      message: string;
      delayMessage?: number;
    }
  | {
      operation: "chat_read" | "chat_archive" | "chat_pin" | "chat_mute";
      groupId: string;
      enabled: boolean;
    }
  | {
      operation: "chat_expiration";
      groupId: string;
      chatExpiration: "24_HOURS" | "7_DAYS" | "90_DAYS" | "OFF";
    }
  | {
      operation: "link_groups" | "unlink_groups";
      communityId: string;
      groupsPhones: string[];
    };

export interface GroupMutationResult {
  outcome: "accepted" | "rejected";
  evidence: "provider_ack";
  groupId?: string;
  invitationLink?: string;
  notAdded?: string[];
  messageIds?: ZapiSendIds;
  partial?: boolean;
}
export interface GroupParticipant {
  phone: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  name?: string;
  short?: string;
}
export interface GroupMetadata {
  phone: string;
  subject?: string;
  description?: string;
  owner?: string;
  communityId?: string;
  participants: GroupParticipant[];
  adminOnlyMessage?: boolean;
  adminOnlySettings?: boolean;
  requireAdminApproval?: boolean;
  adminOnlyAddMember?: boolean;
  isGroupAnnouncement?: boolean;
  invitationLink?: string;
  creation?: number | string;
  subjectTime?: number | string;
  subjectOwner?: string;
  growthLocked?: boolean;
  growthLockExpiration?: number | string;
  contactsCount?: number;
  participantsCount?: number;
}
export interface GroupChat {
  phone: string;
  isGroup?: boolean;
  name?: string;
  unread?: boolean | string;
  archived?: boolean | string;
  pinned?: boolean | string;
  isMuted?: boolean | string;
  isMarkedSpam?: boolean | string;
  messagesUnread?: number | string;
  lastMessageTime?: number | string;
  muteEndTime?: number | string;
  isGroupAnnouncement?: boolean | string;
}
export interface CommunitySummary {
  id: string;
  name?: string;
}
export interface CommunityMetadata extends CommunitySummary {
  description?: string;
  subGroups: { phone: string; name?: string; isGroupAnnouncement?: boolean }[];
}

const invalid = () => new ZapiError("Contrato de grupo inválido.");
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function str(value: unknown, max = 4096): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw invalid();
  return value;
}
function content(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw invalid();
  return value;
}
function plainText(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw invalid();
  return value;
}
function address(value: unknown): string {
  return str(value, 256);
}
function groupId(value: unknown): string {
  const id = address(value);
  if (!/^(?:[A-Za-z0-9._-]+@g\.us|[0-9]+-group)$/.test(id)) throw invalid();
  return id;
}
function stringList(value: unknown, max = 50, groups = false): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max)
    throw invalid();
  return value.map((v) => (groups ? groupId(v) : address(v)));
}
function optional<T>(
  source: Record<string, unknown>,
  key: string,
  parse: (v: unknown) => T,
): T | undefined {
  const value = source[key];
  return value == null ? undefined : parse(value);
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function boolOrString(value: unknown): boolean | string {
  if (typeof value !== "boolean" && typeof value !== "string") throw invalid();
  return value;
}
function numberOrString(value: unknown): number | string {
  if (
    (typeof value !== "number" || !Number.isFinite(value)) &&
    typeof value !== "string"
  )
    throw invalid();
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
function fields<T extends object>(
  source: Record<string, unknown>,
  parsers: Record<string, (v: unknown) => unknown>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(parsers)) {
    const value = optional(source, key, parse);
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
function page(page: number, pageSize: number): string {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw invalid();
  return `?page=${page}&pageSize=${pageSize}`;
}
export function parseGroupInvite(value: unknown): string {
  const text = str(value, 512);
  if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{3,128}$/.test(text))
    throw invalid();
  return text;
}
function photo(bytes: unknown, mime: unknown): string {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > 2 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp"].includes(String(mime))
  )
    throw invalid();
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 12288)
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 12288))));
  return `data:${mime};base64,${parts.join("")}`;
}
function mutationPlan(input: ZapiGroupMutation): {
  endpoint: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
} {
  if (!input || typeof input !== "object") throw invalid();
  const op = input.operation;
  if (op === "create") {
    if (typeof input.autoInvite !== "boolean") throw invalid();
    return {
      endpoint: "create-group",
      method: "POST",
      body: {
        autoInvite: input.autoInvite,
        groupName: str(input.groupName, 256),
        phones: stringList(input.phones),
      },
    };
  }
  if (op === "accept_invite")
    return {
      endpoint: `accept-invite-group?url=${encodeURIComponent(parseGroupInvite(input.url))}`,
      method: "GET",
    };
  if (op === "link_groups" || op === "unlink_groups")
    return {
      endpoint: `communities/${op === "link_groups" ? "link" : "unlink"}`,
      method: "POST",
      body: {
        communityId: address(input.communityId),
        groupsPhones: stringList(input.groupsPhones, 50, true),
      },
    };
  const id = groupId((input as { groupId?: unknown }).groupId);
  if (op === "name")
    return {
      endpoint: "update-group-name",
      method: "POST",
      body: { groupId: id, groupName: str(input.groupName, 256) },
    };
  if (op === "photo")
    return {
      endpoint: "update-group-photo",
      method: "POST",
      body: { groupId: id, groupPhoto: photo(input.bytes, input.mime) },
    };
  const members: Partial<Record<ZapiGroupMutation["operation"], string>> = {
    add_participants: "add-participant",
    remove_participants: "remove-participant",
    approve_participants: "approve-participant",
    reject_participants: "reject-participant",
    promote_admins: "add-admin",
    demote_admins: "remove-admin",
  };
  if (op in members) {
    const item = input as Extract<
      ZapiGroupMutation,
      { phones: string[]; groupId: string }
    >;
    const body: Record<string, unknown> = {
      groupId: id,
      phones: stringList(item.phones),
    };
    if (op === "add_participants") {
      if (typeof (item as { autoInvite?: unknown }).autoInvite !== "boolean")
        throw invalid();
      body.autoInvite = (item as { autoInvite: boolean }).autoInvite;
    }
    return { endpoint: members[op]!, method: "POST", body };
  }
  if (op === "leave")
    return { endpoint: "leave-group", method: "POST", body: { groupId: id } };
  if (op === "settings")
    return {
      endpoint: "update-group-settings",
      method: "POST",
      body: {
        phone: id,
        adminOnlyMessage: bool(input.adminOnlyMessage),
        adminOnlySettings: bool(input.adminOnlySettings),
        requireAdminApproval: bool(input.requireAdminApproval),
        adminOnlyAddMember: bool(input.adminOnlyAddMember),
      },
    };
  if (op === "description")
    return {
      endpoint: "update-group-description",
      method: "POST",
      body: {
        groupId: id,
        groupDescription: plainText(input.groupDescription, 4096),
      },
    };
  if (op === "reset_invite")
    return {
      endpoint: `redefine-invitation-link/${encodeURIComponent(id)}`,
      method: "POST",
    };
  if (
    op === "mention_members" ||
    op === "mention_groups" ||
    op === "mention_all"
  ) {
    const body: Record<string, unknown> = {
      phone: id,
      message: content(input.message, 8000),
    };
    if (input.delayMessage !== undefined) {
      if (
        !Number.isSafeInteger(input.delayMessage) ||
        input.delayMessage < 1 ||
        input.delayMessage > 15
      )
        throw invalid();
      body.delayMessage = input.delayMessage;
    }
    if (op === "mention_members") body.mentioned = stringList(input.mentioned);
    else if (op === "mention_groups") {
      if (
        !Array.isArray(input.groupMentioned) ||
        !input.groupMentioned.length ||
        input.groupMentioned.length > 50
      )
        throw invalid();
      body.groupMentioned = input.groupMentioned.map((g) => ({
        phone: groupId(g.phone),
        subject: str(g.subject, 256),
      }));
      for (const group of body.groupMentioned as { phone: string }[])
        if (!input.message.includes(`@${group.phone}`)) throw invalid();
    } else {
      if (!input.message.includes("@all")) throw invalid();
      body.mentionAll = true;
    }
    return { endpoint: "send-text", method: "POST", body };
  }
  if (
    op === "chat_read" ||
    op === "chat_archive" ||
    op === "chat_pin" ||
    op === "chat_mute"
  ) {
    const actions = {
      chat_read: ["unread", "read"],
      chat_archive: ["unarchive", "archive"],
      chat_pin: ["unpin", "pin"],
      chat_mute: ["unmute", "mute"],
    } as const;
    return {
      endpoint: "modify-chat",
      method: "POST",
      body: { phone: id, action: actions[op][bool(input.enabled) ? 1 : 0] },
    };
  }
  if (op === "chat_clear" || op === "chat_delete")
    return {
      endpoint: "modify-chat",
      method: "POST",
      body: { phone: id, action: op === "chat_clear" ? "clear" : "delete" },
    };
  if (op === "chat_expiration") {
    if (
      !["24_HOURS", "7_DAYS", "90_DAYS", "OFF"].includes(input.chatExpiration)
    )
      throw invalid();
    return {
      endpoint: "send-chat-expiration",
      method: "POST",
      body: { phone: id, chatExpiration: input.chatExpiration },
    };
  }
  throw invalid();
}
export function validateGroupMutation(input: ZapiGroupMutation): void {
  mutationPlan(input);
}

function metadata(value: unknown, includeLink: boolean): GroupMetadata {
  const r = row(value);
  const participants = r.participants;
  if (!Array.isArray(participants) || participants.length > 10000)
    throw invalid();
  return {
    ...fields<GroupMetadata>(r, {
      subject: (v) => str(v, 256),
      description: (v) => plainText(v, 4096),
      owner: address,
      communityId: address,
      adminOnlyMessage: bool,
      adminOnlySettings: bool,
      requireAdminApproval: bool,
      adminOnlyAddMember: bool,
      isGroupAnnouncement: bool,
      creation: numberOrString,
      subjectTime: numberOrString,
      subjectOwner: address,
      growthLocked: bool,
      growthLockExpiration: numberOrString,
      contactsCount: count,
      participantsCount: count,
    }),
    participants: participants.map((v) => {
      const p = row(v);
      return {
        ...fields<GroupParticipant>(p, {
          isAdmin: bool,
          isSuperAdmin: bool,
          name: (v) => str(v, 256),
          short: (v) => str(v, 256),
        }),
        phone: address(p.phone),
      };
    }),
    phone: groupId(r.phone),
    ...(includeLink
      ? fields<GroupMetadata>(r, { invitationLink: parseGroupInvite })
      : {}),
  };
}
function chat(value: unknown): GroupChat {
  const r = row(value);
  return {
    ...fields<GroupChat>(r, {
      name: (v) => str(v, 256),
      isGroup: bool,
      unread: boolOrString,
      archived: boolOrString,
      pinned: boolOrString,
      isMuted: boolOrString,
      isMarkedSpam: boolOrString,
      isGroupAnnouncement: boolOrString,
      messagesUnread: numberOrString,
      lastMessageTime: numberOrString,
      muteEndTime: numberOrString,
    }),
    phone: address(r.phone),
  };
}

export class ZapiGroupsClient extends ZapiClient {
  async metadata(
    group: string,
    variant: "full" | "light" = "light",
  ): Promise<GroupMetadata> {
    return metadata(
      await this.request(
        `${variant === "full" ? "group-metadata" : "light-group-metadata"}/${encodeURIComponent(groupId(group))}`,
      ),
      false,
    );
  }
  async invitationMetadata(url: string): Promise<GroupMetadata> {
    return metadata(
      await this.request(
        `group-invitation-metadata?url=${encodeURIComponent(parseGroupInvite(url))}`,
      ),
      false,
    );
  }
  async invitationLink(group: string): Promise<string> {
    const r = row(
      await this.request(
        `group-invitation-link/${encodeURIComponent(groupId(group))}`,
      ),
    );
    return parseGroupInvite(r.invitationLink);
  }
  async listChats(p: number, size: number): Promise<GroupChat[]> {
    const data = await this.request(`chats${page(p, size)}`);
    if (!Array.isArray(data) || data.length > size) throw invalid();
    return data.map(chat);
  }
  async chatMetadata(group: string): Promise<GroupChat> {
    return chat(
      await this.request(`chats/${encodeURIComponent(groupId(group))}`),
    );
  }
  async listCommunities(p: number, size: number): Promise<CommunitySummary[]> {
    const data = await this.request(`communities${page(p, size)}`);
    if (!Array.isArray(data) || data.length > size) throw invalid();
    return data.map((value) => {
      const r = row(value);
      return {
        ...fields<CommunitySummary>(r, { name: (v) => str(v, 256) }),
        id: address(r.id),
      };
    });
  }
  async communityMetadata(community: string): Promise<CommunityMetadata> {
    const r = row(
      await this.request(
        `communities-metadata/${encodeURIComponent(address(community))}`,
      ),
    );
    if (!Array.isArray(r.subGroups) || r.subGroups.length > 10000)
      throw invalid();
    return {
      ...fields<CommunityMetadata>(r, {
        name: (v) => str(v, 256),
        description: (v) => plainText(v, 4096),
      }),
      subGroups: r.subGroups.map((value) => {
        const g = row(value);
        return {
          ...fields<{ name?: string; isGroupAnnouncement?: boolean }>(g, {
            name: (v) => str(v, 256),
            isGroupAnnouncement: bool,
          }),
          phone: groupId(g.phone),
        };
      }),
      id: address(r.id),
    };
  }
  async mutate(input: ZapiGroupMutation): Promise<GroupMutationResult> {
    const plan = mutationPlan(input);
    const value = await this.request(plan.endpoint, plan.body, {
      method: plan.method,
      effect: true,
    });
    try {
      const r = row(value);
      const rejected = r.value === false || r.success === false;
      if (input.operation === "create") {
        if (rejected) return { outcome: "rejected", evidence: "provider_ack" };
        const group = groupId(r.phone);
        const notAdded =
          r.phonesNotAdded === undefined
            ? undefined
            : Array.isArray(r.phonesNotAdded)
              ? r.phonesNotAdded.map(address)
              : (() => {
                  throw invalid();
                })();
        return {
          outcome: "accepted",
          evidence: "provider_ack",
          groupId: group,
          ...(r.invitationLink == null
            ? {}
            : { invitationLink: parseGroupInvite(r.invitationLink) }),
          ...(notAdded === undefined
            ? {}
            : { notAdded, partial: notAdded.length > 0 }),
        };
      }
      if (input.operation === "reset_invite") {
        if (rejected) return { outcome: "rejected", evidence: "provider_ack" };
        return {
          outcome: "accepted",
          evidence: "provider_ack",
          invitationLink: parseGroupInvite(r.invitationLink),
        };
      }
      if (input.operation.startsWith("mention_")) {
        if (rejected) return { outcome: "rejected", evidence: "provider_ack" };
        const ids = fields<ZapiSendIds>(r, {
          messageId: (v) => str(v, 256),
          zaapId: (v) => str(v, 256),
          id: (v) => str(v, 256),
        });
        if (!Object.keys(ids).length) throw invalid();
        return {
          outcome: "accepted",
          evidence: "provider_ack",
          messageIds: ids,
        };
      }
      const key =
        input.operation === "accept_invite" ||
        input.operation === "link_groups" ||
        input.operation === "unlink_groups"
          ? "success"
          : "value";
      if (typeof r[key] !== "boolean") throw invalid();
      return {
        outcome: r[key] ? "accepted" : "rejected",
        evidence: "provider_ack",
      };
    } catch {
      throw new ProviderUncertainError();
    }
  }
}
