import {z} from 'zod';
import type {Env} from './env';
import {AppError,assertActive,currentFence,safeEqual,sha256} from './core';
import {resolveRuntimeEnv,runtimeConnectionGuard} from './connection';
import type {ConversationActivity,ApprovedSendActivityFence} from './approved-send-contract';
const id=z.string().min(1).max(256),integer=z.number().int().nonnegative().safe();
const query=z.object({secret:z.string().max(256),sourceEpoch:id,sourceGeneration:id,chatId:id}).strict();
const registration=z.object({sourceEpoch:id,sourceGeneration:id,instanceId:id,phoneChatId:id,lidChatId:id,phone:z.string().regex(/^[1-9][0-9]{7,14}$/),lid:z.string().regex(/^[0-9]{5,25}@lid$/),proofHash:z.string().regex(/^[a-f0-9]{64}$/),observedAt:integer}).strict();
const block=(reason:string):ConversationActivity=>({observation:'capture_conversation_activity',state:'blocked',reason});
const CTE=`WITH links AS(SELECT * FROM conversation_relationships WHERE epoch=? AND generation=? AND (phone_chat_id=? OR lid_chat_id=?)),
 ids AS(SELECT ? id UNION SELECT phone_chat_id FROM links UNION SELECT lid_chat_id FROM links)`;
// Every message kind can supersede an earlier turn. Edits/access changes do not
// become new incoming turns: use the first upsert of each actual incoming source.
const latestIncomingSql=(membersSql:string)=>`SELECT COALESCE(MAX(original_sequence),0) FROM (
 SELECT MIN(c.sequence) original_sequence FROM assistant_capture_changes c JOIN messages m
 ON m.id=c.source_id AND m.chat_id=c.chat_id AND m.epoch=c.epoch AND m.generation=c.generation
 WHERE c.epoch=? AND c.generation=? AND c.chat_id IN(${membersSql}) AND c.source_kind='message' AND c.operation='upsert' AND m.from_me=0
 GROUP BY c.chat_id,c.source_id)`;
/** Metadata only, direct relationships only. No alias authorizes content access. */
export async function conversationActivity(env:Env,chatId:string):Promise<ConversationActivity>{
 assertActive(env);const f=currentFence(env);
 const rows=await env.DB.prepare(`${CTE} SELECT c.id,c.capture_enabled,c.identity_blocked,
  COALESCE((SELECT MAX(sequence) FROM assistant_capture_changes WHERE epoch=c.epoch AND generation=c.generation AND chat_id=c.id),0) watermark,
  (SELECT COUNT(*) FROM links) link_count,(SELECT revision FROM links LIMIT 1) revision,(SELECT proof_hash FROM links LIMIT 1) proof_hash,
  (SELECT state FROM links LIMIT 1) link_state,(SELECT instance_id FROM links LIMIT 1) instance_id,
  (SELECT COUNT(*) FROM ids) member_count,
  COALESCE((SELECT MAX(original_sequence) FROM owner_message_originals WHERE epoch=? AND generation=? AND chat_id IN(SELECT id FROM ids)),0) last_owner,
  (${latestIncomingSql('SELECT id FROM ids')}) latest_incoming
  FROM chats c WHERE c.id IN(SELECT id FROM ids) AND c.epoch=? AND c.generation=? ORDER BY c.id LIMIT 3`).bind(f.epoch,f.generation,chatId,chatId,chatId,f.epoch,f.generation,f.epoch,f.generation,f.epoch,f.generation).all<{id:string;capture_enabled:number;identity_blocked:number;watermark:number;link_count:number;revision:number|null;proof_hash:string|null;link_state:string|null;instance_id:string|null;member_count:number;last_owner:number;latest_incoming:number}>();
 const first=rows.results[0];if(!first||!rows.results.some(row=>row.id===chatId)||rows.results.length!==first.member_count)return block('conversation_missing');
 if(rows.results.some(row=>row.identity_blocked===1))return block('identity_conflict');
 if(first.link_count>1||first.member_count>2||first.link_state==='blocked')return block('relationship_ambiguous');
 if(first.link_count&&first.instance_id!==env.ZAPI_INSTANCE_ID)return block('relationship_instance_changed');
 return {observation:'capture_conversation_activity',state:'available',sourceEpoch:f.epoch,sourceGeneration:f.generation,chatId,relationshipRevision:first.revision??0,relationshipProof:first.proof_hash??'0'.repeat(64),members:rows.results.map(r=>({chatId:r.id,captureEnabled:r.capture_enabled===1,watermark:r.watermark})),watermark:Math.max(...rows.results.map(r=>r.watermark)),lastOwnerOriginalSequence:first.last_owner,latestIncomingOriginalSequence:first.latest_incoming};
}
export async function readConversationActivity(raw:Env,input:unknown):Promise<ConversationActivity>{
 const q=query.parse(input),secret=raw.ASSISTANT_READER_SECRET;
 if(!secret||secret.length<32||!await safeEqual(secret,q.secret))throw new AppError('reader_denied',403);
 const env=await resolveRuntimeEnv(raw);assertActive(env);const f=currentFence(env);
 if(q.sourceEpoch!==f.epoch||q.sourceGeneration!==f.generation)throw new AppError('reader_denied',403);
 return conversationActivity(env,q.chatId);
}
/** SQL used by prepare and the final Source claim. All member/relationship and
 * latest-original-owner checks execute inside the same conditional mutation. */
