import type {AssistantEnv} from '../env';
import {conversationIdentity} from './conversation';
import type {NativeApplicationHost} from './native-host';
import {curatorDispatchReceipt,observeCuratorSettlement} from './curator-outcomes';
import {nativeOwnerFence} from './native-policy';
import {nativeConversationInstance,openNativeConversation} from './native-transport';

/** Read the original SDK settlement; no dispatch, retry or paid inference.
 * Only the current owner's latest input can receive the fixed failure notice. */
export async function reconcileOwnerFailures(host:NativeApplicationHost,env:AssistantEnv){
 const scope=host.currentScope(),fence=await nativeOwnerFence(env,scope),db=env.DB!;
 const rows=await db.prepare(`SELECT e.task_ref,e.conversation_id,e.receipt_json,c.identity_json FROM assistant_native_conversation_events e
  JOIN assistant_native_conversations c ON c.id=e.conversation_id WHERE c.installation_id=? AND c.generation=? AND c.tombstoned_at IS NULL
  AND json_extract(c.identity_json,'$.channel')='telegram' AND json_extract(c.identity_json,'$.principalOrChatId')=?
  AND e.state='admitted' AND e.receipt_json IS NOT NULL AND json_extract(e.event_json,'$.kind')='incoming'
  AND json_extract(e.event_json,'$.author.kind')='owner' AND json_extract(e.event_json,'$.author.id')=?
  AND e.sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=e.conversation_id AND json_extract(event_json,'$.kind')='incoming' AND json_extract(event_json,'$.author.kind')='owner' AND json_extract(event_json,'$.author.id')=?)
  ORDER BY e.sequence DESC LIMIT 5`).bind(scope.installationId,scope.generation,fence.userId,fence.userId,fence.userId).all<{task_ref:string;conversation_id:string;receipt_json:string;identity_json:string}>();
 let checked=0,notified=0;
 for(const row of rows.results){let stage='receipt';try{
  const receipt=curatorDispatchReceipt.parse(JSON.parse(row.receipt_json)),identity=conversationIdentity.parse(JSON.parse(row.identity_json));
  stage='registered_context';await host.registered(row.conversation_id);
  // Joined input B keeps receipt B, while its consumed hooks run under active
  // submission A. Resolve that host-recorded owner; never invent a cohort for B.
  stage='consumed_owner';const owners=await db.prepare(`SELECT DISTINCT i.submission_id FROM assistant_native_consumed_inputs i
   WHERE i.installation_id=? AND i.generation=? AND i.conversation_id=? AND i.task_ref=?
    AND EXISTS(SELECT 1 FROM assistant_native_conversation_events e WHERE e.conversation_id=i.conversation_id AND e.state='admitted'
     AND json_extract(e.receipt_json,'$.submissionId')=i.submission_id AND json_extract(e.receipt_json,'$.uid')=?)`)
   .bind(scope.installationId,scope.generation,row.conversation_id,row.task_ref,receipt.uid).all<{submission_id:string}>();
  if(owners.results.length!==1)continue;const consumedSubmission=owners.results[0].submission_id;
  const consumed=await db.prepare(`SELECT task_ref FROM assistant_native_consumed_inputs WHERE installation_id=? AND generation=? AND conversation_id=? AND submission_id=? ORDER BY sequence`)
   .bind(scope.installationId,scope.generation,row.conversation_id,consumedSubmission).all<{task_ref:string}>();
  const refs=consumed.results.map(r=>r.task_ref);if(!refs.length||refs.at(-1)!==row.task_ref)continue;
  stage='restore_task';const task=await host.runtime.resolveStoredTask(identity,row.task_ref,refs);
  if(await db.prepare('SELECT 1 FROM assistant_native_owner_responses WHERE context_ref=?').bind(task.contextRef).first())continue;
  stage='sdk_settlement';const outcome=await observeCuratorSettlement({instance:nativeConversationInstance,read:(session,rec,signal)=>openNativeConversation(session).read(rec,{signal})},row.conversation_id,receipt,event=>console.warn('native_owner_settlement_diagnostic',event),30000);checked++;
  if(outcome!=='failed'&&outcome!=='aborted'){if(outcome===null)console.warn('native_owner_failure_diagnostic',{stage,reason:'unresolved'});continue;}
  stage='owner_notice_context';const request=await host.tasks().ownerNoticeContext(task);
  const head={sql:`EXISTS(SELECT 1 FROM assistant_native_conversation_events WHERE conversation_id=? AND task_ref=? AND sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=? AND json_extract(event_json,'$.kind')='incoming' AND json_extract(event_json,'$.author.kind')='owner' AND json_extract(event_json,'$.author.id')=?) AND state='admitted' AND receipt_json=?)`,values:[row.conversation_id,row.task_ref,row.conversation_id,fence.userId,row.receipt_json]};
  const guard={sql:`(${request.guard.sql}) AND (${head.sql})`,values:[...request.guard.values,...head.values]};
  stage='owner_notice_send';const result=await host.respondOwner(task,'⚠️ Não consegui concluir sua resposta porque o processamento foi interrompido. Pode me pedir para retomar; antes de repetir qualquer ação, vou conferir se ela já aconteceu.',guard);
  if(result.state==='sent')notified++;
 }catch(error){
  // Closed operational metadata only; never log bodies or provider errors.
  const known=new Set(['conversation_context_unavailable','conversation_context_withdrawn','native_task_changed','native_task_owner_required','native_task_source_unavailable','native_session_denied','native_owner_unlinked','native_authority_denied','native_owner_response_denied','native_owner_response_claim_denied']);
  const reason=error instanceof Error&&known.has(error.message)?error.message:'exception';
  console.warn('native_owner_failure_diagnostic',{stage,reason});
  // Revocation, a new head or uncertain delivery never authorizes a retry.
 }}
 return {checked,notified};
}
