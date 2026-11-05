-- Internal image copies are not textual knowledge sources.
DROP TRIGGER assistant_derivative_insert;
DROP TRIGGER assistant_derivative_update;
DROP TRIGGER assistant_derivative_delete;
-- Derivatives remain independently addressable; feed stores identifiers only.
CREATE TRIGGER assistant_derivative_insert AFTER INSERT ON media_derivatives
WHEN NEW.kind<>'image_rendition'
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 SELECT NEW.epoch,NEW.generation,m.chat_id,NEW.id,'derivative',
 CASE WHEN NEW.state='deleted' THEN 'withdraw' ELSE 'upsert' END
 FROM media m WHERE m.id=NEW.media_id AND m.message_id IS NOT NULL;
END;
CREATE TRIGGER assistant_derivative_update AFTER UPDATE ON media_derivatives
WHEN NEW.kind<>'image_rendition' AND (OLD.text IS NOT NEW.text OR OLD.object_key IS NOT NEW.object_key OR OLD.state IS NOT NEW.state
 OR OLD.media_version IS NOT NEW.media_version OR OLD.kind IS NOT NEW.kind)
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 SELECT NEW.epoch,NEW.generation,m.chat_id,NEW.id,'derivative',
 CASE WHEN NEW.state='deleted' THEN 'withdraw' ELSE 'upsert' END
 FROM media m WHERE m.id=NEW.media_id AND m.message_id IS NOT NULL;
END;
CREATE TRIGGER assistant_derivative_delete AFTER DELETE ON media_derivatives
WHEN OLD.kind<>'image_rendition'
BEGIN
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 SELECT OLD.epoch,OLD.generation,m.chat_id,OLD.id,'derivative','withdraw'
 FROM media m WHERE m.id=OLD.media_id AND m.message_id IS NOT NULL;
END;
