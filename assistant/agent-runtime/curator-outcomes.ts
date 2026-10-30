import {z} from 'zod';
import type {DispatchReceipt,AgentReply,AgentInstanceInfo} from '@flue/runtime';
import type {AccessGuard} from '../access';
import type {OriginScope} from '../origin-guard';
import {telegramLinkGuard,type TelegramLinkFence} from '../telegram-auth';
import type {TelegramApi} from '../telegram';
import {conversationIdentity,type ConversationIdentity,type ConversationAuthority} from './conversation';
import {jsonStatement} from '../d1-statement';

type Candidate={id:string;day:string;source_epoch:string;source_generation:string;task_ref:string;conversation_id:string;identity_json:string;authority_json:string;receipt_json:string;outcome:string|null;notice_state:string|null};
type Host={db:D1Database;scope:OriginScope;assertCurrent():void;ownerFence():Promise<TelegramLinkFence>;
 authority(identity:ConversationIdentity):Promise<{authority:ConversationAuthority;guard:AccessGuard}>;
 read(sessionId:string,receipt:DispatchReceipt,signal:AbortSignal):Promise<AgentReply>;
 instance(sessionId:string):Promise<AgentInstanceInfo|null>;
 api(check:()=>Promise<void>):TelegramApi};
export const curatorDispatchReceipt=z.object({submissionId:z.string().min(1).max(256),uid:z.string().min(1).max(256),acceptedAt:z.string().min(1).max(64)}).strict();
const join=(...g:AccessGuard[]):AccessGuard=>({sql:g.map(x=>`(${x.sql})`).join(' AND '),values:g.flatMap(x=>x.values)});
/** Read only the original SDK receipt. A timed-out observation does not stop,
 * restart or change the native submission. No source body is consulted. */
