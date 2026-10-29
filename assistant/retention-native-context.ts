/** Fixed adapters for native/knowledge copies. Every mutation is supplied to the
 * same D1 batch as the exact source purge grant; no native destroy is claimed. */
// 0040 FTS/shadow tables are derived: deleting canonical source_versions
// invokes the fixed per-document trigger, preserving every unrelated document.
export const nativeRetentionTables = new Set(`knowledge_operations native_conversations native_conversation_events native_reply_intents native_context_channels native_context_exposures native_context_purges native_reply_actions native_telegram_reviews native_telegram_callbacks native_host_events native_capture_intake native_owner_responses native_host_state native_help_questions native_help_replies curator_state curator_runs curator_items curator_capture_gaps curator_notices archive_text archive_text_data archive_text_idx archive_text_docsize archive_text_config`.split(' ').map(name=>'assistant_'+name));
const namespace=(alias:string)=>`${alias}.installation_id=?1 AND ${alias}.generation=?2`;
const refs=(kind:string)=>`SELECT id FROM assistant_retention_purge_refs WHERE installation_id=?1 AND generation=?2 AND purge_id=?3 AND kind='${kind}'`;
const valid=(json:string)=>`CASE WHEN json_valid(${json}) THEN ${json} ELSE '{}' END`;
const evidence=(json:string)=>`EXISTS(SELECT 1 FROM json_each(${valid(json)},'$.relations') r, json_each(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.evidence') e WHERE json_extract(CASE WHEN e.type='object' THEN e.value ELSE '{}' END,'$.sourceRef.id')=?4)`;
/** Paths are host contract fields, never substring matching source IDs in text. */
const knowledgeSource=`json_extract(${valid('k.request_json')},'$.sourceId')=?4
 OR json_extract(${valid('k.request_json')},'$.sourceRef.id')=?4
 OR ${evidence('k.request_json')} OR ${evidence('k.normalized_json')}
 OR json_extract(${valid('k.normalized_json')},'$.previousRef.id')=?4
 OR json_extract(${valid('k.normalized_json')},'$.sourceCommand.id')=?4
 OR json_extract(${valid('k.response_json')},'$.sourceRef.id')=?4
 OR EXISTS(SELECT 1 FROM json_each(${valid('k.source_fences_json')},'$.sources') f WHERE json_extract(CASE WHEN f.type='object' THEN f.value ELSE '{}' END,'$.source.id')=?4)
 OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(${valid('k.source_fences_json')})='array' THEN k.source_fences_json ELSE '[]' END) f WHERE json_extract(CASE WHEN f.type='object' THEN f.value ELSE '{}' END,'$.source.id')=?4)
 OR EXISTS(SELECT 1 FROM assistant_sources s WHERE ${namespace('s')} AND s.id=?4 AND s.origin='owner_report' AND s.origin_key='knowledge-report:'||k.id)`;