export function conversationActivityGuard(env:Env,chatId:string,fence:ApprovedSendActivityFence){
 const f=currentFence(env),members=[...fence.members].sort();
 if(members.length<1||members.length>2||new Set(members).size!==members.length||!members.includes(chatId))throw new AppError('activity_invalid',409);
 const placeholders=members.map(()=>'?').join(','),values:(string|number|null)[]=[];
 const relation=fence.relationshipRevision===0?
  `NOT EXISTS(SELECT 1 FROM conversation_relationships WHERE epoch=? AND generation=? AND (phone_chat_id=? OR lid_chat_id=?))`:
  `EXISTS(SELECT 1 FROM conversation_relationships WHERE epoch=? AND generation=? AND instance_id=? AND state='active' AND revision=? AND proof_hash=? AND phone_chat_id IN (${placeholders}) AND lid_chat_id IN (${placeholders})) AND (SELECT COUNT(*) FROM conversation_relationships WHERE epoch=? AND generation=? AND (phone_chat_id IN (${placeholders}) OR lid_chat_id IN (${placeholders})))=1`;
 if(fence.relationshipRevision===0){if(members.length!==1||fence.relationshipProof!=='0'.repeat(64))throw new AppError('activity_invalid',409);values.push(f.epoch,f.generation,chatId,chatId);}
 else{if(members.length!==2)throw new AppError('activity_invalid',409);values.push(f.epoch,f.generation,env.ZAPI_INSTANCE_ID??'',fence.relationshipRevision,fence.relationshipProof,...members,...members,f.epoch,f.generation,...members,...members);}
 const capture=`(SELECT COUNT(*) FROM chats WHERE epoch=? AND generation=? AND capture_enabled=1 AND identity_blocked=0 AND id IN(${placeholders}))=?`;
 values.push(f.epoch,f.generation,...members,members.length);
 const owner=`NOT EXISTS(SELECT 1 FROM owner_message_originals WHERE epoch=? AND generation=? AND chat_id IN(${placeholders}) AND original_sequence>?)`;
 values.push(f.epoch,f.generation,...members,fence.triggerSequence);
 const incoming=`?=(${latestIncomingSql(placeholders)})`;
 values.push(fence.triggerSequence,f.epoch,f.generation,...members);
 const watermark=`COALESCE((SELECT MAX(sequence) FROM assistant_capture_changes WHERE epoch=? AND generation=? AND chat_id IN(${placeholders})),0)=?`;
 values.push(f.epoch,f.generation,...members,fence.watermark);
 const trigger=`EXISTS(SELECT 1 FROM assistant_capture_changes c JOIN messages m ON m.id=c.source_id AND m.chat_id=c.chat_id AND m.epoch=c.epoch AND m.generation=c.generation WHERE c.epoch=? AND c.generation=? AND c.chat_id=? AND c.sequence=? AND c.source_kind='message' AND c.operation='upsert' AND m.from_me=0 AND m.deleted_at IS NULL AND m.privacy_locked=0 AND m.unavailable_reason IS NULL AND c.sequence=(SELECT MIN(old.sequence) FROM assistant_capture_changes old WHERE old.epoch=c.epoch AND old.generation=c.generation AND old.chat_id=c.chat_id AND old.source_id=c.source_id AND old.source_kind='message' AND old.operation='upsert'))`;
 values.push(f.epoch,f.generation,chatId,fence.triggerSequence);
 return {sql:`(${relation}) AND (${capture}) AND (${owner}) AND (${incoming}) AND (${watermark}) AND (${trigger})`,values};
}
/** Reviewable operator plan. The connection predicate is host-selected, never
 * an RPC/message parameter. Its values stay in the private operator channel. */
