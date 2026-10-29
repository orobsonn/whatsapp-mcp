-- A one-off sample is a separate operational receipt, never a daily cursor.
-- The existing UNIQUE day key remains: ISO dates for daily passages and
-- sample:<operationId> for explicitly requested samples.
ALTER TABLE assistant_curator_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'daily' CHECK(run_kind IN ('daily','sample'));
ALTER TABLE assistant_curator_runs ADD COLUMN civil_day TEXT;
UPDATE assistant_curator_runs SET civil_day=day WHERE run_kind='daily';
