-- Host-only media receipts. A crashed parser/attempt is never a retry permit.
CREATE TABLE IF NOT EXISTS assistant_media_receipts (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_key TEXT NOT NULL,
 source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,
 blob_hash TEXT NOT NULL,config_hash TEXT NOT NULL,request_hash TEXT,
 state TEXT NOT NULL CHECK(state IN ('parsing','prepared','attempting','response_ready','complete','uncertain','blocked')),
 admission_json TEXT,response_json TEXT,actual_units INTEGER,reason TEXT,created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,operation_key),
 CHECK(actual_units IS NULL OR (typeof(actual_units)='integer' AND actual_units>=0)),
 FOREIGN KEY(installation_id,generation,source_id) REFERENCES assistant_sources(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_media_artifacts (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_key TEXT NOT NULL,
 source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,
 blob_hash TEXT NOT NULL,config_hash TEXT NOT NULL,text_hash TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,operation_key),
 FOREIGN KEY(installation_id,generation,source_id) REFERENCES assistant_sources(installation_id,generation,id),
 FOREIGN KEY(installation_id,generation,operation_key) REFERENCES assistant_media_receipts(installation_id,generation,operation_key)
);
CREATE TRIGGER IF NOT EXISTS assistant_media_no_replace BEFORE INSERT ON assistant_media_artifacts WHEN EXISTS(SELECT 1 FROM assistant_media_artifacts WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND operation_key=NEW.operation_key) BEGIN SELECT RAISE(ABORT,'immutable_media_artifact'); END;
CREATE TRIGGER IF NOT EXISTS assistant_media_no_update BEFORE UPDATE ON assistant_media_artifacts BEGIN SELECT RAISE(ABORT,'immutable_media_artifact'); END;
CREATE TRIGGER IF NOT EXISTS assistant_media_no_delete BEFORE DELETE ON assistant_media_artifacts BEGIN SELECT RAISE(ABORT,'immutable_media_artifact'); END;
CREATE INDEX IF NOT EXISTS assistant_media_parent ON assistant_media_artifacts(installation_id,generation,source_id,source_revision,source_version,source_hash);
