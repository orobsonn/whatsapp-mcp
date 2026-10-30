-- Metadata-only transaction latch. Originals keep their existing canonical
-- source/version/origin tables and FTS. No capture event or activity is made.
CREATE TABLE IF NOT EXISTS assistant_archive_import_latches (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
  token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('admitted','applied')),
  observed_at INTEGER NOT NULL CHECK(observed_at>=0),
  PRIMARY KEY(installation_id,generation,source_epoch,source_generation)
);
-- Exact live-ref exclusion on every import. The sequence PK cannot serve this
-- lookup; keep absent historical refs from scanning the whole capture inbox.
CREATE INDEX IF NOT EXISTS assistant_inbox_source_ref ON assistant_capture_inbox(
  installation_id,generation,source_epoch,source_generation,source_kind,source_id
);
