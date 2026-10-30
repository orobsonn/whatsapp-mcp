-- Minimal paid-attempt custody. No prompt, response, tool output or credential.
CREATE TABLE assistant_native_model_receipts (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,session_id TEXT NOT NULL,context_epoch TEXT NOT NULL,turn_id TEXT NOT NULL,
 operation_key TEXT NOT NULL,period TEXT NOT NULL,request_hash TEXT NOT NULL,price_version TEXT NOT NULL,
 ceiling_units INTEGER NOT NULL CHECK(ceiling_units>0),
 state TEXT NOT NULL CHECK(state IN ('attempting','uncertain','complete')),
 input_tokens INTEGER,output_tokens INTEGER,actual_units INTEGER,
 PRIMARY KEY(installation_id,generation,session_id,context_epoch,turn_id),
 UNIQUE(installation_id,generation,operation_key),
 CHECK((state='complete' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND actual_units IS NOT NULL AND input_tokens>=0 AND output_tokens>=0 AND actual_units>=0) OR (state<>'complete' AND input_tokens IS NULL AND output_tokens IS NULL AND actual_units IS NULL))
);
