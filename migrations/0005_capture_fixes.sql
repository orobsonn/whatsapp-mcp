-- Preserve irreversible privacy markers and make capture gaps explicit after restore.
ALTER TABLE messages ADD COLUMN privacy_locked INTEGER NOT NULL DEFAULT 0 CHECK(privacy_locked IN (0,1));
UPDATE messages SET privacy_locked=1 WHERE unavailable_reason IN ('view_once','temporary');
ALTER TABLE chats ADD COLUMN capture_discontinuous INTEGER NOT NULL DEFAULT 0 CHECK(capture_discontinuous IN (0,1));
-- Backfill privacy protection for already ingested markers, including any object inserted by replay.
UPDATE messages SET text=NULL,kind='unavailable' WHERE privacy_locked=1;
DELETE FROM message_versions WHERE message_id IN (SELECT id FROM messages WHERE privacy_locked=1);
UPDATE media SET deleted_at=COALESCE(deleted_at,created_at),state='deleted',source_url=NULL WHERE message_id IN (SELECT id FROM messages WHERE privacy_locked=1);
UPDATE media_jobs SET status='cancelled',lease_until=NULL WHERE media_id IN(SELECT id FROM media WHERE deleted_at IS NOT NULL);
UPDATE media_derivatives SET text=NULL,state='deleted' WHERE media_id IN(SELECT id FROM media WHERE deleted_at IS NOT NULL);
