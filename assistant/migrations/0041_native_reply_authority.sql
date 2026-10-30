-- Native effects reuse Source approved_sends/actions. No copied credentials or
-- provider send implementation. One immutable effect slot per native intent.
CREATE TABLE assistant_native_reply_actions (
 intent_id TEXT PRIMARY KEY REFERENCES assistant_native_reply_intents(id),
 installation_id TEXT NOT NULL,
 generation TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 task_json TEXT NOT NULL,
 text TEXT NOT NULL,
 summary TEXT NOT NULL,
 action_id TEXT UNIQUE,
 prepared_json TEXT,
 authority_json TEXT,
 human_guard_json TEXT,
 receipt_json TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX assistant_native_reply_actions_scope ON assistant_native_reply_actions(installation_id,generation,conversation_id);
-- Invalidation preserves the minimal effect/attempt correlation, removing
-- duplicated text/context. Never reopen a Source operation after withdrawal.
CREATE TRIGGER assistant_native_reply_actions_redact AFTER UPDATE OF tombstoned_at ON assistant_native_conversations
 WHEN NEW.tombstoned_at IS NOT NULL
 BEGIN
 UPDATE assistant_native_reply_actions SET task_json='{}',text='',summary='',prepared_json=NULL,authority_json=NULL,human_guard_json=NULL
 WHERE conversation_id=NEW.id;
 END;
