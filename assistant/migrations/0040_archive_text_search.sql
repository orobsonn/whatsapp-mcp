-- Derived full-text index. Canonical source versions remain the sole authority.
-- External content avoids storing a second original body. Restore inserts and
-- retention deletes update the index through these fixed triggers. Rebuild can
-- be run explicitly from canonical data with the same FTS5 rebuild command.
CREATE VIRTUAL TABLE IF NOT EXISTS assistant_archive_text USING fts5(installation_id UNINDEXED,generation UNINDEXED,source_id UNINDEXED,version UNINDEXED,original_text,content='assistant_source_versions',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS assistant_archive_text_insert AFTER INSERT ON assistant_source_versions BEGIN INSERT INTO assistant_archive_text(rowid,installation_id,generation,source_id,version,original_text) VALUES(NEW.rowid,NEW.installation_id,NEW.generation,NEW.source_id,NEW.version,NEW.original_text); END;
CREATE TRIGGER IF NOT EXISTS assistant_archive_text_delete AFTER DELETE ON assistant_source_versions BEGIN INSERT INTO assistant_archive_text(assistant_archive_text,rowid,installation_id,generation,source_id,version,original_text) VALUES('delete',OLD.rowid,OLD.installation_id,OLD.generation,OLD.source_id,OLD.version,OLD.original_text); END;
INSERT INTO assistant_archive_text(assistant_archive_text) VALUES('rebuild');
