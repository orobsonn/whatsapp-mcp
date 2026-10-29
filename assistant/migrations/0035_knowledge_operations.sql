-- Operational receipts only. The semantic graph lives in Cognee.
CREATE TABLE IF NOT EXISTS assistant_knowledge_operations (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,
 kind TEXT NOT NULL,client TEXT NOT NULL,request_hash TEXT NOT NULL,
 request_json TEXT NOT NULL,normalized_json TEXT,source_fences_json TEXT,
 state TEXT NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','attempting','complete','uncertain')),
 response_json TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,id)
);
CREATE INDEX IF NOT EXISTS assistant_knowledge_pending ON assistant_knowledge_operations(installation_id,generation,state,updated_at);
