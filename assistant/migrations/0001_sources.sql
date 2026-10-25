
-- Dedicated assistant database only. Prefixes also isolate local test tables.
-- The controller publishes source/version/change together via D1 batch().
-- Revision is a local CAS token: increment it explicitly for correction,
-- withdrawal or access changes. This schema does not increment it implicitly.
CREATE TABLE IF NOT EXISTS assistant_sources (
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  id TEXT NOT NULL,
  origin TEXT NOT NULL,
  origin_key TEXT NOT NULL,
  title TEXT,
  conversation_id TEXT,
  project_id TEXT,
  audience TEXT NOT NULL DEFAULT 'owner' CHECK(audience IN ('owner','restricted','public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  current_version INTEGER DEFAULT 1,
  CHECK((status='withdrawn' AND current_version IS NULL) OR (current_version IS NOT NULL AND current_version > 0)),
  PRIMARY KEY(installation_id,generation,id),
  UNIQUE(installation_id,generation,origin,origin_key),
  FOREIGN KEY(installation_id,generation,id,current_version)
    REFERENCES assistant_source_versions(installation_id,generation,source_id,version)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS assistant_source_versions (
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  author_id TEXT,
  author_label TEXT,
  original_text TEXT,
  original_object_key TEXT,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  PRIMARY KEY(installation_id,generation,source_id,version),
  CHECK(original_text IS NOT NULL OR original_object_key IS NOT NULL),
  FOREIGN KEY(installation_id,generation,source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);
-- Administrative purge first withdraws the source and clears current_version.
-- Tombstone and change metadata survive body deletion; an API is a later issue.
-- Guard insertion too: SQLite REPLACE can bypass DELETE triggers.
CREATE TRIGGER IF NOT EXISTS assistant_versions_no_replace BEFORE INSERT ON assistant_source_versions WHEN EXISTS(SELECT 1 FROM assistant_source_versions WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND source_id=NEW.source_id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'immutable_source_version'); END;
CREATE TRIGGER IF NOT EXISTS assistant_versions_active_source BEFORE INSERT ON assistant_source_versions WHEN NOT EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND id=NEW.source_id AND status='active') BEGIN SELECT RAISE(ABORT,'source_not_active'); END;
CREATE TRIGGER IF NOT EXISTS assistant_versions_no_update BEFORE UPDATE ON assistant_source_versions BEGIN SELECT RAISE(ABORT,'immutable_source_version'); END;
CREATE TRIGGER IF NOT EXISTS assistant_versions_no_delete BEFORE DELETE ON assistant_source_versions WHEN NOT EXISTS(SELECT 1 FROM assistant_sources WHERE installation_id=OLD.installation_id AND generation=OLD.generation AND id=OLD.source_id AND status='withdrawn') BEGIN SELECT RAISE(ABORT,'immutable_source_version'); END;

CREATE TABLE IF NOT EXISTS assistant_source_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('created','corrected','withdrawn','access_changed')),
  changed_at INTEGER NOT NULL CHECK(changed_at >= 0),
  UNIQUE(installation_id,generation,source_id,revision),
  FOREIGN KEY(installation_id,generation,source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);

CREATE TABLE IF NOT EXISTS assistant_change_cursors (
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  consumer TEXT NOT NULL,
  read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(read_sequence >= 0),
  applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK(applied_sequence >= 0 AND applied_sequence <= read_sequence),
  PRIMARY KEY(installation_id,generation,consumer)
);

CREATE INDEX IF NOT EXISTS assistant_sources_conversation ON assistant_sources(installation_id,generation,conversation_id,status);
CREATE INDEX IF NOT EXISTS assistant_sources_project ON assistant_sources(installation_id,generation,project_id,status);
CREATE INDEX IF NOT EXISTS assistant_changes_feed ON assistant_source_changes(installation_id,generation,sequence);