export function nativeRetentionAdapter(catalog:ReadonlySet<string>){
 const has=(name:string)=>catalog.has('assistant_'+name),native=has('native_conversations');
 const groups=[['native_conversations','native_conversation_events','native_reply_intents'],['native_context_channels','native_context_exposures','native_context_purges'],['native_host_events','native_capture_intake','native_owner_responses','native_host_state'],['native_help_questions','native_help_replies'],['curator_state','curator_runs','curator_items','curator_capture_gaps','curator_notices']];
 if(groups.some(group=>group.some(has)&&!group.every(has)) || (has('native_context_exposures')||has('native_reply_actions')||has('native_telegram_reviews')||has('native_host_events')||has('native_help_questions'))&&!native || has('native_telegram_reviews')!==has('native_telegram_callbacks'))throw Error('native_context_schema_incomplete');
 const collections:{kind:string;query:string}[]=[];
 if(native)collections.push({kind:'native_context',query:`SELECT c.id FROM assistant_native_conversations c WHERE ${namespace('c')} AND (
  EXISTS(SELECT 1 FROM assistant_native_conversation_events e WHERE e.conversation_id=c.id AND json_extract(${valid('e.event_json')},'$.sourceRef.id')=?4)
  ${has('native_context_exposures')?`OR EXISTS(SELECT 1 FROM assistant_native_context_exposures e WHERE ${namespace('e')} AND e.conversation_id=c.id AND e.source_id=?4)`:''}
  ${has('native_host_events')?`OR EXISTS(SELECT 1 FROM assistant_native_host_events h WHERE ${namespace('h')} AND h.conversation_id=c.id AND h.source_id=?4)`:''}
  ${has('native_help_questions')?`OR EXISTS(SELECT 1 FROM assistant_native_help_questions q WHERE ${namespace('q')} AND q.conversation_id=c.id AND (q.source_id=?4 OR q.clarification_source_id=?4))`:''}
  ${has('native_telegram_reviews')?`OR EXISTS(SELECT 1 FROM assistant_native_telegram_reviews r WHERE ${namespace('r')} AND r.conversation_id=c.id AND r.context_source_id=?4)`:''})`});
 if(has('knowledge_operations'))collections.push({kind:'knowledge_operation',query:`SELECT k.id FROM assistant_knowledge_operations k WHERE ${namespace('k')} AND (${knowledgeSource})`});
 return {collections,mutations(gate:string){
  // The root tombstone invalidates frames/effects before clearing their bodies.
  // 0041/0042 triggers remove reply payload/review authority on this same write.
  const mutations:string[]=[];
  if(native){
   mutations.push(`UPDATE assistant_native_conversations AS c SET tombstoned_at=COALESCE(tombstoned_at,?5) WHERE ${namespace('c')} AND c.id IN (${refs('native_context')}) AND ${gate}`);
   mutations.push(`UPDATE assistant_native_conversation_events SET state='withdrawn',event_json=NULL WHERE conversation_id IN (${refs('native_context')}) AND ${gate}`);
   mutations.push(`UPDATE assistant_native_reply_intents SET state='superseded' WHERE conversation_id IN (${refs('native_context')}) AND state IN ('proposed','approved') AND ${gate}`);
   if(has('native_context_purges'))mutations.push(`INSERT INTO assistant_native_context_purges(installation_id,generation,conversation_id,state,updated_at) SELECT ?1,?2,c.id,'tombstoned',?5 FROM assistant_native_conversations c WHERE ${namespace('c')} AND c.id IN (${refs('native_context')}) AND ${gate} ON CONFLICT DO NOTHING`);
  }
  if(has('knowledge_operations'))mutations.push(`UPDATE assistant_knowledge_operations AS k SET request_json='{}',normalized_json=NULL,source_fences_json=NULL,response_json=json_object('operationId',k.id,'state','partial','error','source_purged'),state='complete',error='source_purged',updated_at=?5 WHERE ${namespace('k')} AND k.id IN (${refs('knowledge_operation')}) AND ${gate}`);
  // Telegram keeps the authenticated original before Source admission. Follow
  // the host's exact typed event key; a source ID appearing in text is no link.
  if(has('native_host_events')&&has('telegram_updates'))mutations.push(`UPDATE assistant_telegram_updates AS t SET text=NULL,state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE ${namespace('t')}
   AND EXISTS(SELECT 1 FROM assistant_native_host_events h WHERE ${namespace('h')} AND h.source_id=?4 AND h.event_id='telegram:'||t.bot_instance||':'||t.update_id) AND ${gate}`);
  if(has('native_help_questions')&&has('telegram_updates'))mutations.push(`UPDATE assistant_telegram_updates AS t SET text=NULL,state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE ${namespace('t')}
   AND (EXISTS(SELECT 1 FROM assistant_native_help_replies r JOIN assistant_native_help_questions q ON q.id=r.question_id AND q.installation_id=r.installation_id AND q.generation=r.generation AND q.bot_instance=r.bot_instance
    WHERE ${namespace('r')} AND r.bot_instance=t.bot_instance AND r.update_id=t.update_id AND (q.source_id=?4 OR q.clarification_source_id=?4))
    OR EXISTS(SELECT 1 FROM assistant_native_help_questions q WHERE ${namespace('q')} AND (q.source_id=?4 OR q.clarification_source_id=?4)
     AND q.bot_instance=t.bot_instance AND q.message_id=t.reply_to_message_id AND q.thread_id=t.thread_id
     AND t.reply_to_chat_id=json_extract(${valid('q.link_json')},'$.chatId') AND (t.reply_to_thread_id IS NULL OR t.reply_to_thread_id=q.thread_id)
     AND t.user_id=json_extract(${valid('q.link_json')},'$.userId') AND t.chat_id=json_extract(${valid('q.link_json')},'$.chatId')
     AND t.source_epoch=json_extract(${valid('q.link_json')},'$.sourceEpoch') AND t.source_generation=json_extract(${valid('q.link_json')},'$.sourceGeneration')
     AND t.link_revision=json_extract(${valid('q.link_json')},'$.linkRevision'))) AND ${gate}`);
  if(has('curator_items'))mutations.push(`UPDATE assistant_curator_items AS i SET state='withdrawn',source_hash=NULL,operation_ids_json='[]',updated_at=?5 WHERE ${namespace('i')} AND i.source_id=?4 AND ${gate}`);
  if(has('curator_capture_gaps'))mutations.push(`UPDATE assistant_curator_capture_gaps AS g SET state='withdrawn' WHERE ${namespace('g')} AND EXISTS(SELECT 1 FROM assistant_source_origins o WHERE ${namespace('o')} AND o.canonical_id=?4 AND o.source_kind=g.source_kind AND o.source_id=g.source_id) AND ${gate}`);
  return mutations;
 }};
}
