-- Private operational model phases. Never canonical restore work.
-- No episode FK: purge deletes runtime rows but retains this no-retry latch.
CREATE TABLE IF NOT EXISTS assistant_telegram_dialogue_phases (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,request_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('intent','answer')),
 episode_id TEXT NOT NULL,binding_hash TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)),period TEXT NOT NULL,
 operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,config_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,
 body_json TEXT CHECK(body_json IS NULL OR (json_valid(body_json) AND length(CAST(body_json AS BLOB))<=65536)),
 deps_json TEXT NOT NULL CHECK(json_valid(deps_json) AND json_type(deps_json)='array' AND length(CAST(deps_json AS BLOB))<=32768),deadline_at INTEGER NOT NULL,
 freeze_token TEXT NOT NULL,run_token TEXT,claim_nonce TEXT,
 state TEXT NOT NULL CHECK(state IN ('frozen','invoking','attempting','complete','uncertain','cancelled')),
 result_json TEXT,result_hash TEXT,purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN (0,1)),
 PRIMARY KEY(installation_id,generation,request_id,phase),
 FOREIGN KEY(installation_id,generation,request_id) REFERENCES assistant_sources(installation_id,generation,id),
 CHECK((phase='intent' AND ordinal=1) OR (phase='answer' AND ordinal=2)),
 CHECK(purged=1 OR body_json IS NOT NULL),CHECK(state<>'complete' OR purged=1 OR (result_json IS NOT NULL AND result_hash IS NOT NULL)),
 CHECK(purged=0 OR (body_json IS NULL AND result_json IS NULL AND deps_json='[]'))
);
CREATE TRIGGER IF NOT EXISTS assistant_dialogue_phase_no_delete BEFORE DELETE ON assistant_telegram_dialogue_phases
 BEGIN SELECT RAISE(ABORT,'monotone_dialogue_phase'); END;
CREATE TRIGGER IF NOT EXISTS assistant_dialogue_phase_immutable BEFORE UPDATE ON assistant_telegram_dialogue_phases
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.request_id IS NOT OLD.request_id OR NEW.phase IS NOT OLD.phase
 OR NEW.episode_id IS NOT OLD.episode_id OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.ordinal IS NOT OLD.ordinal OR NEW.period IS NOT OLD.period
 OR NEW.operation_key IS NOT OLD.operation_key OR NEW.request_hash IS NOT OLD.request_hash OR NEW.config_hash IS NOT OLD.config_hash OR NEW.payload_hash IS NOT OLD.payload_hash
 OR NEW.deadline_at IS NOT OLD.deadline_at OR NEW.freeze_token IS NOT OLD.freeze_token OR (OLD.run_token IS NOT NULL AND NEW.run_token IS NOT OLD.run_token)
 OR (NEW.body_json IS NOT OLD.body_json AND NOT(NEW.purged=1 AND NEW.body_json IS NULL))
 OR (NEW.deps_json IS NOT OLD.deps_json AND NOT(NEW.purged=1 AND NEW.deps_json='[]')) OR NEW.purged<OLD.purged
 OR (OLD.state='complete' AND NOT(NEW.state='complete' OR (NEW.state='cancelled' AND NEW.purged=1)))
 OR (OLD.state='uncertain' AND NOT(NEW.state='uncertain' OR (NEW.state='cancelled' AND NEW.purged=1)))
 OR (OLD.state='cancelled' AND NEW.state<>'cancelled')
 OR (OLD.state='invoking' AND NEW.state NOT IN ('invoking','attempting','uncertain','cancelled'))
 OR (OLD.state='attempting' AND NEW.state NOT IN ('attempting','complete','uncertain','cancelled'))
 BEGIN SELECT RAISE(ABORT,'monotone_dialogue_phase'); END;
