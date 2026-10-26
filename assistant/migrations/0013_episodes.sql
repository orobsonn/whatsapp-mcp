-- Host bindings are separate from Flue transcripts and paid model receipts.
CREATE TABLE IF NOT EXISTS assistant_episodes (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL,
 job_id TEXT NOT NULL, episode_generation INTEGER NOT NULL CHECK(episode_generation BETWEEN 1 AND 3),
 request_hash TEXT NOT NULL, binding_hash TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=131072),
 profile TEXT NOT NULL CHECK(profile IN ('owner','interlocutor')), runtime_id TEXT NOT NULL,
 deadline INTEGER NOT NULL, max_calls INTEGER NOT NULL CHECK(max_calls BETWEEN 1 AND 3),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatching','accepted','running','uncertain','settled','blocked')),
 reason TEXT, search_nonce TEXT, work_nonce TEXT, target_nonce TEXT, receipt_json TEXT CHECK(receipt_json IS NULL OR length(receipt_json)<=4096),
 result_json TEXT CHECK(result_json IS NULL OR length(result_json)<=32768),
 dispatch_json TEXT CHECK(dispatch_json IS NULL OR (json_valid(dispatch_json) AND length(CAST(dispatch_json AS BLOB))<=65536)),
 dispatch_hash TEXT, submission_id TEXT, transport_attempts INTEGER NOT NULL DEFAULT 0 CHECK(transport_attempts BETWEEN 0 AND 2),
 CHECK((dispatch_json IS NULL)=(dispatch_hash IS NULL)),
 PRIMARY KEY(installation_id,generation,id), UNIQUE(installation_id,generation,job_id,episode_generation),
 UNIQUE(installation_id,generation,profile,runtime_id),
 FOREIGN KEY(installation_id,generation,job_id,request_hash) REFERENCES assistant_job_ledger(installation_id,generation,job_id,request_hash)
);
CREATE TABLE IF NOT EXISTS assistant_episode_calls (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, episode_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3), payload_hash TEXT NOT NULL,
 token TEXT NOT NULL, operation_key TEXT, broker_hash TEXT, claim_nonce TEXT,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','attempting','complete','uncertain')),
 PRIMARY KEY(installation_id,generation,episode_id,ordinal), UNIQUE(installation_id,generation,episode_id,payload_hash),
 FOREIGN KEY(installation_id,generation,episode_id) REFERENCES assistant_episodes(installation_id,generation,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_episode_active_call ON assistant_episode_calls(installation_id,generation,episode_id) WHERE state IN ('prepared','attempting');
CREATE TRIGGER IF NOT EXISTS assistant_episode_binding_immutable BEFORE UPDATE OF installation_id,generation,id,job_id,episode_generation,request_hash,binding_hash,binding_json,profile,runtime_id,deadline,max_calls ON assistant_episodes BEGIN SELECT RAISE(ABORT,'episode_binding_immutable'); END;
CREATE TRIGGER IF NOT EXISTS assistant_episode_envelope_immutable BEFORE UPDATE OF dispatch_json,dispatch_hash,submission_id ON assistant_episodes
 WHEN (OLD.dispatch_json IS NOT NULL AND (NEW.dispatch_json IS NOT OLD.dispatch_json OR NEW.dispatch_hash IS NOT OLD.dispatch_hash))
 OR (OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id)
 BEGIN SELECT RAISE(ABORT,'episode_envelope_immutable'); END;
