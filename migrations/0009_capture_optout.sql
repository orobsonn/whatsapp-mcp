-- Structural migration only: existing disabled chats are held, never mass-enabled.
-- All statements are replay-safe; marker prevents reclassifying later choices.
CREATE TABLE IF NOT EXISTS capture_settings (
 chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('default','enabled','disabled','legacy_hold')),
 revision INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_gaps (
 chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
 reason TEXT NOT NULL, unknown_start INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(chat_id,revision)
);
CREATE TABLE IF NOT EXISTS capture_metrics (
 epoch TEXT NOT NULL,generation TEXT NOT NULL,day TEXT NOT NULL,
 received INTEGER NOT NULL DEFAULT 0,stored INTEGER NOT NULL DEFAULT 0,
 duplicates INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,
 failed INTEGER NOT NULL DEFAULT 0,last_received_at INTEGER,
 PRIMARY KEY(epoch,generation,day)
);
CREATE TABLE IF NOT EXISTS capture_migrations (name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL);
INSERT INTO capture_settings(chat_id,mode,revision,updated_at)
 SELECT id,CASE capture_enabled WHEN 0 THEN 'legacy_hold' ELSE 'enabled' END,0,CAST(strftime('%s','now') AS INTEGER)*1000 FROM chats
 WHERE NOT EXISTS(SELECT 1 FROM capture_migrations WHERE name='optout-v1')
 ON CONFLICT(chat_id) DO NOTHING;
INSERT INTO capture_gaps(chat_id,revision,started_at,reason,unknown_start)
 SELECT chat_id,0,updated_at,'legacy_hold',1 FROM capture_settings
 WHERE mode='legacy_hold' AND NOT EXISTS(SELECT 1 FROM capture_migrations WHERE name='optout-v1')
 ON CONFLICT DO NOTHING;
UPDATE chats SET capture_discontinuous=1 WHERE id IN(SELECT chat_id FROM capture_settings WHERE mode='legacy_hold')
 AND NOT EXISTS(SELECT 1 FROM capture_migrations WHERE name='optout-v1');
INSERT INTO capture_migrations VALUES('optout-v1',CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT DO NOTHING;

CREATE TRIGGER IF NOT EXISTS capture_chat_insert AFTER INSERT ON chats BEGIN
 INSERT INTO capture_settings(chat_id,mode,revision,updated_at) VALUES(NEW.id,'default',0,NEW.created_at) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS capture_setting_insert AFTER INSERT ON capture_settings BEGIN
 UPDATE chats SET capture_enabled=CASE NEW.mode WHEN 'enabled' THEN 1 WHEN 'default' THEN COALESCE((SELECT CASE value_json WHEN 'true' THEN 1 ELSE 0 END FROM policies WHERE key='capture_default_enabled:'||chats.generation AND epoch=chats.epoch),1) ELSE 0 END,
 capture_since=CASE WHEN capture_since IS NULL AND (NEW.mode='enabled' OR (NEW.mode='default' AND COALESCE((SELECT value_json FROM policies WHERE key='capture_default_enabled:'||chats.generation AND epoch=chats.epoch),'true')='true')) THEN NEW.updated_at ELSE capture_since END
 WHERE id=NEW.chat_id;
 INSERT INTO capture_gaps(chat_id,revision,started_at,reason,unknown_start) SELECT NEW.chat_id,NEW.revision,NEW.updated_at,NEW.mode,0 FROM chats WHERE id=NEW.chat_id AND capture_enabled=0 ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS capture_setting_update AFTER UPDATE OF mode,revision ON capture_settings BEGIN
 UPDATE chats SET capture_enabled=CASE NEW.mode WHEN 'enabled' THEN 1 WHEN 'default' THEN COALESCE((SELECT CASE value_json WHEN 'true' THEN 1 ELSE 0 END FROM policies WHERE key='capture_default_enabled:'||chats.generation AND epoch=chats.epoch),1) ELSE 0 END,
 capture_since=CASE WHEN capture_since IS NULL AND (NEW.mode='enabled' OR (NEW.mode='default' AND COALESCE((SELECT value_json FROM policies WHERE key='capture_default_enabled:'||chats.generation AND epoch=chats.epoch),'true')='true')) THEN NEW.updated_at ELSE capture_since END,updated_at=NEW.updated_at
 WHERE id=NEW.chat_id;
 UPDATE media_jobs SET status='cancelled',lease_until=NULL,error='capture_disabled' WHERE status IN ('pending','retry','processing') AND media_id IN(SELECT m.id FROM media m JOIN chats c ON c.id=m.chat_id WHERE c.id=NEW.chat_id AND c.capture_enabled=0 AND m.message_id IS NOT NULL);
 UPDATE media SET state='failed' WHERE chat_id=NEW.chat_id AND message_id IS NOT NULL AND state='pending' AND EXISTS(SELECT 1 FROM chats c WHERE c.id=NEW.chat_id AND c.capture_enabled=0);
END;
CREATE TRIGGER IF NOT EXISTS capture_transition AFTER UPDATE OF capture_enabled ON chats WHEN OLD.capture_enabled<>NEW.capture_enabled BEGIN
 UPDATE chats SET capture_discontinuous=CASE WHEN NEW.capture_enabled=0 THEN 1 ELSE capture_discontinuous END WHERE id=NEW.id;
 UPDATE capture_gaps SET ended_at=MAX(started_at,NEW.updated_at) WHERE chat_id=NEW.id AND ended_at IS NULL AND NEW.capture_enabled=1;
 INSERT INTO capture_gaps(chat_id,revision,started_at,reason,unknown_start) SELECT NEW.id,revision,updated_at,mode,0 FROM capture_settings WHERE chat_id=NEW.id AND NEW.capture_enabled=0 ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS capture_global_insert AFTER INSERT ON policies WHEN NEW.key LIKE 'capture_default_enabled:%' BEGIN
 UPDATE capture_settings SET revision=revision+1,updated_at=NEW.updated_at WHERE mode='default' AND chat_id IN(SELECT id FROM chats WHERE epoch=NEW.epoch AND NEW.key='capture_default_enabled:'||generation);
END;
CREATE TRIGGER IF NOT EXISTS capture_global_update AFTER UPDATE ON policies WHEN OLD.key LIKE 'capture_default_enabled:%' OR NEW.key LIKE 'capture_default_enabled:%' BEGIN
 UPDATE capture_settings SET revision=revision+1,updated_at=NEW.updated_at WHERE mode='default' AND chat_id IN(SELECT id FROM chats WHERE (epoch=NEW.epoch AND NEW.key='capture_default_enabled:'||generation) OR (epoch=OLD.epoch AND OLD.key='capture_default_enabled:'||generation));
END;
CREATE TRIGGER IF NOT EXISTS capture_global_delete AFTER DELETE ON policies WHEN OLD.key LIKE 'capture_default_enabled:%' BEGIN
 UPDATE capture_settings SET revision=revision+1,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE mode='default' AND chat_id IN(SELECT id FROM chats WHERE epoch=OLD.epoch AND OLD.key='capture_default_enabled:'||generation);
END;
