-- One logical action per notice/proposal, independent of RPC delivery retries.
CREATE TABLE assistant_approved_sends (
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id,generation,source_epoch,source_generation,operation_id)
);
-- Frozen display metadata obeys the action payload's existing retention/purge.
CREATE TRIGGER assistant_approved_sends_redact
AFTER UPDATE OF envelope_json ON actions WHEN NEW.envelope_json='{}'
BEGIN
  UPDATE assistant_approved_sends SET target_json='{}' WHERE action_id=NEW.id;
END;
CREATE TRIGGER assistant_approved_sends_delete_redact
AFTER DELETE ON actions
BEGIN
  UPDATE assistant_approved_sends SET target_json='{}' WHERE action_id=OLD.id;
END;
