-- Metadata-only feed. Material changes and this append commit in the same SQLite transaction.
-- No FK to source: a withdrawal must survive physical deletion of its source.
CREATE TABLE assistant_capture_changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 epoch TEXT NOT NULL, generation TEXT NOT NULL,
 chat_id TEXT NOT NULL, source_id TEXT NOT NULL,
 source_kind TEXT NOT NULL DEFAULT 'message',
 operation TEXT NOT NULL CHECK(operation IN ('upsert','withdraw','access')),
 recorded_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX assistant_capture_changes_scope ON assistant_capture_changes(epoch,generation,sequence);
CREATE TRIGGER assistant_message_insert AFTER INSERT ON messages
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.chat_id,NEW.id,
 CASE WHEN NEW.deleted_at IS NOT NULL OR NEW.privacy_locked=1 THEN 'withdraw' ELSE 'upsert' END);
END;
CREATE TRIGGER assistant_message_update AFTER UPDATE ON messages
WHEN OLD.text IS NOT NEW.text OR OLD.kind IS NOT NEW.kind OR OLD.version IS NOT NEW.version
 OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.privacy_locked IS NOT NEW.privacy_locked
 OR OLD.author_id IS NOT NEW.author_id OR OLD.unavailable_reason IS NOT NEW.unavailable_reason
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.chat_id,NEW.id,
 CASE WHEN NEW.deleted_at IS NOT NULL OR NEW.privacy_locked=1 THEN 'withdraw' ELSE 'upsert' END);
END;
CREATE TRIGGER assistant_message_delete AFTER DELETE ON messages
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,operation)
 VALUES(OLD.epoch,OLD.generation,OLD.chat_id,OLD.id,'withdraw');
END;
