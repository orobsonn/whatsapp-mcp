-- One-time browser confirmations. No Access JWT or OAuth bearer token is stored here.
CREATE TABLE auth_nonces (
  nonce_hash TEXT PRIMARY KEY NOT NULL,
  sub TEXT NOT NULL,
  epoch TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('oauth','send','capture-policy','retention','delete')),
  resource_id TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  payload_json TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX auth_nonces_expiry ON auth_nonces(expires_at);