export function providerRelationshipInsertPlan(input:unknown,connection:{sql:string;values:(string|number|null)[]}){
 const q=registration.parse(input),scope=[q.sourceEpoch,q.sourceGeneration],pair=[q.phoneChatId,q.lidChatId];
 const target=`EXISTS(SELECT 1 FROM chats WHERE epoch=? AND generation=? AND id=? AND kind='individual' AND identity_blocked=0 AND external_id=?) AND EXISTS(SELECT 1 FROM chats WHERE epoch=? AND generation=? AND id=? AND kind='individual' AND identity_blocked=0 AND external_id=?)`;
 const targetValues=[...scope,q.phoneChatId,q.phone,...scope,q.lidChatId,q.lid];
 return {sql:`INSERT INTO conversation_relationships(epoch,generation,instance_id,phone_chat_id,lid_chat_id,proof_hash,revision,state,observed_at) SELECT ?,?,?,?,?,?,1,'active',? WHERE (${connection.sql}) AND (${target}) AND NOT EXISTS(SELECT 1 FROM conversation_relationships WHERE epoch=? AND generation=? AND (phone_chat_id IN(?,?) OR lid_chat_id IN(?,?))) ON CONFLICT DO NOTHING`,values:[...scope,q.instanceId,...pair,q.proofHash,q.observedAt,...connection.values,...targetValues,...scope,...pair,...pair]};
}
/** Pure private operator plan. The new row uses the standard capture identifier
 * and existing creation triggers choose capture defaults; no existing row changes. */
export async function operatorMetadataPlan(input:unknown,connection:{sql:string;values:(string|number|null)[]}){
 const q=registration.pick({sourceEpoch:true,sourceGeneration:true,phoneChatId:true,phone:true,lid:true,observedAt:true}).parse(input);
 const chatId=await sha256(JSON.stringify([q.sourceEpoch,q.sourceGeneration,'chat',q.lid]));
 return {chatId,sql:`INSERT INTO chats(id,epoch,generation,external_id,kind,name,created_at,updated_at)
  SELECT ?,?,?,?,'individual',p.name,?,? FROM chats p WHERE p.id=? AND p.epoch=? AND p.generation=? AND p.kind='individual' AND p.external_id=? AND p.capture_enabled=1 AND p.identity_blocked=0
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='capture_chat_insert') AND (${connection.sql})
  ON CONFLICT(epoch,generation,external_id) DO NOTHING`,values:[chatId,q.sourceEpoch,q.sourceGeneration,q.lid,q.observedAt,q.observedAt,q.phoneChatId,q.sourceEpoch,q.sourceGeneration,q.phone,...connection.values]};
}
/** A proved contradiction is one atomic veto: existing direct pairs and every
 * affected chat, including a new singleton phone. Capture and manual sends stay unchanged. */
