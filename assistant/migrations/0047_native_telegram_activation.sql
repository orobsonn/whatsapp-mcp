-- Operational transition metadata, excluded from canonical exports/restores.
-- The operator records this cut while execution is held and the previous native
-- owner context is retired. It is not inferred from a model or an inbox MAX ID.
ALTER TABLE assistant_native_host_state ADD COLUMN telegram_activation_json TEXT;
ALTER TABLE assistant_native_host_events ADD COLUMN telegram_activation_key TEXT;
