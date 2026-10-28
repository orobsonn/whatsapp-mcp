-- Source metadata only. Direct, disjoint pairs; never a contact merge or ACL.
CREATE TABLE conversation_relationships (
 epoch TEXT NOT NULL,generation TEXT NOT NULL,instance_id TEXT NOT NULL,
 phone_chat_id TEXT NOT NULL,lid_chat_id TEXT NOT NULL,
 proof_hash TEXT NOT NULL,conflict_proof_hash TEXT,
 revision INTEGER NOT NULL CHECK(revision>0),state TEXT NOT NULL CHECK(state IN('active','blocked')),
 observed_at INTEGER NOT NULL,
 PRIMARY KEY(epoch,generation,phone_chat_id),UNIQUE(epoch,generation,lid_chat_id),
 CHECK(phone_chat_id<>lid_chat_id)
);
-- Original owner sends remain evidence after edits/deletions, without retaining text.
CREATE TABLE owner_message_originals (
 epoch TEXT NOT NULL,generation TEXT NOT NULL,chat_id TEXT NOT NULL,source_id TEXT NOT NULL,
 original_sequence INTEGER NOT NULL,
 PRIMARY KEY(epoch,generation,chat_id,source_id)
);
INSERT INTO owner_message_originals(epoch,generation,chat_id,source_id,original_sequence)
 SELECT m.epoch,m.generation,m.chat_id,m.id,MIN(c.sequence)
 FROM messages m JOIN assistant_capture_changes c ON c.epoch=m.epoch AND c.generation=m.generation AND c.chat_id=m.chat_id AND c.source_id=m.id AND c.source_kind='message' AND c.operation='upsert'
 WHERE m.from_me=1 GROUP BY m.epoch,m.generation,m.chat_id,m.id;
CREATE TRIGGER owner_message_original_capture AFTER INSERT ON assistant_capture_changes
WHEN NEW.source_kind='message' AND NEW.operation='upsert'
 AND EXISTS(SELECT 1 FROM messages m WHERE m.id=NEW.source_id AND m.chat_id=NEW.chat_id AND m.epoch=NEW.epoch AND m.generation=NEW.generation AND m.from_me=1)
BEGIN
 INSERT INTO owner_message_originals(epoch,generation,chat_id,source_id,original_sequence)
 VALUES(NEW.epoch,NEW.generation,NEW.chat_id,NEW.source_id,NEW.sequence)
 ON CONFLICT(epoch,generation,chat_id,source_id) DO UPDATE SET original_sequence=MIN(original_sequence,excluded.original_sequence);
END;
ALTER TABLE approved_sends ADD COLUMN activity_json TEXT;
-- Bootstrap is one reviewed INSERT; these effects share that transaction.
CREATE TRIGGER conversation_relationship_insert AFTER INSERT ON conversation_relationships
BEGIN
 UPDATE actions SET status='cancelled' WHERE epoch=NEW.epoch AND generation=NEW.generation
  AND chat_id IN(NEW.phone_chat_id,NEW.lid_chat_id) AND attempted_at IS NULL AND status IN('proposed','approved')
  AND id IN(SELECT action_id FROM approved_sends WHERE source_epoch=NEW.epoch AND source_generation=NEW.generation);
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.phone_chat_id,NEW.phone_chat_id,'conversation','access');
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.lid_chat_id,NEW.lid_chat_id,'conversation','access');
END;
CREATE TRIGGER conversation_relationship_change AFTER UPDATE OF state,revision ON conversation_relationships
WHEN OLD.state<>NEW.state OR OLD.revision<>NEW.revision
BEGIN
 UPDATE actions SET status='cancelled' WHERE epoch=NEW.epoch AND generation=NEW.generation
  AND chat_id IN(NEW.phone_chat_id,NEW.lid_chat_id) AND attempted_at IS NULL AND status IN('proposed','approved')
  AND id IN(SELECT action_id FROM approved_sends WHERE source_epoch=NEW.epoch AND source_generation=NEW.generation);
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.phone_chat_id,NEW.phone_chat_id,'conversation','access');
 INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_id,source_kind,operation)
 VALUES(NEW.epoch,NEW.generation,NEW.lid_chat_id,NEW.lid_chat_id,'conversation','access');
END;
