import {
  captureDiagnostics,
  captureSetting,
  type CaptureMode,
} from "./capture-policy";
import {
  assertChatConfirmation,
  policyConfirmationMode,
  type ChatConfirmation,
} from "./approval";
import {
  invalidateGroupActionsStatements,
  cleanupGroupActions,
} from "./groups";
import type { Env } from "./env";
import type { ConfirmationProof } from "./auth";
import { hashEnvelope } from "./auth";
import { AppError, assertActive, currentFence, type Fence } from "./core";
import { getChat } from "./store";
import { queryMessages, type MessageQuery } from "./capture";
import packageJson from "../package.json";

export type PolicyInput =
  | { kind: "capture"; chatId: string; enabled: boolean }
  | { kind: "retention"; days: number | null }
  | { kind: "delete"; chatId: string };
type Envelope = PolicyInput & {
  epoch: string;
  generation: string;
  previous?: number | null;
  previousCaptureMode?: CaptureMode;
  previousCaptureRevision?: number;
};
type ProposalRow = {
  id: string;
  epoch: string;
  generation: string;
  kind: PolicyInput["kind"];
  envelope_json: string;
  hash: string;
  status: "proposed" | "applied";
  expires_at: number;
};
export type PolicyProposal = {
  id: string;
  kind: PolicyInput["kind"];
  envelope: Envelope;
  hash: string;
  status: "proposed" | "applied";
  expiresAt: number;
  confirmationMode: "chat" | "page";
  confirmationUrl?: string;
};
const now = () => Date.now();
const ttl = 600_000;

