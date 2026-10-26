-- Additive administrative retention. Existing immutable media may be deleted
-- only inside the same D1 transaction that owns an exact withdrawn-source grant.
DROP TRIGGER IF EXISTS assistant_media_no_delete;
CREATE TABLE IF NOT EXISTS assistant_retention_barriers (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_id TEXT NOT NULL,origin TEXT NOT NULL,origin_key TEXT NOT NULL,
 base_revision INTEGER NOT NULL CHECK(base_revision>=0),source_version INTEGER NOT NULL CHECK(source_version>=0),
 operation_id TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),claim_token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending_withdraw','retired')),external_state TEXT NOT NULL CHECK(external_state IN ('pending','recorded','not_configured')),
 created_at INTEGER NOT NULL CHECK(created_at>=0),PRIMARY KEY(installation_id,generation,source_id)
);
CREATE INDEX IF NOT EXISTS assistant_retention_origin ON assistant_retention_barriers(installation_id,origin,origin_key);
CREATE INDEX IF NOT EXISTS assistant_retention_source ON assistant_retention_barriers(installation_id,source_id);
CREATE TRIGGER IF NOT EXISTS assistant_retention_barrier_no_delete BEFORE DELETE ON assistant_retention_barriers BEGIN SELECT RAISE(ABORT,'monotone_retention_barrier'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_barrier_no_replace BEFORE INSERT ON assistant_retention_barriers
 WHEN EXISTS(SELECT 1 FROM assistant_retention_barriers WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND source_id=NEW.source_id)
 BEGIN SELECT RAISE(ABORT,'monotone_retention_barrier'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_barrier_immutable BEFORE UPDATE ON assistant_retention_barriers
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.source_id IS NOT OLD.source_id OR NEW.origin IS NOT OLD.origin OR NEW.origin_key IS NOT OLD.origin_key
 OR NEW.base_revision IS NOT OLD.base_revision OR NEW.source_version IS NOT OLD.source_version OR NEW.operation_id IS NOT OLD.operation_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.claim_token IS NOT OLD.claim_token OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.state='retired' AND NEW.state<>'retired') OR (OLD.external_state='recorded' AND NEW.external_state<>'recorded')
 BEGIN SELECT RAISE(ABORT,'monotone_retention_barrier'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_source_insert BEFORE INSERT ON assistant_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=NEW.installation_id AND (b.source_id=NEW.id OR (b.origin=NEW.origin AND b.origin_key=NEW.origin_key)))
 BEGIN SELECT RAISE(ABORT,'source_retired'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_source_no_delete BEFORE DELETE ON assistant_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=OLD.installation_id AND (b.source_id=OLD.id OR (b.origin=OLD.origin AND b.origin_key=OLD.origin_key)))
 BEGIN SELECT RAISE(ABORT,'retained_source_tombstone'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_source_update BEFORE UPDATE ON assistant_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_barriers b WHERE b.installation_id=OLD.installation_id AND (b.source_id=OLD.id OR (b.origin=OLD.origin AND b.origin_key=OLD.origin_key)))
 AND (NEW.status<>'withdrawn' OR NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.id IS NOT OLD.id OR NEW.origin IS NOT OLD.origin OR NEW.origin_key IS NOT OLD.origin_key OR (NEW.current_version IS NOT OLD.current_version AND NEW.current_version IS NOT NULL)
 OR (NEW.revision IS NOT OLD.revision AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers own WHERE own.installation_id=OLD.installation_id AND own.generation=OLD.generation AND own.source_id=OLD.id AND own.base_revision=OLD.revision AND NEW.revision=own.base_revision+1 AND own.state='pending_withdraw')))
 BEGIN SELECT RAISE(ABORT,'source_retired'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_version_insert BEFORE INSERT ON assistant_source_versions
 WHEN EXISTS(SELECT 1 FROM assistant_sources s JOIN assistant_retention_barriers b ON b.installation_id=s.installation_id AND (b.source_id=s.id OR (b.origin=s.origin AND b.origin_key=s.origin_key)) WHERE s.installation_id=NEW.installation_id AND s.generation=NEW.generation AND s.id=NEW.source_id)
 BEGIN SELECT RAISE(ABORT,'source_retired'); END;
CREATE TABLE IF NOT EXISTS assistant_retention_purges (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),source_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','complete')),report_json TEXT CHECK(report_json IS NULL OR json_valid(report_json)),created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,operation_id)
);
CREATE TABLE IF NOT EXISTS assistant_retention_purge_refs (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,purge_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,
 PRIMARY KEY(installation_id,generation,purge_id,kind,id)
);
CREATE TABLE IF NOT EXISTS assistant_retention_purge_grants (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_id TEXT NOT NULL,purge_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,generation,source_id)
);
CREATE TRIGGER IF NOT EXISTS assistant_media_no_delete BEFORE DELETE ON assistant_media_artifacts
 WHEN NOT EXISTS(SELECT 1 FROM assistant_retention_purge_grants g JOIN assistant_sources s ON s.installation_id=g.installation_id AND s.generation=g.generation AND s.id=g.source_id
 WHERE g.installation_id=OLD.installation_id AND g.generation=OLD.generation AND g.source_id=OLD.source_id AND s.status='withdrawn')
 BEGIN SELECT RAISE(ABORT,'immutable_media_artifact'); END;
CREATE TABLE IF NOT EXISTS assistant_retention_object_claims (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,operation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','deleted','uncertain')),created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 PRIMARY KEY(installation_id,generation,object_key)
);
CREATE TRIGGER IF NOT EXISTS assistant_retention_object_reference BEFORE INSERT ON assistant_source_versions
 WHEN NEW.original_object_key IS NOT NULL AND EXISTS(SELECT 1 FROM assistant_retention_object_claims WHERE object_key=NEW.original_object_key)
 BEGIN SELECT RAISE(ABORT,'object_retirement_claimed'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_object_claim_reference BEFORE INSERT ON assistant_retention_object_claims
 WHEN EXISTS(SELECT 1 FROM assistant_source_versions WHERE original_object_key=NEW.object_key)
 BEGIN SELECT RAISE(ABORT,'object_still_referenced'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_object_claim_no_delete BEFORE DELETE ON assistant_retention_object_claims BEGIN SELECT RAISE(ABORT,'monotone_object_claim'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_object_claim_no_replace BEFORE INSERT ON assistant_retention_object_claims
 WHEN EXISTS(SELECT 1 FROM assistant_retention_object_claims WHERE object_key=NEW.object_key)
 BEGIN SELECT RAISE(ABORT,'monotone_object_claim'); END;
CREATE TRIGGER IF NOT EXISTS assistant_retention_object_claim_immutable BEFORE UPDATE ON assistant_retention_object_claims
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.object_key IS NOT OLD.object_key OR NEW.operation_id IS NOT OLD.operation_id OR NEW.created_at IS NOT OLD.created_at OR (OLD.state='deleted' AND NEW.state<>'deleted')
 BEGIN SELECT RAISE(ABORT,'monotone_object_claim'); END;
