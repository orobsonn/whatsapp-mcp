-- Native conversation identity is independent of jobs, deliveries and topics.
CREATE TABLE assistant_native_conversations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  tombstoned_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE assistant_native_conversation_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES assistant_native_conversations(id),
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  task_ref TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  event_json TEXT,
  authority_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','admitted','uncertain','withdrawn')),
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id,event_id,revision)
);
CREATE INDEX assistant_native_events_order ON assistant_native_conversation_events(conversation_id,sequence);
CREATE TABLE assistant_native_reply_intents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_native_conversations(id),
  context_ref TEXT NOT NULL UNIQUE,
  watermark INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','superseded','discarded','approved','attempted','accepted','delivered','uncertain')),
  created_at INTEGER NOT NULL
);
