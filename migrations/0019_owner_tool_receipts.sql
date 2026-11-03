-- Exact owner-command claims survive RPC/SDK retries. Never reclaim attempting.
CREATE TABLE owner_tool_receipts (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL,
 source_epoch TEXT NOT NULL, source_generation TEXT NOT NULL,
 session_id TEXT NOT NULL, task_ref TEXT NOT NULL, tool TEXT NOT NULL,
 input_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('attempting','complete','uncertain')),
 result_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,source_epoch,source_generation,session_id,task_ref,tool,input_hash)
);
