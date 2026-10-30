-- Freeze each authenticated Telegram owner input to its FIRST native epoch.
-- Pending native admission can retry that epoch; a purged epoch never becomes
-- a fresh owner request just because a webhook/cron is delivered again.
ALTER TABLE assistant_telegram_updates ADD COLUMN native_identity_json TEXT;
ALTER TABLE assistant_telegram_updates ADD COLUMN native_activation_key TEXT;
CREATE TRIGGER assistant_telegram_native_binding_immutable BEFORE UPDATE OF native_identity_json,native_activation_key ON assistant_telegram_updates
 WHEN OLD.native_identity_json IS NOT NULL AND (NEW.native_identity_json IS NOT OLD.native_identity_json OR NEW.native_activation_key IS NOT OLD.native_activation_key)
 BEGIN SELECT RAISE(ABORT,'native_telegram_input_binding_immutable'); END;
