-- Host-only logical channel registry. A withdrawn epoch is never reusable.
CREATE TABLE assistant_native_context_channels (
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('whatsapp','telegram')),
  principal_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES assistant_native_conversations(id),
  PRIMARY KEY(installation_id,generation,channel,principal_id)
);
-- Dependency metadata only. Bodies stay in the source/native stores.
CREATE TABLE assistant_native_context_exposures (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES assistant_native_conversations(id),
  source_id TEXT NOT NULL,
  source_fence_json TEXT NOT NULL,
  origin_fence_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX assistant_native_context_source ON assistant_native_context_exposures(source_id,conversation_id);
CREATE INDEX assistant_native_context_session ON assistant_native_context_exposures(conversation_id,id);
CREATE TABLE assistant_native_context_purges (
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  conversation_id TEXT PRIMARY KEY REFERENCES assistant_native_conversations(id),
  state TEXT NOT NULL CHECK(state IN ('tombstoned','purged')),
  updated_at INTEGER NOT NULL
);
