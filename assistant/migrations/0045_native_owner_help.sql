-- A help notice has one private Telegram attempt. Its task/anchor identity is
-- host fixed; an owner's quoted reply is a clarification, never send approval.
CREATE TABLE assistant_native_help_questions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,context_ref TEXT NOT NULL,
 task_json TEXT NOT NULL,anchor_task_ref TEXT NOT NULL,source_id TEXT NOT NULL,source_ref_json TEXT NOT NULL,
 original_sequence INTEGER NOT NULL,question_text TEXT,request_hash TEXT NOT NULL,
 link_json TEXT NOT NULL,credential_hash TEXT NOT NULL,thread_id INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','sent','uncertain','answered','resuming','resumed','cancelled')),
 message_id INTEGER,owner_update_id INTEGER,clarification_source_id TEXT,clarification_ref_json TEXT,
 receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(installation_id,generation,bot_instance,context_ref),
 UNIQUE(installation_id,generation,bot_instance,message_id),
 UNIQUE(installation_id,generation,bot_instance,owner_update_id)
);
CREATE INDEX assistant_native_help_source ON assistant_native_help_questions(installation_id,generation,source_id);
CREATE INDEX assistant_native_help_clarification ON assistant_native_help_questions(installation_id,generation,clarification_source_id);
CREATE TABLE assistant_native_help_replies (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 update_id INTEGER NOT NULL,question_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
 reply_to_message_id INTEGER NOT NULL,link_json TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,bot_instance,update_id),
 UNIQUE(installation_id,generation,bot_instance,question_id)
);
CREATE TRIGGER assistant_native_help_retire AFTER UPDATE OF tombstoned_at ON assistant_native_conversations
 WHEN NEW.tombstoned_at IS NOT NULL BEGIN
 UPDATE assistant_native_help_questions SET task_json='{}',source_ref_json='{}',question_text=NULL,clarification_ref_json=NULL,state='cancelled'
 WHERE conversation_id=NEW.id;
END;
