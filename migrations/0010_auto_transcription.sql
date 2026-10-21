-- Activation boundary is stable across subsequent deployments; no historical backfill.
CREATE TABLE transcription_state (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled_since INTEGER NOT NULL,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO transcription_state(id,enabled_since) VALUES(1,CAST(unixepoch('subsec')*1000 AS INTEGER));
CREATE TABLE transcription_usage (
 epoch TEXT NOT NULL,generation TEXT NOT NULL,day TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(epoch,generation,day)
);
CREATE INDEX media_audio_queue ON media(kind,state,created_at);
