-- Keep the original creation request hash after corrections and ACL changes.
CREATE TABLE IF NOT EXISTS assistant_source_admissions (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(installation_id,generation,source_id),
  FOREIGN KEY(installation_id,generation,source_id) REFERENCES assistant_sources(installation_id,generation,id)
);
