-- Owner-reported judgments are observations, never execution or correctness receipts.
CREATE TABLE IF NOT EXISTS assistant_evaluation_exposures (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,entry_id TEXT NOT NULL,
 observation_hash TEXT NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
 opened_at INTEGER NOT NULL CHECK(opened_at>=0),
 PRIMARY KEY(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_evaluation_assessments (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,exposure_id TEXT NOT NULL,entry_id TEXT NOT NULL,
 label TEXT NOT NULL CHECK(label IN ('correct','unsupported','missed_silence','unknown')),
 basis TEXT NOT NULL CHECK(basis='owner_report'),human_action TEXT CHECK(human_action IN ('none_observed','replied','declined','rescheduled','other')),
 evidence_fence_json TEXT CHECK(evidence_fence_json IS NULL OR json_valid(evidence_fence_json)),
 reviewed_at INTEGER NOT NULL CHECK(reviewed_at>=0),elapsed_wall_ms INTEGER NOT NULL CHECK(elapsed_wall_ms>=0),
 PRIMARY KEY(installation_id,generation,id),UNIQUE(installation_id,generation,exposure_id),
 FOREIGN KEY(installation_id,generation,exposure_id) REFERENCES assistant_evaluation_exposures(installation_id,generation,id)
);
CREATE INDEX IF NOT EXISTS assistant_evaluation_latest ON assistant_evaluation_assessments(installation_id,generation,entry_id,reviewed_at,id);
CREATE TRIGGER IF NOT EXISTS assistant_evaluation_exposure_immutable BEFORE UPDATE ON assistant_evaluation_exposures BEGIN SELECT RAISE(ABORT,'immutable_evaluation_exposure'); END;
CREATE TRIGGER IF NOT EXISTS assistant_evaluation_assessment_immutable BEFORE UPDATE ON assistant_evaluation_assessments BEGIN SELECT RAISE(ABORT,'immutable_owner_assessment'); END;
