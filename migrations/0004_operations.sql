CREATE TABLE policy_proposals (
 id TEXT PRIMARY KEY,
 epoch TEXT NOT NULL,
 generation TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('capture','retention','delete')),
 envelope_json TEXT NOT NULL,
 hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('proposed','applied')),
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 applied_at INTEGER
);
CREATE INDEX policy_proposals_expiry ON policy_proposals(expires_at);
