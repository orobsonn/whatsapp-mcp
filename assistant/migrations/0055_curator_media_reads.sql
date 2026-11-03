-- Host-issued read custody, never media bodies or model reasoning.
CREATE TABLE assistant_curator_media_reads (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,
 source_id TEXT NOT NULL,revision INTEGER NOT NULL,version INTEGER NOT NULL,source_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('available','pending','unavailable')),complete INTEGER NOT NULL CHECK(complete IN (0,1)),
 reason TEXT,updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,run_id,source_id,revision,version,source_hash),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_curator_runs(installation_id,generation,id) ON DELETE CASCADE
);
CREATE INDEX assistant_curator_media_read_source ON assistant_curator_media_reads(installation_id,generation,source_id);
CREATE TRIGGER assistant_curator_media_read_withdraw AFTER UPDATE OF status,revision,current_version ON assistant_sources
 WHEN NEW.status<>'active' OR NEW.revision<>OLD.revision OR NEW.current_version IS NOT OLD.current_version
 BEGIN
 DELETE FROM assistant_curator_media_reads WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND source_id=NEW.id;
 END;
