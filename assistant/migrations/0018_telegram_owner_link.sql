-- Dedicated host bot identity. update_id dedupe survives revocation/relink.
CREATE TABLE IF NOT EXISTS assistant_telegram_links (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, bot_instance TEXT NOT NULL,
 source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 2147483646),
 state TEXT NOT NULL CHECK(state IN ('unlinked','active','revoked')),
 user_id TEXT, chat_id TEXT, activation_cut INTEGER,
 PRIMARY KEY(installation_id,generation,bot_instance),
 CHECK((state='active' AND user_id IS NOT NULL AND chat_id IS NOT NULL AND activation_cut IS NOT NULL AND activation_cut>=0)
   OR (state<>'active' AND user_id IS NULL AND chat_id IS NULL AND activation_cut IS NULL))
);
CREATE TABLE IF NOT EXISTS assistant_telegram_pairings (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, bot_instance TEXT NOT NULL,
 id TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483645),
 expires_at INTEGER NOT NULL CHECK(expires_at>=0),
 state TEXT NOT NULL CHECK(state IN ('issued','claimed','confirmable','consumed','revoked')),
 a_hash TEXT NOT NULL CHECK(length(a_hash)=64 AND a_hash NOT GLOB '*[^0-9a-f]*'),
 b_hash TEXT CHECK(b_hash IS NULL OR (length(b_hash)=64 AND b_hash NOT GLOB '*[^0-9a-f]*')),
 user_id TEXT, chat_id TEXT,
 PRIMARY KEY(installation_id,generation,bot_instance,id),
 UNIQUE(installation_id,generation,bot_instance,a_hash),
 UNIQUE(installation_id,generation,bot_instance,b_hash),
 CHECK((user_id IS NULL)=(chat_id IS NULL)),
 CHECK(state NOT IN ('claimed','confirmable','consumed') OR user_id IS NOT NULL),
 CHECK(state NOT IN ('confirmable','consumed') OR b_hash IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS assistant_telegram_updates (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, bot_instance TEXT NOT NULL,
 update_id INTEGER NOT NULL CHECK(update_id BETWEEN 0 AND 9007199254740991),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 token TEXT NOT NULL, source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 link_revision INTEGER NOT NULL CHECK(link_revision BETWEEN 0 AND 2147483646),
 pairing_id TEXT, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 message_id INTEGER NOT NULL CHECK(message_id>0), message_date INTEGER NOT NULL CHECK(message_date>=0),
 thread_id INTEGER CHECK(thread_id>0), text TEXT CHECK(text IS NULL OR length(CAST(text AS BLOB))<=16384),
 outcome TEXT NOT NULL CHECK(outcome IN ('pairing_claimed','linked','pending','denied_before_activation','denied_ambiguous_activation','denied_future')),
 state TEXT NOT NULL CHECK(state IN ('pending','completed','cancelled')),
 received_at INTEGER NOT NULL CHECK(received_at>=0),
 PRIMARY KEY(installation_id,generation,bot_instance,update_id),
 CHECK((outcome='pending') OR (state='completed' AND text IS NULL)),
 CHECK((state='pending' AND outcome='pending' AND text IS NOT NULL) OR state<>'pending')
);
