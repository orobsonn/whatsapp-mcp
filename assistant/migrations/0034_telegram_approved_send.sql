-- Real owner approvals are separate from historical shadow simulations.
CREATE TABLE IF NOT EXISTS assistant_telegram_send_reviews (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,id TEXT NOT NULL,
 operation_id TEXT NOT NULL,decision_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,
 fence_json TEXT NOT NULL,pilot_json TEXT NOT NULL,credential_hash TEXT NOT NULL,thread_id INTEGER NOT NULL,
 action_id TEXT NOT NULL,action_hash TEXT NOT NULL,envelope_json TEXT NOT NULL,target_json TEXT NOT NULL,
 expires_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','attempting','sent','uncertain','cancelled')),
 message_id INTEGER,approval_state TEXT NOT NULL DEFAULT 'pending' CHECK(approval_state IN ('pending','approved','discarded')),
 receipt_json TEXT,last_checked_at INTEGER NOT NULL DEFAULT 0,result_notice TEXT NOT NULL DEFAULT 'pending' CHECK(result_notice IN ('pending','attempting','sent','uncertain')),
 PRIMARY KEY(installation_id,generation,bot_instance,id),UNIQUE(installation_id,generation,bot_instance,operation_id),
 UNIQUE(installation_id,generation,bot_instance,action_id)
);
CREATE TABLE IF NOT EXISTS assistant_telegram_send_callbacks (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 update_id INTEGER NOT NULL,query_id TEXT NOT NULL,payload_hash TEXT NOT NULL,review_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approved','discarded')),recorded_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,bot_instance,update_id),UNIQUE(installation_id,generation,bot_instance,query_id),
 UNIQUE(installation_id,generation,bot_instance,review_id)
);
-- Purging a decision removes copied bodies while preserving the one-send tombstone.
CREATE TRIGGER IF NOT EXISTS assistant_telegram_send_redact_decision AFTER DELETE ON assistant_shadow_decisions
BEGIN
 UPDATE assistant_telegram_send_reviews SET envelope_json='{}',target_json='{}',fence_json='{}',pilot_json='{}',state='cancelled'
 WHERE installation_id=OLD.installation_id AND generation=OLD.generation AND decision_id IN (OLD.id,'decision:'||OLD.id);
END;
