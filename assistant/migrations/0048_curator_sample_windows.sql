-- A one-off sample is a separate operational receipt, never a daily cursor.
-- The existing UNIQUE day key remains: ISO dates for daily passages and
-- sample:<operationId> for explicitly requested samples.
ALTER TABLE assistant_curator_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'daily' CHECK(run_kind IN ('daily','sample'));
ALTER TABLE assistant_curator_runs ADD COLUMN civil_day TEXT;
-- Bound before any native registration/dispatch. A paused contender must reuse
-- this first identity even if that context is retired before it resumes.
ALTER TABLE assistant_curator_runs ADD COLUMN native_identity_json TEXT;
ALTER TABLE assistant_curator_runs ADD COLUMN native_session_id TEXT;
UPDATE assistant_curator_runs SET civil_day=day WHERE run_kind='daily';
CREATE TRIGGER assistant_curator_binding_immutable BEFORE UPDATE OF native_identity_json,native_session_id ON assistant_curator_runs
 WHEN OLD.native_session_id IS NOT NULL AND (NEW.native_session_id IS NOT OLD.native_session_id OR NEW.native_identity_json IS NOT OLD.native_identity_json)
 BEGIN SELECT RAISE(ABORT,'curator_sample_binding_immutable'); END;
CREATE TRIGGER assistant_curator_binding_no_replace BEFORE INSERT ON assistant_curator_runs
 WHEN EXISTS(SELECT 1 FROM assistant_curator_runs r WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation
  AND (r.id=NEW.id OR r.day=NEW.day) AND r.native_session_id IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'curator_sample_binding_immutable'); END;
