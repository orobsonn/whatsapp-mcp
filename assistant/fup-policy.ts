import type { AccessGuard } from './access';
import type { SourceScope } from './sources';
import { retentionExecutionGuard } from './retention-execution';
export type ReminderScope = SourceScope & {sourceEpoch?:string;sourceGeneration?:string};

/** Fixed correlated alias f, never supplied SQL. An absent policy permits only
 * a private owner reminder, not group observation or any contact action. */
export function absentReminderPredicate(scope:ReminderScope):AccessGuard {
  if(!scope.sourceEpoch||!scope.sourceGeneration)return {sql:'0',values:[]};
  const execution=retentionExecutionGuard(scope);
  return {sql:`NOT EXISTS(SELECT 1 FROM assistant_conversation_policies p WHERE p.installation_id=f.installation_id AND p.generation=f.generation AND p.conversation_id=f.conversation_id)
    AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=f.installation_id AND q.generation=f.generation AND q.kind='policy' AND q.conversation_id=f.conversation_id AND q.active=1)
    AND EXISTS(SELECT 1 FROM assistant_origin_conversations o WHERE o.installation_id=f.installation_id AND o.generation=f.generation AND o.chat_id=f.conversation_id
      AND o.source_epoch=? AND o.source_generation=? AND o.kind IN ('private','group') AND o.access_state='available'
      AND NOT EXISTS(SELECT 1 FROM assistant_conversations c WHERE c.installation_id=o.installation_id AND c.generation=o.generation AND c.source_epoch=o.source_epoch AND c.source_generation=o.source_generation AND c.chat_id=o.chat_id AND c.paused=1))
    AND (${execution.sql})`,values:[scope.sourceEpoch,scope.sourceGeneration,...execution.values]};
}
/** Work/publication fence for already admitted legacy jobs too. The fixed f/s
 * aliases are the canonical FUP and its source; no model chooses this SQL. */
export function ownerReminderIntentGuard(scope:ReminderScope):AccessGuard {
  const absent=absentReminderPredicate(scope);
  const marker="EXISTS(SELECT 1 FROM assistant_fup_provenance rp WHERE rp.installation_id=f.installation_id AND rp.generation=f.generation AND rp.fup_id=f.id AND rp.version=f.version AND json_type(rp.body_json,'$.ownerReminder') IS NOT NULL)";
  return {sql:`(NOT ${marker} OR (s.origin='owner_note' AND s.audience='owner' AND s.conversation_id IS NULL
    AND EXISTS(SELECT 1 FROM assistant_fup_provenance rp WHERE rp.installation_id=f.installation_id AND rp.generation=f.generation AND rp.fup_id=f.id AND rp.version=f.version AND json_extract(rp.body_json,'$.ownerReminder.policyRevision')=0 AND json_type(rp.body_json,'$.outgoing') IS NULL)
    AND (${absent.sql})))`,values:absent.values};
}
export function fupPolicyGuard(scope:ReminderScope,conversationId:string,revision:number):AccessGuard {
  if(revision===0){const absent=absentReminderPredicate(scope);return {sql:`EXISTS(SELECT 1 FROM (SELECT ? installation_id,? generation,? conversation_id) f WHERE ${absent.sql})`,values:[scope.installationId,scope.generation,conversationId,...absent.values]};}
  const origin=scope.sourceEpoch&&scope.sourceGeneration;
  const originFilter=origin?' AND c.source_epoch=? AND c.source_generation=?':'';
  return {sql:`EXISTS(SELECT 1 FROM assistant_conversation_modes p WHERE p.installation_id=? AND p.generation=? AND p.conversation_id=? AND p.revision=? AND p.effective_mode<>'ignore'
    AND NOT EXISTS(SELECT 1 FROM assistant_conversations c WHERE c.installation_id=p.installation_id AND c.generation=p.generation AND c.chat_id=p.conversation_id AND c.paused=1${originFilter}))`,
    values:[scope.installationId,scope.generation,conversationId,revision,...(origin?[scope.sourceEpoch!,scope.sourceGeneration!]:[])]};
}
/** The read supplies an actionable diagnostic; the SAME guard also fences the
 * ledger transaction. Re-run after a lost admission to classify policy races. */
export async function requireFupPolicy(db:D1Database,scope:ReminderScope,conversationId:string,revision:number):Promise<AccessGuard>{
  const keys=[scope.installationId,scope.generation,conversationId];
  const current=await db.prepare('SELECT revision,effective_mode mode FROM assistant_conversation_modes WHERE installation_id=? AND generation=? AND conversation_id=?').bind(...keys).first<{revision:number;mode:string}>();
  if(revision===0?!!current:!current||current.revision!==revision)throw Error('control_policy_revision');
  if(current?.mode==='ignore'||revision===0&&await db.prepare("SELECT 1 FROM assistant_retention_quarantines WHERE installation_id=? AND generation=? AND conversation_id=? AND kind='policy' AND active=1").bind(...keys).first())throw Error('control_policy_restricted');
  const guard=fupPolicyGuard(scope,conversationId,revision);
  if(!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.values).first())throw Error('control_conversation_unavailable');
  return guard;
}
