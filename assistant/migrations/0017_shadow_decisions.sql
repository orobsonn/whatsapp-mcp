-- Exact host subjects; capture receipts are not duplicated or inferred from source IDs.
CREATE TABLE IF NOT EXISTS assistant_decision_jobs (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,job_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 subject_kind TEXT NOT NULL CHECK(subject_kind IN ('capture_event','owner_request','fup_occurrence')),
 subject_json TEXT NOT NULL CHECK(json_valid(subject_json) AND length(CAST(subject_json AS BLOB))<=2048 AND json_extract(subject_json,'$.kind') IS subject_kind),
 subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),seed_hash TEXT NOT NULL CHECK(length(seed_hash)=64),seeded_at INTEGER NOT NULL CHECK(seeded_at>=0),
 source_epoch TEXT,source_generation TEXT,chat_id TEXT,sequence INTEGER,metadata_hash TEXT,
 coalesced INTEGER CHECK(coalesced IS NULL OR coalesced IN (0,1)),observed_revision INTEGER,observed_watermark INTEGER,
 CHECK((subject_kind='capture_event' AND source_epoch IS NOT NULL AND source_generation IS NOT NULL AND chat_id IS NOT NULL AND sequence IS NOT NULL AND sequence>0 AND metadata_hash IS NOT NULL)
 OR (subject_kind<>'capture_event' AND source_epoch IS NULL AND source_generation IS NULL AND sequence IS NULL AND metadata_hash IS NULL)),
 PRIMARY KEY(installation_id,generation,job_id),UNIQUE(installation_id,generation,job_id,request_hash),UNIQUE(installation_id,generation,subject_hash),
 FOREIGN KEY(installation_id,generation,job_id,request_hash) REFERENCES assistant_job_ledger(installation_id,generation,job_id,request_hash)
);
CREATE INDEX IF NOT EXISTS assistant_decision_capture ON assistant_decision_jobs(installation_id,generation,source_epoch,source_generation,chat_id,sequence);
CREATE TABLE IF NOT EXISTS assistant_shadow_decisions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL CHECK(length(id)=64),job_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),episode_id TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('proposed','silence','waiting_context','failed','uncertain','cancelled')),
 reason TEXT CHECK(reason IS NULL OR reason IN ('budget_blocked','waiting_context','source_changed','publication_rejected','dispatch_uncertain','model_uncertain','cancelled','invariant_failure')),
 binding_hash TEXT,pack_hash TEXT,proposal_hash TEXT,
 dependencies_json TEXT NOT NULL CHECK(json_valid(dependencies_json) AND json_array_length(dependencies_json)<=10 AND length(CAST(dependencies_json AS BLOB))<=8192),
 receipts_json TEXT NOT NULL CHECK(json_valid(receipts_json) AND json_array_length(receipts_json)<=3 AND length(CAST(receipts_json AS BLOB))<=2048),
 proposal_json TEXT CHECK(proposal_json IS NULL OR (json_valid(proposal_json) AND length(CAST(proposal_json AS BLOB))<=32768)),
 recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),publication_nonce TEXT,
 CHECK((proposal_json IS NULL AND proposal_hash IS NULL) OR (proposal_json IS NOT NULL AND proposal_hash IS NOT NULL AND episode_id IS NOT NULL AND binding_hash IS NOT NULL AND pack_hash IS NOT NULL)),
 PRIMARY KEY(installation_id,generation,id),
 FOREIGN KEY(installation_id,generation,job_id,request_hash) REFERENCES assistant_decision_jobs(installation_id,generation,job_id,request_hash),
 FOREIGN KEY(installation_id,generation,episode_id) REFERENCES assistant_episodes(installation_id,generation,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_decision_publication ON assistant_shadow_decisions(installation_id,generation,episode_id) WHERE proposal_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS assistant_decision_page ON assistant_shadow_decisions(installation_id,generation,recorded_at,id);
CREATE INDEX IF NOT EXISTS assistant_decision_job ON assistant_shadow_decisions(installation_id,generation,job_id,recorded_at,id);
CREATE TRIGGER IF NOT EXISTS assistant_decision_seed_immutable BEFORE UPDATE ON assistant_decision_jobs BEGIN SELECT RAISE(ABORT,'decision_seed_immutable'); END;
-- A fresh publication nonce is a transient transaction attestation. Payload/identity stay immutable.
CREATE TRIGGER IF NOT EXISTS assistant_decision_result_immutable BEFORE UPDATE OF installation_id,generation,id,job_id,request_hash,lease_generation,episode_id,outcome,reason,binding_hash,pack_hash,proposal_hash,dependencies_json,receipts_json,proposal_json,recorded_at ON assistant_shadow_decisions BEGIN SELECT RAISE(ABORT,'decision_result_immutable'); END;
