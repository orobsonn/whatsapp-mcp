-- Private generation ledger. Identity is a digest of fence + chat + input/config.
-- No retryable claims: an abandoned attempt may already have been billed.
CREATE TABLE tts_generations (
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation TEXT NOT NULL,
 chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 text TEXT, voice_name TEXT, model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('attempting','ready','failed','uncertain','unavailable')),
 media_id TEXT, error TEXT, deadline_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
ALTER TABLE media ADD COLUMN tts_generation_id TEXT;
CREATE INDEX media_tts ON media(tts_generation_id) WHERE tts_generation_id IS NOT NULL;
-- Redaction is part of the same statement that hides/removes the associated file.
CREATE TRIGGER tts_redact_media AFTER UPDATE OF deleted_at ON media
WHEN NEW.deleted_at IS NOT NULL AND NEW.tts_generation_id IS NOT NULL
BEGIN
 UPDATE tts_generations SET text=NULL,voice_name=NULL,status=CASE WHEN status='ready' THEN 'unavailable' ELSE status END,error=NULL
 WHERE id=NEW.tts_generation_id;
END;
CREATE TRIGGER tts_delete_media AFTER DELETE ON media
WHEN OLD.tts_generation_id IS NOT NULL
BEGIN
 UPDATE tts_generations SET text=NULL,voice_name=NULL,status=CASE WHEN status='ready' THEN 'unavailable' ELSE status END,error=NULL
 WHERE id=OLD.tts_generation_id;
END;