async function blockIdentityContradiction(env:Env,pair:[string,string],proof:string,connection:{sql:string;values:(string|number|null)[]},evidence:{sql:string;values:(string|number|null)[]}){
 const f=currentFence(env),scope=[f.epoch,f.generation];
 const touches="(phone_chat_id IN(?,?) OR lid_chat_id IN(?,?))";
 await env.DB.batch([
  env.DB.prepare(`UPDATE conversation_relationships SET state='blocked',revision=revision+1,conflict_proof_hash=? WHERE epoch=? AND generation=? AND state='active' AND ${touches} AND (${connection.sql}) AND (${evidence.sql})`).bind(proof,...scope,...pair,...pair,...connection.values,...evidence.values),
  env.DB.prepare(`UPDATE chats SET identity_blocked=1 WHERE epoch=? AND generation=? AND identity_blocked=0 AND id IN(
   SELECT ? UNION SELECT ? UNION SELECT phone_chat_id FROM conversation_relationships WHERE epoch=? AND generation=? AND ${touches}
   UNION SELECT lid_chat_id FROM conversation_relationships WHERE epoch=? AND generation=? AND ${touches})
   AND (${connection.sql}) AND (${evidence.sql})`).bind(...scope,...pair,...scope,...pair,...pair,...scope,...pair,...pair,...connection.values,...evidence.values),
 ]);
}
/** Operator-only host function: not exported as HTTP, MCP or reader RPC. The
 * operator must verify the authenticated provider receipt before calling it. */
export async function registerProviderRelationship(raw:Env,input:unknown):Promise<ConversationActivity>{
 const q=registration.parse(input),env=await resolveRuntimeEnv(raw);assertActive(env);const f=currentFence(env);
 if(q.sourceEpoch!==f.epoch||q.sourceGeneration!==f.generation||q.instanceId!==env.ZAPI_INSTANCE_ID||q.phoneChatId===q.lidChatId)throw new AppError('relationship_denied',403);
 const connection=await runtimeConnectionGuard(env),scope=[f.epoch,f.generation],pair=[q.phoneChatId,q.lidChatId];
 const blockConflict=async()=>{
  // A contradictory authenticated proof disables the existing pair. It never
  // redirects, joins a third member, or restores a previously blocked relation.
  const evidence={sql:"EXISTS(SELECT 1 FROM chats WHERE epoch=? AND generation=? AND id=? AND kind='individual' AND external_id=?) AND EXISTS(SELECT 1 FROM chats WHERE epoch=? AND generation=? AND id=? AND kind='individual' AND external_id=?) AND EXISTS(SELECT 1 FROM conversation_relationships WHERE epoch=? AND generation=? AND (phone_chat_id IN(?,?) OR lid_chat_id IN(?,?)) AND (phone_chat_id<>? OR lid_chat_id<>?))",values:[...scope,q.phoneChatId,q.phone,...scope,q.lidChatId,q.lid,...scope,...pair,...pair,...pair]};
  await blockIdentityContradiction(env,[q.phoneChatId,q.lidChatId],q.proofHash,connection,evidence);
  throw new AppError('relationship_conflict',409);
 };
 const existing=await env.DB.prepare('SELECT phone_chat_id,lid_chat_id,proof_hash,state FROM conversation_relationships WHERE epoch=? AND generation=? AND (phone_chat_id IN(?,?) OR lid_chat_id IN(?,?))').bind(...scope,...pair,...pair).all<{phone_chat_id:string;lid_chat_id:string;proof_hash:string;state:string}>();
 if(existing.results.length){const row=existing.results[0]!;if(existing.results.length===1&&row.phone_chat_id===q.phoneChatId&&row.lid_chat_id===q.lidChatId&&row.state==='active')return conversationActivity(env,q.phoneChatId);return blockConflict();}
 const plan=providerRelationshipInsertPlan(q,connection);
 await env.DB.prepare(plan.sql).bind(...plan.values).run();
 const saved=await env.DB.prepare("SELECT 1 FROM conversation_relationships WHERE epoch=? AND generation=? AND phone_chat_id=? AND lid_chat_id=? AND state='active'").bind(...scope,...pair).first();
 if(!saved)return blockConflict();
 return conversationActivity(env,q.phoneChatId);
}
/** Called only by the authenticated Source webhook handler after normalization.
 * Only co-present provider fields can add direct metadata; never routing or ACL. */
