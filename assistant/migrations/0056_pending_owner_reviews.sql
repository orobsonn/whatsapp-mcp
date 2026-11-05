ALTER TABLE assistant_native_telegram_reviews ADD COLUMN owner_pending_review INTEGER NOT NULL DEFAULT 0 CHECK(owner_pending_review IN (0,1));
