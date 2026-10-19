import {
  assertChatConfirmation,
  groupConfirmationMode,
  readableConfirmation,
  type ChatConfirmation,
} from "./approval";
import { z } from "zod";
import type { Env } from "./env";
import {
  AppError,
  assertActive,
  currentFence,
  assertFence,
  boundedInt,
  decodeCursor,
  encodeCursor,
  sha256,
  LIMITS,
} from "./core";
import { hashEnvelope } from "./auth";
import { getChat, type ChatRow, chatView } from "./store";
import { readMedia } from "./media";
import {
  ZapiGroupsClient,
  validateGroupMutation,
  parseGroupInvite,
  type ZapiGroupMutation,
  type GroupMetadata,
  type GroupMutationResult,
} from "./zapi-groups";
import type {
  GroupProvider,
  GroupBinding,
  GroupPrivate,
  GroupEnvelope,
  GroupActionRow,
} from "./group-types";
export type { GroupProvider } from "./group-types";
const ref = z.string().min(1).max(200),
  refs = z
    .array(ref)
    .min(1)
    .max(50)
    .refine((a) => new Set(a).size === a.length);
const name = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(s));
const text = z
  .string()
  .min(1)
  .max(8000)
  .refine(
    (s) => s.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s),
  );
const mention = {
  chatId: ref,
  text,
  delayMessage: z.number().int().min(1).max(15).optional(),
};
const op = <T extends z.ZodRawShape>(operation: string, fields: T) =>
  z.object({ operation: z.literal(operation), ...fields }).strict();
