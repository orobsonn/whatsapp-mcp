-- Canonical audit history for a genuine owner request, never factual memory.
-- Operational Telegram claims remain outside canonical restore.
CREATE TRIGGER IF NOT EXISTS assistant_owner_request_private_insert BEFORE INSERT ON assistant_sources
 WHEN NEW.origin='owner_request' AND (NEW.audience<>'owner' OR NEW.conversation_id IS NOT NULL OR NEW.project_id IS NOT NULL OR (NEW.status='active' AND NEW.current_version IS NOT 1))
 BEGIN SELECT RAISE(ABORT,'immutable_owner_request'); END;
CREATE TRIGGER IF NOT EXISTS assistant_owner_request_immutable BEFORE UPDATE ON assistant_sources
 WHEN OLD.origin='owner_request' AND (NEW.origin IS NOT OLD.origin OR NEW.origin_key IS NOT OLD.origin_key
 OR NEW.audience<>'owner' OR NEW.conversation_id IS NOT NULL OR NEW.project_id IS NOT NULL OR (NEW.status='active' AND NEW.current_version IS NOT 1))
 BEGIN SELECT RAISE(ABORT,'immutable_owner_request'); END;
CREATE TRIGGER IF NOT EXISTS assistant_owner_request_one_version BEFORE INSERT ON assistant_source_versions
 WHEN NEW.version<>1 AND EXISTS(SELECT 1 FROM assistant_sources s WHERE s.installation_id=NEW.installation_id AND s.generation=NEW.generation AND s.id=NEW.source_id AND s.origin='owner_request')
 BEGIN SELECT RAISE(ABORT,'immutable_owner_request'); END;
