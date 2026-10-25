-- Derivatives remain independently addressable; feed stores identifiers only.
CREATE TRIGGER assistant_derivative_insert AFTER INSERT ON media_derivatives
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 SELECT NEW.epoch,NEW.generation,m.chat_id,NEW.id,'derivative',
 CASE WHEN NEW.state='deleted' THEN 'withdraw' ELSE 'upsert' END
 FROM media m WHERE m.id=NEW.media_id AND m.message_id IS NOT NULL;
END;
CREATE TRIGGER assistant_derivative_update AFTER UPDATE ON media_derivatives
WHEN OLD.text IS NOT NEW.text OR OLD.object_key IS NOT NEW.object_key OR OLD.state IS NOT NEW.state
 OR OLD.media_version IS NOT NEW.media_version OR OLD.kind IS NOT NEW.kind
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 SELECT NEW.epoch,NEW.generation,m.chat_id,NEW.id,'derivative',
 CASE WHEN NEW.state='deleted' THEN 'withdraw' ELSE 'upsert' END
 FROM media m WHERE m.id=NEW.media_id AND m.message_id IS NOT NULL;
END;
CREATE TRIGGER assistant_derivative_delete AFTER DELETE ON media_derivatives
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 SELECT OLD.epoch,OLD.generation,m.chat_id,OLD.id,'derivative','withdraw'
 FROM media m WHERE m.id=OLD.media_id AND m.message_id IS NOT NULL;
END;
CREATE TRIGGER assistant_media_update AFTER UPDATE ON media
WHEN NEW.message_id IS NOT NULL AND (OLD.state IS NOT NEW.state OR OLD.sha256 IS NOT NEW.sha256
 OR OLD.version IS NOT NEW.version OR OLD.deleted_at IS NOT NEW.deleted_at
 OR OLD.object_key IS NOT NEW.object_key)
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.chat_id,NEW.id,'media',
 CASE WHEN NEW.deleted_at IS NOT NULL OR NEW.state='deleted' THEN 'withdraw' ELSE 'upsert' END);
END;
CREATE TRIGGER assistant_media_delete AFTER DELETE ON media
WHEN OLD.message_id IS NOT NULL
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(OLD.epoch,OLD.generation,OLD.chat_id,OLD.id,'media','withdraw');
END;
CREATE TRIGGER assistant_capture_policy_update AFTER UPDATE ON chats
WHEN OLD.capture_enabled IS NOT NEW.capture_enabled OR OLD.capture_since IS NOT NEW.capture_since
 OR OLD.capture_discontinuous IS NOT NEW.capture_discontinuous
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.id,NEW.id,'conversation','access');
END;

CREATE TRIGGER assistant_media_insert AFTER INSERT ON media
WHEN NEW.message_id IS NOT NULL
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.chat_id,NEW.id,'media',
 CASE WHEN NEW.deleted_at IS NOT NULL OR NEW.state='deleted' THEN 'withdraw' ELSE 'upsert' END);
END;
