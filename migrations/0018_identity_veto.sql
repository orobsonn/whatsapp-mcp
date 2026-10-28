-- Identity contradictions veto automation without changing capture or routing.
ALTER TABLE chats ADD COLUMN identity_blocked INTEGER NOT NULL DEFAULT 0 CHECK(identity_blocked IN(0,1));
CREATE TRIGGER identity_veto_change AFTER UPDATE OF identity_blocked ON chats
WHEN OLD.identity_blocked=0 AND NEW.identity_blocked=1
BEGIN
 UPDATE actions SET status='cancelled' WHERE epoch=NEW.epoch AND generation=NEW.generation
  AND chat_id=NEW.id AND attempted_at IS NULL AND status IN('proposed','approved')
  AND id IN(SELECT action_id FROM approved_sends WHERE source_epoch=NEW.epoch AND source_generation=NEW.generation);
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.id,NEW.id,'conversation','access');
END;
