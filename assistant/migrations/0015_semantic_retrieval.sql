-- Ranking observations only; no source bodies or financial ledger.
CREATE TABLE IF NOT EXISTS assistant_retrieval_semantic (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,
 proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
 ticket_json TEXT CHECK(ticket_json IS NULL OR json_valid(ticket_json)),
 outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
 ranking_json TEXT CHECK(ranking_json IS NULL OR json_valid(ranking_json)),
 PRIMARY KEY(installation_id,generation,run_id),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_retrieval_runs(installation_id,generation,id)
);