function proposalView(env: Env, row: ProposalRow): PolicyProposal {
  return {
    id: row.id,
    kind: row.kind,
    envelope: JSON.parse(row.envelope_json) as Envelope,
    hash: row.hash,
    status: row.status,
    expiresAt: row.expires_at,
    confirmationMode: policyConfirmationMode(JSON.parse(row.envelope_json)),
    confirmationUrl:
      policyConfirmationMode(JSON.parse(row.envelope_json)) === "page"
        ? `${new URL(env.PUBLIC_ORIGIN).origin}/confirm/policy/${encodeURIComponent(row.id)}`
        : undefined,
  };
}
async function retentionValue(env: Env, fence: Fence): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT value_json FROM policies WHERE key='retention_days' AND epoch=?",
  )
    .bind(fence.epoch)
    .first<{ value_json: string }>();
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value_json);
    return Number.isInteger(value) &&
      typeof value === "number" &&
      value >= 1 &&
      value <= 36500
      ? value
      : null;
  } catch {
    return null;
  }
}
export async function proposalPolicy(
  env: Env,
  input: PolicyInput,
): Promise<PolicyProposal> {
  assertActive(env);
  const fence = currentFence(env);
  let envelope: Envelope;
  if (input.kind === "capture") {
    if (typeof input.enabled !== "boolean")
      throw new AppError("invalid_policy");
    const chat = await getChat(env, input.chatId, fence);
    const setting = await captureSetting(env, chat.id, fence);
    envelope = {
      kind: input.kind,
      chatId: chat.id,
      enabled: input.enabled,
      epoch: fence.epoch,
      generation: fence.generation,
      previous: chat.capture_enabled,
      previousCaptureMode: setting.mode,
      previousCaptureRevision: setting.revision,
    };
  } else if (input.kind === "delete") {
    const chat = await getChat(env, input.chatId, fence);
    envelope = {
      kind: input.kind,
      chatId: chat.id,
      epoch: fence.epoch,
      generation: fence.generation,
    };
  } else if (input.kind === "retention") {
    if (
      input.days !== null &&
      (!Number.isSafeInteger(input.days) ||
        input.days < 1 ||
        input.days > 36500)
    )
      throw new AppError("invalid_retention");
    envelope = {
      kind: input.kind,
      days: input.days,
      epoch: fence.epoch,
      generation: fence.generation,
      previous: await retentionValue(env, fence),
    };
  } else throw new AppError("invalid_policy");
  const id = crypto.randomUUID(),
    hash = await hashEnvelope(envelope),
    expires = now() + ttl;
  await env.DB.prepare(
    "INSERT INTO policy_proposals(id,epoch,generation,kind,envelope_json,hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,'proposed',?,?)",
  )
    .bind(
      id,
      fence.epoch,
      fence.generation,
      input.kind,
      JSON.stringify(envelope),
      hash,
      expires,
      now(),
    )
    .run();
  return proposalView(env, {
    id,
    epoch: fence.epoch,
    generation: fence.generation,
    kind: input.kind,
    envelope_json: JSON.stringify(envelope),
    hash,
    status: "proposed",
    expires_at: expires,
  });
}
export async function getPolicyProposal(
  env: Env,
  id: string,
): Promise<PolicyProposal> {
  const fence = currentFence(env);
  const row = await env.DB.prepare(
    "SELECT * FROM policy_proposals WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(id, fence.epoch, fence.generation)
    .first<ProposalRow>();
  if (!row) throw new AppError("proposal_not_found", 404);
  return proposalView(env, row);
}
type ChatPolicyAuthorization = {
  channel: "chat_client";
  confirmation: ChatConfirmation;
};
function checkedProof(
  env: Env,
  row: ProposalRow,
  proof: ConfirmationProof | ChatPolicyAuthorization,
): void {
  if ("channel" in proof) {
    assertChatConfirmation(
      proof.confirmation,
      row.hash,
      policyConfirmationMode(JSON.parse(row.envelope_json)),
    );
    if (
      row.status !== "proposed" ||
      row.expires_at <= now() ||
      row.epoch !== env.INSTALLATION_EPOCH ||
      row.generation !== env.CONNECTION_GENERATION
    )
      throw new AppError("confirmation_required", 403);
    return;
  }
  if (
    env.MAINTENANCE !== "false" ||
    !env.OWNER_SUB ||
    proof.sub !== env.OWNER_SUB ||
    proof.epoch !== env.INSTALLATION_EPOCH ||
    proof.resourceId !== row.id ||
    proof.envelopeHash !== row.hash ||
    proof.purpose !== (row.kind === "capture" ? "capture-policy" : row.kind) ||
    row.status !== "proposed" ||
    row.expires_at <= now()
  )
    throw new AppError("confirmation_required", 403);
}
export async function applyPolicyProposal(
  env: Env,
  id: string,
  proof: ConfirmationProof | ChatPolicyAuthorization,
): Promise<{ id: string; kind: PolicyInput["kind"]; status: "applied" }> {
  assertActive(env);
  const row = await env.DB.prepare(
    "SELECT * FROM policy_proposals WHERE id=? AND epoch=? AND generation=?",
  )
    .bind(id, env.INSTALLATION_EPOCH, env.CONNECTION_GENERATION)
    .first<ProposalRow>();
  if (!row) throw new AppError("proposal_not_found", 404);
  checkedProof(env, row, proof);
  const envelope = JSON.parse(row.envelope_json) as Envelope;
  if (
    (await hashEnvelope(envelope)) !== row.hash ||
    envelope.epoch !== env.INSTALLATION_EPOCH ||
    envelope.generation !== env.CONNECTION_GENERATION ||
    envelope.kind !== row.kind
  )
    throw new AppError("proposal_stale", 409);
  const time = now();
  // Claim and visibility changes are one D1 transaction. A stale concurrent proposal cannot claim.
  const guard =
    "EXISTS(SELECT 1 FROM policy_proposals WHERE id=? AND status='applied' AND hash=? AND epoch=? AND generation=? AND applied_at=?)";
  const bindGuard = [
    id,
    row.hash,
    env.INSTALLATION_EPOCH,
    env.CONNECTION_GENERATION,
    time,
  ] as const;
  let stateGuard = "";
  let stateArgs: (string | number | null)[] = [];
  if (envelope.kind === "capture") {
    stateGuard =
      "AND EXISTS(SELECT 1 FROM chats c JOIN capture_settings s ON s.chat_id=c.id WHERE c.id=? AND c.epoch=? AND c.generation=? AND c.capture_enabled=? AND s.mode=? AND s.revision=?)";
    stateArgs = [
      envelope.chatId,
      env.INSTALLATION_EPOCH,
      env.CONNECTION_GENERATION,
      envelope.previous ?? 0,
      envelope.previousCaptureMode ?? null,
      envelope.previousCaptureRevision ?? null,
    ];
  } else if (envelope.kind === "retention") {
    stateGuard =
      envelope.previous === null
        ? "AND NOT EXISTS(SELECT 1 FROM policies WHERE key='retention_days' AND epoch=? AND value_json<>'null')"
        : "AND EXISTS(SELECT 1 FROM policies WHERE key='retention_days' AND epoch=? AND value_json=?)";
    stateArgs =
      envelope.previous === null
        ? [env.INSTALLATION_EPOCH]
        : [env.INSTALLATION_EPOCH, JSON.stringify(envelope.previous)];
  } else {
    stateGuard =
      "AND EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=?)";
    stateArgs = [
      envelope.chatId,
      env.INSTALLATION_EPOCH,
      env.CONNECTION_GENERATION,
    ];
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE policy_proposals SET status='applied',approval_channel=?,applied_at=? WHERE id=? AND status='proposed' AND hash=? AND epoch=? AND generation=? AND expires_at>? ${stateGuard}`,
    ).bind(
      "channel" in proof ? "chat_client" : "page",
      time,
      id,
      row.hash,
      env.INSTALLATION_EPOCH,
      env.CONNECTION_GENERATION,
      time,
      ...stateArgs,
    ),
  ];
  if (envelope.kind === "capture") {
    const chat = await getChat(env, envelope.chatId, currentFence(env));
    const setting = await captureSetting(env, chat.id);
    if (
      chat.capture_enabled !== envelope.previous ||
      setting.mode !== envelope.previousCaptureMode ||
      setting.revision !== envelope.previousCaptureRevision
    )
      throw new AppError("proposal_stale", 409);
    statements.push(
      env.DB.prepare(
        `UPDATE capture_settings SET mode=?,revision=revision+1,updated_at=? WHERE chat_id=? AND mode=? AND revision=? AND ${guard}`,
      ).bind(
        envelope.enabled ? "enabled" : "disabled",
        time,
        envelope.chatId,
        envelope.previousCaptureMode,
        envelope.previousCaptureRevision,
        ...bindGuard,
      ),
    );
  } else if (envelope.kind === "retention") {
    const current = await retentionValue(env, currentFence(env));
    if (current !== envelope.previous)
      throw new AppError("proposal_stale", 409);
    statements.push(
      env.DB.prepare(
        `INSERT INTO policies(key,value_json,epoch,updated_at) SELECT 'retention_days',?,?,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,epoch=excluded.epoch,updated_at=excluded.updated_at`,
      ).bind(
        JSON.stringify(envelope.days),
        env.INSTALLATION_EPOCH,
        time,
        ...bindGuard,
      ),
    );
  } else if (envelope.kind === "delete") {
    await getChat(env, envelope.chatId, currentFence(env));
    const chat = envelope.chatId;
    statements.push(
      env.DB.prepare(
        `UPDATE tts_generations SET status='unavailable',text=NULL,voice_name=NULL,error=NULL WHERE chat_id=? AND epoch=? AND generation=? AND ${guard}`,
      ).bind(
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE capture_settings SET mode='disabled',revision=revision+1,updated_at=? WHERE chat_id=? AND ${guard}`,
      ).bind(time, chat, ...bindGuard),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE chats SET capture_discontinuous=CASE WHEN capture_enabled=1 THEN 1 ELSE capture_discontinuous END,capture_enabled=0,capture_since=NULL,updated_at=? WHERE id=? AND epoch=? AND generation=? AND ${guard}`,
      ).bind(
        time,
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE messages SET text=NULL,deleted_at=COALESCE(deleted_at,?),privacy_locked=1,unavailable_reason='deleted_local',failure=NULL WHERE chat_id=? AND epoch=? AND generation=? AND ${guard}`,
      ).bind(
        time,
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `DELETE FROM message_versions WHERE message_id IN(SELECT id FROM messages WHERE chat_id=? AND epoch=? AND generation=?) AND ${guard}`,
      ).bind(
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE media SET state='deleted',deleted_at=COALESCE(deleted_at,?),source_url=NULL,filename=NULL,sha256=NULL,size=NULL WHERE chat_id=? AND epoch=? AND generation=? AND ${guard}`,
      ).bind(
        time,
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE media_jobs SET status='cancelled',lease_until=NULL,error=NULL WHERE media_id IN(SELECT id FROM media WHERE chat_id=? AND epoch=? AND generation=?) AND ${guard}`,
      ).bind(
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE media_derivatives SET state='deleted',text=NULL WHERE media_id IN(SELECT id FROM media WHERE chat_id=? AND epoch=? AND generation=?) AND ${guard}`,
      ).bind(
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE actions SET status=CASE WHEN status IN('proposed','approved') THEN 'cancelled' ELSE status END,envelope_json='{}',last_error=NULL WHERE chat_id=? AND epoch=? AND generation=? AND ${guard}`,
      ).bind(
        chat,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        ...bindGuard,
      ),
    );
    statements.push(
      ...invalidateGroupActionsStatements(env, chat, {
        sql: guard,
        binds: [...bindGuard],
      }),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE policy_proposals SET status='applied',applied_at=? WHERE id<>? AND kind IN('capture','delete') AND status='proposed' AND epoch=? AND generation=? AND json_extract(envelope_json,'$.chatId')=? AND ${guard}`,
      ).bind(
        time,
        id,
        env.INSTALLATION_EPOCH,
        env.CONNECTION_GENERATION,
        chat,
        ...bindGuard,
      ),
    );
  }
  const result = await env.DB.batch(statements);
  if (!result[0]?.meta.changes) throw new AppError("proposal_stale", 409);
  return { id, kind: row.kind, status: "applied" };
}

export async function exportConversation(env: Env, query: MessageQuery) {
  return queryMessages(env, query);
}

async function redactMessages(
  env: Env,
  ids: string[],
  time: number,
): Promise<void> {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE messages SET text=NULL,deleted_at=COALESCE(deleted_at,?),privacy_locked=1,unavailable_reason='retention',failure=NULL WHERE id IN(${marks})`,
    ).bind(time, ...ids),
    env.DB.prepare(
      `DELETE FROM message_versions WHERE message_id IN(${marks})`,
    ).bind(...ids),
    env.DB.prepare(
      `UPDATE media SET state='deleted',deleted_at=COALESCE(deleted_at,?),source_url=NULL,filename=NULL,sha256=NULL,size=NULL WHERE message_id IN(${marks})`,
    ).bind(time, ...ids),
    env.DB.prepare(
      `UPDATE media_jobs SET status='cancelled',lease_until=NULL,error=NULL WHERE media_id IN(SELECT id FROM media WHERE message_id IN(${marks}))`,
    ).bind(...ids),
    env.DB.prepare(
      `UPDATE media_derivatives SET state='deleted',text=NULL WHERE media_id IN(SELECT id FROM media WHERE message_id IN(${marks}))`,
    ).bind(...ids),
  ]);
}
export async function cleanup(env: Env): Promise<{
  retainedMessages: number;
  objectsDeleted: number;
  noncesDeleted: number;
  proposalsDeleted: number;
  jobsDeleted: number;
  pendingStatusesDeleted: number;
  actionPayloadsCleared: number;
  groupPayloadsCleared: number;
}> {
  const fence = currentFence(env),
    time = now();
  let budget = 50;
  const days = await retentionValue(env, fence);
  let retainedMessages = 0,
    objectsDeleted = 0,
    noncesDeleted = 0,
    proposalsDeleted = 0,
    jobsDeleted = 0,
    pendingStatusesDeleted = 0,
    actionPayloadsCleared = 0,
    groupPayloadsCleared = 0;
  if (days !== null) {
    const expired = await env.DB.prepare(
      "SELECT id FROM messages WHERE epoch=? AND generation=? AND deleted_at IS NULL AND timestamp<? ORDER BY timestamp LIMIT ?",
    )
      .bind(
        fence.epoch,
        fence.generation,
        time - days * 86_400_000,
        Math.min(budget, 25),
      )
      .all<{ id: string }>();
    const ids = expired.results.map((x) => x.id);
    await redactMessages(env, ids, time);
    retainedMessages = ids.length;
    budget -= ids.length;
  }
  // Object keys are immutable and private; D1 tombstone precedes each R2 operation.
  const objects = budget
    ? await env.DB.prepare(
        `SELECT 'media' source,m.id,m.object_key FROM media m WHERE m.deleted_at IS NOT NULL AND m.object_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM media live WHERE live.object_key=m.object_key AND live.deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM media_derivatives live WHERE live.object_key=m.object_key AND live.state<>'deleted') UNION ALL SELECT 'derivative' source,d.id,d.object_key FROM media_derivatives d JOIN media m ON m.id=d.media_id WHERE d.state='deleted' AND m.deleted_at IS NOT NULL AND d.object_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM media live WHERE live.object_key=d.object_key AND live.deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM media_derivatives live WHERE live.object_key=d.object_key AND live.state<>'deleted') LIMIT ?`,
      )
        .bind(Math.min(budget, 10))
        .all<{ source: string; id: string; object_key: string }>()
    : { results: [] };
  for (const item of objects.results) {
    await env.MEDIA.delete(item.object_key);
    if (item.source === "media")
      await env.DB.prepare(
        "UPDATE media SET object_key=NULL WHERE id=? AND object_key=? AND deleted_at IS NOT NULL",
      )
        .bind(item.id, item.object_key)
        .run();
    else
      await env.DB.prepare(
        "UPDATE media_derivatives SET object_key=NULL WHERE id=? AND object_key=? AND state='deleted'",
      )
        .bind(item.id, item.object_key)
        .run();
    objectsDeleted++;
    budget--;
  }
  if (budget) {
    const r = await env.DB.prepare(
      "DELETE FROM auth_nonces WHERE nonce_hash IN(SELECT nonce_hash FROM auth_nonces WHERE expires_at<? ORDER BY expires_at LIMIT ?)",
    )
      .bind(Math.floor(time / 1000), Math.min(budget, 5))
      .run();
    noncesDeleted = r.meta.changes;
    budget -= noncesDeleted;
  }
  if (budget) {
    const r = await env.DB.prepare(
      "DELETE FROM policy_proposals WHERE id IN(SELECT id FROM policy_proposals WHERE expires_at<? ORDER BY expires_at LIMIT ?)",
    )
      .bind(time, Math.min(budget, 3))
      .run();
    proposalsDeleted = r.meta.changes;
    budget -= proposalsDeleted;
  }
  if (budget) {
    const r = await env.DB.prepare(
      "DELETE FROM media_jobs WHERE id IN(SELECT j.id FROM media_jobs j JOIN media m ON m.id=j.media_id WHERE (j.epoch<>? OR j.generation<>? OR (m.deleted_at IS NOT NULL AND j.status IN('cancelled','failed'))) LIMIT ?)",
    )
      .bind(fence.epoch, fence.generation, Math.min(budget, 3))
      .run();
    jobsDeleted = r.meta.changes;
    budget -= jobsDeleted;
  }
  if (budget) {
    const r = await env.DB.prepare(
      "DELETE FROM pending_statuses WHERE id IN(SELECT id FROM pending_statuses WHERE epoch<>? OR generation<>? OR created_at<? ORDER BY created_at LIMIT ?)",
    )
      .bind(
        fence.epoch,
        fence.generation,
        time - 7 * 86_400_000,
        Math.min(budget, 2),
      )
      .run();
    pendingStatusesDeleted = r.meta.changes;
    budget -= pendingStatusesDeleted;
  }
  if (budget) {
    const r = await env.DB.prepare(
      "UPDATE actions SET status=CASE WHEN status IN('proposed','approved') THEN 'expired' ELSE status END,envelope_json='{}',last_error=NULL WHERE id IN(SELECT id FROM actions WHERE expires_at<? AND envelope_json<>'{}' ORDER BY expires_at LIMIT ?)",
    )
      .bind(time, Math.min(budget, 2))
      .run();
    actionPayloadsCleared = r.meta.changes;
    budget -= actionPayloadsCleared;
  }
  if (budget)
    groupPayloadsCleared = await cleanupGroupActions(env, Math.min(budget, 2));
  return {
    retainedMessages,
    objectsDeleted,
    noncesDeleted,
    proposalsDeleted,
    jobsDeleted,
    pendingStatusesDeleted,
    actionPayloadsCleared,
    groupPayloadsCleared,
  };
}

