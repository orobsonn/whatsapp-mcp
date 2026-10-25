-- Conversation consumption is independent of capture and any agent transcript.
CREATE TABLE IF NOT EXISTS assistant_conversations (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 chat_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
 evaluated_sequence INTEGER NOT NULL DEFAULT 0 CHECK(evaluated_sequence>=0),
 applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK(applied_sequence>=0 AND applied_sequence<=evaluated_sequence),
 policy_revision INTEGER NOT NULL CHECK(policy_revision>=0), mode TEXT NOT NULL CHECK(mode IN ('ignore','attend','observe','respond')),
 coverage_from INTEGER NOT NULL DEFAULT 0 CHECK(coverage_from>=0),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,chat_id),
 FOREIGN KEY(installation_id,generation,source_epoch,source_generation,chat_id)
  REFERENCES assistant_origin_conversations(installation_id,generation,source_epoch,source_generation,chat_id)
);
CREATE TABLE IF NOT EXISTS assistant_conversation_replay (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 chat_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('applied','withdrawn','ignored','gap')), reason TEXT,
 canonical_id TEXT, observed_revision INTEGER, observed_version INTEGER, observed_watermark INTEGER,
 coalesced INTEGER NOT NULL CHECK(coalesced IN (0,1)),
 authorship TEXT NOT NULL DEFAULT 'unknown' CHECK(authorship='unknown'),
 style_eligible INTEGER NOT NULL DEFAULT 0 CHECK(style_eligible=0),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,chat_id,sequence),
 FOREIGN KEY(installation_id,generation,source_epoch,source_generation,chat_id)
  REFERENCES assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id),
 FOREIGN KEY(installation_id,generation,source_epoch,source_generation,sequence)
  REFERENCES assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence)
);
CREATE INDEX IF NOT EXISTS assistant_inbox_conversation ON assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,chat_id,sequence);
CREATE INDEX IF NOT EXISTS assistant_conversation_gaps ON assistant_conversation_replay(installation_id,generation,source_epoch,source_generation,chat_id,state,sequence);
