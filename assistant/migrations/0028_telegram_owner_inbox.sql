-- Operational authority only: no message body, model output or source proof.
-- Excluded from canonical restore. A terminal attempt is never reclaimed.
CREATE TABLE IF NOT EXISTS assistant_telegram_owner_activations (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 link_revision INTEGER NOT NULL CHECK(link_revision>0),source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,
 user_id TEXT NOT NULL,chat_id TEXT NOT NULL,
 cutoff_at INTEGER NOT NULL CHECK(cutoff_at>=0),cutoff_second INTEGER NOT NULL CHECK(cutoff_second=CAST(cutoff_at/1000 AS INTEGER)),
 PRIMARY KEY(installation_id,generation,bot_instance,link_revision)
);
CREATE TRIGGER IF NOT EXISTS assistant_telegram_owner_activation_no_update BEFORE UPDATE ON assistant_telegram_owner_activations
 BEGIN SELECT RAISE(ABORT,'immutable_telegram_owner_activation'); END;
CREATE TRIGGER IF NOT EXISTS assistant_telegram_owner_activation_no_delete BEFORE DELETE ON assistant_telegram_owner_activations
 BEGIN SELECT RAISE(ABORT,'immutable_telegram_owner_activation'); END;
CREATE TABLE IF NOT EXISTS assistant_telegram_owner_turns (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,
 update_id INTEGER NOT NULL CHECK(update_id BETWEEN 0 AND 9007199254740991),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),token TEXT NOT NULL,update_token TEXT NOT NULL,
 source_epoch TEXT NOT NULL,source_generation TEXT NOT NULL,link_revision INTEGER NOT NULL CHECK(link_revision>0),
 user_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL CHECK(message_id>0),
 message_date INTEGER NOT NULL CHECK(message_date>=0),thread_id INTEGER CHECK(thread_id>0),received_at INTEGER NOT NULL CHECK(received_at>=0),
 claimed_at INTEGER NOT NULL CHECK(claimed_at>=0),deadline_at INTEGER NOT NULL CHECK(deadline_at>claimed_at AND deadline_at<=claimed_at+120000),
 state TEXT NOT NULL CHECK(state IN ('claimed','complete','uncertain','cancelled')),
 finish_token TEXT,completed_at INTEGER,
 PRIMARY KEY(installation_id,generation,bot_instance,update_id),
 CHECK((state='complete' AND finish_token IS NOT NULL AND completed_at IS NOT NULL) OR (state<>'complete' AND finish_token IS NULL AND completed_at IS NULL))
);
CREATE TRIGGER IF NOT EXISTS assistant_telegram_owner_turn_no_delete BEFORE DELETE ON assistant_telegram_owner_turns
 BEGIN SELECT RAISE(ABORT,'monotone_telegram_owner_turn'); END;
CREATE TRIGGER IF NOT EXISTS assistant_telegram_owner_turn_immutable BEFORE UPDATE ON assistant_telegram_owner_turns
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.bot_instance IS NOT OLD.bot_instance
 OR NEW.update_id IS NOT OLD.update_id OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.token IS NOT OLD.token OR NEW.update_token IS NOT OLD.update_token
 OR NEW.source_epoch IS NOT OLD.source_epoch OR NEW.source_generation IS NOT OLD.source_generation OR NEW.link_revision IS NOT OLD.link_revision
 OR NEW.user_id IS NOT OLD.user_id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.message_id IS NOT OLD.message_id OR NEW.message_date IS NOT OLD.message_date
 OR NEW.thread_id IS NOT OLD.thread_id OR NEW.received_at IS NOT OLD.received_at OR NEW.claimed_at IS NOT OLD.claimed_at OR NEW.deadline_at IS NOT OLD.deadline_at
 OR OLD.state<>'claimed'
 BEGIN SELECT RAISE(ABORT,'monotone_telegram_owner_turn'); END;
