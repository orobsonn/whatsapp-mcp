-- Original bodies remain in the canonical source tables, never this ledger.
CREATE TABLE IF NOT EXISTS assistant_retrieval_runs (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL CHECK(length(id)=64),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),request_json TEXT NOT NULL CHECK(json_valid(request_json)),request_hash TEXT NOT NULL CHECK(length(request_hash)=64),run_token TEXT NOT NULL,
 checkpoint INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint>=0),state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','waiting_context')),
 steps_used INTEGER NOT NULL DEFAULT 0 CHECK(steps_used>=0 AND steps_used<=max_steps),evaluations INTEGER NOT NULL DEFAULT 0 CHECK(evaluations>=0 AND evaluations<=max_evaluations),
 active_step TEXT,pack_json TEXT CHECK(pack_json IS NULL OR (json_valid(pack_json) AND json_array_length(pack_json)<=10)),pack_hash TEXT CHECK(pack_hash IS NULL OR length(pack_hash)=64),
 page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 64),max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 80),max_evaluations INTEGER NOT NULL CHECK(max_evaluations BETWEEN 1 AND 4096),
 PRIMARY KEY(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_retrieval_steps (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,step_id TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),token TEXT NOT NULL,expected_checkpoint INTEGER NOT NULL CHECK(expected_checkpoint>=0),
 page_json TEXT NOT NULL CHECK(json_valid(page_json) AND json_array_length(page_json)<=64),state TEXT NOT NULL CHECK(state IN ('prepared','complete')),lease_until INTEGER NOT NULL,lease_generation INTEGER NOT NULL DEFAULT 1 CHECK(lease_generation>0),result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 PRIMARY KEY(installation_id,generation,run_id,step_id),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_retrieval_runs(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_retrieval_items (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,source_id TEXT NOT NULL,fingerprint TEXT NOT NULL,score REAL NOT NULL,linked INTEGER NOT NULL CHECK(linked IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('ready','origin_unavailable','source_text_limit','relation_unavailable')),
 origin_json TEXT CHECK(origin_json IS NULL OR json_valid(origin_json)),conversation_json TEXT CHECK(conversation_json IS NULL OR json_valid(conversation_json)),
 PRIMARY KEY(installation_id,generation,run_id,source_id),
 FOREIGN KEY(installation_id,generation,run_id) REFERENCES assistant_retrieval_runs(installation_id,generation,id),
 FOREIGN KEY(installation_id,generation,source_id) REFERENCES assistant_sources(installation_id,generation,id)
);
