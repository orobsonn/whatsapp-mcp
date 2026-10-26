-- Cron windows coordinate work; they never identify a model operation.
CREATE TABLE IF NOT EXISTS assistant_routine_state (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 owner_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','running','uncertain')),
 cursor_chat TEXT NOT NULL DEFAULT '',fup_cursor TEXT,active_item_id TEXT,paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
 last_run_at INTEGER,last_gap TEXT,PRIMARY KEY(installation_id,generation,source_epoch,source_generation)
);
CREATE TABLE IF NOT EXISTS assistant_routine_cycles (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 window_key INTEGER NOT NULL,owner_token TEXT NOT NULL,lease_until INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','completed','uncertain')),
 phase TEXT NOT NULL,active_item_id TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,last_gap TEXT,
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,window_key)
);
CREATE TABLE IF NOT EXISTS assistant_routine_items (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 id TEXT NOT NULL,subject_json TEXT NOT NULL,binding_hash TEXT NOT NULL,binding_json TEXT NOT NULL,observation_key TEXT NOT NULL,
 actor_json TEXT NOT NULL,profile TEXT NOT NULL CHECK(profile IN ('owner','interlocutor')),source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','waiting_context','ready','processing','complete','uncertain','blocked')),
 phase TEXT NOT NULL DEFAULT 'created',ingest_epoch TEXT,ingest_state TEXT NOT NULL DEFAULT 'not_started' CHECK(ingest_state IN ('not_started','attempting','complete','uncertain')),
 index_sources_json TEXT,run_id TEXT,search_checkpoint INTEGER NOT NULL DEFAULT 0,search_state TEXT,job_id TEXT,episode_id TEXT,last_gap TEXT,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,id),UNIQUE(installation_id,generation,source_epoch,source_generation,observation_key)
);
CREATE TABLE IF NOT EXISTS assistant_routine_event_items (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 chat_id TEXT NOT NULL,sequence INTEGER NOT NULL,item_id TEXT,outcome TEXT NOT NULL,coalesced INTEGER NOT NULL CHECK(coalesced IN (0,1)),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,chat_id,sequence)
);
CREATE TABLE IF NOT EXISTS assistant_routine_reviews (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 period TEXT NOT NULL,id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,period),UNIQUE(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_routine_fup_results (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,occurrence_id TEXT NOT NULL,follow_up_id TEXT NOT NULL,follow_up_version INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,occurrence_id)
);
-- A typed metadata summary is not a fabricated source or shadow proposal.
CREATE TABLE IF NOT EXISTS assistant_telegram_summaries (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,review_id TEXT NOT NULL,period TEXT NOT NULL,
 payload_hash TEXT NOT NULL,fence_json TEXT NOT NULL,thread_id INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','sent','uncertain','cancelled','failed')),
 preflights INTEGER NOT NULL DEFAULT 0 CHECK(preflights BETWEEN 0 AND 3),attempt_token TEXT,message_id INTEGER,
 PRIMARY KEY(installation_id,generation,bot_instance,review_id)
);
CREATE INDEX IF NOT EXISTS assistant_routine_items_pending ON assistant_routine_items(installation_id,generation,source_epoch,source_generation,state,updated_at,id);

CREATE TABLE IF NOT EXISTS assistant_routine_ingestions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 item_id TEXT NOT NULL,source_id TEXT NOT NULL,source_ref_json TEXT NOT NULL,index_epoch TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','complete','uncertain')),
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,item_id,source_id)
);
