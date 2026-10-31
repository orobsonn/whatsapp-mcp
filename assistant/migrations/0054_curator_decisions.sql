-- Private bounded descriptions, never full originals or hidden reasoning.
ALTER TABLE assistant_curator_runs ADD COLUMN model_id TEXT;
ALTER TABLE assistant_curator_runs ADD COLUMN instructions_hash TEXT;
ALTER TABLE assistant_curator_runs ADD COLUMN help_request TEXT;
CREATE TABLE assistant_curator_decisions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 source_id TEXT NOT NULL,revision INTEGER NOT NULL,version INTEGER NOT NULL,source_hash TEXT NOT NULL,
 decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),intent_operation_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(intent_operation_ids_json)),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,run_id,sequence),
 FOREIGN KEY(installation_id,generation,run_id,sequence) REFERENCES assistant_curator_items(installation_id,generation,run_id,sequence) ON DELETE CASCADE
);
CREATE INDEX assistant_curator_decision_source ON assistant_curator_decisions(installation_id,generation,source_id);
CREATE TRIGGER assistant_curator_decision_withdraw AFTER UPDATE OF status,revision,current_version ON assistant_sources
 WHEN NEW.status<>'active' OR NEW.revision<>OLD.revision OR NEW.current_version IS NOT OLD.current_version
 BEGIN
 DELETE FROM assistant_curator_decisions WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND source_id=NEW.id;
 END;
