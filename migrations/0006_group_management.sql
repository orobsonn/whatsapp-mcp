-- Rebuild preserves existing one-time confirmations, including consumption and expiration.
CREATE TABLE auth_nonces_group (
 nonce_hash TEXT PRIMARY KEY NOT NULL, sub TEXT NOT NULL, epoch TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('oauth','send','capture-policy','retention','delete','group')),
 resource_id TEXT NOT NULL,envelope_hash TEXT NOT NULL,payload_json TEXT,expires_at INTEGER NOT NULL,consumed_at INTEGER
);
INSERT INTO auth_nonces_group SELECT * FROM auth_nonces;
DROP TABLE auth_nonces;
ALTER TABLE auth_nonces_group RENAME TO auth_nonces;
CREATE INDEX auth_nonces_expiry ON auth_nonces(expires_at);
CREATE TABLE group_member_refs (
 id TEXT PRIMARY KEY,epoch TEXT NOT NULL,generation TEXT NOT NULL,chat_id TEXT NOT NULL,
 external_id TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(epoch,generation,chat_id,external_id)
);
CREATE INDEX group_members_scope ON group_member_refs(epoch,generation,chat_id);
CREATE TABLE group_community_refs (
 id TEXT PRIMARY KEY,epoch TEXT NOT NULL,generation TEXT NOT NULL,external_id TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(epoch,generation,external_id)
);
CREATE TABLE group_actions (
 id TEXT PRIMARY KEY,epoch TEXT NOT NULL,generation TEXT NOT NULL,
 envelope_json TEXT NOT NULL,private_json TEXT NOT NULL,hash TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('proposed','approved','attempting','accepted','rejected','uncertain','cancelled','expired')),
 expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,approved_at INTEGER,attempted_at INTEGER,
 ack_json TEXT,result_json TEXT,last_error TEXT
);
CREATE INDEX group_actions_cleanup ON group_actions(status,expires_at);
CREATE TABLE group_action_targets (action_id TEXT NOT NULL REFERENCES group_actions(id) ON DELETE CASCADE,chat_id TEXT NOT NULL,PRIMARY KEY(action_id,chat_id));
CREATE INDEX group_targets_chat ON group_action_targets(chat_id,action_id);
-- Private random scope keys make stable member IDs and snapshot commitments non-enumerable.
CREATE TABLE group_snapshot_scopes (
 scope TEXT NOT NULL,epoch TEXT NOT NULL,generation TEXT NOT NULL,secret TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(scope,epoch,generation)
);
