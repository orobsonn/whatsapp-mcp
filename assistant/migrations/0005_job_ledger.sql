-- Additive: one effective request per job; only a fenced CAS admits execution.
-- This ledger is independent from the lease. Reclaim never creates a new key.
CREATE TABLE IF NOT EXISTS assistant_job_ledger (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, job_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(length(request_json)<=32768),
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','attempting','uncertain','complete')),
  admitted_lease_generation INTEGER CHECK(admitted_lease_generation>0),
  PRIMARY KEY(installation_id,generation,job_id),
  UNIQUE(installation_id,generation,job_id,request_hash),
  CHECK(state='prepared' OR admitted_lease_generation IS NOT NULL),
  FOREIGN KEY(installation_id,generation,job_id) REFERENCES assistant_jobs(installation_id,generation,id)
);

-- A late provider answer remains observable even when its lease cannot publish.
CREATE TABLE IF NOT EXISTS assistant_job_receipts (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, job_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result TEXT NOT NULL CHECK(length(result)<=32768),
  received_at INTEGER NOT NULL CHECK(received_at>=0),
  PRIMARY KEY(installation_id,generation,job_id,request_hash),
  FOREIGN KEY(installation_id,generation,job_id,request_hash)
    REFERENCES assistant_job_ledger(installation_id,generation,job_id,request_hash)
);
