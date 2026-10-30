CREATE TABLE assistant_native_telegram_reviews (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 id TEXT NOT NULL,intent_id TEXT NOT NULL,conversation_id TEXT NOT NULL,operation_id TEXT NOT NULL,
 fence_json TEXT NOT NULL,credential_hash TEXT NOT NULL,thread_id INTEGER NOT NULL,
 action_id TEXT NOT NULL,action_hash TEXT NOT NULL,review_hash TEXT NOT NULL,context_source_id TEXT,context_ref_json TEXT NOT NULL,
 context_guard_json TEXT,expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','sent','uncertain','cancelled')),
 message_id INTEGER,approval_state TEXT NOT NULL DEFAULT 'pending' CHECK(approval_state IN ('pending','approved','discarded')),
 receipt_json TEXT,result_status TEXT,result_state TEXT NOT NULL DEFAULT 'pending' CHECK(result_state IN ('pending','attempting','sent','uncertain')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,bot_instance,id),
 UNIQUE(installation_id,generation,bot_instance,intent_id),
 UNIQUE(installation_id,generation,bot_instance,operation_id)
);
CREATE TABLE assistant_native_telegram_callbacks (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 update_id INTEGER NOT NULL,query_id TEXT NOT NULL,payload_hash TEXT NOT NULL,review_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approved','discarded')),created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,bot_instance,update_id),
 UNIQUE(installation_id,generation,bot_instance,query_id),
 UNIQUE(installation_id,generation,bot_instance,review_id)
);
CREATE TRIGGER assistant_native_telegram_reviews_redact AFTER UPDATE OF tombstoned_at ON assistant_native_conversations
 WHEN NEW.tombstoned_at IS NOT NULL
 BEGIN
 UPDATE assistant_native_telegram_reviews SET context_ref_json='{}',context_source_id=NULL,context_guard_json=NULL,state='cancelled'
 WHERE conversation_id=NEW.id;
 END;