export async function observeCuratorSettlement(host:Pick<Host,'instance'|'read'>,sessionId:string,receipt:DispatchReceipt){
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
 const read=(async()=>{
  const before=await host.instance(sessionId);if(controller.signal.aborted||before?.id!==sessionId||before.uid!==receipt.uid)return null;
  let outcome:'completed'|'failed'|'aborted'|null=null;
  try{const reply=await host.read(sessionId,receipt,controller.signal);if(reply.submissionId===receipt.submissionId&&(!reply.uid||reply.uid===receipt.uid))outcome='completed';}
  catch(error){const e=error as {name?:string;outcome?:string;submissionId?:string};if(e.name==='AgentRunError'&&e.submissionId===receipt.submissionId&&(e.outcome==='failed'||e.outcome==='aborted'))outcome=e.outcome;}
  if(controller.signal.aborted)return null;const after=await host.instance(sessionId);
  return !controller.signal.aborted&&after?.id===sessionId&&after.uid===receipt.uid?outcome:null;
 })().catch(()=>null);
 try{return await Promise.race([read,new Promise<null>(resolve=>{timer=setTimeout(()=>{expired=true;controller.abort();resolve(null);},5000);})]).then(value=>expired?null:value);}
 finally{clearTimeout(timer);controller.abort();}
}
export async function reconcileCuratorOutcomes(host:Host,clock=Date.now){
 host.assertCurrent();const s=host.scope,keys=[s.installationId,s.generation];
 const owner=await host.ownerFence(),principal='curator:'+owner.userId;
 // Compute the current grant from a real retained identity, without opening
 // its Source-dependent frame. Obsolete link grants never occupy a work page.
 const identityRow=await host.db.prepare(`SELECT identity_json FROM assistant_native_conversations WHERE installation_id=? AND generation=? AND tombstoned_at IS NULL
  AND json_extract(CASE WHEN json_valid(identity_json) THEN identity_json ELSE '{}' END,'$.channel')='telegram'
  AND json_extract(CASE WHEN json_valid(identity_json) THEN identity_json ELSE '{}' END,'$.principalOrChatId')=? LIMIT 1`).bind(...keys,principal).first<{identity_json:string}>();
 if(!identityRow)return {checked:0,notified:0};
 const grant=await host.authority(conversationIdentity.parse(JSON.parse(identityRow.identity_json)));
 // Least recently checked first: ten is a work page, never a corpus cutoff.
 const rows=await host.db.prepare(`SELECT r.id,r.day,r.source_epoch,r.source_generation,e.task_ref,e.conversation_id,c.identity_json,e.authority_json,e.receipt_json,o.outcome,o.notice_state
  FROM assistant_curator_runs r JOIN assistant_native_conversation_events e ON e.event_id='curator-run:'||r.id AND e.revision=1
  JOIN assistant_native_conversations c ON c.id=e.conversation_id AND c.installation_id=r.installation_id AND c.generation=r.generation
  LEFT JOIN assistant_curator_outcomes o ON o.installation_id=r.installation_id AND o.generation=r.generation AND o.run_id=r.id
  WHERE r.installation_id=? AND r.generation=? AND r.source_epoch=? AND r.source_generation=? AND r.run_kind='daily'
   AND c.tombstoned_at IS NULL AND e.state='admitted' AND e.receipt_json IS NOT NULL AND e.authority_json=?
   AND json_extract(CASE WHEN json_valid(c.identity_json) THEN c.identity_json ELSE '{}' END,'$.principalOrChatId')=?
   AND (o.outcome IS NULL OR o.notice_state='prepared')
  ORDER BY COALESCE(o.last_checked_at,0),r.created_at,r.id LIMIT 10`).bind(...keys,s.sourceEpoch,s.sourceGeneration,JSON.stringify(grant.authority),principal).all<Candidate>();
 let checked=0,notified=0;
 for(const row of rows.results){
  host.assertCurrent();let receipt:DispatchReceipt,identity:ConversationIdentity;
  try{receipt=curatorDispatchReceipt.parse(JSON.parse(row.receipt_json));identity=conversationIdentity.parse(JSON.parse(row.identity_json));}catch{continue;}
  const fence=await host.ownerFence();if(identity.channel!=='telegram'||identity.principalOrChatId!=='curator:'+fence.userId)continue;
  const gate=async()=>{
   host.assertCurrent();const now=await host.ownerFence(),current=await host.authority(identity);
   if(JSON.stringify(now)!==JSON.stringify(fence)||JSON.stringify(current.authority)!==row.authority_json)throw Error('curator_outcome_authority_changed');
   return join(current.guard,telegramLinkGuard(fence),{sql:`EXISTS(SELECT 1 FROM assistant_curator_runs r JOIN assistant_native_conversation_events e ON e.event_id='curator-run:'||r.id
    JOIN assistant_native_conversations c ON c.id=e.conversation_id AND c.tombstoned_at IS NULL
    WHERE r.installation_id=? AND r.generation=? AND r.id=? AND r.run_kind='daily' AND r.source_epoch=? AND r.source_generation=?
     AND e.task_ref=? AND e.conversation_id=? AND c.identity_json=? AND e.state='admitted' AND e.receipt_json=? AND e.authority_json=?)`,
    values:[...keys,row.id,s.sourceEpoch,s.sourceGeneration,row.task_ref,row.conversation_id,row.identity_json,row.receipt_json,row.authority_json]});
  };
  let guard:AccessGuard;try{guard=await gate();}catch{continue;}
  const result=row.outcome??await observeCuratorSettlement(host,row.conversation_id,receipt);host.assertCurrent();guard=await gate();checked++;
  const state=result===null?'pending':result==='completed'?'not_required':'prepared';
  await jsonStatement(host.db,`INSERT INTO assistant_curator_outcomes(installation_id,generation,run_id,submission_id,receipt_json,outcome,notice_state,created_at,last_checked_at)
   SELECT ?,?,?,?,?,?,?,?,? WHERE (${guard.sql}) ON CONFLICT(installation_id,generation,run_id) DO UPDATE SET
    outcome=COALESCE(assistant_curator_outcomes.outcome,excluded.outcome),notice_state=CASE WHEN assistant_curator_outcomes.outcome IS NULL THEN excluded.notice_state ELSE assistant_curator_outcomes.notice_state END,last_checked_at=excluded.last_checked_at
   WHERE assistant_curator_outcomes.receipt_json=excluded.receipt_json AND (assistant_curator_outcomes.outcome IS NULL OR assistant_curator_outcomes.notice_state='prepared')`,
   [...keys,row.id,receipt.submissionId,row.receipt_json,result,state,clock(),clock(),...guard.values]).run();
  if(result!=='failed'&&result!=='aborted')continue;
  const link=telegramLinkGuard(fence),topic=await host.db.prepare(`SELECT thread_id FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=? AND link_revision=? AND slot='summaries' AND state='ready' AND fence_json=? AND (${link.sql})`)
   .bind(...keys,fence.botInstance,fence.linkRevision,JSON.stringify(fence),...link.values).first<number>('thread_id');if(!topic)continue;
  const topicGuard:AccessGuard={sql:`EXISTS(SELECT 1 FROM assistant_telegram_topics WHERE installation_id=? AND generation=? AND bot_instance=? AND link_revision=? AND slot='summaries' AND state='ready' AND thread_id=? AND fence_json=?)`,values:[...keys,fence.botInstance,fence.linkRevision,topic,JSON.stringify(fence)]};
  const final=join(await gate(),topicGuard);
  const claim=await jsonStatement(host.db,`UPDATE assistant_curator_outcomes SET notice_state='attempting' WHERE installation_id=? AND generation=? AND run_id=? AND submission_id=? AND receipt_json=? AND outcome=? AND notice_state='prepared' AND (${final.sql}) RETURNING run_id`,
   [...keys,row.id,receipt.submissionId,row.receipt_json,result,...final.values]).first();if(!claim)continue;
  try{
   const n=await host.db.prepare(`SELECT (SELECT COUNT(*) FROM assistant_curator_items WHERE installation_id=? AND generation=? AND run_id=? AND state IN ('pending','presented','indexing','unavailable'))
    +(SELECT COUNT(*) FROM assistant_curator_capture_gaps WHERE installation_id=? AND generation=? AND run_id=? AND state='pending') n`).bind(...keys,row.id,...keys,row.id).first<number>('n');
   const day=/^\d{4}-\d{2}-\d{2}$/.test(row.day)?row.day:'dia registrado';
   const api=host.api(async()=>{const g=join(await gate(),topicGuard);if(!await jsonStatement(host.db,`SELECT 1 WHERE (${g.sql})`,g.values).first())throw Error('curator_outcome_authority_changed');});
   const message=await api.send(fence.chatId,topic,`⚠️ <b>Revisão da memória — ${day}</b>\n\nA execução foi interrompida.\n${n??0} pendências registradas.\n\nO trabalho já registrado foi preservado.`,[]);
   await host.db.prepare("UPDATE assistant_curator_outcomes SET notice_state='accepted',message_id=? WHERE installation_id=? AND generation=? AND run_id=? AND notice_state='attempting'").bind(message,...keys,row.id).run();notified++;
  }catch{await host.db.prepare("UPDATE assistant_curator_outcomes SET notice_state='uncertain' WHERE installation_id=? AND generation=? AND run_id=? AND notice_state='attempting'").bind(...keys,row.id).run();}
 }
 return {checked,notified};
}