export async function observeAuthenticatedRelationshipCallback(env:Env,input:unknown):Promise<void>{
 const parsed=z.object({type:z.literal('ReceivedCallback'),instanceId:id,connectedPhone:id,phone:z.string().regex(/^[1-9][0-9]{7,14}$/),chatLid:z.string().regex(/^[0-9]{5,25}@lid$/),isGroup:z.literal(false),fromMe:z.boolean(),messageId:id}).passthrough().safeParse(input);
 if(!parsed.success)return;const q=parsed.data;
 const timestamp=q.momment??q.moment;
 if(q.instanceId!==env.ZAPI_INSTANCE_ID||q.connectedPhone!==env.CONNECTED_PHONE||q.isNewsletter===true||typeof timestamp!=='number'||!Number.isFinite(timestamp)||timestamp<0)return;
 assertActive(env);const f=currentFence(env);
 const linked=await env.DB.prepare(`SELECT r.phone_chat_id,r.lid_chat_id,r.revision,r.proof_hash,r.state,l.external_id lid FROM conversation_relationships r
  JOIN chats p ON p.id=r.phone_chat_id AND p.epoch=r.epoch AND p.generation=r.generation AND p.kind='individual'
  JOIN chats l ON l.id=r.lid_chat_id AND l.epoch=r.epoch AND l.generation=r.generation AND l.kind='individual'
  WHERE r.epoch=? AND r.generation=? AND r.instance_id=? AND p.external_id=?`).bind(f.epoch,f.generation,q.instanceId,q.phone).first<{phone_chat_id:string;lid_chat_id:string;revision:number;proof_hash:string;state:string;lid:string}>();
 if(linked&&(linked.state!=='active'||linked.lid===q.chatLid))return;
 const connection=await runtimeConnectionGuard(env);
 if(!linked){
  const phone=await env.DB.prepare("SELECT id,capture_enabled,identity_blocked FROM chats WHERE epoch=? AND generation=? AND external_id=? AND kind='individual'").bind(f.epoch,f.generation,q.phone).first<{id:string;capture_enabled:number;identity_blocked:number}>();
  if(!phone?.capture_enabled||phone.identity_blocked===1)return;
  const plan=await operatorMetadataPlan({sourceEpoch:f.epoch,sourceGeneration:f.generation,phoneChatId:phone.id,phone:q.phone,lid:q.chatLid,observedAt:Date.now()},connection);
  await env.DB.prepare(plan.sql).bind(...plan.values).run();
  const lid=await env.DB.prepare("SELECT id FROM chats WHERE epoch=? AND generation=? AND external_id=? AND kind='individual'").bind(f.epoch,f.generation,q.chatLid).first<{id:string}>();
  if(!lid)return;
  const proof=await sha256(JSON.stringify(['callback_identity_pair',f.epoch,f.generation,q.instanceId,phone.id,lid.id,q.messageId,q.phone,q.chatLid]));
  try{await registerProviderRelationship(env,{sourceEpoch:f.epoch,sourceGeneration:f.generation,instanceId:q.instanceId,phoneChatId:phone.id,lidChatId:lid.id,phone:q.phone,lid:q.chatLid,proofHash:proof,observedAt:Date.now()});}
  catch(error){if(!(error instanceof AppError)||!['relationship_conflict','relationship_denied'].includes(error.code))throw error;}
  return;
 }
 const proof=await sha256(JSON.stringify(['callback_identity_conflict',f.epoch,f.generation,q.instanceId,linked.phone_chat_id,linked.lid_chat_id,q.messageId,q.phone,q.chatLid]));
 const evidence={sql:"EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=? AND kind='individual' AND external_id=?) AND EXISTS(SELECT 1 FROM chats WHERE id=? AND epoch=? AND generation=? AND kind='individual' AND external_id=?)",values:[linked.phone_chat_id,f.epoch,f.generation,q.phone,linked.lid_chat_id,f.epoch,f.generation,linked.lid]};
 await blockIdentityContradiction(env,[linked.phone_chat_id,linked.lid_chat_id],proof,connection,evidence);
}
