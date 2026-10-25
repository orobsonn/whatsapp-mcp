-- Sidecar preserves the published project schema and makes replay idempotent.
CREATE TABLE IF NOT EXISTS assistant_project_revisions (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, project_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(installation_id,generation,project_id),
 FOREIGN KEY(installation_id,generation,project_id) REFERENCES assistant_projects(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_owner_commands (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, operation_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'), token TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(installation_id,generation,operation_id)
);

INSERT INTO assistant_project_revisions SELECT installation_id,generation,id,1 FROM assistant_projects WHERE 1 ON CONFLICT DO NOTHING;
