
-- Received metadata is not an applied canonical source. #35 owns application.
CREATE TABLE IF NOT EXISTS assistant_capture_streams (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL,
 source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(read_sequence>=0),
 applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK(applied_sequence>=0 AND applied_sequence<=read_sequence),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation)
);
CREATE TABLE IF NOT EXISTS assistant_capture_inbox (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL,
 source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 previous_sequence INTEGER NOT NULL CHECK(previous_sequence>=0 AND previous_sequence<sequence),
 chat_id TEXT NOT NULL, source_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('message','derivative','media','conversation')),
 operation TEXT NOT NULL CHECK(operation IN ('upsert','withdraw','access')),
 recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
 metadata_hash TEXT NOT NULL CHECK(length(metadata_hash)=64 AND metadata_hash NOT GLOB '*[^0-9a-f]*'),
 received_at INTEGER NOT NULL,
 application_state TEXT NOT NULL DEFAULT 'pending' CHECK(application_state IN ('pending','applied','blocked')),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,sequence),
 FOREIGN KEY(installation_id,generation,source_epoch,source_generation)
  REFERENCES assistant_capture_streams(installation_id,generation,source_epoch,source_generation)
);
CREATE INDEX IF NOT EXISTS assistant_inbox_pending ON assistant_capture_inbox(installation_id,generation,application_state,sequence);
