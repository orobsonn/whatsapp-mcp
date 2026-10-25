-- Extracted statements are attributed candidates, never administrative commands.
CREATE TABLE IF NOT EXISTS assistant_relation_batches (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, operation_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
 source_version INTEGER NOT NULL, source_hash TEXT NOT NULL,
 author_id TEXT, author_label TEXT, claims_json TEXT NOT NULL CHECK(json_valid(claims_json)),
 PRIMARY KEY(installation_id,generation,operation_key),
 FOREIGN KEY(installation_id,generation,source_id,source_version)
  REFERENCES assistant_source_versions(installation_id,generation,source_id,version)
);
CREATE INDEX IF NOT EXISTS assistant_relations_source ON assistant_relation_batches(installation_id,generation,source_id,source_revision);
