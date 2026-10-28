-- One operational reply per admitted Owner turn. Never restored or reclaimed.
CREATE TABLE IF NOT EXISTS assistant_telegram_owner_replies (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,bot_instance TEXT NOT NULL,update_id INTEGER NOT NULL CHECK(update_id>=0),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
 fence_json TEXT NOT NULL CHECK(json_valid(fence_json)),
 text TEXT CHECK(text IS NULL OR length(CAST(text AS BLOB)) BETWEEN 1 AND 12000),
 deps_json TEXT NOT NULL CHECK(json_valid(deps_json) AND json_type(deps_json)='array' AND length(CAST(deps_json AS BLOB))<=32768),
 expires_at INTEGER NOT NULL CHECK(expires_at>=0),published_at INTEGER NOT NULL CHECK(published_at>=0),
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','sent','uncertain','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts IN (0,1)),attempt_token TEXT,message_id INTEGER CHECK(message_id>0),
 purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN (0,1)),
 PRIMARY KEY(installation_id,generation,bot_instance,update_id),
 CHECK((purged=0 AND text IS NOT NULL) OR (purged=1 AND text IS NULL AND deps_json='[]')),
 CHECK((attempts=0 AND attempt_token IS NULL AND state IN ('prepared','cancelled')) OR (attempts=1 AND attempt_token IS NOT NULL AND state IN ('attempting','sent','uncertain'))),
 CHECK((state='sent' AND message_id IS NOT NULL) OR (state<>'sent' AND message_id IS NULL))
);
CREATE INDEX IF NOT EXISTS assistant_telegram_owner_reply_expiry ON assistant_telegram_owner_replies(installation_id,generation,bot_instance,purged,expires_at);
CREATE TRIGGER IF NOT EXISTS assistant_telegram_owner_reply_no_delete BEFORE DELETE ON assistant_telegram_owner_replies
 BEGIN SELECT RAISE(ABORT,'monotone_telegram_owner_reply'); END;
CREATE TRIGGER IF NOT EXISTS assistant_telegram_owner_reply_immutable BEFORE UPDATE ON assistant_telegram_owner_replies
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.generation IS NOT OLD.generation OR NEW.bot_instance IS NOT OLD.bot_instance OR NEW.update_id IS NOT OLD.update_id
 OR NEW.request_hash IS NOT OLD.request_hash OR NEW.body_hash IS NOT OLD.body_hash OR NEW.fence_json IS NOT OLD.fence_json OR NEW.expires_at IS NOT OLD.expires_at OR NEW.published_at IS NOT OLD.published_at
 OR NEW.attempts<OLD.attempts OR (NEW.attempt_token IS NOT OLD.attempt_token AND NOT(OLD.state='prepared' AND NEW.state='attempting' AND OLD.attempt_token IS NULL AND NEW.attempt_token IS NOT NULL))
 OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id) OR NEW.purged<OLD.purged
 OR ((NEW.text IS NOT OLD.text OR NEW.deps_json IS NOT OLD.deps_json) AND NOT(OLD.purged=0 AND NEW.purged=1 AND NEW.text IS NULL AND NEW.deps_json='[]'))
 OR NOT((OLD.state='prepared' AND NEW.state IN ('prepared','attempting','cancelled')) OR (OLD.state='attempting' AND NEW.state IN ('attempting','uncertain','sent'))
 OR (OLD.state='uncertain' AND NEW.state IN ('uncertain','sent')) OR (OLD.state='sent' AND NEW.state='sent') OR (OLD.state='cancelled' AND NEW.state='cancelled'))
 BEGIN SELECT RAISE(ABORT,'monotone_telegram_owner_reply'); END;
