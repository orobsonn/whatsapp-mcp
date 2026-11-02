import type { AssistantEnv } from './env';
import type { OwnerCommand, NativeTaskEnrollment } from './control';
import type { OwnerAffinity } from './mcp';
import { SourceAccess } from './access';
import { bridgeHash } from './ingress';
import { telegramLinkGuard } from './telegram-auth';
import { retentionExecutionGuard } from './retention-execution';
import { assertRestoredGeneration } from './retention-runtime';
import { NativeApplicationHost } from './agent-runtime/native-host';
import { conversationAddress } from './agent-runtime/conversation';
import { joinGuards, nativeMode, nativeOwnerFence, nativeTelegramActivation } from './agent-runtime/native-policy';

/** Called ONLY by the exclusive authenticated owner RPC. The source is a
 * revocable evidence fence, never the authority to enroll a task. No payload
 * can supply an enrollment, principal, channel or activation. */
async function deriveMcpFollowUp(env: AssistantEnv, scope: OwnerAffinity,
  command: Extract<OwnerCommand, { kind: 'fup.put' }>) {
  if (nativeMode(env) === 'off' || env.ROUTINES_PAUSED === 'true') throw Error('control_scheduler_unavailable');
  await assertRestoredGeneration(env);
  const host = new NativeApplicationHost(env), fence = await nativeOwnerFence(env, scope);
  const activation = await nativeTelegramActivation(env, scope, fence);
  const identity = await host.retention.currentIdentity('telegram', fence.userId);
  if (!identity) throw Error('control_scheduler_unavailable');
  const session = await conversationAddress(identity, 'telegram', fence.userId, identity.contextEpoch);
  const access = new SourceAccess(env.DB!, scope, Date.now, 'knowledge');
  const source = await access.read({ kind: 'owner' }, command.source.id, command.source.revision);
  if (!source) throw Error('control_source_unavailable');
  const guards = [access.guard({ kind: 'owner' }, source.fence, Date.now()), telegramLinkGuard(fence), activation.guard,
    retentionExecutionGuard(scope), host.retention.authorityGuard(session), {
      sql: "EXISTS(SELECT 1 FROM assistant_native_context_channels WHERE installation_id=? AND generation=? AND channel='telegram' AND principal_id=? AND conversation_id=?)",
      values: [scope.installationId, scope.generation, fence.userId, session],
    }];
  if (source.fence.source.origin === 'whatsapp') {
    const origin = await host.origin.fence(source.id);
    if (!origin || (await host.origin.checkContext(origin)).state !== 'current') throw Error('control_precondition');
    guards.push(host.origin.localContextGuard(origin));
  }
  const ref = { id: source.id, revision: source.fence.source.revision, version: source.fence.source.version, hash: source.fence.source.hash };
  const enrollment: NativeTaskEnrollment = { kind: 'follow_up',
    id: 'native-task-binding:' + await bridgeHash([[scope.installationId, scope.generation], 'follow_up', command.id, command.expectedVersion + 1]),
    sourceRefJSON: JSON.stringify(ref), authorizationRefJSON: JSON.stringify(ref), ownerFenceJSON: JSON.stringify(fence),
    activationKey: activation.key, activationJSON: activation.json, principalId: fence.userId, threadId: null };
  const guard = joinGuards(...guards);
  return { enrollment, admission: () => {
    host.currentScope();
    if (nativeMode(env) === 'off' || env.ROUTINES_PAUSED === 'true') throw Error('control_scheduler_unavailable');
    return guard;
  } };
}

export async function prepareMcpFollowUp(env: AssistantEnv, scope: OwnerAffinity,
  command: Extract<OwnerCommand, { kind: 'fup.put' }>) {
  try { return await deriveMcpFollowUp(env, scope, command); }
  catch (error) {
    if (error instanceof Error && ['native_owner_unlinked','native_telegram_cut_unconfigured','native_telegram_cut_denied',
      'native_unconfigured','native_configuration_invalid','native_autonomous_disabled'].includes(error.message)) throw Error('control_scheduler_unavailable');
    throw error;
  }
}
