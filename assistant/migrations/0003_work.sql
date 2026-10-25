
-- Durable obligations and worker jobs are different entities. Times are epoch
-- milliseconds. SQL stores scheduling intent; it neither schedules nor sends.
CREATE TABLE IF NOT EXISTS assistant_missions (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  objective TEXT NOT NULL CHECK(length(objective)>0),
  source_id TEXT NOT NULL, source_revision INTEGER NOT NULL CHECK(source_revision>0),
  project_id TEXT, stop_condition TEXT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','paused','resolved','cancelled')),
  next_evaluation_at INTEGER CHECK(next_evaluation_at IS NULL OR next_evaluation_at>=0),
  PRIMARY KEY(installation_id,generation,id),
  FOREIGN KEY(installation_id,generation,source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);

-- Rescheduling creates a new version; old occurrences retain their references.
-- Controllers must select/revalidate the latest version and cancel obsolete work.
-- Project/recipient/mandate IDs are opaque until identity/policy controllers bind
-- them. These fields never constitute identity proof or authorization themselves.
CREATE TABLE IF NOT EXISTS assistant_follow_ups (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  mission_id TEXT, project_id TEXT, recipient_id TEXT,
  source_id TEXT NOT NULL, source_revision INTEGER NOT NULL CHECK(source_revision>0),
  origin TEXT NOT NULL CHECK(origin IN ('owner_request','assistant_commitment','external_request')),
  conversation_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(length(purpose)>0),
  due_at INTEGER CHECK(due_at IS NULL OR due_at>=0),
  window_end INTEGER CHECK(window_end IS NULL OR (due_at IS NOT NULL AND window_end>=due_at)),
  timezone TEXT NOT NULL CHECK(length(timezone)>0),
  precision TEXT NOT NULL DEFAULT 'unset' CHECK(precision IN ('unset','exact','day','window')),
  condition_text TEXT, reason TEXT, external_event_ref TEXT,
  mandate_id TEXT, mandate_version INTEGER,
  recurrence_limit INTEGER NOT NULL DEFAULT 1 CHECK(recurrence_limit>=1),
  state TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK(state IN ('scheduled','awaiting_condition','awaiting_approval','paused','closed','cancelled')),
  next_evaluation_at INTEGER NOT NULL CHECK(next_evaluation_at>=0),
  PRIMARY KEY(installation_id,generation,id,version),
  CHECK((due_at IS NULL AND precision='unset') OR (due_at IS NOT NULL AND precision<>'unset')),
  CHECK((mandate_id IS NULL AND mandate_version IS NULL) OR (mandate_id IS NOT NULL AND mandate_version IS NOT NULL AND mandate_version>0)),
  FOREIGN KEY(installation_id,generation,mission_id)
    REFERENCES assistant_missions(installation_id,generation,id),
  FOREIGN KEY(installation_id,generation,source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);

CREATE TABLE IF NOT EXISTS assistant_fup_occurrences (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, follow_up_id TEXT NOT NULL, follow_up_version INTEGER NOT NULL,
  due_at INTEGER NOT NULL CHECK(due_at>=0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','blocked','paused','shadow_completed','cancelled')),
  PRIMARY KEY(installation_id,generation,id),
  UNIQUE(installation_id,generation,follow_up_id,follow_up_version,due_at),
  FOREIGN KEY(installation_id,generation,follow_up_id,follow_up_version)
    REFERENCES assistant_follow_ups(installation_id,generation,id,version)
);

-- shadow_completed means computation completed, not contact or delivery.
-- No trigger changes a mission/FUP state when a job or occurrence completes.
CREATE TABLE IF NOT EXISTS assistant_jobs (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('extraction','reasoning','follow_up','review','maintenance')),
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key)>0),
  occurrence_id TEXT, source_id TEXT, source_revision INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','shadow_completed','failed','cancelled')),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=max_attempts),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts>=1),
  lease_until INTEGER CHECK(lease_until IS NULL OR lease_until>=0),
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
  last_error TEXT,
  PRIMARY KEY(installation_id,generation,id),
  UNIQUE(installation_id,generation,dedupe_key),
  CHECK(state<>'processing' OR lease_until IS NOT NULL),
  CHECK((source_id IS NULL AND source_revision IS NULL) OR (source_id IS NOT NULL AND source_revision IS NOT NULL AND source_revision>0)),
  FOREIGN KEY(installation_id,generation,occurrence_id)
    REFERENCES assistant_fup_occurrences(installation_id,generation,id),
  FOREIGN KEY(installation_id,generation,source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);

CREATE INDEX IF NOT EXISTS assistant_missions_due ON assistant_missions(installation_id,generation,state,next_evaluation_at,id);
CREATE INDEX IF NOT EXISTS assistant_follow_ups_due ON assistant_follow_ups(installation_id,generation,state,next_evaluation_at,id,version);
CREATE INDEX IF NOT EXISTS assistant_occurrences_due ON assistant_fup_occurrences(installation_id,generation,state,due_at,id);
CREATE INDEX IF NOT EXISTS assistant_jobs_due ON assistant_jobs(installation_id,generation,state,next_attempt_at,id);
CREATE INDEX IF NOT EXISTS assistant_jobs_leases ON assistant_jobs(installation_id,generation,state,lease_until);
