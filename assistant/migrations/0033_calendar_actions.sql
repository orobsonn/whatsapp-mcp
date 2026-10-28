-- External effects are never replayable jobs or model receipts. Keep a redacted
-- monotonic latch after source withdrawal; no restore imports this authority.
CREATE TABLE assistant_calendar_actions (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL,
 request_id TEXT NOT NULL, authority_id TEXT NOT NULL, affinity_hash TEXT NOT NULL,
 command_hash TEXT NOT NULL, command_json TEXT, result_json TEXT,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','applied','conflict','rejected','uncertain','cancelled')),
 purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,id)
);
CREATE INDEX assistant_calendar_actions_support ON assistant_calendar_actions(installation_id,generation,request_id,authority_id);

CREATE TRIGGER assistant_calendar_action_no_delete BEFORE DELETE ON assistant_calendar_actions
 BEGIN SELECT RAISE(ABORT,'monotone_calendar_action'); END;
CREATE TRIGGER assistant_calendar_action_immutable BEFORE UPDATE ON assistant_calendar_actions
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.id IS NOT OLD.id
 OR NEW.request_id IS NOT OLD.request_id OR NEW.authority_id IS NOT OLD.authority_id
 OR NEW.affinity_hash IS NOT OLD.affinity_hash OR NEW.command_hash IS NOT OLD.command_hash OR NEW.created_at IS NOT OLD.created_at
 OR NEW.purged<OLD.purged OR (NEW.command_json IS NOT OLD.command_json AND NOT(NEW.purged=1 AND NEW.command_json IS NULL))
 OR (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json AND NOT(NEW.purged=1 AND NEW.result_json IS NULL))
 OR (OLD.state<>'prepared' AND NEW.state='prepared') OR (OLD.state NOT IN ('prepared','attempting') AND NEW.state IS NOT OLD.state)
 OR (OLD.purged=1 AND (NEW.command_json IS NOT NULL OR NEW.result_json IS NOT NULL))
 BEGIN SELECT RAISE(ABORT,'monotone_calendar_action'); END;
