-- SDK settlement is operational metadata, separate from coverage and summaries.
CREATE TABLE assistant_curator_outcomes (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,
 submission_id TEXT NOT NULL,receipt_json TEXT NOT NULL,
 outcome TEXT CHECK(outcome IN ('completed','failed','aborted')),
 notice_state TEXT NOT NULL DEFAULT 'pending' CHECK(notice_state IN ('pending','not_required','prepared','attempting','accepted','uncertain')),
 created_at INTEGER NOT NULL,last_checked_at INTEGER NOT NULL,message_id INTEGER,
 PRIMARY KEY(installation_id,generation,run_id),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_curator_runs(installation_id,generation,id),
 CHECK((outcome IS NULL AND notice_state='pending') OR (outcome='completed' AND notice_state='not_required') OR (outcome IN ('failed','aborted') AND notice_state IN ('prepared','attempting','accepted','uncertain')))
);
