-- Host-only single attempt per source revision. Operational latches and model
-- payloads are excluded from canonical snapshots; paid #37 is preserved.
CREATE TABLE IF NOT EXISTS assistant_canonical_extractions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL CHECK(source_revision>0),
 source_version INTEGER NOT NULL CHECK(source_version>0),source_hash TEXT NOT NULL,slot_key TEXT NOT NULL,pin_hash TEXT NOT NULL,config_hash TEXT NOT NULL,
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),fence_json TEXT NOT NULL CHECK(json_valid(fence_json)),origin_json TEXT CHECK(origin_json IS NULL OR json_valid(origin_json)),
 catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json) AND length(CAST(catalog_json AS BLOB))<=8192),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),period TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','uncertain','published','rejected')),operation_key TEXT,request_hash TEXT,
 claims_count INTEGER CHECK(claims_count IS NULL OR (claims_count>=0 AND claims_count<=8)),gap TEXT,created_at INTEGER NOT NULL,
 CHECK((operation_key IS NULL)=(request_hash IS NULL)),CHECK(state<>'published' OR (claims_count IS NOT NULL AND operation_key IS NOT NULL)),
 PRIMARY KEY(installation_id,generation,source_id,source_revision),
 FOREIGN KEY(installation_id,generation,source_id,source_version) REFERENCES assistant_source_versions(installation_id,generation,source_id,version)
);
CREATE INDEX IF NOT EXISTS canonical_extraction_status ON assistant_canonical_extractions(installation_id,generation,state,source_id);
CREATE TRIGGER IF NOT EXISTS retention_freeze_canonical_extraction_insert BEFORE INSERT ON assistant_canonical_extractions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_canonical_extraction_update BEFORE UPDATE ON assistant_canonical_extractions
 WHEN NEW.state IN ('prepared','attempting','published') AND EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_canonical_extraction_delete BEFORE DELETE ON assistant_canonical_extractions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=OLD.installation_id AND p.generation=OLD.generation AND p.source_id=OLD.source_id)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