export async function diagnostics(env: Env) {
  const fence = currentFence(env);
  const count = async (sql: string) =>
    (
      await env.DB.prepare(sql)
        .bind(fence.epoch, fence.generation)
        .first<{ n: number }>()
    )?.n ?? 0;
  return {
    version: packageJson.version,
    capture: await captureDiagnostics(env),
    epochConfigured: !!fence.epoch && fence.epoch !== "unconfigured",
    generationConfigured:
      !!fence.generation && fence.generation !== "unconfigured",
    maintenance: env.MAINTENANCE !== "false",
    retentionDays: await retentionValue(env, fence),
    counts: {
      chats: await count(
        "SELECT COUNT(*) n FROM chats WHERE epoch=? AND generation=?",
      ),
      capturedChats: await count(
        "SELECT COUNT(*) n FROM chats WHERE epoch=? AND generation=? AND capture_enabled=1",
      ),
      messages: await count(
        "SELECT COUNT(*) n FROM messages WHERE epoch=? AND generation=? AND deleted_at IS NULL",
      ),
      unavailable: await count(
        "SELECT COUNT(*) n FROM messages WHERE epoch=? AND generation=? AND unavailable_reason IS NOT NULL AND deleted_at IS NULL",
      ),
      pendingMedia: await count(
        "SELECT COUNT(*) n FROM media WHERE epoch=? AND generation=? AND deleted_at IS NULL AND state<>'ready'",
      ),
      pendingJobs: await count(
        "SELECT COUNT(*) n FROM media_jobs WHERE epoch=? AND generation=? AND status IN('pending','retry','processing')",
      ),
      uncertainGroupActions: await count(
        "SELECT COUNT(*) n FROM group_actions WHERE epoch=? AND generation=? AND status IN('uncertain','attempting')",
      ),
      pendingGroupActions: await count(
        "SELECT COUNT(*) n FROM group_actions WHERE epoch=? AND generation=? AND status IN('proposed','approved')",
      ),
      uncertainActions: await count(
        "SELECT COUNT(*) n FROM actions WHERE epoch=? AND generation=? AND status IN('uncertain','attempting')",
      ),
    },
  };
}

export async function applyPolicyFromChat(
  env: Env,
  id: string,
  confirmation: ChatConfirmation,
) {
  return applyPolicyProposal(env, id, { channel: "chat_client", confirmation });
}
