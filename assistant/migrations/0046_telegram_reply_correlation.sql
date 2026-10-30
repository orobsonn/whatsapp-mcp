-- Preserve only the provider's quoted-message identity with the authenticated
-- inbox admission. Recovery needs no original webhook body or reconstructed
-- payload hash. These nullable identifiers never grant execution on their own.
ALTER TABLE assistant_telegram_updates ADD COLUMN reply_to_message_id INTEGER
 CHECK(reply_to_message_id IS NULL OR reply_to_message_id BETWEEN 1 AND 9007199254740991);
ALTER TABLE assistant_telegram_updates ADD COLUMN reply_to_chat_id TEXT
 CHECK(reply_to_chat_id IS NULL OR length(reply_to_chat_id) BETWEEN 1 AND 256);
ALTER TABLE assistant_telegram_updates ADD COLUMN reply_to_thread_id INTEGER
 CHECK(reply_to_thread_id IS NULL OR reply_to_thread_id BETWEEN 1 AND 9007199254740991);
