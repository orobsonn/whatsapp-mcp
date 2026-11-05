-- Closed operational diagnostics only; no prompt, provider text or credentials.
ALTER TABLE assistant_native_model_receipts ADD COLUMN failure_stage TEXT CHECK(failure_stage IN('admission','transport','response','usage','settlement','authority'));
ALTER TABLE assistant_native_model_receipts ADD COLUMN failure_code TEXT CHECK(failure_code IN('timeout','aborted','transport_error','http_rejected','invalid_response','authority_or_ledger'));
ALTER TABLE assistant_native_model_receipts ADD COLUMN http_status INTEGER CHECK(http_status BETWEEN 100 AND 599);
ALTER TABLE assistant_native_model_receipts ADD COLUMN elapsed_ms INTEGER CHECK(elapsed_ms>=0);
ALTER TABLE assistant_native_model_receipts ADD COLUMN timed_out INTEGER CHECK(timed_out IN(0,1));
ALTER TABLE assistant_native_model_receipts ADD COLUMN response_state TEXT CHECK(response_state IN('incomplete','failed','error'));
ALTER TABLE assistant_native_model_receipts ADD COLUMN incomplete_reason TEXT CHECK(incomplete_reason IN('max_output_tokens','content_filter','other'));
