-- Private curation receipts. Original bodies and graph claims are never copied here.
CREATE TABLE assistant_curator_state (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(read_sequence>=0),last_day TEXT,
 notice_mode TEXT NOT NULL DEFAULT 'daily_summary' CHECK(notice_mode IN ('daily_summary','errors_help')),
 notice_confirmed_at INTEGER,
 PRIMARY KEY(installation_id,generation)
);
CREATE TABLE assistant_curator_runs (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,
 source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,day TEXT NOT NULL,
 from_sequence INTEGER NOT NULL CHECK(from_sequence>=0),to_sequence INTEGER NOT NULL CHECK(to_sequence>=from_sequence),
 capture_to_sequence INTEGER NOT NULL CHECK(capture_to_sequence>=0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','partial','complete')),
 needs_help INTEGER NOT NULL DEFAULT 0 CHECK(needs_help IN (0,1)),created_at INTEGER NOT NULL,finished_at INTEGER,
 PRIMARY KEY(installation_id,generation,id),UNIQUE(installation_id,generation,day)
);
CREATE TABLE assistant_curator_items (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 source_id TEXT NOT NULL,revision INTEGER NOT NULL,version INTEGER NOT NULL,source_hash TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','presented','evaluated','learned','indexing','unavailable','skipped_policy','superseded','withdrawn')),
 operation_ids_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,run_id,sequence),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_curator_runs(installation_id,generation,id)
);
CREATE INDEX assistant_curator_item_source ON assistant_curator_items(installation_id,generation,source_id,revision,version,state);
CREATE TABLE assistant_curator_capture_gaps (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 source_kind TEXT NOT NULL,source_id TEXT NOT NULL,chat_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','evaluated','skipped_policy','withdrawn')),
 PRIMARY KEY(installation_id,generation,run_id,sequence),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_curator_runs(installation_id,generation,id)
);
CREATE TABLE assistant_curator_notices (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('attempting','accepted','uncertain')),updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,run_id),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_curator_runs(installation_id,generation,id)
);
