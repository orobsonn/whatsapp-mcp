-- One bounded page per native SDK submission; the daily run remains the journal.
CREATE TABLE assistant_curator_passages (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),conversation_id TEXT NOT NULL,
 after_sequence INTEGER NOT NULL CHECK(after_sequence>=0),through_sequence INTEGER NOT NULL CHECK(through_sequence>=after_sequence),
 resume_request_hash TEXT,state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','yielded','finished')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,run_id,revision),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_curator_runs(installation_id,generation,id)
);
