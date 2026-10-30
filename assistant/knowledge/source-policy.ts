import type { AccessGuard } from '../access';
/** Trusted kc/kp aliases only. Also used before importing historical bodies. */
export const knowledgeConversationEligibility = `(kp.kind IS NULL OR kp.kind=kc.kind) AND COALESCE(kp.excluded,0)=0
 AND (kc.kind='private' OR kp.group_mode IN ('observe','respond'))
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_quarantines kq
   WHERE kq.installation_id=kc.installation_id AND kq.generation=kc.generation
     AND kq.kind='policy' AND kq.conversation_id=kc.chat_id AND kq.version=kp.revision AND kq.active=1)`;
/** Shared eligibility for bot, curator and MCP knowledge, before ranking.
 * Archive capture and a direct owner archive read are separate purposes.
 * Alias s is the trusted assistant_sources projection, never model input. */
export function knowledgeSourcePolicy(origin: {sourceEpoch:string;sourceGeneration:string}): AccessGuard {
 return {sql:`s.origin<>'owner_request' AND (
   (s.conversation_id IS NULL AND s.origin<>'whatsapp')
   OR EXISTS (
    SELECT 1 FROM assistant_origin_conversations kc
    LEFT JOIN assistant_conversation_policies kp ON kp.installation_id=kc.installation_id
      AND kp.generation=kc.generation AND kp.conversation_id=kc.chat_id
    WHERE kc.installation_id=s.installation_id AND kc.generation=s.generation
      AND kc.source_epoch=? AND kc.source_generation=? AND kc.chat_id=s.conversation_id
      AND kc.access_state='available' AND kc.kind IN ('private','group')
      AND ${knowledgeConversationEligibility}
      AND (s.origin<>'whatsapp' OR EXISTS(SELECT 1 FROM assistant_source_origins ko
        WHERE ko.installation_id=s.installation_id AND ko.generation=s.generation AND ko.canonical_id=s.id
          AND ko.source_epoch=kc.source_epoch AND ko.source_generation=kc.source_generation
          AND ko.chat_id=kc.chat_id AND ko.tombstoned=0))
   )
 )`,values:[origin.sourceEpoch,origin.sourceGeneration]};
}
