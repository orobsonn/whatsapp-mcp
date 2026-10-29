-- Host admission receipts contain metadata and hashes, never a second message
-- body. Native event content remains in the existing purgeable event store.
CREATE TABLE assistant_native_host_events (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,
 conversation_id TEXT NOT NULL,event_id TEXT NOT NULL,event_revision INTEGER NOT NULL,
 request_hash TEXT NOT NULL,source_id TEXT NOT NULL,source_ref_json TEXT NOT NULL,
 original_sequence INTEGER,owner_link_json TEXT,created_at INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,event_id,event_revision)
);
CREATE INDEX assistant_native_host_source ON assistant_native_host_events(installation_id,generation,source_id);
CREATE TABLE assistant_native_capture_intake (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 sequence INTEGER NOT NULL,metadata_hash TEXT NOT NULL,state TEXT NOT NULL,
 task_ref TEXT,last_gap TEXT,updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,sequence)
);
CREATE TABLE assistant_native_owner_responses (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,
 context_ref TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 link_json TEXT NOT NULL,thread_id INTEGER,state TEXT NOT NULL CHECK(state IN ('attempting','sent','uncertain','cancelled')),
 message_id INTEGER,created_at INTEGER NOT NULL
);
CREATE TABLE assistant_native_host_state (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,purge_cursor TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(installation_id,generation)
);
CREATE TRIGGER assistant_native_host_retire AFTER UPDATE OF tombstoned_at ON assistant_native_conversations
 WHEN NEW.tombstoned_at IS NOT NULL BEGIN
 UPDATE assistant_native_host_events SET source_ref_json='{}',owner_link_json=NULL WHERE conversation_id=NEW.id;
 UPDATE assistant_native_owner_responses SET state='cancelled' WHERE conversation_id=NEW.id AND state='attempting';
END;
