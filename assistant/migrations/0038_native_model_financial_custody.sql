-- Native receipts contain only minimal financial custody, across generations.
-- Settlement remains writable while quiescing and invalidates a stale seal.
CREATE TRIGGER IF NOT EXISTS retention_financial_native_model_receipts_insert AFTER INSERT ON assistant_native_model_receipts
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=NEW.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_financial_native_model_receipts_update AFTER UPDATE ON assistant_native_model_receipts
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id IN (OLD.installation_id,NEW.installation_id); END;
CREATE TRIGGER IF NOT EXISTS retention_financial_native_model_receipts_delete AFTER DELETE ON assistant_native_model_receipts
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=OLD.installation_id; END;
