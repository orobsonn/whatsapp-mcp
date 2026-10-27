-- Owner discovery uses the existing UNIQUE source/revision attempt in0026.
-- These tables carry immutable proofs and private status, never another attempt.
CREATE UNIQUE INDEX IF NOT EXISTS owner_context_slot_pin ON assistant_canonical_extractions(installation_id,generation,source_id,source_revision,slot_key,pin_hash);
CREATE UNIQUE INDEX IF NOT EXISTS owner_context_batch_ref ON assistant_relation_batches(installation_id,generation,operation_key,source_id,source_revision,source_version,source_hash);
CREATE TABLE IF NOT EXISTS assistant_owner_canonical_supports (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,
 slot_key TEXT NOT NULL,pin_hash TEXT NOT NULL,proof_hash TEXT NOT NULL,
 proof_json TEXT NOT NULL CHECK(json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=32768),
 PRIMARY KEY(installation_id,generation,source_id,source_revision),UNIQUE(installation_id,generation,slot_key),
 FOREIGN KEY(installation_id,generation,source_id,source_revision,slot_key,pin_hash) REFERENCES assistant_canonical_extractions(installation_id,generation,source_id,source_revision,slot_key,pin_hash),
 CHECK(substr(slot_key,1,19)='canonical-owner-v2:' AND length(slot_key)=83)
);
CREATE TABLE IF NOT EXISTS assistant_owner_relation_proofs (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_key TEXT NOT NULL,
 source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,
 slot_key TEXT NOT NULL,pin_hash TEXT NOT NULL,config_hash TEXT NOT NULL,catalog_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,support_hash TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility='owner'),
 PRIMARY KEY(installation_id,generation,operation_key),
 FOREIGN KEY(installation_id,generation,operation_key,source_id,source_revision,source_version,source_hash) REFERENCES assistant_relation_batches(installation_id,generation,operation_key,source_id,source_revision,source_version,source_hash),
 FOREIGN KEY(installation_id,generation,source_id,source_revision,slot_key,pin_hash) REFERENCES assistant_canonical_extractions(installation_id,generation,source_id,source_revision,slot_key,pin_hash),
 CHECK(operation_key=slot_key AND substr(operation_key,1,19)='canonical-owner-v2:' AND length(operation_key)=83)
);
CREATE TABLE IF NOT EXISTS assistant_owner_canonical_status (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,item_id TEXT NOT NULL,
 source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,
 body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(CAST(body_json AS BLOB))<=4096),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,item_id),
 FOREIGN KEY(installation_id,generation,source_epoch,source_generation,item_id) REFERENCES assistant_routine_items(installation_id,generation,source_epoch,source_generation,id)
);
CREATE TRIGGER IF NOT EXISTS owner_relation_marker_immutable BEFORE UPDATE ON assistant_relation_batches
 WHEN substr(OLD.operation_key,1,19)='canonical-owner-v2:' OR EXISTS(SELECT 1 FROM assistant_owner_relation_proofs p WHERE p.installation_id=OLD.installation_id AND p.generation=OLD.generation AND p.operation_key=OLD.operation_key)
 BEGIN SELECT RAISE(ABORT,'owner_relation_marker_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_support_proof_immutable BEFORE UPDATE ON assistant_owner_canonical_supports
 BEGIN SELECT RAISE(ABORT,'owner_context_proof_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_relation_proof_immutable BEFORE UPDATE ON assistant_owner_relation_proofs
 BEGIN SELECT RAISE(ABORT,'owner_context_proof_immutable'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_canonical_supports_insert BEFORE INSERT ON assistant_owner_canonical_supports
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=NEW.installation_id AND p.generation=NEW.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_canonical_supports_update BEFORE UPDATE ON assistant_owner_canonical_supports
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=NEW.installation_id AND p.generation=NEW.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_canonical_supports_delete BEFORE DELETE ON assistant_owner_canonical_supports
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=OLD.installation_id AND p.generation=OLD.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_relation_proofs_insert BEFORE INSERT ON assistant_owner_relation_proofs
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=NEW.installation_id AND p.generation=NEW.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_relation_proofs_update BEFORE UPDATE ON assistant_owner_relation_proofs
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=NEW.installation_id AND p.generation=NEW.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_relation_proofs_delete BEFORE DELETE ON assistant_owner_relation_proofs
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=OLD.installation_id AND p.generation=OLD.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_canonical_status_insert BEFORE INSERT ON assistant_owner_canonical_status
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=NEW.installation_id AND p.generation=NEW.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_canonical_status_update BEFORE UPDATE ON assistant_owner_canonical_status
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=NEW.installation_id AND p.generation=NEW.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_owner_canonical_status_delete BEFORE DELETE ON assistant_owner_canonical_status
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=OLD.installation_id AND p.generation=OLD.generation)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS owner_context_slot_immutable BEFORE UPDATE ON assistant_canonical_extractions
 WHEN substr(OLD.slot_key,1,19)='canonical-owner-v2:' AND (
 NEW.installation_id<>OLD.installation_id OR NEW.generation<>OLD.generation OR NEW.source_id<>OLD.source_id OR NEW.source_revision<>OLD.source_revision OR NEW.source_version<>OLD.source_version OR NEW.source_hash<>OLD.source_hash
 OR NEW.slot_key<>OLD.slot_key OR NEW.pin_hash<>OLD.pin_hash OR NEW.config_hash<>OLD.config_hash OR NEW.actor_json<>OLD.actor_json OR NEW.fence_json<>OLD.fence_json OR NEW.origin_json IS NOT OLD.origin_json
 OR (OLD.operation_key IS NOT NULL AND (NEW.operation_key IS NOT OLD.operation_key OR NEW.request_hash IS NOT OLD.request_hash)) OR (OLD.state<>'prepared' AND NEW.state='prepared')
 OR ((NEW.catalog_json<>OLD.catalog_json OR NEW.payload_json<>OLD.payload_json) AND NOT(NEW.state='rejected' AND NEW.gap='canonical_context_purged' AND NEW.catalog_json='[]' AND NEW.payload_json='{}' AND EXISTS(SELECT 1 FROM assistant_retention_purge_grants p WHERE p.installation_id=OLD.installation_id AND p.generation=OLD.generation))))
 BEGIN SELECT RAISE(ABORT,'owner_context_slot_immutable'); END;
