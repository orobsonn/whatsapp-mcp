-- Singleton installation connection. Secrets and phone live exclusively in the authenticated cipher.
CREATE TABLE connection_state (
 id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, cipher TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','active')), attempt_id TEXT NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 step TEXT NOT NULL, error TEXT, version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- Preserve all existing confirmations; setup is a separate, one-time purpose.
CREATE TABLE auth_nonces_setup (
 nonce_hash TEXT PRIMARY KEY NOT NULL, sub TEXT NOT NULL, epoch TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('oauth','send','capture-policy','retention','delete','group','setup')),
 resource_id TEXT NOT NULL,envelope_hash TEXT NOT NULL,payload_json TEXT,expires_at INTEGER NOT NULL,consumed_at INTEGER
);
INSERT INTO auth_nonces_setup SELECT * FROM auth_nonces;
DROP TABLE auth_nonces;
ALTER TABLE auth_nonces_setup RENAME TO auth_nonces;
CREATE INDEX auth_nonces_expiry ON auth_nonces(expires_at);