export const groupActionSchema = z.discriminatedUnion("operation", [
  op("create", { name, contactIds: refs, autoInvite: z.boolean() }),
  op("name", { chatId: ref, name }),
  op("photo", {
    chatId: ref,
    mediaId: ref,
    mediaHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  op("add_participants", {
    chatId: ref,
    contactIds: refs,
    autoInvite: z.boolean(),
  }),
  ...["remove_participants", "promote_admins", "demote_admins"].map((v) =>
    op(v, { chatId: ref, memberIds: refs }),
  ),
  ...["approve_participants", "reject_participants"].map((v) =>
    op(v, { chatId: ref, contactIds: refs }),
  ),
  ...["leave", "reset_invite", "chat_clear", "chat_delete"].map((v) =>
    op(v, { chatId: ref }),
  ),
  op("settings", {
    chatId: ref,
    adminOnlyMessage: z.boolean(),
    adminOnlySettings: z.boolean(),
    requireAdminApproval: z.boolean(),
    adminOnlyAddMember: z.boolean(),
  }),
  op("description", {
    chatId: ref,
    description: z
      .string()
      .max(4096)
      .refine((s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)),
  }),
  op("accept_invite", { inviteURL: z.string().max(512) }),
  op("mention_members", { ...mention, memberIds: refs }),
  op("mention_groups", { ...mention, groupIds: refs }),
  op("mention_all", {
    ...mention,
    text: text.refine((s) => s.includes("@all")),
  }),
  ...["chat_read", "chat_archive", "chat_pin", "chat_mute"].map((v) =>
    op(v, { chatId: ref, enabled: z.boolean() }),
  ),
  op("chat_expiration", {
    chatId: ref,
    chatExpiration: z.enum(["24_HOURS", "7_DAYS", "90_DAYS", "OFF"]),
  }),
  ...["link_groups", "unlink_groups"].map((v) =>
    op(v, { communityId: ref, chatIds: refs }),
  ),
]);
type Operation = Record<string, unknown> & { operation: string };
const defaultProvider = (env: Env): GroupProvider => new ZapiGroupsClient(env);
const bounded = <T>(v: T): T => {
  if (new TextEncoder().encode(JSON.stringify(v)).length > 32768)
    throw new AppError("group_output_too_large", 413);
  return v;
};
function secretKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
async function commitment(p: GroupPrivate) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(p.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const { key, ...data } = p;
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(await hashEnvelope(data)),
  );
  return Array.from(new Uint8Array(sig), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
function publicOperation(
  operation: Record<string, unknown>,
  inviteTarget?: GroupPrivate["inviteTarget"],
) {
  if (operation.operation === "accept_invite")
    return {
      operation: "accept_invite",
      inviteProvided: true,
      inviteTarget: inviteTarget ?? null,
    };
  return operation;
}
async function snapshot(p: GroupPrivate): Promise<GroupEnvelope> {
  const operation = publicOperation(p.operation, p.inviteTarget),
    warnings: string[] = [
      "Permissão e efeito final dependem do WhatsApp; ack não prova leitura/propagação.",
    ];
  if (p.operation.autoInvite === true)
    warnings.push(
      "Pode enviar convites privados aos contatos que não forem adicionados.",
    );
  if (p.operation.operation === "mention_all")
    warnings.push("Audiência dinâmica: inclui quem entrar até a execução.");
  if (
    [
      "chat_clear",
      "chat_delete",
      "leave",
      "remove_participants",
      "demote_admins",
    ].includes(String(p.operation.operation))
  )
    warnings.push(
      "Ação destrutiva no WhatsApp; o arquivo local é independente.",
    );
  return {
    operation,
    targets: p.bindings.map((b) => ({ id: b.id, kind: b.kind, name: b.name })),
    bindingCommitment: await commitment(p),
    warnings,
  };
}
async function actionRow(env: Env, id: string) {
  assertActive(env);
  const f = currentFence(env);
  const a = await env.DB.prepare(
    "SELECT * FROM group_actions WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(id, f.epoch, f.generation)
    .first<GroupActionRow>();
  if (!a) throw new AppError("group_action_not_found", 404);
  if (a.envelope_json !== "{}") {
    try {
      const p = JSON.parse(a.private_json) as GroupPrivate;
      if (
        (await hashEnvelope(JSON.parse(a.envelope_json))) !== a.hash ||
        (await hashEnvelope(await snapshot(p))) !== a.hash
      )
        throw 0;
    } catch {
      throw new AppError("action_changed", 409);
    }
  }
  return a;
}
function groupAddress(value: string) {
  return value.endsWith("@g.us") || /^\d{5,64}-group$/.test(value);
}
async function group(env: Env, id: string) {
  const c = await getChat(env, id);
  if (c.kind !== "group") throw new AppError("group_required");
  if (!groupAddress(c.external_id)) throw new AppError("invalid_group_address");
  return c;
}
function phone(address: string) {
  if (address.endsWith("@lid")) throw new AppError("unsupported_lid", 409);
  if (!/^\d{8,20}$/.test(address))
    throw new AppError("unsupported_member_address", 409);
  return address;
}
async function binding(
  env: Env,
  kind: GroupBinding["kind"],
  id: string,
  chatId?: string,
): Promise<GroupBinding> {
  const f = currentFence(env);
  if (kind === "group" || kind === "contact") {
    const c = kind === "group" ? await group(env, id) : await getChat(env, id);
    if (kind === "contact" && c.kind !== "individual")
      throw new AppError("contact_required");
    return { kind, id, externalId: c.external_id, name: c.name };
  }
  const table =
    kind === "member" ? "group_member_refs" : "group_community_refs";
  const r = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id=? AND epoch=? AND generation=?${kind === "member" ? " AND chat_id=?" : ""}`,
  )
    .bind(id, f.epoch, f.generation, ...(kind === "member" ? [chatId] : []))
    .first<{ external_id: string; name: string; chat_id?: string }>();
  if (!r)
    throw new AppError(
      kind === "member" ? "member_not_found" : "community_not_found",
      404,
    );
  return {
    kind,
    id,
    externalId: r.external_id,
    name: r.name,
    ...(kind === "member" ? { chatId: r.chat_id! } : {}),
  };
}
async function connected(env: Env, p: GroupProvider) {
  const status = await p.status();
  if (
    !status.connected ||
    !env.CONNECTED_PHONE ||
    status.phone !== env.CONNECTED_PHONE
  )
    throw new AppError("device_changed", 409);
  assertActive(env);
}
async function mediaPrivate(env: Env, id: string, hash: string) {
  const m = await env.DB.prepare(
    "SELECT m.* FROM media m LEFT JOIN messages x ON x.id=m.message_id WHERE m.id=? AND m.epoch=? AND m.generation=? AND m.state='ready' AND m.deleted_at IS NULL AND (m.message_id IS NULL OR (x.deleted_at IS NULL AND x.version=m.message_version))",
  )
    .bind(id, env.INSTALLATION_EPOCH, env.CONNECTION_GENERATION)
    .first<{
      id: string;
      sha256: string;
      kind: string;
      mime: string;
      version: number;
      object_key: string;
      message_id: string | null;
      message_version: number;
    }>();
  if (
    !m ||
    m.sha256 !== hash ||
    m.kind !== "image" ||
    !["image/png", "image/jpeg", "image/webp"].includes(m.mime)
  )
    throw new AppError("media_unavailable", 409);
  return {
    id: m.id,
    hash: m.sha256,
    version: m.version,
    objectKey: m.object_key,
    mime: m.mime,
    messageId: m.message_id,
    messageVersion: m.message_version,
  };
}
export async function prepareGroupAction(
  env: Env,
  input: unknown,
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const operation = groupActionSchema.parse(input) as Operation;
  const totalRefs =
    ["contactIds", "memberIds", "groupIds", "chatIds"].reduce(
      (n, key) => n + ((operation[key] as unknown[] | undefined)?.length ?? 0),
      typeof operation.chatId === "string" ? 1 : 0,
    ) + (typeof operation.communityId === "string" ? 1 : 0);
  if (totalRefs > 50) throw new AppError("too_many_group_refs");
  const p: GroupPrivate = { operation, bindings: [], key: secretKey() };
  const add = async (k: GroupBinding["kind"], id: string, chatId?: string) => {
    if (p.bindings.length >= 101) throw new AppError("too_many_group_refs");
    const b = await binding(env, k, id, chatId);
    p.bindings.push(b);
    return b;
  };
  if (typeof operation.chatId === "string")
    await add("group", operation.chatId);
  for (const id of (operation.contactIds ?? []) as string[]) {
    const b = await add("contact", id);
    phone(b.externalId);
    if (b.externalId === env.CONNECTED_PHONE)
      throw new AppError("connected_contact_not_allowed");
  }
  for (const id of (operation.memberIds ?? []) as string[]) {
    const b = await add("member", id, String(operation.chatId));
    phone(b.externalId);
  }
  for (const id of (operation.groupIds ?? operation.chatIds ?? []) as string[])
    await add("group", id);
  if (typeof operation.communityId === "string")
    await add("community", operation.communityId);
  if (operation.operation === "accept_invite") {
    operation.inviteURL = parseGroupInvite(operation.inviteURL);
    const metadata = await provider.invitationMetadata(
      String(operation.inviteURL),
    );
    p.acceptedGroup = metadata.phone;
    p.inviteTarget = {
      name: metadata.subject ?? "Grupo sem nome",
      participantsCount:
        metadata.participantsCount ?? metadata.participants.length,
    };
  }
  if (operation.operation === "photo")
    p.media = await mediaPrivate(
      env,
      String(operation.mediaId),
      String(operation.mediaHash),
    );
  if (["mention_groups", "mention_members"].includes(operation.operation))
    mentionText(p);
  await connected(env, provider);
  await preflight(env, p, provider);
  const envelope = await snapshot(p);
  bounded(envelope);
  const id = crypto.randomUUID(),
    now = Date.now(),
    hash = await hashEnvelope(envelope),
    f = currentFence(env);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO group_actions(id,epoch,generation,envelope_json,private_json,hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,'proposed',?,?)",
    ).bind(
      id,
      f.epoch,
      f.generation,
      JSON.stringify(envelope),
      JSON.stringify(p),
      hash,
      now + 600000,
      now,
    ),
    ...Array.from(
      new Set(
        p.bindings
          .filter((b) => b.kind === "group" || b.kind === "contact")
          .map((b) => b.id),
      ),
    ).map((chatId) =>
      env.DB.prepare(
        "INSERT INTO group_action_targets(action_id,chat_id) VALUES(?,?)",
      ).bind(id, chatId),
    ),
  ]);
  return getGroupAction(env, id);
}
async function preflight(env: Env, p: GroupPrivate, provider: GroupProvider) {
  if (p.operation.operation === "accept_invite") {
    const m = await provider.invitationMetadata(String(p.operation.inviteURL));
    if (
      m.phone !== p.acceptedGroup ||
      (m.subject ?? "Grupo sem nome") !== p.inviteTarget?.name
    )
      throw new AppError("group_binding_changed", 409);
  }
  for (const b of p.bindings) {
    const current = await binding(env, b.kind, b.id, b.chatId);
    if ((await hashEnvelope(current)) !== (await hashEnvelope(b)))
      throw new AppError("group_binding_changed", 409);
  }
  const primary = p.bindings.find(
    (b) => b.kind === "group" && b.id === p.operation.chatId,
  );
  if (primary) {
    const m = await provider.metadata(primary.externalId, "light");
    if (m.phone !== primary.externalId)
      throw new AppError("group_binding_changed", 409);
    for (const b of p.bindings.filter((b) => b.kind === "member"))
      if (!m.participants.some((member) => member.phone === b.externalId))
        throw new AppError("member_no_longer_present", 409);
    if (p.operation.operation === "mention_groups") {
      if (!m.communityId)
        throw new AppError("groups_must_share_community", 409);
      for (const b of p.bindings.filter(
        (b) => b.kind === "group" && b.id !== primary.id,
      )) {
        const other = await provider.metadata(b.externalId, "light");
        if (other.communityId !== m.communityId)
          throw new AppError("groups_must_share_community", 409);
      }
    }
  }
}
export async function getGroupAction(env: Env, id: string) {
  const a = await actionRow(env, id);
  return {
    id: a.id,
    status: a.status === "attempting" ? "uncertain" : a.status,
    envelope:
      a.envelope_json === "{}"
        ? null
        : (JSON.parse(a.envelope_json) as GroupEnvelope),
    redacted: a.envelope_json === "{}",
    hash: a.hash,
    expiresAt: a.expires_at,
    error: a.last_error,
    evidence: ["accepted", "rejected"].includes(a.status)
      ? "provider_ack"
      : undefined,
    result: a.result_json
      ? (JSON.parse(a.result_json) as {
          partial?: boolean;
          notAddedCount?: number;
          chat?: ReturnType<typeof chatView>;
          localReferencePending?: boolean;
          notAdded?: { id: string; name: string }[];
          unmappedNotAdded?: number;
        })
      : null,
    confirmationMode: groupConfirmationMode(
      a.envelope_json === "{}" ? {} : JSON.parse(a.envelope_json).operation,
    ),
    confirmationUrl:
      groupConfirmationMode(
        a.envelope_json === "{}" ? {} : JSON.parse(a.envelope_json).operation,
      ) === "page"
        ? `${env.PUBLIC_ORIGIN}/confirm/group/${encodeURIComponent(a.id)}`
        : undefined,
    preview: readableConfirmation(
      "group",
      a.envelope_json === "{}" ? {} : JSON.parse(a.envelope_json),
    ),
  };
}
export async function approveGroupAction(
  env: Env,
  id: string,
  proof: {
    sub: string;
    epoch: string;
    purpose: string;
    resourceId: string;
    envelopeHash: string;
  },
) {
  const a = await actionRow(env, id);
  if (
    proof.sub !== env.OWNER_SUB ||
    proof.epoch !== a.epoch ||
    proof.purpose !== "group" ||
    proof.resourceId !== id ||
    proof.envelopeHash !== a.hash
  )
    throw new AppError("approval_mismatch", 403);
  if (a.expires_at <= Date.now() || a.envelope_json === "{}")
    throw new AppError("action_expired", 409);
  const r = await env.DB.prepare(
    "UPDATE group_actions SET status='approved',approval_channel='page',approved_at=?,version=version+1 WHERE id=? AND status='proposed' AND version=? AND hash=? AND envelope_json=? AND private_json=? AND epoch=? AND generation=? AND expires_at>?",
  )
    .bind(
      Date.now(),
      id,
      a.version,
      a.hash,
      a.envelope_json,
      a.private_json,
      a.epoch,
      a.generation,
      Date.now(),
    )
    .run();
  if (r.meta.changes !== 1) throw new AppError("action_not_proposed", 409);
}
export async function cancelGroupAction(env: Env, id: string) {
  const a = await actionRow(env, id);
  await env.DB.prepare(
    "UPDATE group_actions SET status='cancelled',version=version+1 WHERE id=? AND epoch=? AND generation=? AND status IN ('proposed','approved')",
  )
    .bind(id, a.epoch, a.generation)
    .run();
}
function mentionText(p: GroupPrivate) {
  let text = String(p.operation.text);
  const kind = p.operation.operation === "mention_groups" ? "group" : "member",
    targets = p.bindings.filter(
      (b) => b.kind === kind && b.id !== p.operation.chatId,
    );
  for (const b of targets) {
    const marker = `@{${b.id}}`;
    if (!text.includes(marker)) throw new AppError("mention_marker_required");
    text = text.split(marker).join(`@${b.externalId}`);
  }
  if (/@\{[^}]+\}/.test(text)) throw new AppError("unknown_mention_marker");
  return text;
}
function mutation(p: GroupPrivate, bytes?: Uint8Array): ZapiGroupMutation {
  const o = p.operation as Operation,
    groupId =
      p.bindings.find((b) => b.kind === "group" && b.id === o.chatId)
        ?.externalId ?? "",
    phones = p.bindings
      .filter((b) => b.kind === "contact" || b.kind === "member")
      .map((b) => phone(b.externalId)),
    operation = o.operation;
  switch (operation) {
    case "create":
      return {
        operation,
        groupName: String(o.name),
        phones,
        autoInvite: o.autoInvite as boolean,
      };
    case "name":
      return { operation, groupId, groupName: String(o.name) };
    case "photo":
      return {
        operation,
        groupId,
        bytes: bytes!,
        mime: p.media!.mime as "image/png",
      };
    case "add_participants":
      return {
        operation,
        groupId,
        phones,
        autoInvite: o.autoInvite as boolean,
      };
    case "remove_participants":
    case "approve_participants":
    case "reject_participants":
    case "promote_admins":
    case "demote_admins":
      return { operation, groupId, phones };
    case "leave":
    case "reset_invite":
    case "chat_clear":
    case "chat_delete":
      return { operation, groupId };
    case "settings":
      return {
        operation,
        groupId,
        adminOnlyMessage: o.adminOnlyMessage as boolean,
        adminOnlySettings: o.adminOnlySettings as boolean,
        requireAdminApproval: o.requireAdminApproval as boolean,
        adminOnlyAddMember: o.adminOnlyAddMember as boolean,
      };
    case "description":
      return { operation, groupId, groupDescription: String(o.description) };
    case "accept_invite":
      return { operation, url: String(o.inviteURL) };
    case "mention_members":
      return {
        operation,
        groupId,
        message: mentionText(p),
        mentioned: phones,
        ...(o.delayMessage === undefined
          ? {}
          : { delayMessage: Number(o.delayMessage) }),
      };
    case "mention_groups":
      return {
        operation,
        groupId,
        message: mentionText(p),
        groupMentioned: p.bindings
          .filter((b) => b.kind === "group" && b.id !== o.chatId)
          .map((b) => ({ phone: b.externalId, subject: b.name })),
        ...(o.delayMessage === undefined
          ? {}
          : { delayMessage: Number(o.delayMessage) }),
      };
    case "mention_all":
      return {
        operation,
        groupId,
        message: String(o.text),
        ...(o.delayMessage === undefined
          ? {}
          : { delayMessage: Number(o.delayMessage) }),
      };
    case "chat_read":
    case "chat_archive":
    case "chat_pin":
    case "chat_mute":
      return { operation, groupId, enabled: o.enabled as boolean };
    case "chat_expiration":
      return { operation, groupId, chatExpiration: o.chatExpiration as "OFF" };
    case "link_groups":
    case "unlink_groups":
      return {
        operation,
        communityId: p.bindings.find((b) => b.kind === "community")!.externalId,
        groupsPhones: p.bindings
          .filter((b) => b.kind === "group")
          .map((b) => b.externalId),
      };
    default:
      throw new AppError("unsupported_group_operation");
  }
}
export async function executeGroupAction(
  env: Env,
  id: string,
  provider: GroupProvider = defaultProvider(env),
  confirmation?: ChatConfirmation,
) {
  let a = await actionRow(env, id);
  if (confirmation !== undefined) {
    if (confirmation.hash !== a.hash)
      throw new AppError("confirmation_mismatch", 403);
    if (["proposed", "approved"].includes(a.status))
      assertChatConfirmation(
        confirmation,
        a.hash,
        groupConfirmationMode(JSON.parse(a.envelope_json).operation),
      );
  }
  if (a.status === "proposed" && confirmation !== undefined) {
    if (a.expires_at <= Date.now()) throw new AppError("action_expired", 409);
    await env.DB.prepare(
      "UPDATE group_actions SET status='approved',approval_channel='chat_client',approved_at=?,version=version+1 WHERE id=? AND epoch=? AND generation=? AND status='proposed' AND hash=? AND version=? AND expires_at>?",
    )
      .bind(
        Date.now(),
        id,
        a.epoch,
        a.generation,
        a.hash,
        a.version,
        Date.now(),
      )
      .run();
    a = await actionRow(env, id);
  }
  if (a.status === "accepted" && a.ack_json) {
    await materialize(env, a);
    return getGroupAction(env, id);
  }
  if (!["proposed", "approved"].includes(a.status))
    return getGroupAction(env, id);
  if (a.expires_at <= Date.now() || a.envelope_json === "{}")
    throw new AppError("action_expired", 409);
  if (a.status !== "approved") throw new AppError("action_not_approved", 403);
  const p = JSON.parse(a.private_json) as GroupPrivate;
  let bytes: Uint8Array | undefined;
  if (p.media) {
    const m = await readMedia(env, p.media.id);
    if (m.metadata.sha256 !== p.media.hash)
      throw new AppError("media_changed", 409);
    bytes = m.bytes;
  }
  await preflight(env, p, provider);
  const dto = mutation(p, bytes);
  validateGroupMutation(dto);
  await connected(env, provider);
  assertActive(env);
  const claimed = await env.DB.prepare(
    `UPDATE group_actions SET status='attempting',attempted_at=?,version=version+1 WHERE id=? AND epoch=? AND generation=? AND status='approved' AND version=? AND expires_at>? AND hash=? AND envelope_json=? AND private_json=? AND NOT EXISTS(SELECT 1 FROM json_each(?) b WHERE CASE json_extract(b.value,'$.kind') WHEN 'group' THEN NOT EXISTS(SELECT 1 FROM chats c WHERE c.id=json_extract(b.value,'$.id') AND c.kind='group' AND c.external_id=json_extract(b.value,'$.externalId') AND c.name=json_extract(b.value,'$.name') AND c.epoch=group_actions.epoch AND c.generation=group_actions.generation) WHEN 'contact' THEN NOT EXISTS(SELECT 1 FROM chats c WHERE c.id=json_extract(b.value,'$.id') AND c.kind='individual' AND c.external_id=json_extract(b.value,'$.externalId') AND c.name=json_extract(b.value,'$.name') AND c.epoch=group_actions.epoch AND c.generation=group_actions.generation) WHEN 'member' THEN NOT EXISTS(SELECT 1 FROM group_member_refs r WHERE r.id=json_extract(b.value,'$.id') AND r.chat_id=json_extract(b.value,'$.chatId') AND r.external_id=json_extract(b.value,'$.externalId') AND r.name=json_extract(b.value,'$.name') AND r.epoch=group_actions.epoch AND r.generation=group_actions.generation) WHEN 'community' THEN NOT EXISTS(SELECT 1 FROM group_community_refs r WHERE r.id=json_extract(b.value,'$.id') AND r.external_id=json_extract(b.value,'$.externalId') AND r.name=json_extract(b.value,'$.name') AND r.epoch=group_actions.epoch AND r.generation=group_actions.generation) ELSE 1 END) AND (? IS NULL OR EXISTS(SELECT 1 FROM media m LEFT JOIN messages x ON x.id=m.message_id WHERE m.id=? AND m.epoch=group_actions.epoch AND m.generation=group_actions.generation AND m.sha256=? AND m.version=? AND m.object_key=? AND m.message_id IS ? AND m.mime=? AND m.kind='image' AND m.state='ready' AND m.deleted_at IS NULL AND (m.message_id IS NULL OR (x.deleted_at IS NULL AND x.version=m.message_version AND m.message_version=?))))`,
  )
    .bind(
      Date.now(),
      id,
      a.epoch,
      a.generation,
      a.version,
      Date.now(),
      a.hash,
      a.envelope_json,
      a.private_json,
      JSON.stringify(p.bindings),
      p.media?.id ?? null,
      p.media?.id ?? null,
      p.media?.hash ?? null,
      p.media?.version ?? null,
      p.media?.objectKey ?? null,
      p.media?.messageId ?? null,
      p.media?.mime ?? null,
      p.media?.messageVersion ?? null,
    )
    .run();
  if (claimed.meta.changes !== 1) {
    const latest = await actionRow(env, id);
    if (latest.status === "approved")
      throw new AppError("group_binding_changed", 409);
    return getGroupAction(env, id);
  }
  let result: GroupMutationResult;
  try {
    result = await provider.mutate(dto);
  } catch {
    await env.DB.prepare(
      "UPDATE group_actions SET status='uncertain',last_error='provider_result_unknown' WHERE id=? AND status='attempting'",
    )
      .bind(id)
      .run();
    return getGroupAction(env, id);
  }
  // Persist the ack before local reference materialization. Raw links are discarded.
  const notAdded = (result.notAdded ?? []).flatMap((address) => {
    const b = p.bindings.find(
      (b) => b.kind === "contact" && b.externalId === address,
    );
    return b ? [{ id: b.id, name: b.name }] : [];
  });
  const publicResult = {
    partial: result.partial ?? false,
    notAddedCount: result.notAdded?.length ?? 0,
    notAdded,
    unmappedNotAdded: (result.notAdded?.length ?? 0) - notAdded.length,
  };
  const ack = {
    ...publicResult,
    groupId: result.groupId ?? p.acceptedGroup ?? null,
    needsReference: ["create", "accept_invite"].includes(
      String(p.operation.operation),
    ),
    name: p.operation.name ?? p.inviteTarget?.name ?? null,
  };
  await env.DB.prepare(
    "UPDATE group_actions SET status=?,ack_json=?,result_json=?,last_error=NULL WHERE id=? AND status='attempting' AND private_json<>'{}'",
  )
    .bind(result.outcome, JSON.stringify(ack), JSON.stringify(publicResult), id)
    .run();
  await materialize(env, await actionRow(env, id));
  return getGroupAction(env, id);
}
async function materialize(env: Env, a: GroupActionRow) {
  if (
    a.status !== "accepted" ||
    !a.ack_json ||
    a.epoch !== env.INSTALLATION_EPOCH ||
    a.generation !== env.CONNECTION_GENERATION
  )
    return;
  const ack = JSON.parse(a.ack_json) as {
    groupId?: string;
    name?: string;
    needsReference?: boolean;
    partial: boolean;
    notAddedCount: number;
    notAdded?: { id: string; name: string }[];
    unmappedNotAdded?: number;
  };
  const p =
    a.private_json === "{}"
      ? null
      : (JSON.parse(a.private_json) as GroupPrivate);
  if (
    !ack.groupId ||
    (!ack.needsReference &&
      !["create", "accept_invite"].includes(String(p?.operation.operation)))
  )
    return;
  try {
    const now = Date.now(),
      id = await sha256(
        JSON.stringify(["group-created", a.epoch, a.generation, ack.groupId]),
      ),
      result = {
        partial: ack.partial,
        notAddedCount: ack.notAddedCount,
        notAdded: ack.notAdded ?? [],
        unmappedNotAdded: ack.unmappedNotAdded ?? 0,
      };
    // Creation, resulting-chat target and public result share one guarded transaction.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at) SELECT ?,?,?,?,'group',?,0,?,? WHERE EXISTS(SELECT 1 FROM group_actions WHERE id=? AND status='accepted' AND ack_json=?) ON CONFLICT(epoch,generation,external_id) DO NOTHING",
      ).bind(
        id,
        a.epoch,
        a.generation,
        ack.groupId,
        ack.name ??
          p?.operation.name ??
          p?.inviteTarget?.name ??
          "Grupo por convite",
        now,
        now,
        a.id,
        a.ack_json,
      ),
      env.DB.prepare(
        "INSERT INTO group_action_targets(action_id,chat_id) SELECT ?,c.id FROM chats c WHERE c.epoch=? AND c.generation=? AND c.external_id=? AND c.kind='group' AND EXISTS(SELECT 1 FROM group_actions WHERE id=? AND status='accepted' AND ack_json=?) ON CONFLICT(action_id,chat_id) DO NOTHING",
      ).bind(a.id, a.epoch, a.generation, ack.groupId, a.id, a.ack_json),
      env.DB.prepare(
        "UPDATE group_actions SET result_json=(SELECT json_set(?,'$.chat',json_object('id',c.id,'kind',c.kind,'name',c.name,'captureEnabled',json(CASE c.capture_enabled WHEN 1 THEN 'true' ELSE 'false' END))) FROM chats c WHERE c.epoch=? AND c.generation=? AND c.external_id=? AND c.kind='group'),ack_json=NULL WHERE id=? AND status='accepted' AND ack_json=? AND EXISTS(SELECT 1 FROM chats c WHERE c.epoch=? AND c.generation=? AND c.external_id=? AND c.kind='group')",
      ).bind(
        JSON.stringify(result),
        a.epoch,
        a.generation,
        ack.groupId,
        a.id,
        a.ack_json,
        a.epoch,
        a.generation,
        ack.groupId,
      ),
    ]);
  } catch {
    await env.DB.prepare(
      "UPDATE group_actions SET result_json=? WHERE id=? AND status='accepted' AND ack_json=?",
    )
      .bind(
        JSON.stringify({
          partial: ack.partial,
          notAddedCount: ack.notAddedCount,
          notAdded: ack.notAdded ?? [],
          unmappedNotAdded: ack.unmappedNotAdded ?? 0,
          localReferencePending: true,
        }),
        a.id,
        a.ack_json,
      )
      .run();
  }
}
/** Internal SQL guard comes only from the policy service, never tool arguments. */
export function invalidateGroupActionsStatements(
  env: Env,
  chatId: string,
  guard?: { sql: string; binds: unknown[] },
) {
  const f = currentFence(env),
    g = guard ? ` AND (${guard.sql})` : "",
    values = guard?.binds ?? [];
  return [
    env.DB.prepare(
      "UPDATE group_actions SET status=CASE WHEN status IN ('proposed','approved') THEN 'cancelled' WHEN status='attempting' THEN 'uncertain' ELSE status END,envelope_json='{}',private_json='{}',ack_json=NULL,result_json=NULL,version=version+1 WHERE epoch=? AND generation=? AND id IN (SELECT action_id FROM group_action_targets WHERE chat_id=?)" +
        g,
    ).bind(f.epoch, f.generation, chatId, ...values),
    env.DB.prepare(
      "DELETE FROM group_member_refs WHERE epoch=? AND generation=? AND chat_id=?" +
        g,
    ).bind(f.epoch, f.generation, chatId, ...values),
    env.DB.prepare(
      "DELETE FROM group_snapshot_scopes WHERE epoch=? AND generation=? AND scope=?" +
        g,
    ).bind(f.epoch, f.generation, `group:${chatId}`, ...values),
  ];
}
export async function cleanupGroupActions(env: Env, limit = 50) {
  const n = boundedInt(limit, 50, 100);
  const rows = await env.DB.prepare(
    "SELECT * FROM group_actions WHERE (status IN ('cancelled','expired') OR expires_at<=?) AND (envelope_json<>'{}' OR (status='accepted' AND ack_json IS NOT NULL AND json_extract(result_json,'$.localReferencePending')=1)) ORDER BY CASE WHEN envelope_json<>'{}' THEN 0 ELSE 1 END,expires_at LIMIT ?",
  )
    .bind(Date.now(), n)
    .all<GroupActionRow>();
  let cleaned = 0;
  for (const row of rows.results) {
    const current =
      row.epoch === env.INSTALLATION_EPOCH &&
      row.generation === env.CONNECTION_GENERATION;
    if (current && row.status === "accepted" && row.ack_json)
      await materialize(env, row);
    const latest = await env.DB.prepare(
      "SELECT ack_json,result_json FROM group_actions WHERE id=?",
    )
      .bind(row.id)
      .first<{ ack_json: string | null; result_json: string | null }>();
    const preserveAck =
      current &&
      latest?.result_json &&
      JSON.parse(latest.result_json).localReferencePending === true
        ? latest.ack_json
        : null;
    const r = await env.DB.prepare(
      "UPDATE group_actions SET status=CASE WHEN status IN ('proposed','approved') THEN 'expired' WHEN status='attempting' THEN 'uncertain' ELSE status END,envelope_json='{}',private_json='{}',ack_json=?,version=version+1 WHERE id=? AND (status IN ('cancelled','expired') OR expires_at<=?) AND (envelope_json<>'{}' OR ack_json IS NOT ?)",
    )
      .bind(preserveAck, row.id, Date.now(), preserveAck)
      .run();
    cleaned += r.meta.changes;
  }
  return cleaned;
}
interface PageInput {
  limit?: number;
  cursor?: string;
}
async function projectionPage<T>(
  env: Env,
  scope: string,
  items: T[],
  input: PageInput,
  key?: string,
) {
  const limit = boundedInt(input.limit, 50, 50),
    f = currentFence(env),
    hash = key ? await keyed(key, items) : await hashEnvelope(items);
  let offset = 0;
  if (input.cursor) {
    const cursor = decodeCursor<{
      epoch: string;
      generation: string;
      scope: string;
      hash: string;
      offset: number;
    }>(input.cursor);
    if (
      cursor.epoch !== f.epoch ||
      cursor.generation !== f.generation ||
      cursor.scope !== scope ||
      cursor.hash !== hash ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > items.length
    )
      throw new AppError("invalid_cursor");
    offset = cursor.offset;
  }
  const out = items.slice(offset, offset + limit),
    complete = offset + out.length >= items.length;
  return bounded({
    items: out,
    total: items.length,
    complete,
    ...(complete
      ? {}
      : {
          nextCursor: encodeCursor({
            ...f,
            scope,
            hash,
            offset: offset + out.length,
          }),
        }),
  });
}
async function keyed(key: string, value: unknown) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        k,
        new TextEncoder().encode(await hashEnvelope(value)),
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
async function scopeKey(env: Env, scope: string) {
  const f = currentFence(env);
  await env.DB.prepare(
    "INSERT INTO group_snapshot_scopes(scope,epoch,generation,secret,created_at) VALUES(?,?,?,?,?) ON CONFLICT(scope,epoch,generation) DO NOTHING",
  )
    .bind(scope, f.epoch, f.generation, secretKey(), Date.now())
    .run();
  const r = await env.DB.prepare(
    "SELECT secret FROM group_snapshot_scopes WHERE scope=? AND epoch=? AND generation=?",
  )
    .bind(scope, f.epoch, f.generation)
    .first<{ secret: string }>();
  if (!r) throw new AppError("snapshot_scope_unavailable", 409);
  return r.secret;
}
function metadataView(m: GroupMetadata) {
  return {
    name: m.subject ?? "Grupo sem nome",
    description: m.description ?? null,
    adminOnlyMessage: m.adminOnlyMessage ?? null,
    adminOnlySettings: m.adminOnlySettings ?? null,
    requireAdminApproval: m.requireAdminApproval ?? null,
    adminOnlyAddMember: m.adminOnlyAddMember ?? null,
    isGroupAnnouncement: m.isGroupAnnouncement ?? null,
    growthLocked: m.growthLocked ?? null,
    growthLockExpiration: m.growthLockExpiration ?? null,
    creation: m.creation ?? null,
    subjectTime: m.subjectTime ?? null,
    contactsCount: m.contactsCount ?? null,
    participantsCount: m.participantsCount ?? m.participants.length,
    pendingRequesters: "not_documented",
    permissions: "provider_authority",
  };
}
export async function readGroup(
  env: Env,
  input: {
    chatId: string;
    variant?: "full" | "light";
    limit?: number;
    cursor?: string;
  },
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  if (input.variant !== undefined && !["full", "light"].includes(input.variant))
    throw new AppError("invalid_group_variant");
  const f = currentFence(env),
    c = await group(env, input.chatId);
  await connected(env, provider);
  const m = await provider.metadata(c.external_id, input.variant ?? "light");
  assertFence(env, f);
  if (m.phone !== c.external_id)
    throw new AppError("group_binding_changed", 409);
  const key = await scopeKey(env, `group:${c.id}`),
    page = await projectionPage(
      env,
      `group:${c.id}:${input.variant ?? "light"}:${await hashEnvelope(metadataView(m))}`,
      m.participants,
      input,
      key,
    );
  const additional = m.participants.filter(
      (p) => p.phone === m.owner || p.phone === m.subjectOwner,
    ),
    selected = Array.from(
      new Map([...page.items, ...additional].map((p) => [p.phone, p])).values(),
    ),
    records: { id: string; name: string; phone: string }[] = [];
  for (const p of selected)
    records.push({
      id: "gm_" + (await keyed(key, p.phone)),
      name: p.name ?? p.short ?? "Participante sem nome",
      phone: p.phone,
    });
  if (records.length)
    await env.DB.batch(
      records.map((r) =>
        env.DB.prepare(
          "INSERT INTO group_member_refs(id,epoch,generation,chat_id,external_id,name,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(epoch,generation,chat_id,external_id) DO UPDATE SET name=excluded.name",
        ).bind(r.id, f.epoch, f.generation, c.id, r.phone, r.name, Date.now()),
      ),
    );
  const items = page.items.map((p) => {
      const r = records.find((r) => r.phone === p.phone)!;
      return {
        id: r.id,
        name: r.name,
        isAdmin: p.isAdmin ?? null,
        isSuperAdmin: p.isSuperAdmin ?? null,
        addressSupport: p.phone.endsWith("@lid")
          ? "unsupported_lid"
          : /^\d{8,20}$/.test(p.phone)
            ? "phone"
            : "unsupported",
      };
    }),
    owner = records.find((r) => r.phone === m.owner),
    subjectOwner = records.find((r) => r.phone === m.subjectOwner),
    community = m.communityId
      ? await communityReference(env, m.communityId, "Comunidade do grupo")
      : null;
  return bounded({
    chat: chatView(c),
    metadata: {
      ...metadataView(m),
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerKnown: !!owner,
      subjectOwner: subjectOwner
        ? { id: subjectOwner.id, name: subjectOwner.name }
        : null,
      community,
    },
    ...page,
    items,
  });
}
export async function readGroupInviteMetadata(
  env: Env,
  input: { invite: string; limit?: number; cursor?: string },
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const f = currentFence(env),
    invite = parseGroupInvite(input.invite);
  await connected(env, provider);
  const m = await provider.invitationMetadata(invite);
  assertFence(env, f);
  const items = m.participants.map((p) => ({
    name: p.name ?? p.short ?? "Participante sem nome",
    isAdmin: p.isAdmin ?? null,
    isSuperAdmin: p.isSuperAdmin ?? null,
  }));
  return bounded({
    metadata: metadataView(m),
    ...(await projectionPage(
      env,
      `invite:${await sha256(invite)}`,
      items,
      input,
      await scopeKey(env, `invite:${await sha256(invite)}`),
    )),
  });
}
async function ensureGroups(
  env: Env,
  rows: { phone: string; name?: string }[],
) {
  const f = currentFence(env);
  if (rows.length > 50) throw new AppError("group_page_too_large");
  for (const r of rows)
    if (!groupAddress(r.phone)) throw new AppError("invalid_group_address");
  if (!rows.length) return [];
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        "INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at) VALUES(?,?,?,?,'group',?,0,?,?) ON CONFLICT(epoch,generation,external_id) DO NOTHING",
      ).bind(
        crypto.randomUUID(),
        f.epoch,
        f.generation,
        r.phone,
        r.name && r.name !== r.phone ? r.name : "Grupo sem nome",
        Date.now(),
        Date.now(),
      ),
    ),
  );
  const found = await env.DB.prepare(
    "SELECT * FROM chats WHERE epoch=? AND generation=? AND kind='group' AND external_id IN (SELECT value FROM json_each(?))",
  )
    .bind(f.epoch, f.generation, JSON.stringify(rows.map((r) => r.phone)))
    .all<ChatRow>();
  return rows.map((r) => {
    const c = found.results.find((c) => c.external_id === r.phone);
    if (!c) throw new AppError("group_reference_unavailable", 409);
    return chatView(c);
  });
}
export async function listGroupChats(
  env: Env,
  input: { page?: number; pageSize?: number } = {},
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const f = currentFence(env),
    page = boundedInt(input.page, 1, 100000),
    size = boundedInt(input.pageSize, 50, 50);
  await connected(env, provider);
  const raw = await provider.listChats(page, size);
  assertFence(env, f);
  const groups = raw.filter((c) => c.isGroup === true),
    chats = await ensureGroups(env, groups),
    items = groups.map((c, i) => ({
      ...chats[i]!,
      unread: c.unread ?? null,
      archived: c.archived ?? null,
      pinned: c.pinned ?? null,
      isMuted: c.isMuted ?? null,
      messagesUnread: c.messagesUnread ?? null,
    }));
  return bounded({
    items,
    complete: raw.length < size,
    ...(raw.length < size ? {} : { nextPage: page + 1 }),
    sourcePage: page,
    rawCount: raw.length,
  });
}
export async function readGroupChat(
  env: Env,
  chatId: string,
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const f = currentFence(env),
    c = await group(env, chatId);
  await connected(env, provider);
  const m = await provider.chatMetadata(c.external_id);
  assertFence(env, f);
  if (m.phone !== c.external_id || m.isGroup === false)
    throw new AppError("group_binding_changed", 409);
  return bounded({
    chat: chatView(c),
    unread: m.unread ?? null,
    archived: m.archived ?? null,
    pinned: m.pinned ?? null,
    isMuted: m.isMuted ?? null,
    messagesUnread: m.messagesUnread ?? null,
    lastMessageTime: m.lastMessageTime ?? null,
    isGroupAnnouncement: m.isGroupAnnouncement ?? null,
  });
}
async function communityReference(env: Env, id: string, name: string) {
  const f = currentFence(env);
  await env.DB.prepare(
    "INSERT INTO group_community_refs(id,epoch,generation,external_id,name,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(epoch,generation,external_id) DO NOTHING",
  )
    .bind(crypto.randomUUID(), f.epoch, f.generation, id, name, Date.now())
    .run();
  const c = await env.DB.prepare(
    "SELECT id,name FROM group_community_refs WHERE external_id=? AND epoch=? AND generation=?",
  )
    .bind(id, f.epoch, f.generation)
    .first<{ id: string; name: string }>();
  if (!c) throw new AppError("community_reference_unavailable", 409);
  return c;
}
export async function listCommunities(
  env: Env,
  input: { page?: number; pageSize?: number } = {},
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const f = currentFence(env),
    page = boundedInt(input.page, 1, 100000),
    size = boundedInt(input.pageSize, 50, 50);
  await connected(env, provider);
  const raw = await provider.listCommunities(page, size);
  assertFence(env, f);
  const items = [];
  for (const c of raw)
    items.push(
      await communityReference(env, c.id, c.name ?? "Comunidade sem nome"),
    );
  return bounded({
    items,
    complete: raw.length < size,
    ...(raw.length < size ? {} : { nextPage: page + 1 }),
  });
}
export async function readCommunity(
  env: Env,
  input: { communityId: string; limit?: number; cursor?: string } | string,
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const options = typeof input === "string" ? { communityId: input } : input,
    f = currentFence(env),
    c = await binding(env, "community", options.communityId);
  await connected(env, provider);
  const m = await provider.communityMetadata(c.externalId);
  assertFence(env, f);
  if (m.id !== c.externalId) throw new AppError("group_binding_changed", 409);
  const page = await projectionPage(
      env,
      `community:${c.id}`,
      m.subGroups,
      options,
      await scopeKey(env, `community:${c.id}`),
    ),
    groups = await ensureGroups(env, page.items),
    items = groups.map((g, i) => ({
      ...g,
      isGroupAnnouncement: page.items[i]!.isGroupAnnouncement ?? null,
    }));
  return bounded({
    community: { id: c.id, name: c.name, description: m.description ?? null },
    ...page,
    items,
  });
}
/** Backend-only accessor. The caller must authenticate Access; never return this through MCP. */
export async function getGroupInvite(
  env: Env,
  chatId: string,
  provider: GroupProvider = defaultProvider(env),
) {
  assertActive(env);
  const f = currentFence(env),
    c = await group(env, chatId);
  await connected(env, provider);
  const invite = parseGroupInvite(await provider.invitationLink(c.external_id));
  assertFence(env, f);
  return invite;
}
export function getGroupCapabilities(_env?: Env) {
  return {
    documentedOperations: 35,
    groups: 22,
    chats: 9,
    communities: 4,
    actionOperations: [
      "create",
      "name",
      "photo",
      "add_participants",
      "remove_participants",
      "approve_participants",
      "reject_participants",
      "promote_admins",
      "demote_admins",
      "leave",
      "settings",
      "description",
      "reset_invite",
      "accept_invite",
      "mention_members",
      "mention_groups",
      "mention_all",
      "chat_read",
      "chat_archive",
      "chat_pin",
      "chat_mute",
      "chat_clear",
      "chat_delete",
      "chat_expiration",
      "link_groups",
      "unlink_groups",
    ],
    confirmation:
      "server risk policy: chat client attestation for routine actions; Access owner page for critical actions; immutable envelope",
    limits: {
      page: 50,
      outputBytes: 32768,
      actionReferences: 50,
      photoBytes: LIMITS.mediaBytes,
    },
    evidence: "documented_contract_and_synthetic_tests",
    realInstanceValidated: false,
    pendingRequesterList: false,
    lidPhoneConversion: false,
    mentionMediaOrReply: false,
    mentionSyntax:
      "mention_members/groups: use @{internalReferenceId} for every selected target; backend resolves exact address",
    groupDelivery: "aggregate_only",
    chatExpirationInGroups: "unvalidated",
    inviteLinks: "Access page only",
    mutationResult: "provider_ack does not prove final propagation",
  };
}
