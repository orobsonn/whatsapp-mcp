-- Host-only review, scoped to the authenticated pairing revision.
CREATE TABLE IF NOT EXISTS assistant_telegram_topics (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,link_revision INTEGER NOT NULL,
 slot TEXT NOT NULL CHECK(slot IN ('general','summaries','pending','missions')),fence_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','ready','uncertain','failed')),preflights INTEGER NOT NULL DEFAULT 0 CHECK(preflights BETWEEN 0 AND 3),
 thread_id INTEGER CHECK(thread_id>0),PRIMARY KEY(installation_id,generation,bot_instance,link_revision,slot),
 UNIQUE(installation_id,generation,bot_instance,link_revision,thread_id),CHECK(state<>'ready' OR thread_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS assistant_telegram_notifications (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,id TEXT NOT NULL,
 operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,fence_json TEXT NOT NULL,slot TEXT NOT NULL,thread_id INTEGER NOT NULL CHECK(thread_id>0),
 decision_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,
 review_hash TEXT NOT NULL,simulate_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','sent','uncertain','cancelled','failed')),
 preflights INTEGER NOT NULL DEFAULT 0 CHECK(preflights BETWEEN 0 AND 3),attempt_token TEXT,message_id INTEGER CHECK(message_id>0),
 review_state TEXT NOT NULL DEFAULT 'pending' CHECK(review_state IN ('pending','reviewed','simulated')),
 PRIMARY KEY(installation_id,generation,bot_instance,id),UNIQUE(installation_id,generation,bot_instance,operation_key),
 UNIQUE(installation_id,generation,bot_instance,review_hash),UNIQUE(installation_id,generation,bot_instance,simulate_hash),
 CHECK(state<>'sent' OR message_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS assistant_telegram_reviews (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,update_id INTEGER NOT NULL,
 query_id TEXT NOT NULL,payload_hash TEXT NOT NULL,notification_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('reviewed','simulated')),answer_state TEXT NOT NULL CHECK(answer_state IN ('attempting','answered','uncertain')),
 recorded_at INTEGER NOT NULL,PRIMARY KEY(installation_id,generation,bot_instance,update_id),UNIQUE(installation_id,generation,bot_instance,query_id)
);
-- Created and consumed only inside one Journal admission batch. Never reusable.
CREATE TABLE IF NOT EXISTS assistant_telegram_read_admissions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,token TEXT NOT NULL,
 decision_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,publication_nonce TEXT NOT NULL,
 PRIMARY KEY(installation_id,generation,token)
);
