-- Private host capability and model receipts. No provider credential is stored.
CREATE TABLE IF NOT EXISTS assistant_model_permits (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,token_hash TEXT NOT NULL,
 source_id TEXT NOT NULL,fence_json TEXT NOT NULL CHECK(json_valid(fence_json)),config_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>=0),
 PRIMARY KEY(installation_id,generation,token_hash),
 FOREIGN KEY(installation_id,generation,source_id) REFERENCES assistant_sources(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_model_receipts (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,
 source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,config_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('attempting','uncertain','response_ready','complete')),
 response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB))<=262144)),
 actual_units INTEGER CHECK(actual_units IS NULL OR actual_units>=0),created_at INTEGER NOT NULL,
 CHECK((state='attempting' AND response_json IS NULL AND actual_units IS NULL) OR (state='uncertain' AND response_json IS NULL)
   OR (state IN ('response_ready','complete') AND response_json IS NOT NULL AND actual_units IS NOT NULL)),
 PRIMARY KEY(installation_id,generation,operation_key),
 FOREIGN KEY(installation_id,generation,source_id) REFERENCES assistant_sources(installation_id,generation,id)
);
CREATE INDEX IF NOT EXISTS assistant_model_receipts_source ON assistant_model_receipts(installation_id,generation,source_id,source_revision);
