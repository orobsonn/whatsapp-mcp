-- These are observations of a remote archive, never present authorization.
CREATE TABLE IF NOT EXISTS assistant_origin_conversations (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
  chat_id TEXT NOT NULL, watermark INTEGER NOT NULL CHECK(watermark>=0),
  kind TEXT CHECK(kind IN ('private','group')), access_state TEXT NOT NULL CHECK(access_state IN ('available','withdrawn','unknown')),
  PRIMARY KEY(installation_id,generation,source_epoch,source_generation,chat_id)
);
CREATE TABLE IF NOT EXISTS assistant_source_origins (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('message','media','derivative')), source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL, canonical_id TEXT NOT NULL, watermark INTEGER NOT NULL CHECK(watermark>=0),
  observation_hash TEXT, tombstoned INTEGER NOT NULL DEFAULT 0 CHECK(tombstoned IN (0,1)),
  PRIMARY KEY(installation_id,generation,source_epoch,source_generation,source_kind,source_id),
  UNIQUE(installation_id,generation,canonical_id),
  FOREIGN KEY(installation_id,generation,canonical_id) REFERENCES assistant_sources(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_origin_versions (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, canonical_id TEXT NOT NULL, version INTEGER NOT NULL,
  source_version INTEGER, watermark INTEGER NOT NULL CHECK(watermark>=0), observation_hash TEXT NOT NULL,
  dependencies_json TEXT NOT NULL CHECK(length(dependencies_json)<=32768),
  PRIMARY KEY(installation_id,generation,canonical_id,version),
  FOREIGN KEY(installation_id,generation,canonical_id,version) REFERENCES assistant_source_versions(installation_id,generation,source_id,version)
);
CREATE TABLE IF NOT EXISTS assistant_materialization_results (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
  sequence INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('admitted','applied','blocked')),
  last_gap_reason TEXT, attempts INTEGER NOT NULL CHECK(attempts>0), next_retry_at INTEGER,
  observed_at INTEGER NOT NULL, watermark INTEGER, observation_hash TEXT,
  PRIMARY KEY(installation_id,generation,source_epoch,source_generation,sequence),
  FOREIGN KEY(installation_id,generation,source_epoch,source_generation,sequence)
    REFERENCES assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence)
);
CREATE TABLE IF NOT EXISTS assistant_materialization_progress (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
  evaluated_sequence INTEGER NOT NULL DEFAULT 0 CHECK(evaluated_sequence>=0),
  PRIMARY KEY(installation_id,generation,source_epoch,source_generation)
);
CREATE INDEX IF NOT EXISTS assistant_materialization_retries ON assistant_materialization_results(installation_id,generation,source_epoch,source_generation,state,next_retry_at,sequence);
CREATE INDEX IF NOT EXISTS assistant_inbox_unapplied ON assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence) WHERE application_state<>'applied';
CREATE INDEX IF NOT EXISTS assistant_inbox_unevaluated ON assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence) WHERE application_state='pending';
